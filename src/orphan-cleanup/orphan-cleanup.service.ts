import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull, Repository } from 'typeorm';

import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';
import { SupplementProjectGroup } from 'src/supplement-project-group/entities/supplement-project-group.entity';
import { EquipmentProjectGroup } from 'src/equipment-project-group/entities/equipment-project-group.entity';
import { TrackingStatus } from 'src/tracking-status/entities/tracking-status.entity';
import { Status } from 'src/status/entities/status.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { DevelopmentPlanRevision } from 'src/development-plan-revision/entities/development-plan-revision.entity';
import { DevelopmentPlanSupplement } from 'src/development-plan-supplement/entities/development-plan-supplement.entity';

import { LineageLockService } from 'src/common/lineage-lock/lineage-lock.service';
import { PrevProjectType } from 'src/revised-project-group/dto/create-revised-project-group.dto';
import { STATUS_NAMES } from 'src/common/status-names';
import {
  BOOK_TYPE_LABELS,
  ORPHAN_CLEANUP_REASONS,
  OrphanCleanupBookKind,
  resolveFinalizeReasonKind,
} from './constants/orphan-cleanup-reasons';

/**
 * Canonical conflict error code thrown when a candidate RPG / SPG has a
 * non-soft-deleted descendant outside the cleanup batch (CLAUDE.md §18.8 +
 * §14.3). FE-01 detects this exact code to render the lineage-conflict
 * modal.
 *
 * The string is FROZEN — DOC-01 §18 / workflow-orphan-cleanup.md /
 * W110-BE-01 are aligned on `ORPHAN_CASCADE_HAS_LIVE_DESCENDANT` (the
 * earlier `_BATCH_` drift was resolved before this batch).
 */
export const ORPHAN_CASCADE_HAS_LIVE_DESCENDANT =
  'ORPHAN_CASCADE_HAS_LIVE_DESCENDANT';

/** Pending notification queued by the cascade for post-commit dispatch. */
interface PendingPgResetNotification {
  projectId: string;
  projectTitle: string;
  ownerWorkHistoryId: string | null;
  bookName: string;
  staffRemark: string;
}

const FINALIZE_NON_TARGET_STATUSES: ReadonlySet<string> = new Set<string>([
  STATUS_NAMES.READY,
  STATUS_NAMES.APPROVED,
  // Rejected is the W67 8th canonical status — workflow exit state
  // ("เกินศักยภาพ"). It is now registered in STATUS_NAMES (W67 catch-up);
  // the literal-string fallback used in earlier waves has been removed.
  STATUS_NAMES.REJECTED,
]);

/**
 * W110-BE-01 — OrphanCleanupService
 *
 * Implements the auto-cascade rules of CLAUDE.md §18 + the operational
 * walkthrough in `docs/workflow-orphan-cleanup.md`.
 *
 * Two cascade entry points (cancel + finalize) participate in the host
 * book operation's transaction by accepting an `EntityManager`. They MUST
 * NOT begin or commit a transaction on their own — the host owns the
 * transactional boundary so the cascade and the book mutation commit (or
 * roll back) together.
 *
 * The preview endpoint is read-only and runs OUTSIDE any transaction; FE-01
 * uses it advisorily (preview drift is documented and tolerated per §18 +
 * the workflow doc Edge Cases).
 *
 * Notifications are buffered inside the cascade and surfaced to the caller
 * via `pendingNotifications`; the host invokes `dispatchPendingNotifications`
 * AFTER its transaction commits so a notification failure can never roll
 * back the cascade (§18.7 + §17.2 advisory rule).
 */
@Injectable()
export class OrphanCleanupService {
  private readonly logger = new Logger(OrphanCleanupService.name);

