import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CitizenAppeal } from '../entities/citizen-appeal.entity';
import { CitizenIdentity } from '../entities/citizen-identity.entity';
import { CitizenModerationLog } from '../entities/citizen-moderation-log.entity';
import { CitizenPost } from '../entities/citizen-post.entity';
import { CitizenReport } from '../entities/citizen-report.entity';

/**
 * W-T4 window / limit tunables. `windowDays` bounds the author-ranking aggregates
 * (`created_at >= now - window`) so a moderator may ask for 7 / 30 / 90 days but
 * never an unbounded scan. The overview is point-in-time (current open counts)
 * and is NOT windowed.
 */
const DEFAULT_WINDOW_DAYS = 30;
const MIN_WINDOW_DAYS = 1;
const MAX_WINDOW_DAYS = 365;
const DEFAULT_TOP_LIMIT = 10;
const MAX_TOP_LIMIT = 50;
const DEFAULT_RECENT_LIMIT = 20;
const MAX_RECENT_LIMIT = 100;

export interface CitizenModerationOverview {
  openReports: number;
  openAppeals: number;
  shadowedPosts: number;
  removedPosts: number;
  suspendedAccounts: number;
}

export interface CitizenTopReportedAuthor {
  authorIdentityId: string;
  /** ALIAS-ONLY — never national_id / thaid / *_enc / *_hash (§17.3 / PDPA). */
  displayAlias: string;
  distinctReporters: number;
  reportedPosts: number;
}

export interface CitizenTopActionedAuthor {
  authorIdentityId: string;
  /** ALIAS-ONLY (§17.3 / PDPA). */
  displayAlias: string;
  removedCount: number;
  shadowedCount: number;
}

export interface CitizenRecentAction {
  action: string;
  actorRole: string | null;
  postId: string | null;
  /** The POST AUTHOR's alias — NEVER the reporter's identity / any PII. */
  authorAlias: string | null;
  reason: string | null;
  createdAt: Date;
}

/**
 * CitizenModerationInsightsService — W-T4 staff moderation risk dashboard.
 *
 * §18.13 ZERO-WRITE read aggregator: every method is a grouped/counted SELECT
 * over the `citizen_*` namespace. It inserts NO `tracking_status`, writes NO
 * `ai_*` row, fires NO notification, and mutates NOTHING (no save / insert /
 * update / delete). §17.2 advisory — the numbers inform a moderator; they gate
 * no workflow transition and auto-action NOTHING (every action still goes
 * through the existing W-T3 per-item flow). §17.3 isolation — the queries touch
 * ONLY citizen_* tables, hold NO new FK, and expose NO citizen PII (alias-only
 * authors; counts everywhere else; the reporter's identity is NEVER projected).
 *
 * NO service↔service import: this aggregator depends ONLY on repositories + its
 * own DTOs. There is no transitive import cycle.
 */
@Injectable()
export class CitizenModerationInsightsService {
  constructor(
    @InjectRepository(CitizenReport)
    private readonly reportRepo: Repository<CitizenReport>,
    @InjectRepository(CitizenAppeal)
    private readonly appealRepo: Repository<CitizenAppeal>,
    @InjectRepository(CitizenPost)
    private readonly postRepo: Repository<CitizenPost>,
    @InjectRepository(CitizenIdentity)
    private readonly identityRepo: Repository<CitizenIdentity>,
    @InjectRepository(CitizenModerationLog)
    private readonly logRepo: Repository<CitizenModerationLog>,
  ) {}

  // ---------------------------------------------------------------------------
  // overview — point-in-time queue-pressure counts
  // ---------------------------------------------------------------------------

