import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull, Repository } from 'typeorm';

import { CitizenAppeal } from '../entities/citizen-appeal.entity';
import { CitizenAuditLog } from '../entities/citizen-audit-log.entity';
import { CitizenModerationLog } from '../entities/citizen-moderation-log.entity';
import { CitizenPost } from '../entities/citizen-post.entity';
import { CitizenReport } from '../entities/citizen-report.entity';

/** A post in a NON-visible moderation state can be appealed. */
const APPEALABLE_STATES = ['hidden', 'removed', 'shadow'];

export interface AppealResult {
  appealId: string;
  status: string;
}

export interface AppealQueueItem {
  appealId: string;
  reason: string;
  createdAt: string;
  appellant: { displayAlias: string };
  post: {
    postId: string;
    title: string | null;
    detail: string | null;
    moderationState: string;
  };
}

/**
 * The resolving STAFF member, resolved at the controller from the JWT context
 * (NEVER the request body). `workHistoryId` + `displayName` are PLAIN values
 * snapshotted into `citizen_appeal` — NO FK into users / work_history (§17.3),
 * mirroring C4 `OfficialResponder`.
 */
export interface AppealResolver {
  workHistoryId: string;
  role: string;
  displayName: string;
}

/**
 * CitizenAppealService — W-T3 moderation v2 (appeals).
 *
 * CITIZEN side: `appeal` lets the post OWNER appeal a hidden / removed / shadowed
 * post ONCE. STAFF side (gated upstream by JwtAuthGuard + the `moderate` grant —
 * §4.1 staff authority, NOT ownership): `queue` lists open appeals newest-first;
 * `resolve` either REVERSES (restores the post + resolves its reports) or UPHOLDS
 * (keeps it removed). Every resolution snapshots the resolver name (§17.3 — plain
 * string, no FK), writes a `citizen_moderation_log` row, and an audit row.
 *
 * §17.3 isolation: touches ONLY `citizen_*` tables; NO `tracking_status` write.
 * §17.2 advisory — an appeal changes a post's display state only.
 */
@Injectable()
export class CitizenAppealService {
  constructor(
    @InjectRepository(CitizenAppeal)
    private readonly appealRepo: Repository<CitizenAppeal>,
    @InjectRepository(CitizenPost)
    private readonly postRepo: Repository<CitizenPost>,
    private readonly dataSource: DataSource,
  ) {}

  // ---------------------------------------------------------------------------
  // CITIZEN — submit appeal (owner-only)
  // ---------------------------------------------------------------------------

  /**
   * File an appeal on the caller's OWN non-visible post. Owner-only
   * (`post.authorIdentityId === identityId`, §4 ownership); the post MUST be in
   * a non-visible moderation state (`hidden` / `removed` / `shadow`); at most
   * one OPEN appeal per (post, appellant).
   *   - 404 when the post is missing / soft-deleted
   *   - 403 CITIZEN_APPEAL_NOT_OWNER when the caller is not the author
   *   - 400 CITIZEN_APPEAL_POST_NOT_APPEALABLE when the post is still visible
   *   - 409 CITIZEN_APPEAL_ALREADY_OPEN when an open appeal already exists
   */
  async appeal(
    identityId: string,
    postId: string,
    reason: string,
  ): Promise<AppealResult> {
    return this.dataSource.transaction(async (em) => {
      const post = await em.getRepository(CitizenPost).findOne({
        where: { id: postId, deletedAt: IsNull() },
      });
      if (!post) {
        throw new NotFoundException('CITIZEN_POST_NOT_FOUND');
      }
      // Ownership (§4): only the author of the post may appeal it.
      if (post.authorIdentityId !== identityId) {
        throw new ForbiddenException('CITIZEN_APPEAL_NOT_OWNER');
      }
      // Only a post that staff (or the auto-hide) took DOWN can be appealed —
      // a still-visible post has nothing to appeal.
      if (!APPEALABLE_STATES.includes(post.moderationState)) {
        throw new BadRequestException('CITIZEN_APPEAL_POST_NOT_APPEALABLE');
      }

      const appealRepo = em.getRepository(CitizenAppeal);
      const existing = await appealRepo.findOne({
        where: {
          postId,
          appellantIdentityId: identityId,
          status: 'open',
          deletedAt: IsNull(),
        },
      });
      if (existing) {
        throw new ConflictException('CITIZEN_APPEAL_ALREADY_OPEN');
      }

      const appeal = appealRepo.create({
        postId,
        appellantIdentityId: identityId,
        reason,
        status: 'open',
        resolverWorkHistoryId: null,
        resolverName: null,
        resolvedAt: null,
      });
      const saved = await appealRepo.save(appeal);

      await this.writeAudit(em, 'citizen', identityId, 'appeal.create', 'appeal', saved.id, {
        postId,
      });

      return { appealId: saved.id, status: saved.status };
    });
  }

