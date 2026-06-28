import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull, Repository } from 'typeorm';

import { CitizenAuditLog } from '../entities/citizen-audit-log.entity';
import { CitizenIdentity } from '../entities/citizen-identity.entity';
import { CitizenModerationLog } from '../entities/citizen-moderation-log.entity';
import { CitizenPost } from '../entities/citizen-post.entity';
import { CitizenReport } from '../entities/citizen-report.entity';

/** Distinct-reporter count at which a still-`visible` post auto-moves to `shadow`. */
export const AUTO_HIDE_THRESHOLD = 3;

/**
 * W-T3 offender ladder: distinct removed posts by one author at which the author
 * is auto-`suspended` (writes blocked) until a staff reinstate lifts it.
 */
export const OFFENDER_REMOVAL_THRESHOLD = 3;

export interface ReportResult {
  reported: boolean;
  autoHidden: boolean;
}

export interface ModerationQueueItem {
  postId: string;
  title: string | null;
  detail: string | null;
  moderationState: string;
  author: { displayAlias: string };
  reportCount: number;
  latestReportAt: string;
}

/** Staff action on a reported post. `restore` returns it to the public feed. */
export type ModerationAction = 'hide' | 'remove' | 'restore';

const ACTION_TO_STATE: Record<ModerationAction, string> = {
  hide: 'hidden',
  remove: 'removed',
  restore: 'visible',
};

/**
 * CitizenModerationService — moderation-at-scale (C5, plan D13).
 *
 * CITIZEN side: `reportPost` records a de-duplicated report; once
 * AUTO_HIDE_THRESHOLD distinct citizens report a still-`visible` post it is
 * auto-moved to `shadow` (hidden from the public feed, awaiting staff review).
 *
 * STAFF side (gated upstream by JwtAuthGuard + the `moderate` grant): `queue`
 * lists posts with open reports; `moderate` hides / removes / restores a post
 * and resolves its open reports.
 *
 * §17.3 isolation: touches ONLY `citizen_*` tables. Citizen reports audit with
 * `actorKind='citizen'`; staff actions with `actorKind='internal'`. The
 * moderation ACTION trail lives in `citizen_moderation_log`. NO `tracking_status`
 * write; the board is ADVISORY (§17.2).
 */
@Injectable()
export class CitizenModerationService {
  constructor(
    @InjectRepository(CitizenReport)
    private readonly reportRepo: Repository<CitizenReport>,
    @InjectRepository(CitizenPost)
    private readonly postRepo: Repository<CitizenPost>,
    @InjectRepository(CitizenIdentity)
    private readonly identityRepo: Repository<CitizenIdentity>,
    private readonly dataSource: DataSource,
  ) {}

  // ---------------------------------------------------------------------------
  // CITIZEN — report
  // ---------------------------------------------------------------------------

  /**
   * Record a de-duplicated citizen report. One live report per (post, reporter)
   * — a repeat is a no-op (orIgnore). When the DISTINCT-reporter count reaches
   * AUTO_HIDE_THRESHOLD and the post is still `visible`, it auto-moves to
   * `shadow`. 404 when the post is missing / already removed.
   */
  async reportPost(
    reporterIdentityId: string,
    postId: string,
    reason: string | null,
  ): Promise<ReportResult> {
    return this.dataSource.transaction(async (em) => {
      const postRepo = em.getRepository(CitizenPost);
      const post = await postRepo.findOne({
        where: { id: postId, deletedAt: IsNull() },
      });
      // Can only report a live post that the public could see / could have
      // seen — `removed` is a terminal staff state.
      if (!post || post.moderationState === 'removed') {
        throw new NotFoundException('CITIZEN_POST_NOT_FOUND');
      }

      const reportRepo = em.getRepository(CitizenReport);
      // Race-safe de-dup: ON CONFLICT DO NOTHING against the partial-unique
      // `(post_id, reporter_identity_id) WHERE deleted_at IS NULL`. The
      // RETURNING rows tell us whether a NEW report was actually created.
      const insertResult = await reportRepo
        .createQueryBuilder()
        .insert()
        .values({ postId, reporterIdentityId, reason: reason ?? null, status: 'open' })
        .orIgnore()
        .execute();
      const created = Array.isArray(insertResult.raw) && insertResult.raw.length > 0;
      if (!created) {
        // The same citizen already has a live report on this post — idempotent
        // no-op: no log/audit spam, no threshold re-evaluation (count unchanged).
        return { reported: true, autoHidden: false };
      }

      // Append-only moderation log for the report event.
      await this.writeModerationLog(em, {
        postId,
        reporterIdentityId,
        actorWorkHistoryId: null,
        actorRole: null,
        action: 'report',
        reason: reason ?? null,
      });
      await this.writeAudit(em, 'citizen', reporterIdentityId, 'report.create', 'post', postId, {
        postId,
      });

      // Distinct live reporters drive the threshold.
      const reportCount = await reportRepo.count({
        where: { postId, status: 'open', deletedAt: IsNull() },
      });

      let autoHidden = false;
      if (reportCount >= AUTO_HIDE_THRESHOLD) {
        // Race-safe conditional flip: ONLY a still-`visible` post is auto-shadowed,
        // evaluated against the COMMITTED row — never a stale read-modify-write
        // `save()` that could resurrect a concurrently staff-removed/-hidden post.
        const res = await postRepo
          .createQueryBuilder()
          .update()
          .set({ moderationState: 'shadow' })
          .where('id = :id AND moderation_state = :visible', { id: postId, visible: 'visible' })
          .execute();
        if ((res.affected ?? 0) > 0) {
          autoHidden = true;
          await this.writeModerationLog(em, {
            postId,
            reporterIdentityId: null,
            actorWorkHistoryId: null,
            actorRole: 'system',
            action: 'hide',
            reason: `auto-hide: ${reportCount} reports`,
          });
          await this.writeAudit(em, 'citizen', reporterIdentityId, 'post.auto_shadow', 'post', postId, {
            postId,
            reportCount,
          });
        }
      }

      return { reported: true, autoHidden };
    });
  }