  /**
   * Current moderation-queue pressure: open reports, open appeals, posts in the
   * `shadow` / `removed` states, and suspended citizen accounts. Each count
   * filters not-deleted (`deleted_at IS NULL`) where the table is soft-deletable
   * (report / appeal / post). `citizen_moderation_log` is append-only (no
   * soft-delete) and is not part of the overview. Not windowed — this is the
   * live backlog.
   */
  async overview(): Promise<CitizenModerationOverview> {
    const openReports = await this.reportRepo
      .createQueryBuilder('r')
      .where('r.status = :s', { s: 'open' })
      .andWhere('r.deleted_at IS NULL')
      .getCount();

    const openAppeals = await this.appealRepo
      .createQueryBuilder('a')
      .where('a.status = :s', { s: 'open' })
      .andWhere('a.deleted_at IS NULL')
      .getCount();

    const shadowedPosts = await this.postRepo
      .createQueryBuilder('p')
      .where('p.moderation_state = :s', { s: 'shadow' })
      .andWhere('p.deleted_at IS NULL')
      .getCount();

    const removedPosts = await this.postRepo
      .createQueryBuilder('p')
      .where('p.moderation_state = :s', { s: 'removed' })
      .andWhere('p.deleted_at IS NULL')
      .getCount();

    const suspendedAccounts = await this.identityRepo
      .createQueryBuilder('i')
      .where('i.status = :s', { s: 'suspended' })
      .andWhere('i.deleted_at IS NULL')
      .getCount();

    return {
      openReports,
      openAppeals,
      shadowedPosts,
      removedPosts,
      suspendedAccounts,
    };
  }

  // ---------------------------------------------------------------------------
  // topReportedAuthors — repeat-offender heat by distinct reporters
  // ---------------------------------------------------------------------------

  /**
   * Authors ranked by how many DISTINCT citizens have reported them over the
   * window — the proactive repeat-offender signal. Joins
   * `citizen_report` → `citizen_post` (the reported post's author) →
   * `citizen_identities` (alias only). COUNT(DISTINCT reporter_identity_id) is
   * the rank; COUNT(DISTINCT post_id) shows breadth across the author's posts.
   * Reports + posts filtered not-deleted; reports windowed by `created_at`.
   * The reporter's identity is NEVER projected — only counted (§17.3 / PDPA).
   */
  async topReportedAuthors(
    windowDays?: number,
    limit?: number,
  ): Promise<CitizenTopReportedAuthor[]> {
    const since = this.sinceOf(this.clampWindow(windowDays));
    const take = this.clampLimit(limit);

    const rows = await this.reportRepo
      .createQueryBuilder('r')
      .innerJoin('citizen_post', 'p', 'p.id = r.post_id')
      // Alias ONLY — no PII column is ever selected from the identity row.
      .innerJoin('citizen_identities', 'i', 'i.id = p.author_identity_id')
      .select('p.author_identity_id', 'authorIdentityId')
      .addSelect('i.display_alias', 'displayAlias')
      .addSelect('COUNT(DISTINCT r.reporter_identity_id)', 'distinctReporters')
      .addSelect('COUNT(DISTINCT r.post_id)', 'reportedPosts')
      .where('r.deleted_at IS NULL')
      .andWhere('r.created_at >= :since', { since })
      .andWhere('p.deleted_at IS NULL')
      .groupBy('p.author_identity_id')
      .addGroupBy('i.display_alias')
      .orderBy('"distinctReporters"', 'DESC')
      .addOrderBy('"reportedPosts"', 'DESC')
      .limit(take)
      .getRawMany<{
        authorIdentityId: string;
        displayAlias: string;
        distinctReporters: string;
        reportedPosts: string;
      }>();

    return rows.map((r) => ({
      authorIdentityId: r.authorIdentityId,
      displayAlias: r.displayAlias,
      distinctReporters: Number(r.distinctReporters),
      reportedPosts: Number(r.reportedPosts),
    }));
  }

  // ---------------------------------------------------------------------------
  // topActionedAuthors — staff-action heat by removed / shadowed post counts
  // ---------------------------------------------------------------------------

