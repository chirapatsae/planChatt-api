import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';

import {
  TrendingHashtagDto,
  TrendingHashtagsResponseDto,
} from '../dto/citizen-hashtag-response.dto';
import { CitizenHashtag } from '../entities/citizen-hashtag.entity';
import { CitizenPostHashtag } from '../entities/citizen-post-hashtag.entity';

/**
 * W-S4 tunables.
 *
 * - MAX_TAGS_PER_POST  — cap on links written per post (anti-spam; a body with
 *   30 tags links only the first 10 distinct ones).
 * - TAG_MAX_LENGTH     — matches the `citizen_hashtag.tag` column width; an
 *   over-long token is skipped (never truncated into a different tag).
 * - DEFAULT/MAX trending window + result caps — bound the grouped COUNT.
 */
const MAX_TAGS_PER_POST = 10;
const TAG_MAX_LENGTH = 140;
const DEFAULT_TRENDING_WINDOW_HOURS = 24;
const MAX_TRENDING_WINDOW_HOURS = 24 * 14; // two weeks
const DEFAULT_TRENDING_LIMIT = 20;
const MAX_TRENDING_LIMIT = 50;

/**
 * Hashtag extractor. A token is a `#` followed by 1+ tag characters. The class
 * deliberately allows the Unicode letter/number classes PLUS the Thai block and
 * an underscore, so `#สวนสาธารณะ`, `#Park`, `#โครงการ_2026`, and `#road2` all
 * parse, while punctuation / whitespace terminate the tag.
 *
 * `\p{L}` (letters, incl. Thai) + `\p{N}` (numbers) + `_`, with the `u` flag.
 * Thai combining marks (`\p{M}`, e.g. สระ/วรรณยุกต์) are included so a tag like
 * `#นครราชสีมา` is captured whole rather than split at a combining vowel.
 */
const HASHTAG_REGEX = /#([\p{L}\p{M}\p{N}_]+)/gu;

/**
 * CitizenHashtagService — extraction + linking + trending (W-S4, §17.2 ADVISORY).
 *
 * §17.3 isolation: touches ONLY `citizen_*` tables (`citizen_hashtag`,
 * `citizen_post_hashtag`). It writes NO `tracking_status` and references no
 * project / users / work_history. Linking runs INSIDE the post-create
 * transaction (the caller's `EntityManager`) so the post row + its tag links
 * commit atomically; trending is a pure read.
 */
@Injectable()
export class CitizenHashtagService {
  constructor(
    @InjectRepository(CitizenHashtag)
    private readonly hashtagRepo: Repository<CitizenHashtag>,
    @InjectRepository(CitizenPostHashtag)
    private readonly postHashtagRepo: Repository<CitizenPostHashtag>,
    private readonly dataSource: DataSource,
  ) {}

  // ---------------------------------------------------------------------------
  // EXTRACTION (pure)
  // ---------------------------------------------------------------------------

  /**
   * Parse `#tags` out of a free-text body and return the NORMALIZED, DEDUPED,
   * CAPPED list of canonical tags:
   *   - parse  — `#` + (Unicode letter | mark | number | `_`)+, incl. Thai
   *   - normalize — NFC, strip the leading `#`, lowercase
   *   - dedupe — first-seen order, after normalization (so `#Park` and `#park`
   *     collapse to one)
   *   - cap — at most MAX_TAGS_PER_POST tags (first-seen wins)
   *   - skip — empty / over-length tokens are dropped (never truncated)
   *
   * Pure + side-effect-free so it is unit-testable in isolation and reusable to
   * normalize a single `:tag` path param on the search read.
   */
  static extractTags(text: string | null | undefined): string[] {
    if (!text) {
      return [];
    }
    const seen = new Set<string>();
    const out: string[] = [];
    for (const match of text.matchAll(HASHTAG_REGEX)) {
      const tag = CitizenHashtagService.normalizeTag(match[1]);
      if (!tag || tag.length > TAG_MAX_LENGTH) {
        continue;
      }
      if (seen.has(tag)) {
        continue;
      }
      seen.add(tag);
      out.push(tag);
      if (out.length >= MAX_TAGS_PER_POST) {
        break;
      }
    }
    return out;
  }

  /**
   * Normalize ONE raw tag token to its canonical key: NFC, strip a single
   * leading `#` (the `:tag` search param may or may not carry it), lowercase,
   * trim. Returns '' for a token that is empty after normalization.
   */
  static normalizeTag(raw: string | null | undefined): string {
    if (!raw) {
      return '';
    }
    let t = raw.normalize('NFC').trim();
    if (t.startsWith('#')) {
      t = t.slice(1);
    }
    // Lowercase AFTER NFC so the Unicode case-fold sees the composed form.
    return t.toLowerCase();
  }

