import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CitizenPost } from '../entities/citizen-post.entity';
import { CitizenPostComment } from '../entities/citizen-post-comment.entity';
import { CitizenPostReaction } from '../entities/citizen-post-reaction.entity';
import { CitizenPostHashtag } from '../entities/citizen-post-hashtag.entity';
import { CitizenStory } from '../entities/citizen-story.entity';
import { CitizenHashtag } from '../entities/citizen-hashtag.entity';

/**
 * W-G3 window tunables — bound every aggregate's `created_at >= now - window`
 * filter so an executive can ask for 7 / 30 / 90 days but never an unbounded
 * scan.
 */
const DEFAULT_WINDOW_DAYS = 30;
const MIN_WINDOW_DAYS = 1;
const MAX_WINDOW_DAYS = 365;
const DEFAULT_TOP_LIMIT = 10;
const MAX_TOP_LIMIT = 50;

/** Snippet cap on the top-posts title/detail so the payload stays small. */
const SNIPPET_MAX = 200;

export interface CitizenInsightsOverview {
  windowDays: number;
  totals: {
    posts: number;
    comments: number;
    reactions: number;
    activeCitizens: number;
    polls: number;
    stories: number;
  };
  byKind: Record<string, number>;
  newPostsByDay: Array<{ day: string; count: number }>;
}

export interface CitizenTopCategory {
  category: string;
  postCount: number;
  reactionCount: number;
}

export interface CitizenTopHashtag {
  tag: string;
  postCount: number;
}

export interface CitizenTopPost {
  id: string;
  title: string | null;
  detail: string | null;
  postKind: string;
  category: string | null;
  heartCount: number;
  commentCount: number;
  engagement: number;
  /** ALIAS-ONLY author — never national_id / thaid / *_enc (§17.3 / PDPA). */
  displayAlias: string;
  createdAt: Date;
}

export interface CitizenByAmphoe {
  amphoeId: string;
  postCount: number;
}

/**
 * CitizenInsightsService — W-G3 executive analytics read aggregator.
 *
 * §18.13 ZERO-WRITE read aggregator: every method is a grouped/counted SELECT
 * over the `citizen_*` namespace. It inserts NO `tracking_status`, writes NO
 * `ai_*` row, fires NO notification, and mutates NOTHING. §17.2 advisory — the
 * numbers inform an executive; they gate no workflow transition. §17.3 isolation
 * — the queries touch ONLY citizen_* tables, hold NO new FK, and expose NO
 * citizen PII (alias-only on top-posts; counts everywhere else).
 *
 * Every aggregate filters VISIBLE-only (`moderation_state = 'visible'`) +
 * not-deleted (`deleted_at IS NULL`) and is windowed by `created_at >= now -
 * windowDays`. `windowDays` is clamped to [1, 365] (default 30).
 */
@Injectable()
export class CitizenInsightsService {
  constructor(
    @InjectRepository(CitizenPost)
    private readonly postRepo: Repository<CitizenPost>,
    @InjectRepository(CitizenPostComment)
    private readonly commentRepo: Repository<CitizenPostComment>,
    @InjectRepository(CitizenPostReaction)
    private readonly reactionRepo: Repository<CitizenPostReaction>,
    @InjectRepository(CitizenPostHashtag)
    private readonly postHashtagRepo: Repository<CitizenPostHashtag>,
    @InjectRepository(CitizenStory)
    private readonly storyRepo: Repository<CitizenStory>,
  ) {}

  // ---------------------------------------------------------------------------
  // overview
  // ---------------------------------------------------------------------------

