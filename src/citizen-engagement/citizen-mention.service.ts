import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, IsNull, Repository } from 'typeorm';

import { CitizenBlockService } from './block/citizen-block.service';
import { escapeLike } from './citizen-search.util';
import {
  CitizenMentionDto,
  CitizenMentionSearchResultDto,
} from './dto/citizen-mention-response.dto';
import { CitizenIdentity } from './entities/citizen-identity.entity';
import { CitizenMention } from './entities/citizen-mention.entity';
import { CitizenNotificationService } from './notification/citizen-notification.service';
import { CitizenPost } from './entities/citizen-post.entity';

/** Cap on the autocomplete result set (W-S6). */
const SEARCH_LIMIT = 8;
/** Cap on the number of distinct mentions persisted per post / comment (matches the DTO `@ArrayMaxSize(10)`). */
const MAX_MENTIONS = 10;

/**
 * CitizenMentionService — W-S6 @mention (identity-resolved, alias-display).
 *
 * TWO responsibilities, both §17.2 advisory + §17.3 isolated (touches ONLY
 * `citizen_*` tables):
 *
 *   1. Alias autocomplete (`searchByAlias`) — the composer searches active
 *      citizens by alias prefix and gets back `{ id, displayAlias }` (NO PII).
 *      Excludes the caller + (when a viewer is present) W-T1 blocked pairs.
 *   2. Create-time mention processing (`processMentions`) — called INSIDE the
 *      post-create / comment-create transaction. Validates each requested
 *      identity id (real, non-deleted, active citizen), drops self / dups /
 *      blocked pairs, inserts `citizen_mention` rows, and fires a `'mention'`
 *      notification (realtime via the W-T2 bus) to each surviving mentioned id.
 *      Returns the resolved `mentions[]` (alias-only) so the caller can attach
 *      them to the post / comment response for FE linkify.
 *
 * §17.2 advisory — a mention notifies; it gates NOTHING. A bad / blocked id is
 * silently dropped (never an error), so a mention never blocks the post / comment
 * write.
 */
@Injectable()
export class CitizenMentionService {
  constructor(
    @InjectRepository(CitizenIdentity)
    private readonly identityRepo: Repository<CitizenIdentity>,
    private readonly blockService: CitizenBlockService,
    private readonly notificationService: CitizenNotificationService,
  ) {}

  // ---------------------------------------------------------------------------
  // SEARCH (autocomplete)
  // ---------------------------------------------------------------------------

  /**
   * W-S6 autocomplete: active citizens whose `display_alias` matches the `q`
   * prefix, newest-alias-agnostic, capped to {@link SEARCH_LIMIT}. Returns
   * `{ id, displayAlias }` ONLY (§17.3 / PDPA — never PII). Excludes the caller
   * (`viewerId`) + (when a viewer is present) every citizen in a W-T1 `block`
   * pair with the viewer (either direction).
   */
  async searchByAlias(
    q: string,
    viewerId?: string,
  ): Promise<CitizenMentionSearchResultDto[]> {
    const term = q.trim();
    if (term.length < 1) {
      return [];
    }

    const qb = this.identityRepo
      .createQueryBuilder('c')
      // §17.3 / PDPA: load ONLY the id + public alias — never the *_enc / *_hash
      // PII columns (the response exposes id + displayAlias only).
      .select(['c.id', 'c.displayAlias'])
      .where('c.status = :status', { status: 'active' })
      .andWhere('c.deletedAt IS NULL')
      // Prefix ILIKE: the LIKE metachars are escaped + bound as a parameter (no
      // SQL injection, no ReDoS — ILIKE is not a regex). Thai has no word
      // boundaries, so a prefix match on the alias is the correct + simple shape.
      .andWhere('c.displayAlias ILIKE :like', { like: `${escapeLike(term)}%` });

    // Never offer the caller themselves (self-mention is meaningless).
    if (viewerId) {
      qb.andWhere('c.id <> :viewerId', { viewerId });
    }

    // Over-fetch a little so the post-query W-T1 block filter can drop pairs and
    // still return up to SEARCH_LIMIT rows.
    const rows = await qb
      .orderBy('c.displayAlias', 'ASC')
      .addOrderBy('c.id', 'ASC')
      .take(SEARCH_LIMIT * 2)
      .getMany();

    // W-T1: drop block pairs with the viewer (EITHER direction) — a viewer can't
    // @mention someone they blocked / who blocked them. `mute` does NOT restrict
    // mentioning. Anonymous viewer → no exclusions. Block-only via the canonical
    // `isBlockedEitherWay` helper (same semantic as repost/comment/react).
    const kept: CitizenMentionSearchResultDto[] = [];
    for (const r of rows) {
      if (kept.length >= SEARCH_LIMIT) {
        break;
      }
      if (viewerId && (await this.blockService.isBlockedEitherWay(viewerId, r.id))) {
        continue;
      }
      kept.push({ id: r.id, displayAlias: r.displayAlias });
    }
    return kept;
  }

  // ---------------------------------------------------------------------------
  // CREATE-TIME PROCESSING (inside the post / comment transaction)
  // ---------------------------------------------------------------------------