  // ---------------------------------------------------------------------------
  // STAFF — queue + action (moderate-grant gated upstream)
  // ---------------------------------------------------------------------------

  /** Posts with open reports, most-reported first, for the staff review queue. */
  async queue(limit = 100): Promise<ModerationQueueItem[]> {
    const grouped = await this.reportRepo
      .createQueryBuilder('r')
      .select('r.postId', 'postId')
      .addSelect('COUNT(*)', 'cnt')
      .addSelect('MAX(r.createdAt)', 'latest')
      .where('r.status = :s', { s: 'open' })
      .andWhere('r.deletedAt IS NULL')
      .groupBy('r.postId')
      .orderBy('cnt', 'DESC')
      .addOrderBy('latest', 'DESC')
      .limit(Math.min(limit, 200))
      .getRawMany<{ postId: string; cnt: string; latest: Date }>();

    if (grouped.length === 0) {
      return [];
    }

    const postIds = grouped.map((g) => g.postId);
    // §17.3 / PDPA: load ONLY the author's id + public alias — never the
    // *_enc / *_hash PII columns (the queue exposes displayAlias only).
    const posts = await this.postRepo
      .createQueryBuilder('p')
      .leftJoin('p.author', 'author')
      .addSelect(['author.id', 'author.displayAlias'])
      .where('p.id IN (:...postIds)', { postIds })
      .andWhere('p.deletedAt IS NULL')
      .getMany();
    const postById = new Map(posts.map((p) => [p.id, p]));

    return grouped
      .map((g) => {
        const post = postById.get(g.postId);
        if (!post) return null;
        return {
          postId: post.id,
          title: post.title,
          detail: post.detail,
          moderationState: post.moderationState,
          author: { displayAlias: post.author?.displayAlias ?? '' },
          reportCount: Number(g.cnt),
          latestReportAt: new Date(g.latest).toISOString(),
        };
      })
      .filter((x): x is ModerationQueueItem => x !== null);
  }

  /**
   * Apply a staff moderation action. `hide`/`remove` resolve the post's open
   * reports as `actioned`; `restore` returns it to `visible` and `dismisses`
   * the open reports.
   */
  async moderate(
    actorWorkHistoryId: string,
    actorRole: string,
    postId: string,
    action: ModerationAction,
  ): Promise<{ moderationState: string }> {
    if (!ACTION_TO_STATE[action]) {
      throw new BadRequestException('CITIZEN_MODERATION_ACTION_INVALID');
    }
    return this.dataSource.transaction(async (em) => {
      const postRepo = em.getRepository(CitizenPost);
      const post = await postRepo.findOne({
        where: { id: postId, deletedAt: IsNull() },
      });
      if (!post) {
        throw new NotFoundException('CITIZEN_POST_NOT_FOUND');
      }

      const newState = ACTION_TO_STATE[action];
      // Targeted column update — never a full-entity `save()` (which would write
      // back a stale heart_count/comment_count snapshot under concurrency).
      await postRepo.update({ id: postId }, { moderationState: newState });

      const reportRepo = em.getRepository(CitizenReport);
      if (action === 'restore') {
        // Clean slate — SOFT-DELETE every live report so the post can be
        // re-reported + re-auto-hidden in a fresh cycle. The partial-unique
        // `… WHERE deleted_at IS NULL` then no longer blocks a prior reporter.
        await reportRepo.softDelete({ postId });
      } else {
        // hide / remove — mark open reports `actioned` (resolved, kept for audit).
        await reportRepo.update(
          { postId, status: 'open', deletedAt: IsNull() },
          { status: 'actioned' },
        );
      }

      await this.writeModerationLog(em, {
        postId,
        reporterIdentityId: null,
        actorWorkHistoryId,
        actorRole,
        action,
        reason: null,
      });
      await this.writeAudit(em, 'internal', actorWorkHistoryId, `moderate.${action}`, 'post', postId, {
        postId,
        moderationState: newState,
      });

      // W-T3 offender ladder: after a REMOVE flips, count this author's distinct
      // removed posts; at OFFENDER_REMOVAL_THRESHOLD auto-suspend the author
      // (writes blocked until a staff reinstate). Same tx — never tracking_status.
      if (action === 'remove') {
        await this.maybeSuspendAuthor(em, post.authorIdentityId, actorWorkHistoryId, actorRole);
      }

      return { moderationState: newState };
    });
  }