  /**
   * Buffer for post-commit notifications keyed per cascade invocation.
   * The buffer is appended inside the cascade and drained by the host
   * via `consumePendingPgNotifications()` after its transaction commits.
   * NestJS provides a singleton service so we use a Map keyed on the
   * book id to keep concurrent cascade invocations isolated.
   */
  private readonly pendingPgNotifications = new Map<
    string,
    PendingPgResetNotification[]
  >();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(ProjectGroup)
    private readonly projectGroupRepo: Repository<ProjectGroup>,
    @InjectRepository(RevisedProjectGroup)
    private readonly revisedProjectGroupRepo: Repository<RevisedProjectGroup>,
    @InjectRepository(SupplementProjectGroup)
    private readonly supplementProjectGroupRepo: Repository<SupplementProjectGroup>,
    @InjectRepository(EquipmentProjectGroup)
    private readonly equipmentProjectGroupRepo: Repository<EquipmentProjectGroup>,
    @InjectRepository(Status)
    private readonly statusRepo: Repository<Status>,
    @InjectRepository(TrackingStatus)
    private readonly trackingStatusRepo: Repository<TrackingStatus>,
    private readonly lineageLockService: LineageLockService,
  ) {}

  // ===================================================================
  // Public API — Cascade entry points
  // ===================================================================

  /**
   * Event 1 — Cancel book. Invoked from the host softRemove (DPR / Plan /
   * Supplement) inside its transaction. Resets every PG / RPG / SPG bound
   * to the cancelled book to a sensible state, regardless of latest
   * status.
   */
  async cascadeOnBookCancel(
    book: DevelopmentPlan | DevelopmentPlanRevision | DevelopmentPlanSupplement,
    bookKind: OrphanCleanupBookKind,
    em: EntityManager,
    actorUserId: string,
  ): Promise<{ pgCount: number; rpgCount: number; equipmentCount: number }> {
    const bookName = this.resolveBookName(book, bookKind);
    const reasonText = ORPHAN_CLEANUP_REASONS.BOOK_CANCELLED(
      BOOK_TYPE_LABELS[bookKind],
      bookName,
    );

    const actorWorkHistory = await this.resolveActorWorkHistory(em, actorUserId);
    const readyStatusId = await this.resolveStatusId(em, STATUS_NAMES.READY);

    let pgCount = 0;
    let rpgCount = 0;
    let equipmentCount = 0;

    if (bookKind === 'PLAN') {
      pgCount = await this.bulkResetProjectGroups({
        em,
        bookId: book.id,
        bookName,
        actorWorkHistoryId: actorWorkHistory.id,
        readyStatusId,
        reasonText,
        // Event 1 — every non-soft-deleted PG is in scope.
        statusFilter: 'all',
      });

      // Wave Equipment ผ.03 Phase 2 — BE-05.
      // Equipment items live under MAIN_PLAN only (per Q2). Mirror the PG
      // Phase A bulk-reset exactly: same scope, same reason, same audit
      // shape. Lineage is vacuous (no prev_project_id columns per DB-02
      // R3=NO), so no topological sort / lineage guard is needed.
      equipmentCount = await this.bulkResetEquipmentProjectGroups({
        em,
        bookId: book.id,
        bookName,
        actorWorkHistoryId: actorWorkHistory.id,
        readyStatusId,
        reasonText,
        statusFilter: 'all',
      });
    }

    if (bookKind === 'REVISION') {
      rpgCount = await this.bulkSoftDeleteRevisedProjectGroups({
        em,
        bookId: book.id,
        actorWorkHistoryId: actorWorkHistory.id,
        reasonText,
        statusFilter: 'all',
      });
    }

    if (bookKind === 'SUPPLEMENT') {
      // §18 specifies "RPG" for supplement scope but RevisedProjectGroup
      // does not link to DevelopmentPlanSupplement. The only project
      // entity bound to a supplement is `SupplementProjectGroup`. We
      // apply the RPG-equivalent procedure (lineage-lock guard is a
      // no-op here because SPG never has descendants) and write a
      // tombstone TrackingStatus row before flipping `deletedAt`.
      rpgCount = await this.bulkSoftDeleteSupplementProjectGroups({
        em,
        bookId: book.id,
        actorWorkHistoryId: actorWorkHistory.id,
        reasonText,
        statusFilter: 'all',
      });
    }

    this.logger.log(
      `[OrphanCleanup] cascadeOnBookCancel kind=${bookKind} book=${book.id} pg=${pgCount} rpg=${rpgCount} equipment=${equipmentCount}`,
    );

    return { pgCount, rpgCount, equipmentCount };
  }

  /**
   * Event 2 — Finalize book. Invoked BEFORE the host writes
   * `isBooked = true`. Resets only non-terminal projects so that already
   * Approved / Rejected rows survive untouched.
   */
  async cascadeOnBookFinalize(
    book: DevelopmentPlan | DevelopmentPlanRevision | DevelopmentPlanSupplement,
    bookKind: OrphanCleanupBookKind,
    em: EntityManager,
    actorUserId: string,
  ): Promise<{ pgCount: number; rpgCount: number; equipmentCount: number }> {
    const bookName = this.resolveBookName(book, bookKind);
    const actorWorkHistory = await this.resolveActorWorkHistory(em, actorUserId);
    const readyStatusId = await this.resolveStatusId(em, STATUS_NAMES.READY);

    let pgCount = 0;
    let rpgCount = 0;
    let equipmentCount = 0;

    if (bookKind === 'PLAN') {
      pgCount = await this.bulkResetProjectGroups({
        em,
        bookId: book.id,
        bookName,
        actorWorkHistoryId: actorWorkHistory.id,
        readyStatusId,
        // For finalize, the reason text is per-row (status-driven). The
        // bulk helper resolves it from the prior status name.
        reasonText: null,
        statusFilter: 'finalize',
      });

      // Wave Equipment ผ.03 Phase 2 — BE-05.
      // Mirror PG finalize: exclude {Ready, Approved, Rejected}; resolve
      // reason per-row via §18.6.1 mapping.
      equipmentCount = await this.bulkResetEquipmentProjectGroups({
        em,
        bookId: book.id,
        bookName,
        actorWorkHistoryId: actorWorkHistory.id,
        readyStatusId,
        reasonText: null,
        statusFilter: 'finalize',
      });
    }

    if (bookKind === 'REVISION') {
      rpgCount = await this.bulkSoftDeleteRevisedProjectGroups({
        em,
        bookId: book.id,
        actorWorkHistoryId: actorWorkHistory.id,
        reasonText: null,
        bookNameForFinalize: bookName,
        statusFilter: 'finalize',
      });
    }

    if (bookKind === 'SUPPLEMENT') {
      rpgCount = await this.bulkSoftDeleteSupplementProjectGroups({
        em,
        bookId: book.id,
        actorWorkHistoryId: actorWorkHistory.id,
        reasonText: null,
        bookNameForFinalize: bookName,
        statusFilter: 'finalize',
      });
    }

    this.logger.log(
      `[OrphanCleanup] cascadeOnBookFinalize kind=${bookKind} book=${book.id} pg=${pgCount} rpg=${rpgCount} equipment=${equipmentCount}`,
    );

    return { pgCount, rpgCount, equipmentCount };
  }

  /**
   * Read-only preview for FE-01 confirmation modal. Mirrors the cascade
   * scope query exactly so the count is meaningful, but does not lock or
   * mutate any row.
   */
  async previewBookCleanup(
    bookId: string,
    bookKind: OrphanCleanupBookKind,
    kind: 'cancel' | 'finalize',
  ): Promise<{
    pgCount: number;
    rpgCount: number;
    equipmentCount: number;
    pgWithLiveDescendant: 0;
    rpgWithLiveDescendant: number;
  }> {
    let pgCount = 0;
    let rpgCount = 0;
    let equipmentCount = 0;
    let rpgWithLiveDescendant = 0;

    if (bookKind === 'PLAN') {
      const pgIds = await this.materializeCandidatePgIds({
        em: this.dataSource.manager,
        bookId,
        statusFilter: kind === 'cancel' ? 'all' : 'finalize',
      });
      pgCount = pgIds.length;

      // Wave Equipment ผ.03 Phase 2 — BE-05. Equipment is MAIN_PLAN-scoped.
      const equipmentIds = await this.materializeCandidateEquipmentIds({
        em: this.dataSource.manager,
        bookId,
        statusFilter: kind === 'cancel' ? 'all' : 'finalize',
      });
      equipmentCount = equipmentIds.length;
    } else if (bookKind === 'REVISION') {
      const rpgIds = await this.materializeCandidateRpgIds({
        em: this.dataSource.manager,
        bookId,
        statusFilter: kind === 'cancel' ? 'all' : 'finalize',
      });
      rpgCount = rpgIds.length;
      // Best-effort lineage check on the read side — does not throw, just
      // counts how many RPGs have a non-deleted descendant.
      for (const id of rpgIds) {
        const locked =
          await this.lineageLockService.hasNonDeletedDescendant(
            id,
            'revised',
            this.dataSource.manager,
          );
        if (locked) rpgWithLiveDescendant += 1;
      }
    } else if (bookKind === 'SUPPLEMENT') {
      const spgIds = await this.materializeCandidateSpgIds({
        em: this.dataSource.manager,
        bookId,
        statusFilter: kind === 'cancel' ? 'all' : 'finalize',
      });
      rpgCount = spgIds.length;
    }

    return {
      pgCount,
      rpgCount,
      equipmentCount,
      pgWithLiveDescendant: 0,
      rpgWithLiveDescendant,
    };
  }

  /**
   * One-shot legacy backfill. Detects PGs that are `Approved` but no
   * longer belong to a live DevelopmentPlan (the parent plan was already
   * soft-deleted before W110 shipped). Resets them to `Ready` with the
   * frozen `LEGACY_BACKFILL` reason. Idempotent — projects whose latest
   * tracking row is already `Ready` are skipped.
   *
   * Rationale (workflow doc Legacy Migration): pre-W110, cancelling a
   * plan did not propagate to its child PGs. The migration cleans the
   * historical tail without trying to identify the operator who originally
   * cancelled the plan — `createdBy` falls back to the parent plan's
   * `deletedBy` when present, or the plan's `createdBy` otherwise.
   */
  async migrateLegacyOrphans(
    em?: EntityManager,
  ): Promise<{ pgMigrated: number; rpgMigrated: number }> {
    const manager = em ?? this.dataSource.manager;
    const readyStatusId = await this.resolveStatusId(manager, STATUS_NAMES.READY);

    // Detect orphan PGs: deletedAt IS NULL, isBooked=false, latest status
    // = Approved, parent plan deletedAt IS NOT NULL.
    const orphanPgs = await manager
      .createQueryBuilder(ProjectGroup, 'pg')
      .leftJoin('pg.developmentPlan', 'dp')
      .innerJoin(
        TrackingStatus,
        'ts',
        'ts.project_group_id = pg.id AND ts.is_latest = TRUE',
      )
      .innerJoin(Status, 'st', 'st.id = ts.status_id')
      .where('pg.deletedAt IS NULL')
      .andWhere('pg.isBooked = FALSE')
      .andWhere('st.name = :approved', { approved: STATUS_NAMES.APPROVED })
      .andWhere('dp.deleted_at IS NOT NULL')
      .select(['pg.id'])
      .getMany();

    let pgMigrated = 0;
    for (const pg of orphanPgs) {
      const wrote = await this.legacyResetSinglePg(
        manager,
        pg.id,
        readyStatusId,
      );
      if (wrote) pgMigrated += 1;
    }

    // Detect orphan RPGs: deletedAt IS NULL, parent revision.deletedAt IS
    // NOT NULL. We don't filter by status because pre-W110 revision
    // cancellation also did not cascade. Soft-delete with tombstone row.
    const orphanRpgs = await manager
      .createQueryBuilder(RevisedProjectGroup, 'rpg')
      .leftJoin('rpg.developmentPlanRevision', 'dpr')
      .where('rpg.deletedAt IS NULL')
      .andWhere('dpr.deleted_at IS NOT NULL')
      .select(['rpg.id'])
      .getMany();

    let rpgMigrated = 0;
    for (const rpg of orphanRpgs) {
      const wrote = await this.legacyTombstoneSingleRpg(manager, rpg.id);
      if (wrote) rpgMigrated += 1;
    }

    this.logger.log(
      `[OrphanCleanup] migrateLegacyOrphans pg=${pgMigrated} rpg=${rpgMigrated}`,
    );
    return { pgMigrated, rpgMigrated };
  }

  // ===================================================================
  // Notification buffer — host drains AFTER commit
  // ===================================================================

  consumePendingPgNotifications(
    bookId: string,
  ): PendingPgResetNotification[] {
    const buffered = this.pendingPgNotifications.get(bookId) ?? [];
    this.pendingPgNotifications.delete(bookId);
    return buffered;
  }

  // ===================================================================
  // Internals — PG bulk reset (Phase A)
  // ===================================================================

  private async bulkResetProjectGroups(args: {
    em: EntityManager;
    bookId: string;
    bookName: string;
    actorWorkHistoryId: string;
    readyStatusId: string;
    reasonText: string | null; // null → resolve per-row from status (finalize)
    statusFilter: 'all' | 'finalize';
  }): Promise<number> {
    const ids = await this.materializeCandidatePgIds({
      em: args.em,
      bookId: args.bookId,
      statusFilter: args.statusFilter,
    });
    if (ids.length === 0) return 0;

    let resetCount = 0;
    for (const pgId of ids) {
      const wrote = await this.resetSingleProjectGroup({
        em: args.em,
        pgId,
        bookName: args.bookName,
        actorWorkHistoryId: args.actorWorkHistoryId,
        readyStatusId: args.readyStatusId,
        reasonText: args.reasonText,
      });
      if (wrote) resetCount += 1;
    }
    return resetCount;
  }

  private async resetSingleProjectGroup(args: {
    em: EntityManager;
    pgId: string;
    bookName: string;
    actorWorkHistoryId: string;
    readyStatusId: string;
    reasonText: string | null;
  }): Promise<boolean> {
    const { em, pgId, bookName, actorWorkHistoryId, readyStatusId } = args;

    // Pessimistic lock the PG row (CLAUDE.md §18 + workflow doc Phase A).
    // We need the creator WorkHistory's amphoe + LAO context to classify
    // agency vs LAO origin per CLAUDE.md §1.
    //
    // Postgres rejects `FOR UPDATE` against an outer-join'd query with
    //   `FOR UPDATE cannot be applied to the nullable side of an outer join`
    // because the join sides could yield NULL rows. We need the joined
    // context (createdBy + amphoe + LAO + responsibleAgency) for the §1
    // classification + §7 responsibleAgency clearing logic, but the lock
    // should only apply to the PG row itself. The `lockTables: ['pg']`
    // argument produces `FOR UPDATE OF "pg"` which Postgres accepts even
    // with outer joins — the joined tables are read but not locked.
    const pg = await em
      .createQueryBuilder(ProjectGroup, 'pg')
      .leftJoinAndSelect('pg.createdBy', 'createdBy')
      .leftJoinAndSelect('createdBy.amphoe', 'createdByAmphoe')
      .leftJoinAndSelect(
        'createdBy.localAdministrativeOrganization',
        'createdByLao',
      )
      .leftJoinAndSelect('pg.responsibleAgency', 'responsibleAgency')
      .where('pg.id = :pgId', { pgId })
      .andWhere('pg.deletedAt IS NULL')
      .setLock('pessimistic_write', undefined, ['pg'])
      .getOne();
    if (!pg) return false;

    // Resolve current latest tracking + its status name.
    const currentTracking = await em.findOne(TrackingStatus, {
      where: { projectGroupId: { id: pgId }, isLatest: true },
      relations: ['statusId'],
    });
    if (!currentTracking) return false;

    const priorStatusName = currentTracking.statusId?.name ?? '';

    // Resolve final reason text. For Event 1 the caller passes the
    // BOOK_CANCELLED literal. For Event 2 we map per-row.
    let staffRemark = args.reasonText;
    if (staffRemark === null) {
      const reasonKind = resolveFinalizeReasonKind(priorStatusName);
      if (reasonKind === 'NOT_AFFECTED') {
        // Defensive — shouldn't reach here because materializer already
        // filters Approved/Rejected/Ready. Skip the row.
        return false;
      }
      staffRemark =
        reasonKind === 'OWNER_TIMEOUT'
          ? ORPHAN_CLEANUP_REASONS.FINALIZE_OWNER_TIMEOUT(bookName)
          : ORPHAN_CLEANUP_REASONS.FINALIZE_STAFF_TIMEOUT(bookName);
    }

    // Demote prior latest. We do NOT delete the row — §12 audit
    // preservation. The cascade is NOT a rollback (§18.4 / §12 exception
    // applies only to staff-led rollback per CLAUDE.md §12 + §14.6).
    await em.update(
      TrackingStatus,
      { id: currentTracking.id },
      { isLatest: false },
    );

    // Insert NEW Ready row.
    const newTracking = em.create(TrackingStatus, {
      statusId: { id: readyStatusId } as Status,
      isLatest: true,
      comment: undefined,
      staffRemark,
      projectGroupId: { id: pgId } as ProjectGroup,
      revisedProjectGroupId: null,
      supplementProjectGroupId: null,
      createdBy: { id: actorWorkHistoryId } as WorkHistory,
    });
    await em.save(TrackingStatus, newTracking);

    // §7 / §18 LAO clearing — only for LAO-origin AND prior status in
    // {Pending, Verified, Pending_Approval} AND responsibleAgency is set.
    // Agency-origin PGs MUST NEVER have responsibleAgency cleared.
    const isLaoOrigin = !this.isAgencyWorkHistory(pg.createdBy ?? null);
    const priorStatusIsAssigned =
      priorStatusName === STATUS_NAMES.PENDING ||
      priorStatusName === STATUS_NAMES.VERIFIED ||
      priorStatusName === STATUS_NAMES.PENDING_APPROVAL;
    if (
      isLaoOrigin &&
      priorStatusIsAssigned &&
      pg.responsibleAgency !== null
    ) {
      await em.update(
        ProjectGroup,
        { id: pgId },
        { responsibleAgency: null as any },
      );
    }

    // Buffer post-commit notification (§18.7). Use the host-supplied
    // bookId via pg.developmentPlan? No — we key on pgId is awkward.
    // Instead key on developmentPlanId via the loaded PG; if that fails
    // we fall back to the pgId.
    const developmentPlanId = await this.resolveBookIdForPg(em, pgId);
    if (developmentPlanId) {
      const buffered =
        this.pendingPgNotifications.get(developmentPlanId) ?? [];
      buffered.push({
        projectId: pgId,
        projectTitle: pg.title ?? '',
        ownerWorkHistoryId: pg.createdBy?.id ?? null,
        bookName,
        staffRemark,
      });
      this.pendingPgNotifications.set(developmentPlanId, buffered);
    }

    return true;
  }

  private async resolveBookIdForPg(
    em: EntityManager,
    pgId: string,
  ): Promise<string | null> {
    const row = await em
      .createQueryBuilder(ProjectGroup, 'pg')
      .select('dp.id', 'id')
      .leftJoin('pg.developmentPlan', 'dp')
      .where('pg.id = :pgId', { pgId })
      .getRawOne<{ id: string }>();
    return row?.id ?? null;
  }

  // ===================================================================
  // Internals — RPG soft-delete (Phase B)
  // ===================================================================

  private async bulkSoftDeleteRevisedProjectGroups(args: {
    em: EntityManager;
    bookId: string;
    actorWorkHistoryId: string;
    reasonText: string | null;
    bookNameForFinalize?: string;
    statusFilter: 'all' | 'finalize';
  }): Promise<number> {
    const ids = await this.materializeCandidateRpgIds({
      em: args.em,
      bookId: args.bookId,
      statusFilter: args.statusFilter,
    });
    if (ids.length === 0) return 0;

    // Lineage check — abort the whole transaction if any candidate has
    // a non-batch live descendant (§18.8 + §14.3).
    await this.assertNoLiveExternalDescendantRpg(args.em, ids);

    // Topological sort — deepest descendants first. Since the candidate
    // set may itself form a forest (parent→child links via prevProjectId
    // when prevProjectType='revised'), we sort children before parents.
    const sortedIds = await this.topoSortRpgDeepestFirst(args.em, ids);

    let count = 0;
    for (const rpgId of sortedIds) {
      const wrote = await this.tombstoneAndSoftDeleteRpg({
        em: args.em,
        rpgId,
        actorWorkHistoryId: args.actorWorkHistoryId,
        reasonText: args.reasonText,
        bookNameForFinalize: args.bookNameForFinalize,
      });
      if (wrote) count += 1;
    }
    return count;
  }

  private async tombstoneAndSoftDeleteRpg(args: {
    em: EntityManager;
    rpgId: string;
    actorWorkHistoryId: string;
    reasonText: string | null;
    bookNameForFinalize?: string;
  }): Promise<boolean> {
    const { em, rpgId, actorWorkHistoryId } = args;

    const rpg = await em
      .createQueryBuilder(RevisedProjectGroup, 'rpg')
      .where('rpg.id = :rpgId', { rpgId })
      .andWhere('rpg.deletedAt IS NULL')
      .setLock('pessimistic_write')
      .getOne();
    if (!rpg) return false;

    const currentTracking = await em.findOne(TrackingStatus, {
      where: { revisedProjectGroupId: { id: rpgId }, isLatest: true },
      relations: ['statusId'],
    });
    // Resolve final reason
    let staffRemark = args.reasonText;
    if (staffRemark === null) {
      const priorStatusName = currentTracking?.statusId?.name ?? '';
      const reasonKind = resolveFinalizeReasonKind(priorStatusName);
      if (reasonKind === 'NOT_AFFECTED') {
        // Should not reach here per the materializer; skip.
        return false;
      }
      const bookName = args.bookNameForFinalize ?? '';
      staffRemark =
        reasonKind === 'OWNER_TIMEOUT'
          ? ORPHAN_CLEANUP_REASONS.FINALIZE_OWNER_TIMEOUT(bookName)
          : ORPHAN_CLEANUP_REASONS.FINALIZE_STAFF_TIMEOUT(bookName);
    }

    // Demote prior latest (§12 — RPG is leaving the workflow but the
    // prior tracking row stays as historical record).
    if (currentTracking) {
      await em.update(
        TrackingStatus,
        { id: currentTracking.id },
        { isLatest: false },
      );
    }

    // Tombstone TrackingStatus — preserves the original status id, marks
    // isLatest = false (the workflow ended, no successor).
    const tombstoneStatusId =
      currentTracking?.statusId?.id ?? (await this.resolveStatusId(em, STATUS_NAMES.READY));
    const tombstone = em.create(TrackingStatus, {
      statusId: { id: tombstoneStatusId } as Status,
      isLatest: false,
      comment: undefined,
      staffRemark,
      projectGroupId: null,
      revisedProjectGroupId: { id: rpgId } as RevisedProjectGroup,
      supplementProjectGroupId: null,
      createdBy: { id: actorWorkHistoryId } as WorkHistory,
    });
    await em.save(TrackingStatus, tombstone);

    // Finally soft-delete the RPG row itself.
    await em.softDelete(RevisedProjectGroup, { id: rpgId });
    return true;
  }

  // ===================================================================
  // Internals — Supplement project group soft-delete (mirror of RPG)
  // ===================================================================

  private async bulkSoftDeleteSupplementProjectGroups(args: {
    em: EntityManager;
    bookId: string;
    actorWorkHistoryId: string;
    reasonText: string | null;
    bookNameForFinalize?: string;
    statusFilter: 'all' | 'finalize';
  }): Promise<number> {
    const ids = await this.materializeCandidateSpgIds({
      em: args.em,
      bookId: args.bookId,
      statusFilter: args.statusFilter,
    });
    if (ids.length === 0) return 0;

    // Wave SUPP-4 — SPG can now be the parent of an RPG via
    // `prev_project_type='supplement'`. Reject the entire cancel/finalize
    // transaction if any candidate SPG has a LIVE external RPG descendant
    // (one that is NOT in any current candidate set — typically because
    // the RPG lives under a different DPR that is NOT being cleaned up).
    // Mirrors the RPG guard at line 585 (§18.8 + §14.3).
    await this.assertNoLiveExternalDescendantSpg(args.em, ids);

    let count = 0;
    for (const spgId of ids) {
      const wrote = await this.tombstoneAndSoftDeleteSpg({
        em: args.em,
        spgId,
        actorWorkHistoryId: args.actorWorkHistoryId,
        reasonText: args.reasonText,
        bookNameForFinalize: args.bookNameForFinalize,
      });
      if (wrote) count += 1;
    }
    return count;
  }

  private async tombstoneAndSoftDeleteSpg(args: {
    em: EntityManager;
    spgId: string;
    actorWorkHistoryId: string;
    reasonText: string | null;
    bookNameForFinalize?: string;
  }): Promise<boolean> {
    const { em, spgId, actorWorkHistoryId } = args;
    const spg = await em
      .createQueryBuilder(SupplementProjectGroup, 'spg')
      .where('spg.id = :spgId', { spgId })
      .andWhere('spg.deletedAt IS NULL')
      .setLock('pessimistic_write')
      .getOne();
    if (!spg) return false;

    const currentTracking = await em.findOne(TrackingStatus, {
      where: { supplementProjectGroupId: { id: spgId }, isLatest: true },
      relations: ['statusId'],
    });

    let staffRemark = args.reasonText;
    if (staffRemark === null) {
      const priorStatusName = currentTracking?.statusId?.name ?? '';
      const reasonKind = resolveFinalizeReasonKind(priorStatusName);
      if (reasonKind === 'NOT_AFFECTED') return false;
      const bookName = args.bookNameForFinalize ?? '';
      staffRemark =
        reasonKind === 'OWNER_TIMEOUT'
          ? ORPHAN_CLEANUP_REASONS.FINALIZE_OWNER_TIMEOUT(bookName)
          : ORPHAN_CLEANUP_REASONS.FINALIZE_STAFF_TIMEOUT(bookName);
    }

    if (currentTracking) {
      await em.update(
        TrackingStatus,
        { id: currentTracking.id },
        { isLatest: false },
      );
    }
    const tombstoneStatusId =
      currentTracking?.statusId?.id ??
      (await this.resolveStatusId(em, STATUS_NAMES.READY));
    const tombstone = em.create(TrackingStatus, {
      statusId: { id: tombstoneStatusId } as Status,
      isLatest: false,
      comment: undefined,
      staffRemark,
      projectGroupId: null,
      revisedProjectGroupId: null,
      supplementProjectGroupId: { id: spgId } as SupplementProjectGroup,
      createdBy: { id: actorWorkHistoryId } as WorkHistory,
    });
    await em.save(TrackingStatus, tombstone);
    await em.softDelete(SupplementProjectGroup, { id: spgId });
    return true;
  }

  // ===================================================================
  // Internals — Equipment bulk reset (Wave Equipment ผ.03 Phase 2 — BE-05)
  //
  // Mirror of `bulkResetProjectGroups` / `resetSingleProjectGroup` but
  // bound to `EquipmentProjectGroup`. Equipment is MAIN_PLAN-only (Q2)
  // so this is only ever invoked from the PLAN cancel/finalize branches.
  // No lineage (R3=NO per DB-02) → no topological sort, no descendant
  // guard. §7.3 second-context LAO-clearing of `responsibleAgency` is
  // VACUOUS here per the 2026-05-28 "agency-only authoring" decision —
  // equipment is always agency-origin so the §7.1 "MUST NEVER clear"
  // invariant always wins. The classification check is still implemented
  // defensively (matches the PG branch byte-for-spirit) so a future
  // policy change that admits LAO-origin equipment lights up correctly.
  // ===================================================================

  private async bulkResetEquipmentProjectGroups(args: {
    em: EntityManager;
    bookId: string;
    bookName: string;
    actorWorkHistoryId: string;
    readyStatusId: string;
    reasonText: string | null; // null → resolve per-row from status (finalize)
    statusFilter: 'all' | 'finalize';
  }): Promise<number> {
    const ids = await this.materializeCandidateEquipmentIds({
      em: args.em,
      bookId: args.bookId,
      statusFilter: args.statusFilter,
    });
    if (ids.length === 0) return 0;

    let resetCount = 0;
    for (const equipmentId of ids) {
      const wrote = await this.resetSingleEquipmentProjectGroup({
        em: args.em,
        equipmentId,
        bookName: args.bookName,
        actorWorkHistoryId: args.actorWorkHistoryId,
        readyStatusId: args.readyStatusId,
        reasonText: args.reasonText,
      });
      if (wrote) resetCount += 1;
    }
    return resetCount;
  }

  private async resetSingleEquipmentProjectGroup(args: {
    em: EntityManager;
    equipmentId: string;
    bookName: string;
    actorWorkHistoryId: string;
    readyStatusId: string;
    reasonText: string | null;
  }): Promise<boolean> {
    const { em, equipmentId, bookName, actorWorkHistoryId, readyStatusId } =
      args;

    // Pessimistic lock the equipment row only; outer-joined relations
    // are read but not locked (mirrors PG reset rationale at line 459).
    const equipment = await em
      .createQueryBuilder(EquipmentProjectGroup, 'eq')
      .leftJoinAndSelect('eq.createdBy', 'createdBy')
      .leftJoinAndSelect('createdBy.amphoe', 'createdByAmphoe')
      .leftJoinAndSelect(
        'createdBy.localAdministrativeOrganization',
        'createdByLao',
      )
      .leftJoinAndSelect('eq.responsibleAgency', 'responsibleAgency')
      .where('eq.id = :equipmentId', { equipmentId })
      .andWhere('eq.deletedAt IS NULL')
      .setLock('pessimistic_write', undefined, ['eq'])
      .getOne();
    if (!equipment) return false;

    const currentTracking = await em.findOne(TrackingStatus, {
      where: {
        equipmentProjectGroupId: { id: equipmentId },
        isLatest: true,
      },
      relations: ['statusId'],
    });
    if (!currentTracking) return false;

    const priorStatusName = currentTracking.statusId?.name ?? '';

    let staffRemark = args.reasonText;
    if (staffRemark === null) {
      const reasonKind = resolveFinalizeReasonKind(priorStatusName);
      if (reasonKind === 'NOT_AFFECTED') {
        // Defensive — materializer already filters Approved/Rejected/Ready.
        return false;
      }
      staffRemark =
        reasonKind === 'OWNER_TIMEOUT'
          ? ORPHAN_CLEANUP_REASONS.FINALIZE_OWNER_TIMEOUT(bookName)
          : ORPHAN_CLEANUP_REASONS.FINALIZE_STAFF_TIMEOUT(bookName);
    }

    // Demote prior latest — §12 audit preservation. We do NOT delete.
    await em.update(
      TrackingStatus,
      { id: currentTracking.id },
      { isLatest: false },
    );

    // Insert NEW Ready row tagged on the equipment FK column.
    const newTracking = em.create(TrackingStatus, {
      statusId: { id: readyStatusId } as Status,
      isLatest: true,
      comment: undefined,
      staffRemark,
      projectGroupId: null,
      revisedProjectGroupId: null,
      supplementProjectGroupId: null,
      equipmentProjectGroupId: { id: equipmentId } as EquipmentProjectGroup,
      createdBy: { id: actorWorkHistoryId } as WorkHistory,
    });
    await em.save(TrackingStatus, newTracking);

    // §7 / §18.11 — defensive parity with PG. Equipment is agency-only
    // per the 2026-05-28 authoring decision, so this branch is expected
    // to be unreachable (§7.1 "MUST NEVER clear" for agency-origin) and
    // the guard short-circuits via `isLaoOrigin === false`. Kept to
    // mirror PG so a future LAO admission lights up correctly. NO
    // clearing fires for agency equipment per spec.
    const isLaoOrigin = !this.isAgencyWorkHistory(equipment.createdBy ?? null);
    const priorStatusIsAssigned =
      priorStatusName === STATUS_NAMES.PENDING ||
      priorStatusName === STATUS_NAMES.VERIFIED ||
      priorStatusName === STATUS_NAMES.PENDING_APPROVAL;
    if (
      isLaoOrigin &&
      priorStatusIsAssigned &&
      equipment.responsibleAgency !== null
    ) {
      await em.update(
        EquipmentProjectGroup,
        { id: equipmentId },
        { responsibleAgency: null as any },
      );
    }

    // Buffer post-commit notification (§18.7). Reuse the same per-book
    // buffer keyed on developmentPlanId; PG and equipment notifications
    // co-fan-out from the host after commit.
    const developmentPlanId = await this.resolveBookIdForEquipment(
      em,
      equipmentId,
    );
    if (developmentPlanId) {
      const buffered =
        this.pendingPgNotifications.get(developmentPlanId) ?? [];
      buffered.push({
        projectId: equipmentId,
        projectTitle: equipment.equipmentName ?? '',
        ownerWorkHistoryId: equipment.createdBy?.id ?? null,
        bookName,
        staffRemark,
      });
      this.pendingPgNotifications.set(developmentPlanId, buffered);
    }

    return true;
  }

  private async resolveBookIdForEquipment(
    em: EntityManager,
    equipmentId: string,
  ): Promise<string | null> {
    const row = await em
      .createQueryBuilder(EquipmentProjectGroup, 'eq')
      .select('dp.id', 'id')
      .leftJoin('eq.developmentPlan', 'dp')
      .where('eq.id = :equipmentId', { equipmentId })
      .getRawOne<{ id: string }>();
    return row?.id ?? null;
  }

  private async materializeCandidateEquipmentIds(args: {
    em: EntityManager;
    bookId: string;
    statusFilter: 'all' | 'finalize';
  }): Promise<string[]> {
    const qb = args.em
      .createQueryBuilder(EquipmentProjectGroup, 'eq')
      .leftJoin('eq.developmentPlan', 'dp')
      .innerJoin(
        TrackingStatus,
        'ts',
        'ts.equipment_project_group_id = eq.id AND ts.is_latest = TRUE',
      )
      .innerJoin(Status, 'st', 'st.id = ts.status_id')
      .where('eq.deletedAt IS NULL')
      .andWhere('dp.id = :bookId', { bookId: args.bookId });

    if (args.statusFilter === 'finalize') {
      qb.andWhere('st.name NOT IN (:...nonTarget)', {
        nonTarget: Array.from(FINALIZE_NON_TARGET_STATUSES),
      });
    }
    qb.select('eq.id', 'id');
    const rows = await qb.getRawMany<{ id: string }>();
    return rows.map((r) => r.id);
  }

  // ===================================================================
  // Materialization queries
  // ===================================================================

  private async materializeCandidatePgIds(args: {
    em: EntityManager;
    bookId: string;
    statusFilter: 'all' | 'finalize';
  }): Promise<string[]> {
    const qb = args.em
      .createQueryBuilder(ProjectGroup, 'pg')
      .leftJoin('pg.developmentPlan', 'dp')
      .innerJoin(
        TrackingStatus,
        'ts',
        'ts.project_group_id = pg.id AND ts.is_latest = TRUE',
      )
      .innerJoin(Status, 'st', 'st.id = ts.status_id')
      .where('pg.deletedAt IS NULL')
      .andWhere('dp.id = :bookId', { bookId: args.bookId });

    if (args.statusFilter === 'finalize') {
      qb.andWhere('st.name NOT IN (:...nonTarget)', {
        nonTarget: Array.from(FINALIZE_NON_TARGET_STATUSES),
      });
    }
    qb.select('pg.id', 'id');
    const rows = await qb.getRawMany<{ id: string }>();
    return rows.map((r) => r.id);
  }

  private async materializeCandidateRpgIds(args: {
    em: EntityManager;
    bookId: string;
    statusFilter: 'all' | 'finalize';
  }): Promise<string[]> {
    const qb = args.em
      .createQueryBuilder(RevisedProjectGroup, 'rpg')
      .leftJoin('rpg.developmentPlanRevision', 'dpr')
      .innerJoin(
        TrackingStatus,
        'ts',
        'ts.revised_project_group_id = rpg.id AND ts.is_latest = TRUE',
      )
      .innerJoin(Status, 'st', 'st.id = ts.status_id')
      .where('rpg.deletedAt IS NULL')
      .andWhere('dpr.id = :bookId', { bookId: args.bookId });

    if (args.statusFilter === 'finalize') {
      qb.andWhere('st.name NOT IN (:...nonTarget)', {
        // For RPG finalize, terminal set is {Approved, Rejected} per
        // workflow doc action matrix. Ready RPGs do not exist in normal
        // workflow but we exclude Approved/Rejected only here.
        nonTarget: [STATUS_NAMES.APPROVED, STATUS_NAMES.REJECTED],
      });
    }
    qb.select('rpg.id', 'id');
    const rows = await qb.getRawMany<{ id: string }>();
    return rows.map((r) => r.id);
  }

  private async materializeCandidateSpgIds(args: {
    em: EntityManager;
    bookId: string;
    statusFilter: 'all' | 'finalize';
  }): Promise<string[]> {
    const qb = args.em
      .createQueryBuilder(SupplementProjectGroup, 'spg')
      .leftJoin('spg.developmentPlanSupplement', 'dps')
      .leftJoin(
        TrackingStatus,
        'ts',
        'ts.supplement_project_group_id = spg.id AND ts.is_latest = TRUE',
      )
      .leftJoin(Status, 'st', 'st.id = ts.status_id')
      .where('spg.deletedAt IS NULL')
      .andWhere('dps.id = :bookId', { bookId: args.bookId });

    if (args.statusFilter === 'finalize') {
      qb.andWhere(
        '(st.name IS NULL OR st.name NOT IN (:...nonTarget))',
        {
          nonTarget: [STATUS_NAMES.APPROVED, STATUS_NAMES.REJECTED],
        },
      );
    }
    qb.select('spg.id', 'id');
    const rows = await qb.getRawMany<{ id: string }>();
    return rows.map((r) => r.id);
  }

  // ===================================================================
  // Lineage + topology helpers
  // ===================================================================

  /**
   * Throws ConflictException with `ORPHAN_CASCADE_HAS_LIVE_DESCENDANT`
   * when any candidate RPG has a non-soft-deleted descendant whose id is
   * NOT in the candidate set. In-batch descendants are tolerated because
   * the topological sort will delete them first.
   */
  private async assertNoLiveExternalDescendantRpg(
    em: EntityManager,
    candidateIds: string[],
  ): Promise<void> {
    if (candidateIds.length === 0) return;

    // For each candidate, look up live descendants (prev_project_id = X
    // AND prev_project_type = 'revised' AND deleted_at IS NULL). If any
    // descendant id is NOT in the candidate set, abort.
    const candidateSet = new Set(candidateIds);
    const offenders: Array<{ parentId: string; descendantId: string }> = [];

    const rows = await em
      .createQueryBuilder(RevisedProjectGroup, 'child')
      .select('child.id', 'descendantId')
      .addSelect('child.prevProjectId', 'parentId')
      .where('child.deletedAt IS NULL')
      .andWhere('child.prev_project_type = :type', {
        type: PrevProjectType.REVISION,
      })
      .andWhere('child.prev_project_id IN (:...ids)', { ids: candidateIds })
      .getRawMany<{ parentId: string; descendantId: string }>();

    for (const row of rows) {
      if (!candidateSet.has(row.descendantId)) {
        offenders.push(row);
      }
    }

    if (offenders.length > 0) {
      const summary = offenders
        .slice(0, 5)
        .map((o) => `${o.parentId}->${o.descendantId}`)
        .join(', ');
      throw new ConflictException(
        `${ORPHAN_CASCADE_HAS_LIVE_DESCENDANT}: ไม่สามารถยกเลิก/รวมเล่มได้ เนื่องจากโครงการแก้ไขในเล่มนี้มีเวอร์ชันที่ใช้งานอยู่ภายนอก (CLAUDE.md §18.8/§14.3) [${summary}${offenders.length > 5 ? ', ...' : ''}]`,
      );
    }
  }

  /**
   * Wave SUPP-4 — SPG analogue of `assertNoLiveExternalDescendantRpg`.
   *
   * Once `prev_project_type='supplement'` exists, an SPG MAY have RPG
   * descendants that live under a different DPR. The cancel/finalize
   * cascade of a supplement book MUST abort if any candidate SPG has a
   * live RPG descendant (descendants of an SPG live under a DPR by
   * construction — they cannot be in the SPG candidate set — so every
   * hit is "external" by definition).
   */
  private async assertNoLiveExternalDescendantSpg(
    em: EntityManager,
    candidateSpgIds: string[],
  ): Promise<void> {
    if (candidateSpgIds.length === 0) return;

    const rows = await em
      .createQueryBuilder(RevisedProjectGroup, 'child')
      .select('child.id', 'descendantId')
      .addSelect('child.prevProjectId', 'parentId')
      .where('child.deletedAt IS NULL')
      .andWhere('child.prev_project_type = :type', {
        type: PrevProjectType.SUPPLEMENT,
      })
      .andWhere('child.prev_project_id IN (:...ids)', { ids: candidateSpgIds })
      .getRawMany<{ parentId: string; descendantId: string }>();

    if (rows.length > 0) {
      const summary = rows
        .slice(0, 5)
        .map((o) => `${o.parentId}->${o.descendantId}`)
        .join(', ');
      throw new ConflictException(
        `${ORPHAN_CASCADE_HAS_LIVE_DESCENDANT}: ไม่สามารถยกเลิก/รวมเล่มเพิ่มเติมได้ เนื่องจากโครงการเพิ่มเติมในเล่มนี้มีเวอร์ชันแก้ไข/เปลี่ยนแปลงที่ใช้งานอยู่ภายนอก (CLAUDE.md §18.8/§14.3) [${summary}${rows.length > 5 ? ', ...' : ''}]`,
      );
    }
  }

  /**
   * Topologically sort RPG candidates so descendants appear BEFORE
   * ancestors (deepest-first). Tolerates DAG forks per §14.1.
   */
  private async topoSortRpgDeepestFirst(
    em: EntityManager,
    ids: string[],
  ): Promise<string[]> {
    if (ids.length <= 1) return [...ids];

    const idSet = new Set(ids);
    // Map parentId -> child ids (within candidate set only).
    const childrenOf = new Map<string, Set<string>>();
    for (const id of ids) childrenOf.set(id, new Set());

    const rows = await em
      .createQueryBuilder(RevisedProjectGroup, 'rpg')
      .select('rpg.id', 'id')
      .addSelect('rpg.prevProjectId', 'parentId')
      .where('rpg.id IN (:...ids)', { ids })
      .getRawMany<{ id: string; parentId: string | null }>();

    for (const row of rows) {
      if (row.parentId && idSet.has(row.parentId)) {
        childrenOf.get(row.parentId)!.add(row.id);
      }
    }

    // Post-order DFS — visit children first, then self. Cycles are
    // impossible per §14 invariants (lineage is a DAG with createdAt
    // monotonic) but we still guard with a visited set.
    const visited = new Set<string>();
    const sorted: string[] = [];
    const visit = (id: string): void => {
      if (visited.has(id)) return;
      visited.add(id);
      const children = childrenOf.get(id) ?? new Set();
      for (const childId of children) visit(childId);
      sorted.push(id);
    };
    for (const id of ids) visit(id);
    return sorted;
  }

  // ===================================================================
  // Misc helpers
  // ===================================================================

  private async resolveStatusId(
    em: EntityManager,
    name: string,
  ): Promise<string> {
    const status = await em.findOne(Status, { where: { name } });
    if (!status) {
      throw new NotFoundException(
        `Status "${name}" not found in system status table`,
      );
    }
    return status.id;
  }

  private async resolveActorWorkHistory(
    em: EntityManager,
    actorUserId: string,
  ): Promise<WorkHistory> {
    // Use the current/latest WorkHistory for the actor (§4 ownership
    // model). Fallback to any approved WorkHistory if isCurrent is not
    // set (legacy data).
    let wh = await em.findOne(WorkHistory, {
      where: { user: { id: actorUserId }, isCurrent: true },
    });
    if (!wh) {
      wh = await em.findOne(WorkHistory, {
        where: { user: { id: actorUserId }, workStatus: { name: 'approved' } },
      });
    }
    if (!wh) {
      throw new NotFoundException(
        `Current WorkHistory not found for actor user ${actorUserId}`,
      );
    }
    return wh;
  }

  private resolveBookName(
    book: DevelopmentPlan | DevelopmentPlanRevision | DevelopmentPlanSupplement,
    bookKind: OrphanCleanupBookKind,
  ): string {
    if (bookKind === 'PLAN') {
      const dp = book as DevelopmentPlan;
      return dp.name ?? `แผน ${dp.startYear}-${dp.endYear}`;
    }
    if (bookKind === 'REVISION') {
      const dpr = book as DevelopmentPlanRevision;
      return dpr.description ?? `ฉบับแก้ไข/เปลี่ยนแปลง #${dpr.revisionNumber}`;
    }
    const dps = book as DevelopmentPlanSupplement;
    return dps.description ?? `ฉบับเพิ่มเติม #${dps.supplementNumber}`;
  }

  private isAgencyWorkHistory(wh: WorkHistory | null | undefined): boolean {
    if (!wh) return false;
    // CLAUDE.md §1 — agency iff amphoe.id = 3001 AND
    // localAdministrativeOrganization.id = 3001027.
    const amphoeId = wh.amphoe?.id;
    const laoId = wh.localAdministrativeOrganization?.id;
    return String(amphoeId) === '3001' && String(laoId) === '3001027';
  }

  // ===================================================================
  // Legacy migration internals
  // ===================================================================

  private async legacyResetSinglePg(
    em: EntityManager,
    pgId: string,
    readyStatusId: string,
  ): Promise<boolean> {
    const currentTracking = await em.findOne(TrackingStatus, {
      where: { projectGroupId: { id: pgId }, isLatest: true },
      relations: ['statusId', 'createdBy'],
    });
    if (!currentTracking) return false;

    // Idempotency — skip if already Ready.
    if (currentTracking.statusId?.name === STATUS_NAMES.READY) return false;

    // Determine actor WorkHistory — fall back to the original creator of
    // the latest tracking row (always present).
    const actorWh = currentTracking.createdBy;
    if (!actorWh?.id) return false;

    await em.update(
      TrackingStatus,
      { id: currentTracking.id },
      { isLatest: false },
    );
    const reset = em.create(TrackingStatus, {
      statusId: { id: readyStatusId } as Status,
      isLatest: true,
      comment: undefined,
      staffRemark: ORPHAN_CLEANUP_REASONS.LEGACY_BACKFILL,
      projectGroupId: { id: pgId } as ProjectGroup,
      createdBy: actorWh,
    });
    await em.save(TrackingStatus, reset);
    return true;
  }

  private async legacyTombstoneSingleRpg(
    em: EntityManager,
    rpgId: string,
  ): Promise<boolean> {
    // Idempotency — only act if RPG still has a live row.
    const rpg = await em.findOne(RevisedProjectGroup, {
      where: { id: rpgId, deletedAt: IsNull() },
    });
    if (!rpg) return false;

    const currentTracking = await em.findOne(TrackingStatus, {
      where: { revisedProjectGroupId: { id: rpgId }, isLatest: true },
      relations: ['statusId', 'createdBy'],
    });
    const actorWh = currentTracking?.createdBy;
    if (currentTracking) {
      await em.update(
        TrackingStatus,
        { id: currentTracking.id },
        { isLatest: false },
      );
    }
    const tombstoneStatusId =
      currentTracking?.statusId?.id ??
      (await this.resolveStatusId(em, STATUS_NAMES.READY));
    const tombstone = em.create(TrackingStatus, {
      statusId: { id: tombstoneStatusId } as Status,
      isLatest: false,
      comment: undefined,
      staffRemark: ORPHAN_CLEANUP_REASONS.LEGACY_BACKFILL,
      revisedProjectGroupId: { id: rpgId } as RevisedProjectGroup,
      createdBy: actorWh ?? undefined,
    });
    await em.save(TrackingStatus, tombstone);
    await em.softDelete(RevisedProjectGroup, { id: rpgId });
    return true;
  }
}