  /**
   * Headline counts over the window: posts / comments / reactions / distinct
   * active citizens / polls / stories, the per-kind post split, and a
   * new-posts-by-day series. All counts are VISIBLE + not-deleted within the
   * window. `activeCitizens` = distinct VISIBLE post authors in the window
   * (an aggregate, NOT a citizen list — no identity leaves the service).
   */
  async overview(windowDays?: number): Promise<CitizenInsightsOverview> {
    const win = this.clampWindow(windowDays);
    const since = this.sinceOf(win);

    const posts = await this.postRepo
      .createQueryBuilder('p')
      .where('p.moderation_state = :state', { state: 'visible' })
      .andWhere('p.deleted_at IS NULL')
      .andWhere('p.created_at >= :since', { since })
      .getCount();

    const comments = await this.commentRepo
      .createQueryBuilder('c')
      .where('c.moderation_state = :state', { state: 'visible' })
      .andWhere('c.deleted_at IS NULL')
      .andWhere('c.created_at >= :since', { since })
      .getCount();

    // Reactions have no moderation_state — a live (not-soft-deleted) reaction
    // on a VISIBLE post in the window. Join the post for the visible filter.
    const reactions = await this.reactionRepo
      .createQueryBuilder('r')
      .innerJoin('citizen_post', 'p', 'p.id = r.post_id')
      .where('r.deleted_at IS NULL')
      .andWhere('r.created_at >= :since', { since })
      .andWhere('p.moderation_state = :state', { state: 'visible' })
      .andWhere('p.deleted_at IS NULL')
      .getCount();

    const activeRow = await this.postRepo
      .createQueryBuilder('p')
      .select('COUNT(DISTINCT p.author_identity_id)', 'cnt')
      .where('p.moderation_state = :state', { state: 'visible' })
      .andWhere('p.deleted_at IS NULL')
      .andWhere('p.created_at >= :since', { since })
      .getRawOne<{ cnt: string }>();
    const activeCitizens = Number(activeRow?.cnt ?? 0);

    const polls = await this.postRepo
      .createQueryBuilder('p')
      .where('p.post_kind = :kind', { kind: 'poll' })
      .andWhere('p.moderation_state = :state', { state: 'visible' })
      .andWhere('p.deleted_at IS NULL')
      .andWhere('p.created_at >= :since', { since })
      .getCount();

    const stories = await this.storyRepo
      .createQueryBuilder('s')
      .where('s.deleted_at IS NULL')
      .andWhere('s.created_at >= :since', { since })
      .getCount();

    const kindRows = await this.postRepo
      .createQueryBuilder('p')
      .select('p.post_kind', 'kind')
      .addSelect('COUNT(*)', 'cnt')
      .where('p.moderation_state = :state', { state: 'visible' })
      .andWhere('p.deleted_at IS NULL')
      .andWhere('p.created_at >= :since', { since })
      .groupBy('p.post_kind')
      .getRawMany<{ kind: string; cnt: string }>();
    const byKind: Record<string, number> = {};
    for (const row of kindRows) {
      byKind[row.kind] = Number(row.cnt);
    }

    const dayRows = await this.postRepo
      .createQueryBuilder('p')
      .select("to_char(date_trunc('day', p.created_at), 'YYYY-MM-DD')", 'day')
      .addSelect('COUNT(*)', 'cnt')
      .where('p.moderation_state = :state', { state: 'visible' })
      .andWhere('p.deleted_at IS NULL')
      .andWhere('p.created_at >= :since', { since })
      .groupBy("date_trunc('day', p.created_at)")
      .orderBy("date_trunc('day', p.created_at)", 'ASC')
      .getRawMany<{ day: string; cnt: string }>();
    const newPostsByDay = dayRows.map((r) => ({
      day: r.day,
      count: Number(r.cnt),
    }));

    return {
      windowDays: win,
      totals: { posts, comments, reactions, activeCitizens, polls, stories },
      byKind,
      newPostsByDay,
    };
  }

  // ---------------------------------------------------------------------------
  // topCategories (idea categories)
  // ---------------------------------------------------------------------------