  /**
   * Authors ranked by how many of THEIR posts staff have acted on — grouped by
   * the post's terminal `moderation_state`. `removedCount` = posts in `removed`,
   * `shadowedCount` = posts in `shadow`. Joins `citizen_post` →
   * `citizen_identities` (alias only). Posts filtered not-deleted and windowed
   * by the post `created_at` (the window bounds which authoring cohort is
   * surfaced). Ranked by removed-first then shadowed.
   */
  async topActionedAuthors(
    windowDays?: number,
    limit?: number,
  ): Promise<CitizenTopActionedAuthor[]> {
    const since = this.sinceOf(this.clampWindow(windowDays));
    const take = this.clampLimit(limit);

    const rows = await this.postRepo
      .createQueryBuilder('p')
      // Alias ONLY — no PII column is ever selected.
      .innerJoin('citizen_identities', 'i', 'i.id = p.author_identity_id')
      .select('p.author_identity_id', 'authorIdentityId')
      .addSelect('i.display_alias', 'displayAlias')
      .addSelect(
        "COUNT(*) FILTER (WHERE p.moderation_state = 'removed')",
        'removedCount',
      )
      .addSelect(
        "COUNT(*) FILTER (WHERE p.moderation_state = 'shadow')",
        'shadowedCount',
      )
      .where('p.deleted_at IS NULL')
      .andWhere("p.moderation_state IN ('removed', 'shadow')")
      .andWhere('p.created_at >= :since', { since })
      .groupBy('p.author_identity_id')
      .addGroupBy('i.display_alias')
      .orderBy('"removedCount"', 'DESC')
      .addOrderBy('"shadowedCount"', 'DESC')
      .limit(take)
      .getRawMany<{
        authorIdentityId: string;
        displayAlias: string;
        removedCount: string;
        shadowedCount: string;
      }>();

    return rows.map((r) => ({
      authorIdentityId: r.authorIdentityId,
      displayAlias: r.displayAlias,
      removedCount: Number(r.removedCount),
      shadowedCount: Number(r.shadowedCount),
    }));
  }

  // ---------------------------------------------------------------------------
  // recentActions — staff-action timeline (alias-only)
  // ---------------------------------------------------------------------------

  /**
   * The most recent STAFF moderation actions (the append-only
   * `citizen_moderation_log`, newest first). The `'report'` action is EXCLUDED
   * so the timeline focuses on staff / system actions (hide / remove / restore /
   * suspend_author / reinstate_author / appeal_uphold) — citizen reports are the
   * raw input surfaced in the queue, not the moderation history. The post
   * AUTHOR's alias is resolved via `citizen_post` → `citizen_identities`; the
   * log's `reporter_identity_id` is NEVER projected (§17.3 / PDPA). `reason` is
   * staff-authored / system text and passes through verbatim. Account-level
   * actions (`suspend_author` / `reinstate_author`) have a null `post_id` →
   * null `authorAlias` (no post to resolve).
   */
  async recentActions(limit?: number): Promise<CitizenRecentAction[]> {
    const take = this.clampRecent(limit);

    const rows = await this.logRepo
      .createQueryBuilder('m')
      // LEFT join the post + author so account-level rows (post_id NULL) survive;
      // alias ONLY — no PII column is ever selected.
      .leftJoin('citizen_post', 'p', 'p.id = m.post_id')
      .leftJoin('citizen_identities', 'i', 'i.id = p.author_identity_id')
      .select('m.action', 'action')
      .addSelect('m.actor_role', 'actorRole')
      .addSelect('m.post_id', 'postId')
      .addSelect('m.reason', 'reason')
      .addSelect('m.created_at', 'createdAt')
      .addSelect('i.display_alias', 'authorAlias')
      .where('m.action <> :report', { report: 'report' })
      .orderBy('m.created_at', 'DESC')
      .limit(take)
      .getRawMany<{
        action: string;
        actorRole: string | null;
        postId: string | null;
        reason: string | null;
        createdAt: Date;
        authorAlias: string | null;
      }>();

    return rows.map((r) => ({
      action: r.action,
      actorRole: r.actorRole ?? null,
      postId: r.postId ?? null,
      authorAlias: r.authorAlias ?? null,
      reason: r.reason ?? null,
      createdAt: r.createdAt,
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

  /** Clamp a top-N author limit to [1, 50], default 10. */
  private clampLimit(limit?: number): number {
    if (limit === undefined || limit === null || Number.isNaN(limit)) {
      return DEFAULT_TOP_LIMIT;
    }
    return this.clamp(limit, 1, MAX_TOP_LIMIT);
  }

  /** Clamp the recent-actions limit to [1, 100], default 20. */
  private clampRecent(limit?: number): number {
    if (limit === undefined || limit === null || Number.isNaN(limit)) {
      return DEFAULT_RECENT_LIMIT;
    }
    return this.clamp(limit, 1, MAX_RECENT_LIMIT);
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
}