  // ---------------------------------------------------------------------------
  // STAFF — queue + resolve (moderate-grant gated upstream)
  // ---------------------------------------------------------------------------

  /** Open appeals, newest-first, with alias-only appellant + the post snapshot. */
  async queue(limit = 100): Promise<AppealQueueItem[]> {
    const appeals = await this.appealRepo
      .createQueryBuilder('a')
      // §17.3 / PDPA: load ONLY the appellant's id + public alias — never the
      // *_enc / *_hash PII columns (the queue exposes displayAlias only).
      .leftJoin('a.appellant', 'appellant')
      .addSelect(['appellant.id', 'appellant.displayAlias'])
      .where('a.status = :s', { s: 'open' })
      .andWhere('a.deletedAt IS NULL')
      .orderBy('a.createdAt', 'DESC')
      .limit(Math.min(limit, 200))
      .getMany();

    if (appeals.length === 0) {
      return [];
    }

    const postIds = [...new Set(appeals.map((a) => a.postId))];
    const posts = await this.postRepo
      .createQueryBuilder('p')
      .where('p.id IN (:...postIds)', { postIds })
      .getMany();
    const postById = new Map(posts.map((p) => [p.id, p]));

    return appeals
      .map((a) => {
        const post = postById.get(a.postId);
        if (!post) return null;
        return {
          appealId: a.id,
          reason: a.reason,
          createdAt: (a.createdAt ?? new Date()).toISOString(),
          appellant: { displayAlias: a.appellant?.displayAlias ?? '' },
          post: {
            postId: post.id,
            title: post.title,
            detail: post.detail,
            moderationState: post.moderationState,
          },
        };
      })
      .filter((x): x is AppealQueueItem => x !== null);
  }

  /**
   * Resolve an open appeal (staff). `reversed` → restore the post (set
   * `moderation_state='visible'`, soft-delete its live reports for a clean
   * re-report slate — mirrors the C5 `moderate('restore')` cleanup) AND mark the
   * appeal `reversed`; `upheld` → mark the appeal `upheld` (the post stays
   * removed). Both snapshot the resolver name and write a moderation_log + audit
   * row. 404 when the appeal is missing / not open.
   */
  async resolve(
    resolver: AppealResolver,
    appealId: string,
    decision: 'reversed' | 'upheld',
  ): Promise<AppealResult> {
    if (decision !== 'reversed' && decision !== 'upheld') {
      throw new BadRequestException('CITIZEN_APPEAL_DECISION_INVALID');
    }
    return this.dataSource.transaction(async (em) => {
      const appealRepo = em.getRepository(CitizenAppeal);
      const appeal = await appealRepo.findOne({
        where: { id: appealId, status: 'open', deletedAt: IsNull() },
      });
      if (!appeal) {
        throw new NotFoundException('CITIZEN_APPEAL_NOT_FOUND');
      }

      const now = new Date();

      if (decision === 'reversed') {
        const postRepo = em.getRepository(CitizenPost);
        // Targeted column update — never a full-entity save() (which would write
        // back a stale heart_count/comment_count snapshot under concurrency).
        await postRepo.update(
          { id: appeal.postId },
          { moderationState: 'visible' },
        );
        // Clean slate — SOFT-DELETE every live report so the post can be
        // re-reported + re-auto-hidden in a fresh cycle (mirrors C5 restore).
        await em.getRepository(CitizenReport).softDelete({ postId: appeal.postId });
      }

      await appealRepo.update(
        { id: appealId },
        {
          status: decision,
          resolverWorkHistoryId: resolver.workHistoryId,
          resolverName: resolver.displayName,
          resolvedAt: now,
        },
      );

      // Moderation-log the restore (reverse) action; uphold is a no-op on the
      // post so it logs as an appeal_uphold marker.
      await this.writeModerationLog(em, {
        postId: appeal.postId,
        actorWorkHistoryId: resolver.workHistoryId,
        actorRole: resolver.role,
        action: decision === 'reversed' ? 'restore' : 'appeal_uphold',
        reason: `appeal ${decision}`,
      });
      await this.writeAudit(
        em,
        'internal',
        resolver.workHistoryId,
        `appeal.${decision}`,
        'appeal',
        appealId,
        { postId: appeal.postId, decision },
      );

      return { appealId, status: decision };
    });
  }

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  private async writeModerationLog(
    em: EntityManager,
    row: {
      postId: string;
      actorWorkHistoryId: string | null;
      actorRole: string | null;
      action: string;
      reason: string | null;
    },
  ): Promise<void> {
    const log = em.getRepository(CitizenModerationLog).create({
      postId: row.postId,
      commentId: null,
      reporterIdentityId: null,
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