  /**
   * Top idea categories over the window — post count + summed heart_count per
   * category. Only `idea` posts carry a `category`; the NOT-NULL filter drops
   * discussions / polls. VISIBLE + not-deleted only.
   */
  async topCategories(windowDays?: number): Promise<CitizenTopCategory[]> {
    const win = this.clampWindow(windowDays);
    const since = this.sinceOf(win);

    const rows = await this.postRepo
      .createQueryBuilder('p')
      .select('p.category', 'category')
      .addSelect('COUNT(*)', 'postCount')
      // heart_count is the denormalized live-reaction signal on the post.
      .addSelect('COALESCE(SUM(p.heart_count), 0)', 'reactionCount')
      .where('p.category IS NOT NULL')
      .andWhere('p.moderation_state = :state', { state: 'visible' })
      .andWhere('p.deleted_at IS NULL')
      .andWhere('p.created_at >= :since', { since })
      .groupBy('p.category')
      .orderBy('"postCount"', 'DESC')
      .addOrderBy('p.category', 'ASC')
      .getRawMany<{
        category: string;
        postCount: string;
        reactionCount: string;
      }>();

    return rows.map((r) => ({
      category: r.category,
      postCount: Number(r.postCount),
      reactionCount: Number(r.reactionCount),
    }));
  }

  // ---------------------------------------------------------------------------
  // topHashtags (wraps the W-S4 trending query, day window)
  // ---------------------------------------------------------------------------

  /**
   * Top hashtags over the window — DISTINCT VISIBLE posts per tag, mirroring the
   * W-S4 trending query (grouped COUNT over the link table joined to the
   * dictionary + the post for the visible filter). The day-scoped sibling of
   * `CitizenHashtagService.listTrending` (which is hour-scoped); kept here so
   * the executive surface uses one consistent day window across all 5 reads.
   */
  async topHashtags(
    windowDays?: number,
    limit?: number,
  ): Promise<CitizenTopHashtag[]> {
    const win = this.clampWindow(windowDays);
    const take = this.clampLimit(limit);
    const since = this.sinceOf(win);

    const rows = await this.postHashtagRepo
      .createQueryBuilder('ph')
      .innerJoin(CitizenHashtag, 'h', 'h.id = ph.hashtag_id')
      .innerJoin('citizen_post', 'p', 'p.id = ph.post_id')
      .select('h.tag', 'tag')
      .addSelect('COUNT(DISTINCT ph.post_id)', 'postCount')
      .where('ph.created_at >= :since', { since })
      .andWhere('p.moderation_state = :state', { state: 'visible' })
      .andWhere('p.deleted_at IS NULL')
      .groupBy('h.tag')
      .orderBy('"postCount"', 'DESC')
      .addOrderBy('h.tag', 'ASC')
      .limit(take)
      .getRawMany<{ tag: string; postCount: string }>();

    return rows.map((r) => ({ tag: r.tag, postCount: Number(r.postCount) }));
  }

  // ---------------------------------------------------------------------------
  // topPosts (most-engaged, ALIAS-ONLY author)
  // ---------------------------------------------------------------------------