  // ---------------------------------------------------------------------------
  // LINKING (in-tx, called from post / poll create AFTER the post row exists)
  // ---------------------------------------------------------------------------

  /**
   * Extract the `#tags` from `text` and link them to `postId`, IN the caller's
   * transaction (so the links commit atomically with the post). For each
   * distinct tag:
   *   1. upsert the dictionary row (race-safe `ON CONFLICT DO NOTHING` on the
   *      unique `tag`, then re-read to get the id),
   *   2. insert the (post, hashtag) link (race-safe `ON CONFLICT DO NOTHING` on
   *      the unique `(post_id, hashtag_id)`).
   *
   * No-op when `text` carries no tags. NEVER throws on a duplicate (orIgnore) so
   * a concurrent create of the same tag / a re-link cannot abort the host
   * transaction (mirrors the W-S1 reaction / W-S7 vote orIgnore pattern).
   */
  async extractAndLink(
    em: EntityManager,
    postId: string,
    text: string | null | undefined,
  ): Promise<void> {
    const tags = CitizenHashtagService.extractTags(text);
    if (tags.length === 0) {
      return;
    }

    const hashtagRepo = em.getRepository(CitizenHashtag);
    const linkRepo = em.getRepository(CitizenPostHashtag);

    for (const tag of tags) {
      // Race-safe dictionary upsert: insert-or-ignore on the unique `tag`, then
      // read back the id (the row exists either way after this point).
      await hashtagRepo
        .createQueryBuilder()
        .insert()
        .values({ tag })
        .orIgnore()
        .execute();
      const dict = await hashtagRepo.findOne({ where: { tag } });
      if (!dict) {
        // Should not happen (we just ensured the row), but never throw.
        continue;
      }

      // Race-safe link insert: insert-or-ignore on the unique (post, hashtag).
      await linkRepo
        .createQueryBuilder()
        .insert()
        .values({ postId, hashtagId: dict.id })
        .orIgnore()
        .execute();
    }
  }

  // ---------------------------------------------------------------------------
  // TRENDING (public read — §17.2 advisory)
  // ---------------------------------------------------------------------------

  /**
   * Trending hashtags = the tags used by the most DISTINCT VISIBLE posts inside
   * the recent window (default 24h). A grouped COUNT over the link table joined
   * to the dictionary (for the tag text) and the post (for the visible +
   * not-deleted filter), ordered by post count DESC. §17.2 advisory — a ranking
   * only; it gates nothing.
   */
  async listTrending(
    windowHours?: number,
    limit?: number,
  ): Promise<TrendingHashtagsResponseDto> {
    const win = this.clamp(
      windowHours ?? DEFAULT_TRENDING_WINDOW_HOURS,
      1,
      MAX_TRENDING_WINDOW_HOURS,
    );
    const take = this.clamp(limit ?? DEFAULT_TRENDING_LIMIT, 1, MAX_TRENDING_LIMIT);
    const since = new Date(Date.now() - win * 60 * 60 * 1000);

    const rows = await this.postHashtagRepo
      .createQueryBuilder('ph')
      .innerJoin(CitizenHashtag, 'h', 'h.id = ph.hashtag_id')
      // Visible + not-deleted posts only — a hidden / removed / soft-deleted
      // post never contributes to trending (mirrors the public feed filter).
      .innerJoin('citizen_post', 'p', 'p.id = ph.post_id')
      .select('h.tag', 'tag')
      // DISTINCT post so a tag used twice in one body counts once (the unique
      // link already enforces one link per (post, tag), but COUNT(DISTINCT) is
      // belt-and-braces).
      .addSelect('COUNT(DISTINCT ph.post_id)', 'postCount')
      .where('ph.created_at >= :since', { since })
      .andWhere("p.moderation_state = :state", { state: 'visible' })
      .andWhere('p.deleted_at IS NULL')
      .groupBy('h.tag')
      .orderBy('"postCount"', 'DESC')
      .addOrderBy('h.tag', 'ASC')
      .limit(take)
      .getRawMany<{ tag: string; postCount: string }>();

    const items: TrendingHashtagDto[] = rows.map((r) => ({
      tag: r.tag,
      postCount: Number(r.postCount),
    }));
    return { items, windowHours: win };
  }

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  private clamp(n: number, lo: number, hi: number): number {
    if (Number.isNaN(n)) {
      return lo;
    }
    return Math.max(lo, Math.min(hi, Math.trunc(n)));
  }
}