  /**
   * W-T3 offender ladder. Count the author's distinct `removed` (non-deleted)
   * posts; at OFFENDER_REMOVAL_THRESHOLD set `citizen_identities.status =
   * 'suspended'` (blocks WRITES via CitizenJwtGuard → 403 CITIZEN_SUSPENDED) and
   * write a moderation_log + audit row. Idempotent: a conditional update keyed on
   * `status = 'active'` means a re-removal on an already-suspended author is a
   * no-op (no duplicate log/audit). A reversal/appeal that restores a post does
   * NOT auto-un-suspend in v1 — staff lift it via `reinstate`.
   */
  private async maybeSuspendAuthor(
    em: EntityManager,
    authorIdentityId: string,
    actorWorkHistoryId: string,
    actorRole: string,
  ): Promise<void> {
    const removedCount = await em.getRepository(CitizenPost).count({
      where: {
        authorIdentityId,
        moderationState: 'removed',
        deletedAt: IsNull(),
      },
    });
    if (removedCount < OFFENDER_REMOVAL_THRESHOLD) {
      return;
    }

    // Race-safe conditional flip: ONLY an `active` author moves to `suspended`,
    // so a concurrent / repeat removal does not re-log against an author already
    // suspended (or one that is blocked/deleted — those terminal states win).
    const res = await em
      .getRepository(CitizenIdentity)
      .createQueryBuilder()
      .update()
      .set({ status: 'suspended' })
      .where('id = :id AND status = :active', { id: authorIdentityId, active: 'active' })
      .execute();
    if ((res.affected ?? 0) === 0) {
      return;
    }

    await this.writeModerationLog(em, {
      postId: null,
      reporterIdentityId: null,
      actorWorkHistoryId,
      actorRole,
      action: 'suspend_author',
      reason: `auto-suspend: ${removedCount} removed posts`,
    });
    await this.writeAudit(em, 'internal', actorWorkHistoryId, 'identity.suspend', 'identity', authorIdentityId, {
      removedCount,
    });
  }

  /**
   * W-T3 staff lift: reinstate a suspended author back to `active` (re-enables
   * writes). Staff-gated upstream by the `moderate` grant. Idempotent — a
   * conditional flip keyed on `status = 'suspended'` no-ops (and skips the audit)
   * when the identity is missing / not suspended. 404 when the identity does not
   * exist at all.
   */
  async reinstate(
    actorWorkHistoryId: string,
    actorRole: string,
    identityId: string,
  ): Promise<{ status: string }> {
    return this.dataSource.transaction(async (em) => {
      const identityRepo = em.getRepository(CitizenIdentity);
      const identity = await identityRepo.findOne({
        where: { id: identityId, deletedAt: IsNull() },
      });
      if (!identity) {
        throw new NotFoundException('CITIZEN_IDENTITY_NOT_FOUND');
      }
      if (identity.status !== 'suspended') {
        // Not suspended → nothing to lift (idempotent). Return current status.
        return { status: identity.status };
      }

      await identityRepo.update({ id: identityId }, { status: 'active' });

      await this.writeModerationLog(em, {
        postId: null,
        reporterIdentityId: null,
        actorWorkHistoryId,
        actorRole,
        action: 'reinstate_author',
        reason: null,
      });
      await this.writeAudit(em, 'internal', actorWorkHistoryId, 'identity.reinstate', 'identity', identityId, {});

      return { status: 'active' };
    });
  }

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  private async writeModerationLog(
    em: EntityManager,
    row: {
      postId: string | null;
      reporterIdentityId: string | null;
      actorWorkHistoryId: string | null;
      actorRole: string | null;
      action: string;
      reason: string | null;
    },
  ): Promise<void> {
    const log = em.getRepository(CitizenModerationLog).create({
      postId: row.postId,
      commentId: null,
      reporterIdentityId: row.reporterIdentityId,
      actorWorkHistoryId: row.actorWorkHistoryId,
      actorRole: row.actorRole,
      action: row.action,
      reason: row.reason,
    });
    await em.getRepository(CitizenModerationLog).save(log);
  }

  private async writeAudit(
    em: EntityManager,
    actorKind: 'citizen' | 'internal',
    actorId: string,
    action: string,
    targetKind: string,
    targetId: string | null,
    detail: Record<string, unknown>,
  ): Promise<void> {
    const row = em.getRepository(CitizenAuditLog).create({
      actorKind,
      actorId,
      action,
      targetKind,
      targetId,
      detail,
    });
    await em.getRepository(CitizenAuditLog).save(row);
  }
}