  /**
   * Resolve, persist, and notify the requested @mentions for a freshly-created
   * post or comment. EXACTLY ONE of (`post`, `commentId`) identifies the source.
   *
   * For each requested identity id (deduped, self-dropped):
   *   - keep ONLY real, non-deleted, `active` citizens;
   *   - drop W-T1 block pairs with the author (either direction);
   *   - insert a `citizen_mention` row (source = the post / comment);
   *   - fire a `'mention'` notification (realtime via the W-T2 bus).
   *
   * Returns the surviving mentions as `{ identityId, displayAlias }` (alias-only)
   * so the caller can attach `mentions[]` to the response. Empty / undefined
   * input → no-op → `[]`. Runs on the caller's `EntityManager` so the inserts +
   * notifications commit with the post / comment write.
   */
  async processMentions(
    em: EntityManager,
    authorIdentityId: string,
    requestedIds: string[] | undefined,
    source: { post: CitizenPost; commentId?: undefined } | { post: CitizenPost; commentId: string },
  ): Promise<CitizenMentionDto[]> {
    // Dedup + drop self + cap. Self-mention is meaningless; a citizen never
    // notifies themselves about their own post / comment.
    const unique = [...new Set(requestedIds ?? [])]
      .filter((id) => id && id !== authorIdentityId)
      .slice(0, MAX_MENTIONS);
    if (unique.length === 0) {
      return [];
    }

    // Validate: keep ONLY real, non-deleted, active citizens. A bogus / deleted /
    // blocked-status id is silently dropped (§17.2 advisory — never an error).
    // PDPA: select id + alias ONLY (never the *_enc / *_hash columns).
    const candidates = await em.getRepository(CitizenIdentity).find({
      where: { id: In(unique), status: 'active', deletedAt: IsNull() },
      select: { id: true, displayAlias: true },
    });

    const resolved: CitizenMentionDto[] = [];
    const mentionRepo = em.getRepository(CitizenMention);
    const commentId =
      'commentId' in source && source.commentId ? source.commentId : null;

    for (const c of candidates) {
      // W-T1: drop block pairs with the AUTHOR (either direction). Mute does NOT
      // restrict mentioning. Block-only via the canonical `isBlockedEitherWay`
      // helper (same semantic as repost/comment/react).
      if (await this.blockService.isBlockedEitherWay(authorIdentityId, c.id)) {
        continue;
      }
      // Insert the mention edge (source = post OR comment — exactly one set,
      // enforced by the DB CHECK ck_citizen_mention_source).
      const row = mentionRepo.create({
        postId: commentId === null ? source.post.id : null,
        commentId,
        mentionedIdentityId: c.id,
      });
      await mentionRepo.save(row);

      // Fire a 'mention' notification (realtime via the W-T2 bus). Best-effort
      // ping inside the notify helper; a self-mention can't reach here (dropped
      // above), so no NO-OP guard is needed.
      await this.notificationService.notifyOnMention(
        em,
        authorIdentityId,
        c.id,
        source.post,
        commentId ?? undefined,
      );

      resolved.push({ identityId: c.id, displayAlias: c.displayAlias });
    }

    return resolved;
  }

  // ---------------------------------------------------------------------------
  // READ-PATH HYDRATION (W-S6 — linkify mentions on list/detail reload)
  // ---------------------------------------------------------------------------

  /** Batch-load resolved mentions for a set of posts → Map<postId, dto[]>. */
  async loadMentionsForPosts(
    postIds: string[],
  ): Promise<Map<string, CitizenMentionDto[]>> {
    return this.loadMentionsBy('post_id', postIds);
  }

  /** Batch-load resolved mentions for a set of comments → Map<commentId, dto[]>. */
  async loadMentionsForComments(
    commentIds: string[],
  ): Promise<Map<string, CitizenMentionDto[]>> {
    return this.loadMentionsBy('comment_id', commentIds);
  }

  /**
   * Shared batch loader. Joins `citizen_mention` → `citizen_identities` for the
   * alias and groups by the source column. Alias-only (§17.3 / PDPA — id +
   * displayAlias ONLY). No N+1: one query per page.
   */
  private async loadMentionsBy(
    sourceCol: 'post_id' | 'comment_id',
    ids: string[],
  ): Promise<Map<string, CitizenMentionDto[]>> {
    const map = new Map<string, CitizenMentionDto[]>();
    if (ids.length === 0) return map;
    const rows = await this.identityRepo.manager
      .getRepository(CitizenMention)
      .createQueryBuilder('m')
      .innerJoin(CitizenIdentity, 'i', 'i.id = m.mentioned_identity_id')
      .select(`m.${sourceCol}`, 'srcId')
      .addSelect('i.id', 'identityId')
      .addSelect('i.display_alias', 'displayAlias')
      .where(`m.${sourceCol} IN (:...ids)`, { ids })
      .orderBy('m.created_at', 'ASC')
      .getRawMany<{ srcId: string; identityId: string; displayAlias: string }>();
    for (const r of rows) {
      const list = map.get(r.srcId) ?? [];
      list.push({ identityId: r.identityId, displayAlias: r.displayAlias });
      map.set(r.srcId, list);
    }
    return map;
  }
}