  /**
   * Most-engaged VISIBLE posts over the window, ranked by
   * `heart_count + 2 * comment_count`. The author is exposed ALIAS-ONLY
   * (`display_alias`) — national_id / thaid / *_enc / *_hash columns are NEVER
   * selected (§17.3 / PDPA). title + detail are trimmed to a snippet.
   */
  async topPosts(
    windowDays?: number,
    limit?: number,
  ): Promise<CitizenTopPost[]> {
    const win = this.clampWindow(windowDays);
    const take = this.clampLimit(limit);
    const since = this.sinceOf(win);

    const rows = await this.postRepo
      .createQueryBuilder('p')
      // Join the author identity ONLY for the public alias — no PII column.
      .innerJoin('citizen_identities', 'i', 'i.id = p.author_identity_id')
      .select('p.id', 'id')
      .addSelect('p.title', 'title')
      .addSelect('p.detail', 'detail')
      .addSelect('p.post_kind', 'postKind')
      .addSelect('p.category', 'category')
      .addSelect('p.heart_count', 'heartCount')
      .addSelect('p.comment_count', 'commentCount')
      .addSelect('p.created_at', 'createdAt')
      .addSelect('i.display_alias', 'displayAlias')
      .addSelect('(p.heart_count + 2 * p.comment_count)', 'engagement')
      .where('p.moderation_state = :state', { state: 'visible' })
      .andWhere('p.deleted_at IS NULL')
      .andWhere('p.created_at >= :since', { since })
      .orderBy('"engagement"', 'DESC')
      .addOrderBy('p.created_at', 'DESC')
      .limit(take)
      .getRawMany<{
        id: string;
        title: string | null;
        detail: string | null;
        postKind: string;
        category: string | null;
        heartCount: number;
        commentCount: number;
        engagement: number;
        displayAlias: string;
        createdAt: Date;
      }>();

    return rows.map((r) => ({
      id: r.id,
      title: this.snippet(r.title),
      detail: this.snippet(r.detail),
      postKind: r.postKind,
      category: r.category,
      heartCount: Number(r.heartCount),
      commentCount: Number(r.commentCount),
      engagement: Number(r.engagement),
      displayAlias: r.displayAlias,
      createdAt: r.createdAt,
    }));
  }

  // ---------------------------------------------------------------------------
  // byAmphoe (idea posts carry an amphoe pin)
  // ---------------------------------------------------------------------------

  /**
   * Post count per amphoe over the window — only posts with a non-null
   * `amphoe_id` (ideas are geo-pinned). The amphoe NAME is resolved at the FE
   * from the existing amphoe list; the BE stays aggregate-only and returns the
   * plain `amphoe_id` uuid (no FK, no master-table join). VISIBLE + not-deleted.
   */
  async byAmphoe(windowDays?: number): Promise<CitizenByAmphoe[]> {
    const win = this.clampWindow(windowDays);
    const since = this.sinceOf(win);

    const rows = await this.postRepo
      .createQueryBuilder('p')
      .select('p.amphoe_id', 'amphoeId')
      .addSelect('COUNT(*)', 'postCount')
      .where('p.amphoe_id IS NOT NULL')
      .andWhere('p.moderation_state = :state', { state: 'visible' })
      .andWhere('p.deleted_at IS NULL')
      .andWhere('p.created_at >= :since', { since })
      .groupBy('p.amphoe_id')
      .orderBy('"postCount"', 'DESC')
      .getRawMany<{ amphoeId: string; postCount: string }>();

    return rows.map((r) => ({
      amphoeId: r.amphoeId,
      postCount: Number(r.postCount),
    }));
  }

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  /** Clamp windowDays to [1, 365], default 30 (NaN / undefined → default). */
  private clampWindow(days?: number): number {
    if (days === undefined || days === null || Number.isNaN(days)) {
      return DEFAULT_WINDOW_DAYS;
    }
    return this.clamp(days, MIN_WINDOW_DAYS, MAX_WINDOW_DAYS);
  }

  /** Clamp a top-N limit to [1, 50], default 10. */
  private clampLimit(limit?: number): number {
    if (limit === undefined || limit === null || Number.isNaN(limit)) {
      return DEFAULT_TOP_LIMIT;
    }
    return this.clamp(limit, 1, MAX_TOP_LIMIT);
  }

  private clamp(n: number, lo: number, hi: number): number {
    if (Number.isNaN(n)) {
      return lo;
    }
    return Math.max(lo, Math.min(hi, Math.trunc(n)));
  }

  private sinceOf(windowDays: number): Date {
    return new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  }

  private snippet(text: string | null): string | null {
    if (!text) {
      return text ?? null;
    }
    return text.length > SNIPPET_MAX ? `${text.slice(0, SNIPPET_MAX)}…` : text;
  }
}
