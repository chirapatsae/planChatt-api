// ===================================================================
// SupplementAssemblyService — SUPP_STANDALONE_BE_02
// ===================================================================
//
// Orchestration service for the STANDALONE Supplement Assembly subsystem
// (Wave 2 of 6). Owns the in-flight Part1 → Part2 → Part3 → finalize
// state machine, the cancel path, and the per-supplement multi-version
// (v1..vN, Q8=A / Q9=A) history.
//
// Locked decisions referenced inline:
//   - Q4=C  — Wave A scope is Part1/2/3 + finalize + cancel ONLY.
//             Correction + deprecation audit deferred to Wave B.
//   - Q7=A  — `merge()` is the new §18.2.1 SUPPLEMENT finalize trigger
//             surface; cascade fires INSIDE the transaction, BEFORE
//             `DevelopmentPlanSupplement.isBooked = true`.
//   - Q8=A / Q9=A — multi-version, version numbers per-supplement
//             (next = MAX(version) + 1 WHERE supplementId = ...).
//   - Q10=B — standalone; this service MUST NOT import from
//             `src/book-assembly/`.
//
// CLAUDE.md compliance:
//   - §2  workStatus = 'approved' — re-checked at service entry per
//         method (controller may also pre-filter).
//   - §4.1 / §18.3 authority inheritance — admin + super-admin only.
//   - §12 audit — the cascade (NOT this service) writes TrackingStatus
//         rows. This service writes only `supplement_assembly_*` tables
//         + the supplement's `isBooked` flip.
//   - §14 / §15 — `BookLockService.assertEditable(
//         supplement.id, 'development_plan_supplement', em)`
//         runs BEFORE every mutating call.
//   - §16.3 — `reportFormat` resolved via parent plan; never overridden.
//   - §17 — no AI side-effects.
//   - §18.2.1 — cascade BEFORE `isBooked = true` flip, atomic
//         transaction. Throws (e.g. `ORPHAN_CASCADE_HAS_LIVE_DESCENDANT`
//         — vacuous for supplement today but invariant must hold) roll
//         back the entire merge.
// ===================================================================

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { PDFDocument } from 'pdf-lib';

import { SupplementAssemblyDraft } from './entities/supplement-assembly-draft.entity';
import { SupplementAssemblyVersion } from './entities/supplement-assembly-version.entity';
import { SupplementAssemblyVersionProject } from './entities/supplement-assembly-version-project.entity';
// wave-supplement-convergence-milestone-4-lineage / BE-01 (2026-05-25) —
// segregated SPG lineage table (CTO M4 decision Option B). Service
// helpers `populateLineageForSupplementMerge` /
// `restoreLineageAfterSupplementCancel` write here inside the existing
// merge / cancel / correct(Part3) transactions.
import { SupplementProjectLineage } from './entities/supplement-project-lineage.entity';
import {
  SupplementAssemblyCorrectionMode,
  SupplementAssemblyDraftStatus,
  SupplementAssemblyPartSource,
  SupplementAssemblyPartUploadStatus,
  SupplementAssemblyVersionStatus,
} from './enums/supplement-assembly.enums';
import { CorrectSupplementBookDto } from './dto/correct-supplement-book.dto';
import { CancelSupplementBookDto } from './dto/cancel-supplement-book.dto';
import { SupplementAssemblyDraftDto } from './dto/draft-response.dto';
import { SupplementAssemblyVersionDto } from './dto/version-response.dto';
import {
  SupplementReadinessBreakdownDto,
  SupplementReadinessDto,
} from './dto/supplement-readiness.dto';
import {
  SupplementBookDisplayStateDto,
  SupplementBookDisplayStateEnum,
} from './dto/supplement-book-display-state.dto';
import { STATUS_NAMES } from 'src/common/status-names';

import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { DevelopmentPlanSupplement } from 'src/development-plan-supplement/entities/development-plan-supplement.entity';
import { SupplementProjectGroup } from 'src/supplement-project-group/entities/supplement-project-group.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { User } from 'src/users/entities/user.entity';

import {
  SupplementAssemblyFileService,
  SupplementLocation,
} from './supplement-assembly-file.service';
import { SupplementPdfService } from 'src/pdf/supplement-pdf.service';
import { BookLockService } from 'src/common/book-lock/book-lock.service';
import { OrphanCleanupService } from 'src/orphan-cleanup/orphan-cleanup.service';
import { LineageLockService } from 'src/common/lineage-lock/lineage-lock.service';
import { UsersService } from 'src/users/users.service';

/** Roles permitted to perform supplement-assembly write actions (§4.1 / §18.3). */
const ADMIN_ROLES = ['admin', 'super-admin'];

/** Roles permitted to view / download. Mirrors BookAssembly precedent. */
const READ_ROLES = ['staff', 'admin', 'super-admin'];

/** Part-number guard — Part 1/2/3 only. */
type PartNumber = 1 | 2 | 3;

/**
 * Readiness denominator exclusion list — mirrors
 * `BookAssemblyService.READINESS_EXCLUSION_STATUSES` byte-for-byte so
 * the supplement gate and the main-plan / revision gate agree.
 *
 * Excluded statuses:
 *   - Ready: pre-submission; owner has not yet entered review.
 *   - Pull_Back: owner withdrew; §18 cascade auto-resets on finalize.
 *   - Rejected (W67): "เกินศักยภาพ" workflow exit; routed to the
 *     out-authority pipeline, never appears in the supplement book.
 *
 * Per CTO note on the BE-01 task: the supplement gate must use the
 * SAME predicate as `merge` so preview-time and finalize-time truth
 * agree. `merge` consumes `listSupplementProjectsForPdf({ approvedOnly:
 * true })` which keys on `status.name = 'Approved'`. Readiness uses
 * `approvedCount === totalCount` and excludes the three non-progressing
 * statuses above from the denominator — the result is equivalent to
 * "every remaining (in-flight or approved) project is approved".
 */
const SUPPLEMENT_READINESS_EXCLUSION_STATUSES: readonly string[] = [
  STATUS_NAMES.READY,
  STATUS_NAMES.PULL_BACK,
  STATUS_NAMES.REJECTED,
] as const;

/**
 * wave-supplement-correction-workflow / BE-01 — identity-verification
 * retry policy. Mirrors `BookAssemblyService` constants byte-for-byte
 * (Q3=B duplicate; do NOT import from `book-assembly`).
 */
const MAX_IDENTITY_ATTEMPTS = 3;
const IDENTITY_LOCK_MS = 15 * 60 * 1000; // 15 minutes

@Injectable()
export class SupplementAssemblyService {
  private readonly logger = new Logger(SupplementAssemblyService.name);

  /**
   * wave-supplement-correction-workflow / BE-01 — in-memory identity-
   * verification retry tracker keyed by userId. Mirrors the main-plan
   * `BookAssemblyService.identityAttempts` map; per Q3=B isolation we
   * keep a dedicated map (no shared state across subsystems).
   */
  private readonly identityAttempts = new Map<
    string,
    { count: number; lockedUntil?: Date }
  >();

  constructor(
    @InjectRepository(SupplementAssemblyDraft)
    private readonly draftRepo: Repository<SupplementAssemblyDraft>,

    @InjectRepository(SupplementAssemblyVersion)
    private readonly versionRepo: Repository<SupplementAssemblyVersion>,

    @InjectRepository(SupplementAssemblyVersionProject)
    private readonly versionProjectRepo: Repository<SupplementAssemblyVersionProject>,

    @InjectRepository(DevelopmentPlanSupplement)
    private readonly supplementRepo: Repository<DevelopmentPlanSupplement>,

    @InjectRepository(SupplementProjectGroup)
    private readonly spgRepo: Repository<SupplementProjectGroup>,

    @InjectRepository(WorkHistory)
    private readonly workHistoryRepo: Repository<WorkHistory>,

    @InjectRepository(User)
    private readonly userRepo: Repository<User>,

    private readonly fileService: SupplementAssemblyFileService,
    private readonly pdfService: SupplementPdfService,
    private readonly bookLockService: BookLockService,
    private readonly orphanCleanupService: OrphanCleanupService,
    // wave-supplement-correction-workflow / BE-01 — UsersService is used
    // ONLY by `validateSupplementDeprecationAuth` to read the operator's
    // decrypted `citizenId` (the column is encrypted at rest per W89).
    // Loading via the User repo directly would return ciphertext.
    private readonly usersService: UsersService,
    // §14.11 — cancel-time descendant guard (reuses canonical §14
    // lineage machinery; SPG descendants are RPG rows with
    // prev_project_type='supplement', discriminator 'supplement').
    private readonly lineageLockService: LineageLockService,
    private readonly dataSource: DataSource,
  ) {}

  // ===================================================================
  // Public API — Sidebar Counts
  // ===================================================================

  /**
   * Returns the number of ACTIONABLE supplements that should appear in
   * the `/local-plan-book/assembly/supplement` sidebar badge.
   *
   * Predicate (FROZEN — must match `SupplementAssemblyPage.tsx`
   * `activeSupplements` membership rule + the §7.2 contract in
   * `docs/tasks/SUPPLEMENT_SIDEBAR_BADGES_BE_ASSEMBLY_COUNT.md`):
   *   - parent `DevelopmentPlan.isLatest = true`
   *   - `DevelopmentPlanSupplement.isOpen = true`
   *   - `DevelopmentPlanSupplement.isBooked = false`
   *   - `DevelopmentPlanSupplement.deletedAt IS NULL` (auto via
   *     `@DeleteDateColumn`)
   *   - `hasNewerRevision = false` — i.e. NO strictly-newer
   *     non-soft-deleted sibling supplement exists under the same plan.
   *     Replicated server-side as a `NOT EXISTS` subquery because the
   *     `hasNewerRevision` field on the entity is a runtime-only flag
   *     (see entity comment) populated by
   *     `DevelopmentPlanService.decorateBookLockFlags` — there is NO DB
   *     column. NOTE: this actionable-count derivation pre-dates the
   *     wave-lineage-linear-chain-by-bookedAt rewrite and still orders
   *     by `created_at` because it counts UNBOOKED draft supplements
   *     eligible for assembly (drafts have no `bookedAt`). It is NOT a
   *     §15 lock predicate and is intentionally divergent from
   *     `BookLockService.hasStrictlyNewerBookedSibling`.
   *
   * Role gate (§4.1, §17.2):
   *   - admin + super-admin → live count
   *   - any other role → silent `0` (no 403; mirrors the
   *     `fallbackZero` convention used by `useSidebarCounts`)
   *
   * §17.2 — pure read, advisory only; MUST NOT gate workflow.
   */
  async getActionableCount(callerRole: string | undefined): Promise<number> {
    if (callerRole !== 'admin' && callerRole !== 'super-admin') {
      return 0;
    }

    // ONE SQL round-trip. `@DeleteDateColumn` on
    // `DevelopmentPlanSupplement.deletedAt` is auto-applied by TypeORM
    // on the primary alias (`s`), so we do not add it explicitly.
    // The `NOT EXISTS` subquery aliases the same table as `s2` and
    // explicitly includes `s2.deleted_at IS NULL` because TypeORM's
    // soft-delete filter does NOT propagate to manually-aliased
    // subqueries inside a single QueryBuilder.
    const count = await this.supplementRepo
      .createQueryBuilder('s')
      .innerJoin('s.developmentPlan', 'plan')
      .where('plan.is_latest = :planLatest', { planLatest: true })
      .andWhere('s.is_open = :isOpen', { isOpen: true })
      .andWhere('s.is_booked = :isBooked', { isBooked: false })
      .andWhere(
        `NOT EXISTS (
          SELECT 1
          FROM development_plan_supplement s2
          WHERE s2.development_plan_id = plan.id
            AND s2.id <> s.id
            AND s2.created_at > s.created_at
            AND s2.deleted_at IS NULL
        )`,
      )
      .getCount();

    return count;
  }

  // ===================================================================
  // Public API — Draft authoring
  // ===================================================================

  /**
   * Create a new draft for the supplement. Rejects if an active draft
   * already exists (DB partial-unique `uniq_sad_active_draft` is the
   * canonical guard; we also pre-check for a nicer error message).
   *
   * §15 lock is enforced before any write.
   */
  async createDraft(
    supplementId: string,
    userId: string,
  ): Promise<SupplementAssemblyDraftDto> {
    const workHistory = await this.loadAndValidateWorkHistory(
      userId,
      ADMIN_ROLES,
    );

    return this.dataSource.transaction(async (manager) => {
      await this.loadSupplementOrFail(supplementId, manager);
      await this.bookLockService.assertEditable(
        supplementId,
        'development_plan_supplement',
        manager,
      );

      const existingActive = await manager.findOne(SupplementAssemblyDraft, {
        where: [
          {
            developmentPlanSupplementId: supplementId,
            assemblyStatus: SupplementAssemblyDraftStatus.PREPARING,
          },
          {
            developmentPlanSupplementId: supplementId,
            assemblyStatus: SupplementAssemblyDraftStatus.READY,
          },
        ],
      });
      if (existingActive) {
        throw new ConflictException(
          'มี draft รวมเล่มที่กำลังดำเนินการอยู่แล้วสำหรับรอบเพิ่มเติมนี้',
        );
      }

      const draft = manager.create(SupplementAssemblyDraft, {
        developmentPlanSupplementId: supplementId,
        assemblyStatus: SupplementAssemblyDraftStatus.PREPARING,
        part1Status: SupplementAssemblyPartUploadStatus.PENDING,
        part2Status: SupplementAssemblyPartUploadStatus.PENDING,
        part3Status: SupplementAssemblyPartUploadStatus.PENDING,
        createdById: workHistory.id,
      });
      const saved = await manager.save(SupplementAssemblyDraft, draft);

      this.logger.log(
        `[SupplementAssembly] createDraft supplement=${supplementId} draft=${saved.id}`,
      );
      // wave-supplement-assembly-metadata-parity / BE-01 — re-fetch with
      // relations so the returned DTO carries createdBy.user.
      const full = await manager.findOne(SupplementAssemblyDraft, {
        where: { id: saved.id },
        relations: ['createdBy', 'createdBy.user'],
      });
      return this.toDraftDto(full ?? saved);
    });
  }

  /**
   * Return the current active (preparing | ready) draft, or null.
   * Read-only — bypasses §15 lock per §15.5 exemption.
   */
  async getActiveDraft(
    supplementId: string,
    userId: string,
  ): Promise<SupplementAssemblyDraftDto | null> {
    await this.loadAndValidateWorkHistory(userId, READ_ROLES);
    const draft = await this.findActiveDraft(supplementId);
    return draft ? this.toDraftDto(draft) : null;
  }

  /**
   * Alias for `cancel()` — matches the BookAssembly surface.
   */
  async discardDraft(
    supplementId: string,
    userId: string,
  ): Promise<{ message: string; draftId: string }> {
    return this.cancel(supplementId, userId);
  }

  /**
   * Cancel the active draft (state → `canceled`). Terminal state.
   * The host file-system writes are intentionally NOT cleaned — the
   * forensic copy is retained per Q4=C Wave A scope. Wave B may add an
   * explicit purge endpoint.
   */
  async cancel(
    supplementId: string,
    userId: string,
  ): Promise<{ message: string; draftId: string }> {
    await this.loadAndValidateWorkHistory(userId, ADMIN_ROLES);

    return this.dataSource.transaction(async (manager) => {
      await this.bookLockService.assertEditable(
        supplementId,
        'development_plan_supplement',
        manager,
      );

      const draft = await manager.findOne(SupplementAssemblyDraft, {
        where: [
          {
            developmentPlanSupplementId: supplementId,
            assemblyStatus: SupplementAssemblyDraftStatus.PREPARING,
          },
          {
            developmentPlanSupplementId: supplementId,
            assemblyStatus: SupplementAssemblyDraftStatus.READY,
          },
        ],
      });
      if (!draft) {
        throw new NotFoundException(
          'ไม่พบ draft รวมเล่มที่กำลังดำเนินการสำหรับรอบเพิ่มเติมนี้',
        );
      }

      draft.assemblyStatus = SupplementAssemblyDraftStatus.CANCELED;
      await manager.save(SupplementAssemblyDraft, draft);

      this.logger.log(
        `[SupplementAssembly] cancel supplement=${supplementId} draft=${draft.id}`,
      );
      return { message: 'ยกเลิก draft สำเร็จ', draftId: draft.id };
    });
  }

  /**
   * Returns the most recent CANCELED draft for the supplement, or null.
   * Used by the FE to offer a "restore" option after cancellation.
   */
  async getCanceledDraft(
    supplementId: string,
    userId: string,
  ): Promise<SupplementAssemblyDraftDto | null> {
    await this.loadAndValidateWorkHistory(userId, READ_ROLES);
    // wave-supplement-assembly-metadata-parity / BE-01 — eager-load
    // createdBy.user so the restore-prompt UI can attribute the canceled
    // draft to its author.
    const draft = await this.draftRepo.findOne({
      where: {
        developmentPlanSupplementId: supplementId,
        assemblyStatus: SupplementAssemblyDraftStatus.CANCELED,
      },
      relations: ['createdBy', 'createdBy.user'],
      order: { updatedAt: 'DESC' },
    });
    return draft ? this.toDraftDto(draft) : null;
  }

  /**
   * Un-cancel a previously canceled draft back to `preparing`, ONLY when
   * no other active draft has been created in the meantime AND no newer
   * `merged` version was published. Implementation is conservative — we
   * only flip the status; uploaded part files are preserved on disk per
   * the forensic-retention policy of `cancel()`.
   */
  async restoreDraft(
    supplementId: string,
    userId: string,
  ): Promise<SupplementAssemblyDraftDto> {
    await this.loadAndValidateWorkHistory(userId, ADMIN_ROLES);

    return this.dataSource.transaction(async (manager) => {
      await this.bookLockService.assertEditable(
        supplementId,
        'development_plan_supplement',
        manager,
      );

      const activeDraft = await manager.findOne(SupplementAssemblyDraft, {
        where: [
          {
            developmentPlanSupplementId: supplementId,
            assemblyStatus: SupplementAssemblyDraftStatus.PREPARING,
          },
          {
            developmentPlanSupplementId: supplementId,
            assemblyStatus: SupplementAssemblyDraftStatus.READY,
          },
        ],
      });
      if (activeDraft) {
        throw new ConflictException(
          'มี draft รวมเล่มที่กำลังดำเนินการอยู่แล้ว ไม่สามารถกู้คืน draft ที่ยกเลิกได้',
        );
      }

      const canceled = await manager.findOne(SupplementAssemblyDraft, {
        where: {
          developmentPlanSupplementId: supplementId,
          assemblyStatus: SupplementAssemblyDraftStatus.CANCELED,
        },
        order: { updatedAt: 'DESC' },
      });
      if (!canceled) {
        throw new NotFoundException(
          'ไม่พบ draft ที่ยกเลิกสำหรับรอบเพิ่มเติมนี้',
        );
      }

      // Reset to preparing or ready depending on whether all parts are
      // present. `READY` is reserved for the all-3-uploaded state.
      canceled.assemblyStatus = this.computeDraftStatus({
        part1Status: canceled.part1Status,
        part2Status: canceled.part2Status,
        part3Status: canceled.part3Status,
      });
      const saved = await manager.save(SupplementAssemblyDraft, canceled);

      this.logger.log(
        `[SupplementAssembly] restoreDraft supplement=${supplementId} draft=${saved.id}`,
      );
      return this.toDraftDto(saved);
    });
  }

  /**
   * Hard-delete a canceled draft + its draft-stage files. Wave A only —
   * purging finalized versions is forbidden by the immutability rule.
   */
  async purgeCanceledDraft(
    supplementId: string,
    userId: string,
  ): Promise<{ message: string; draftId: string }> {
    await this.loadAndValidateWorkHistory(userId, ADMIN_ROLES);

    return this.dataSource.transaction(async (manager) => {
      const canceled = await manager.findOne(SupplementAssemblyDraft, {
        where: {
          developmentPlanSupplementId: supplementId,
          assemblyStatus: SupplementAssemblyDraftStatus.CANCELED,
        },
        order: { updatedAt: 'DESC' },
      });
      if (!canceled) {
        throw new NotFoundException(
          'ไม่พบ draft ที่ยกเลิกสำหรับรอบเพิ่มเติมนี้',
        );
      }

      await manager.remove(SupplementAssemblyDraft, canceled);

      this.logger.log(
        `[SupplementAssembly] purgeCanceledDraft supplement=${supplementId} draft=${canceled.id}`,
      );
      return { message: 'ลบ draft ที่ยกเลิกสำเร็จ', draftId: canceled.id };
    });
  }

  // ===================================================================
  // Public API — Cancel published version
  // (wave-supplement-convergence-milestone-1-parity-contract / BE-01)
  // ===================================================================

  /**
   * Cancel (deprecate) a PUBLISHED COMPLETED version of a supplement
   * book + reset the supplement back to its pre-finalize state.
   *
   * Mirrors `BookAssemblyService.cancel()` byte-for-spirit (Q3=B
   * duplicate — DO NOT import from `book-assembly`). Closes the live
   * bug where the supplement `cancel()` method (draft cancel, kept
   * unchanged at line ~348) was the only cancel path even though the
   * FE shows the cancel button on `published_latest` state — clicks
   * resulted in 404 confusion because no published draft exists.
   *
   * CRITICAL TRANSACTIONAL FLOW (mirrors BookAssemblyService.cancel
   * lines 1204-1303):
   *   1. §15 lock check (BookLockService.assertEditable) — blocks if
   *      a strictly-newer-booked sibling locks this supplement.
   *   2. Validate operator (role, workStatus, confirmation,
   *      citizenIdSuffix) via the shared `validateSupplementDeprecation
   *      Auth` helper.
   *   3. Load the target version under pessimistic_write lock so a
   *      concurrent correct / re-cancel cannot race. 404 if the row
   *      does not exist OR belongs to a different supplement; 409
   *      `CANNOT_CANCEL_DEPRECATED` if it is already DEPRECATED
   *      (idempotency contract — second cancel against the same
   *      version is a no-op-style hard error so the operator sees
   *      that the row was already retired).
   *   4. Deprecate the version (status=DEPRECATED, deprecatedAt,
   *      deprecatedById, deprecationReason).
   *   5. Reset SPG booking — `isBooked=false`, `bookedAt=null`,
   *      `pageNumber=null` cleared on every SPG in the
   *      `part3ProjectSnapshot`. wave-supplement-convergence-milestone-
   *      2-spg-booked-fields / BE-01 (2026-05-25) — §20 parity with
   *      PG/RPG; SPG now carries its own booked-state columns added by
   *      DB-01 of the same wave.
   *   6. Reset supplement state — `isBooked=false` + `bookedAt=null`.
   *      Clearing `bookedAt` is CRITICAL for §15 Model A linear-chain:
   *      it removes this supplement from the strictly-newer-bookedAt
   *      sibling probe so older siblings unlock automatically.
   *   7. M1 deferred: `DeprecationAuditLog` table parity (the main-
   *      plan precedent writes a SUCCESS audit row via `manager.save
   *      (DeprecationAuditLog, ...)`. The supplement equivalent table
   *      is owned by Milestone 2 / 3 of this convergence wave. For M1
   *      we log to the BE logger so operators have an immediate audit
   *      trail; the persisted `deprecationReason` column on the
   *      version row carries the durable record.
   *
   * §15 unlock behavior: after this method commits, the supplement is
   * `isBooked=false` AND `bookedAt=null`, which removes it from the
   * §15.3 sibling probe per BookLockService's predicate. An older
   * sibling that was previously locked by this supplement's bookedAt
   * automatically becomes editable.
   *
   * §18 interaction: cancel of a PUBLISHED VERSION is NOT a §18.2.1
   * cascade trigger. Only book-row `softRemove` (cancel book) and
   * `merge()` (finalize) fire the orphan cleanup cascade. This op
   * deprecates a single version + resets SPG pageNumbers / supplement
   * booking flags — none of which warrants a §18 cascade.
   *
   * §12 audit: the version row's `deprecation_reason` + `deprecated
   * _by_id` + `deprecated_at` columns ARE the durable audit record
   * for this op (mirrors the main-plan precedent). No `TrackingStatus`
   * row is written because the SPG status itself is NOT changing —
   * this is a book-version retirement, not a project state change.
   *
   * Error contract:
   *   - 401 UnauthorizedException — citizenIdSuffix mismatch (after
   *     retry-lock check) OR workStatus !== 'approved'
   *   - 403 ForbiddenException — role not in {admin, super-admin}
   *     OR identity retry lock armed
   *   - 404 NotFoundException — supplement / version not found
   *   - 409 ConflictException with `BOOK_HAS_NEWER_REVISION` — §15
   *     sibling lock (delegated to BookLockService)
   *   - 409 ConflictException with `CANNOT_CANCEL_DEPRECATED` —
   *     version is already in DEPRECATED status
   *   - 400 BadRequestException — `confirmed !== true`
   */
  async cancelPublishedVersion(
    supplementId: string,
    versionId: string,
    dto: CancelSupplementBookDto,
    userId: string,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      // Step 1 — §15 lock check. Blocks when a strictly-newer-booked
      // sibling locks this supplement. Delegates to BookLockService's
      // canonical predicate (no duplication).
      await this.bookLockService.assertEditable(
        supplementId,
        'development_plan_supplement',
        manager,
      );

      // Step 2 — Validate operator (role + workStatus + confirmation
      // + citizenIdSuffix retry-lock + match). Reuses the existing
      // helper from the correction workflow so the gate behaves
      // identically across the two deprecation surfaces.
      const { workHistory } = await this.validateSupplementDeprecationAuth(
        dto.confirmed,
        dto.citizenIdSuffix,
        userId,
        manager,
      );

      // Step 3 — Load the target version with pessimistic_write lock,
      // scoped by BOTH versionId AND supplementId so a malicious /
      // mistaken caller cannot deprecate a sibling supplement's
      // version by spoofing the path param.
      const version = await manager.findOne(SupplementAssemblyVersion, {
        where: {
          id: versionId,
          developmentPlanSupplementId: supplementId,
        },
        lock: { mode: 'pessimistic_write' },
      });
      if (!version) {
        throw new NotFoundException(
          `ไม่พบเวอร์ชัน ${versionId} ของรอบเพิ่มเติมนี้`,
        );
      }
      if (version.status === SupplementAssemblyVersionStatus.DEPRECATED) {
        throw new ConflictException({
          code: 'CANNOT_CANCEL_DEPRECATED',
          message: 'เวอร์ชันนี้ถูกยกเลิกไปแล้ว ไม่สามารถยกเลิกซ้ำได้',
        });
      }
      if (version.status !== SupplementAssemblyVersionStatus.COMPLETED) {
        // Defensive — the enum only has COMPLETED + DEPRECATED today,
        // but a future variant (e.g. DRAFT) must not silently slip
        // through this gate.
        throw new ConflictException({
          code: 'CANNOT_CANCEL_NON_COMPLETED',
          message: `ไม่สามารถยกเลิกเวอร์ชันที่มีสถานะ ${version.status}`,
        });
      }

      // Step 3b — §14.11 cancel-time descendant guard. Block cancel if
      // ANY SPG in this version's snapshot was forked into a LATER book
      // (live §14 descendant referencing it via
      // prev_project_type='supplement', §14.7). Cancelling here would
      // un-book the forked source while the downstream fork still points
      // at it, leaving the source permanently §14-locked and the lineage
      // "ขาดช่วง". The operator must remove the downstream fork first.
      // Reuses the shared collectDownstreamForkIds helper — the SAME source
      // of truth as the read-side hasDownstreamFork DTO flag, so the
      // pre-emptive FE disable can never disagree with this throw. Runs INSIDE
      // the transaction, BEFORE the deprecate write. (Today supplement→RPG
      // forks are rare, but the §20.7 parity invariant must hold.)
      const supplementSnapshotIds = version.part3ProjectSnapshot ?? [];
      const blockingProjectIds = await this.collectDownstreamForkIds(
        supplementSnapshotIds,
        manager,
      );
      if (blockingProjectIds.length > 0) {
        throw new ConflictException({
          code: 'BOOK_PROJECTS_REFERENCED_DOWNSTREAM',
          message:
            'ไม่สามารถยกเลิกเล่มนี้ได้ เนื่องจากมีโครงการในเล่มนี้ถูกนำไปใช้ต่อ (fork) ในเล่มอื่นที่ออกภายหลัง ' +
            'กรุณาลบรายการที่อ้างอิงในเล่มถัดไปก่อน แล้วจึงยกเลิกเล่มนี้ได้ ' +
            `(โครงการที่ถูกอ้างอิง: ${blockingProjectIds.join(', ')})`,
          blockingProjectIds,
        });
      }

      // Step 4 — Deprecate the version row.
      await manager.update(SupplementAssemblyVersion, version.id, {
        status: SupplementAssemblyVersionStatus.DEPRECATED,
        deprecatedAt: new Date(),
        deprecatedById: workHistory.id,
        deprecationReason: dto.reason,
      });

      // Step 5 — Reset SPG booking state for every SPG in the
      // deprecated version's snapshot. Reuses the same helper as the
      // correction full-reset path so the behavior matches byte-for-
      // byte. wave-supplement-convergence-milestone-2-spg-booked-fields
      // / BE-01 (2026-05-25) — clears `isBooked` + `bookedAt` +
      // `pageNumber` (full §20 parity with PG/RPG via DB-01 columns).
      await this.resetSupplementProjectBooking(
        version.part3ProjectSnapshot ?? [],
        manager,
        version,
      );

      // Step 6 — Reset supplement state: `isBooked=false` +
      // `bookedAt=null`. Clearing bookedAt removes this supplement
      // from the §15 linear-chain predicate so older siblings unlock.
      // Reuses the same helper as the correction full-reset path.
      await this.resetSupplementState(supplementId, manager);

      // Step 6b — wave-supplement-convergence-milestone-4-lineage /
      // BE-01 (2026-05-25). Roll the SPG-lineage leaf pointers back
      // to the cancelled version's parent so a subsequent §15 / §18
      // sibling probe sees the pre-cancel leaf state. Mirrors
      // BookAssemblyService.restoreLineageAfterCancel at
      // book-assembly.service.ts:1282. Inside the same transaction —
      // a deprecation rollback also rolls back the leaf flips.
      await this.restoreLineageAfterSupplementCancel(version.id, manager);

      // Step 7 — M1 deferred: DeprecationAuditLog table parity. The
      // main-plan precedent writes a SUCCESS audit row here. M2 / M3
      // of this convergence wave will introduce the supplement audit
      // table; for M1 we rely on the version row's deprecation
      // columns (durable) + BE logger (operational).
      const identityMasked = `****${dto.citizenIdSuffix.slice(-2)}`;
      this.logger.log(
        `[SupplementAssembly] cancelPublishedVersion ` +
          `supplement=${supplementId} version=${version.id} ` +
          `v${version.versionNumber} by user=${userId} ` +
          `identity=${identityMasked} reason="${dto.reason.slice(0, 60)}"`,
      );
    });
  }

  // ===================================================================
  // Public API — Correct (wave-supplement-correction-workflow / BE-01)
  // ===================================================================

  /**
   * Deprecate the current COMPLETED supplement-assembly version and
   * spawn a new PREPARING draft pre-populated with the parts that are
   * NOT being corrected. Mirrors `BookAssemblyService.correct()` byte-
   * for-spirit (Q3=B duplicate — DO NOT import from `book-assembly`).
   *
   * Q1 = (a) Full parity with main-plan / edit / change (user direction
   * 2026-05-25). When `correctionMode === CORRECTION_PART3` the
   * supplement is rolled back to its pre-finalize state inside the
   * same transaction:
   *   1. Every `SupplementProjectGroup` in the deprecated version's
   *      `part3ProjectSnapshot` has its `isBooked` / `bookedAt` /
   *      `pageNumber` cleared. wave-supplement-convergence-milestone-
   *      2-spg-booked-fields / BE-01 (2026-05-25) — full §20 parity
   *      with PG/RPG (the DB-01 of the same wave added the columns;
   *      `tool-registry.ts:128` "always-booked-when-persisted"
   *      shortcut is lifted).
   *   2. The `DevelopmentPlanSupplement` row is set to
   *      `isBooked = false` and `bookedAt = null` — CRITICAL for §15
   *      Model A linear-chain: clearing `bookedAt` removes the
   *      supplement from the strictly-newer-bookedAt sibling probe so
   *      older siblings unlock automatically.
   *   3. Part 1 + Part 2 file copies are REUSED into the new draft;
   *      Part 3 stays PENDING — admin must regenerate it from the
   *      current approval state via `generatePart3`.
   * Skipped vs. main-plan: `PlanPhase.isMerged = false` reset — supplement
   * has no PlanPhase relation; it IS the round.
   *
   * For `CORRECTION_PART1` / `CORRECTION_PART2` the cascade is skipped
   * entirely; the two other parts (including Part 3 file + snapshot +
   * pageMap-equivalent metadata) are reused unchanged.
   *
   * CLAUDE.md compliance:
   *   - §15 — `BookLockService.assertEditable(..., 'development_plan_
   *     supplement', em)` runs BEFORE every write so a supplement
   *     locked by a strictly-newer-booked sibling cannot be corrected.
   *   - §17.2 — no AI side-effects.
   *   - §18 — correction is NOT a §18 cancel/finalize trigger; the
   *     orphan cleanup service is NOT invoked from this path.
   *   - §12 audit — the version row carries the `deprecation_reason`
   *     and `deprecated_by_id` columns; there is no supplement
   *     equivalent of `DeprecationAuditLog` yet (deferred per the
   *     task §4 Out of Scope note).
   */
  async correct(
    supplementId: string,
    dto: CorrectSupplementBookDto,
    userId: string,
  ): Promise<SupplementAssemblyDraftDto> {
    // The `cancellation` variant is intentionally excluded from the
    // supplement enum, but we keep a defensive guard symmetric with
    // BookAssemblyService for future-proofing.
    if (
      (dto.correctionMode as string) !==
        SupplementAssemblyCorrectionMode.CORRECTION_PART1 &&
      (dto.correctionMode as string) !==
        SupplementAssemblyCorrectionMode.CORRECTION_PART2 &&
      (dto.correctionMode as string) !==
        SupplementAssemblyCorrectionMode.CORRECTION_PART3
    ) {
      throw new BadRequestException(
        'correctionMode ต้องเป็น correction_part1, correction_part2 หรือ correction_part3',
      );
    }

    return this.dataSource.transaction(async (manager) => {
      // §15 lock — block when a strictly-newer-booked sibling exists.
      await this.bookLockService.assertEditable(
        supplementId,
        'development_plan_supplement',
        manager,
      );

      // Step 1 — validate operator (role, workStatus, confirmation,
      // citizenId suffix). Mirrors `BookAssemblyService.validate
      // DeprecationAuth`.
      const { workHistory } = await this.validateSupplementDeprecationAuth(
        dto.confirmed,
        dto.citizenIdSuffix,
        userId,
        manager,
      );

      // Step 2 — load the current COMPLETED version under a pessimistic
      // write lock so a concurrent merge/cancel cannot race.
      const currentVersion = await this.loadCompletedVersionForUpdate(
        supplementId,
        manager,
      );

      // Step 3a — reject if a CANCELED draft is still parked (would
      // collide with the partial-unique index `uniq_sad_active_draft`
      // on restore — admin must restore or purge first).
      const canceledDraft = await manager.findOne(SupplementAssemblyDraft, {
        where: {
          developmentPlanSupplementId: supplementId,
          assemblyStatus: SupplementAssemblyDraftStatus.CANCELED,
        },
      });
      if (canceledDraft) {
        throw new ConflictException({
          message:
            'มี draft ที่ยกเลิกแล้วอยู่ กรุณากู้คืนหรือลบทิ้งก่อนดำเนินการแก้ไข',
          errorCode: 'CANCELED_DRAFT_EXISTS',
          canceledDraftId: canceledDraft.id,
        });
      }

      // Step 3b — reject if an active (PREPARING / READY) draft already
      // exists. Correction creates a NEW draft and there is at most one
      // active draft per supplement.
      const activeDraft = await manager.findOne(SupplementAssemblyDraft, {
        where: [
          {
            developmentPlanSupplementId: supplementId,
            assemblyStatus: SupplementAssemblyDraftStatus.PREPARING,
          },
          {
            developmentPlanSupplementId: supplementId,
            assemblyStatus: SupplementAssemblyDraftStatus.READY,
          },
        ],
      });
      if (activeDraft) {
        throw new ConflictException({
          message:
            'มี draft รวมเล่มที่กำลังดำเนินการอยู่แล้ว ไม่สามารถเริ่มแก้ไขใหม่ได้',
          errorCode: 'ACTIVE_DRAFT_EXISTS',
          activeDraftId: activeDraft.id,
        });
      }

      const isFullReset =
        dto.correctionMode ===
        SupplementAssemblyCorrectionMode.CORRECTION_PART3;

      // Step 3c — §14.11 correction-time descendant guard (parity with
      // the cancel guard above). CORRECTION_PART3 un-books every SPG in
      // the deprecated version's snapshot (Step 5 resetSupplementProjectBooking).
      // If ANY of those SPGs was forked into a LATER book (live §14
      // descendant, prev_project_type='supplement', §14.7), un-booking it
      // here would strand the forked source: the downstream fork still
      // points at it, so the source stays permanently §14-locked while its
      // booked standing is gone ("ขาดช่วง"). Block exactly as cancel does.
      // Reuses LineageLockService — no parallel query. Runs INSIDE the
      // transaction, BEFORE the deprecate/un-book writes. PART1/PART2 leave
      // SPGs booked, so they are NOT guarded.
      if (isFullReset) {
        const snapshotIds = currentVersion.part3ProjectSnapshot ?? [];
        const blockingProjectIds = await this.collectDownstreamForkIds(
          snapshotIds,
          manager,
        );
        if (blockingProjectIds.length > 0) {
          throw new ConflictException({
            code: 'BOOK_PROJECTS_REFERENCED_DOWNSTREAM',
            message:
              'ไม่สามารถยกเลิกเล่มนี้ได้ เนื่องจากมีโครงการในเล่มนี้ถูกนำไปใช้ต่อ (fork) ในเล่มอื่นที่ออกภายหลัง ' +
              'กรุณาลบรายการที่อ้างอิงในเล่มถัดไปก่อน แล้วจึงยกเลิกเล่มนี้ได้ ' +
              `(โครงการที่ถูกอ้างอิง: ${blockingProjectIds.join(', ')})`,
            blockingProjectIds,
          });
        }
      }

      // Step 4 — deprecate the current version.
      await manager.update(SupplementAssemblyVersion, currentVersion.id, {
        status: SupplementAssemblyVersionStatus.DEPRECATED,
        deprecatedAt: new Date(),
        deprecatedById: workHistory.id,
        deprecationReason: dto.reason,
      });

      // Step 5 — Q1=a full reset side-effects (Part 3 correction only).
      // The cascade is NOT a §18 orphan cleanup — it is a data-rollback
      // of the LIVE supplement state so the admin can regenerate Part 3
      // from the current approval set.
      if (isFullReset) {
        await this.resetSupplementProjectBooking(
          currentVersion.part3ProjectSnapshot ?? [],
          manager,
          currentVersion,
        );
        await this.resetSupplementState(supplementId, manager);
        // wave-supplement-convergence-milestone-4-lineage / BE-01
        // (2026-05-25). Roll the SPG-lineage leaf pointers back to
        // the deprecated current version's parent. Without this, v1's
        // lineage rows would stay `is_current_leaf=true` while v1 is
        // DEPRECATED — making the leaf state divergent from the
        // version state until the (potentially never-merged) v2 fires
        // populateLineageForSupplementMerge. Note this is a deliberate
        // divergence from BookAssemblyService.correct() which leaves
        // lineage repair to the next merge; for supplements we keep
        // leaf state coherent immediately so §15 / §18 sibling probes
        // observe accurate "current leaf" semantics on an abandoned
        // correction draft. Part 1 / Part 2 correction skips this
        // call because the Part 3 snapshot — and therefore the SPG
        // set — is preserved across those modes.
        await this.restoreLineageAfterSupplementCancel(
          currentVersion.id,
          manager,
        );
      }

      // Step 6 — create the new draft. `targetVersion` is the version
      // this draft will become on merge.
      const nextVersion = currentVersion.versionNumber + 1;
      const correctLocation = await this.resolveLocation(
        supplementId,
        manager,
      );
      this.fileService.ensureVersionFolders(correctLocation, nextVersion);

      const draft = manager.create(SupplementAssemblyDraft, {
        developmentPlanSupplementId: supplementId,
        targetVersion: nextVersion,
        previousVersionId: currentVersion.id,
        correctionMode: dto.correctionMode,
        correctionReason: dto.reason,
        assemblyStatus: SupplementAssemblyDraftStatus.PREPARING,
        part1Status: SupplementAssemblyPartUploadStatus.PENDING,
        part2Status: SupplementAssemblyPartUploadStatus.PENDING,
        part3Status: SupplementAssemblyPartUploadStatus.PENDING,
        createdById: workHistory.id,
      });

      // Step 7 — auto-reuse parts that are NOT being corrected. Part 3
      // is ALSO skipped on full reset so the admin must regenerate it.
      const correctingPart: PartNumber =
        dto.correctionMode ===
        SupplementAssemblyCorrectionMode.CORRECTION_PART1
          ? 1
          : dto.correctionMode ===
              SupplementAssemblyCorrectionMode.CORRECTION_PART2
            ? 2
            : 3;

      for (const pn of [1, 2, 3] as const) {
        if (pn === correctingPart) continue;
        if (pn === 3 && isFullReset) continue;

        try {
          this.fileService.copyPartFromVersion(
            correctLocation,
            currentVersion.versionNumber,
            nextVersion,
            pn,
          );
          const fallbackFilename = `part-${pn}.pdf`;
          const reusedFilename =
            this.readPartFilenameFromMetadata(currentVersion, pn) ??
            fallbackFilename;
          const now = new Date();
          if (pn === 1) {
            draft.part1Status = SupplementAssemblyPartUploadStatus.REUSED;
            draft.part1Source = SupplementAssemblyPartSource.REUSED;
            draft.part1OriginalFileName = reusedFilename;
            draft.part1UploadedAt = now;
          } else if (pn === 2) {
            draft.part2Status = SupplementAssemblyPartUploadStatus.REUSED;
            draft.part2Source = SupplementAssemblyPartSource.REUSED;
            draft.part2OriginalFileName = reusedFilename;
            draft.part2UploadedAt = now;
          } else {
            // Only reached on CORRECTION_PART1 / CORRECTION_PART2 paths
            // (full-reset branch `continue`s above).
            draft.part3Status = SupplementAssemblyPartUploadStatus.REUSED;
            draft.part3Source = SupplementAssemblyPartSource.REUSED;
            draft.part3OriginalFileName = reusedFilename;
            draft.part3GeneratedAt = now;
          }
        } catch (copyError) {
          this.logger.warn(
            `[SupplementAssembly] correct: failed to reuse part-${pn} from v${currentVersion.versionNumber}: ${
              (copyError as Error)?.message
            }`,
          );
          // Part stays PENDING — admin must provide it before merge.
        }
      }

      // Step 8 — recompute draft assemblyStatus (READY vs PREPARING).
      draft.assemblyStatus = this.computeDraftStatus(draft);
      const saved = await manager.save(SupplementAssemblyDraft, draft);

      this.logger.log(
        `[SupplementAssembly] correct supplement=${supplementId} v${currentVersion.versionNumber} → ` +
          `draft v${nextVersion} [mode=${dto.correctionMode}] isFullReset=${isFullReset}`,
      );

      // Re-fetch with relations so the response DTO carries createdBy.user.
      const full = await manager.findOne(SupplementAssemblyDraft, {
        where: { id: saved.id },
        relations: ['createdBy', 'createdBy.user'],
      });
      return this.toDraftDto(full ?? saved);
    });
  }

  // ===================================================================
  // Public API — Upload / generate parts
  // ===================================================================

  /**
   * Upload Part 1 (cover / front matter).
   * Per the BE_01 file-service contract, the uploaded buffer is written
   * under the NEXT version folder (i.e. the version the active draft
   * will become on merge). Wave A always writes to `vN` where
   * `N = MAX(version)+1` per supplement.
   */
  async uploadPart1(
    supplementId: string,
    userId: string,
    buffer: Buffer,
    filename: string,
  ): Promise<SupplementAssemblyDraftDto> {
    return this.uploadPartInternal(
      supplementId,
      userId,
      1,
      buffer,
      filename,
      SupplementAssemblyPartSource.UPLOADED,
    );
  }

  /**
   * Upload Part 2 (project list / summary).
   */
  async uploadPart2(
    supplementId: string,
    userId: string,
    buffer: Buffer,
    filename: string,
  ): Promise<SupplementAssemblyDraftDto> {
    return this.uploadPartInternal(
      supplementId,
      userId,
      2,
      buffer,
      filename,
      SupplementAssemblyPartSource.UPLOADED,
    );
  }

  // ===================================================================
  // Public API — Readiness (wave-supplement-assembly-button-gate / BE-01)
  // ===================================================================

  /**
   * Compute the readiness envelope for a supplement so the FE
   * `BookAssemblyDashboard` / `DraftPanel` can drive the Part 3 lock +
   * "รวมเล่ม" enable gate.
   *
   * Shape parity: returns `SupplementReadinessDto` whose fields match
   * `RevisionReadinessDto` byte-for-byte (intentional — the shared FE
   * adapter at `bookAssemblyService.ts:706-742` calls this endpoint
   * under the `SUPPLEMENT` source-type branch and expects the same
   * envelope; per Q10=B we DO NOT import the main-plan DTO type).
   *
   * Predicate parity (CRITICAL):
   *   - `approvedCount` keys on `latest TrackingStatus.status.name =
   *     'Approved'`, matching `listSupplementProjectsForPdf({
   *     approvedOnly: true })` used by both `generatePart3` and
   *     `merge`. This guarantees preview-time and finalize-time agree.
   *   - `totalCount` excludes Ready / Pull_Back / Rejected per the
   *     main-plan W-BE-01 patch (2026-05-22) and the BE-01 task
   *     contract. Rationale per the constant docblock above.
   *
   * `hasOpenPhase` semantics (per CLAUDE.md §15 + task header):
   *   - `DevelopmentPlanSupplement.isOpen = true` ⇒ `hasOpenPhase=true`
   *     ⇒ `isReady=false` (round must be closed before merge).
   *   - There is no separate `PlanPhase` for supplements; the
   *     supplement IS the round. The field name `hasOpenPhase` is
   *     preserved purely for shape parity with the main-plan DTO.
   *
   * `isReady` formula (main-plan parity, §15 + W110):
   *   `approvedCount === totalCount && totalCount > 0 && !hasOpenPhase`
   *
   * CLAUDE.md compliance:
   *   - §12 — pure read; NO `TrackingStatus` rows written.
   *   - §15 — no book mutation; lock not enforced here (read-only).
   *   - §17.2 — advisory only; FE MUST NOT gate workflow on this
   *     beyond the merge-button affordance. The merge endpoint
   *     re-validates approvedProjects.length > 0 at finalize time and
   *     stays the source of truth for the cascade.
   *   - §18 — no orphan-cleanup interaction.
   */
  async getReadiness(
    supplementId: string,
    userId: string,
  ): Promise<SupplementReadinessDto> {
    // Auth — read scope (staff + admin + super-admin) mirrors every
    // other readiness/version GET in this service.
    await this.loadAndValidateWorkHistory(userId, READ_ROLES);

    // 404 if the supplement is missing / soft-deleted. `withDeleted:
    // false` is the TypeORM default for `@DeleteDateColumn` — we set
    // it explicitly for self-documentation.
    const supplement = await this.supplementRepo.findOne({
      where: { id: supplementId },
      withDeleted: false,
    });
    if (!supplement) {
      throw new NotFoundException(
        `ไม่พบรอบเพิ่มเติม (DevelopmentPlanSupplement ${supplementId})`,
      );
    }

    // --- scalar counts ---
    // totalCount: non-deleted SPGs whose latest tracking status is NOT
    // in the exclusion list. The `innerJoin` on `trackingStatus.statusId`
    // mirrors the main-plan predicate exactly (note: the TypeORM
    // relation name is `statusId` even though the joined table is
    // `status` — see `tracking-status.entity.ts:107-112`).
    const totalCount = await this.spgRepo
      .createQueryBuilder('spg')
      .innerJoin('spg.trackingStatus', 'ts')
      .innerJoin('ts.statusId', 'status')
      .where('spg.developmentPlanSupplement = :supplementId', { supplementId })
      .andWhere('spg.deletedAt IS NULL')
      .andWhere('ts.isLatest = :isLatest', { isLatest: true })
      .andWhere('status.name NOT IN (:...excludedStatuses)', {
        excludedStatuses: SUPPLEMENT_READINESS_EXCLUSION_STATUSES,
      })
      .getCount();

    const approvedCount = await this.spgRepo
      .createQueryBuilder('spg')
      .innerJoin('spg.trackingStatus', 'ts')
      .innerJoin('ts.statusId', 'status')
      .where('spg.developmentPlanSupplement = :supplementId', { supplementId })
      .andWhere('spg.deletedAt IS NULL')
      .andWhere('ts.isLatest = :isLatest', { isLatest: true })
      .andWhere('status.name = :statusName', {
        statusName: STATUS_NAMES.APPROVED,
      })
      .getCount();

    const hasOpenPhase = supplement.isOpen === true;
    const isReady =
      approvedCount === totalCount && totalCount > 0 && !hasOpenPhase;

    // --- breakdown: origin (agency vs lao) ---
    // SPG is agency-only per Q1+Q2 of `workflow-add-project-supplement.md`,
    // so `laoCount` is structurally 0 today. We keep the query shape
    // identical to the main-plan / revision counterpart so a future
    // scope-widening doesn't require a parallel refactor.
    const agencyCount = await this.spgRepo
      .createQueryBuilder('spg')
      .innerJoin('spg.createdBy', 'wh')
      .innerJoin('wh.amphoe', 'amp')
      .innerJoin('wh.localAdministrativeOrganization', 'lao')
      .innerJoin('spg.trackingStatus', 'ts')
      .innerJoin('ts.statusId', 'status')
      .where('spg.developmentPlanSupplement = :supplementId', { supplementId })
      .andWhere('spg.deletedAt IS NULL')
      .andWhere('ts.isLatest = :isLatest', { isLatest: true })
      .andWhere('status.name NOT IN (:...excludedStatuses)', {
        excludedStatuses: SUPPLEMENT_READINESS_EXCLUSION_STATUSES,
      })
      .andWhere('amp.id = :amphoeId', { amphoeId: '3001' })
      .andWhere('lao.id = :laoId', { laoId: '3001027' })
      .getCount();

    const laoCount = totalCount - agencyCount;

    // --- breakdown: status counts via a single aggregation query ---
    const statusRows: { statusName: string; cnt: string }[] = await this.spgRepo
      .createQueryBuilder('spg')
      .select('status.name', 'statusName')
      .addSelect('COUNT(spg.id)', 'cnt')
      .innerJoin('spg.trackingStatus', 'ts')
      .innerJoin('ts.statusId', 'status')
      .where('spg.developmentPlanSupplement = :supplementId', { supplementId })
      .andWhere('spg.deletedAt IS NULL')
      .andWhere('ts.isLatest = :isLatest', { isLatest: true })
      .groupBy('status.name')
      .getRawMany();

    const statusMap = this.buildStatusMap(statusRows);

    const breakdown: SupplementReadinessBreakdownDto = {
      agencyCount,
      laoCount,
      pendingCount: statusMap[STATUS_NAMES.PENDING] ?? 0,
      verifiedCount: statusMap[STATUS_NAMES.VERIFIED] ?? 0,
      pendingApprovalCount: statusMap[STATUS_NAMES.PENDING_APPROVAL] ?? 0,
      approvedCount: statusMap[STATUS_NAMES.APPROVED] ?? 0,
      readyCount: statusMap[STATUS_NAMES.READY] ?? 0,
      returnedForRevisionCount:
        statusMap[STATUS_NAMES.RETURNED_FOR_REVISION] ?? 0,
      pullBackCount: statusMap[STATUS_NAMES.PULL_BACK] ?? 0,
      rejectedCount: statusMap[STATUS_NAMES.REJECTED] ?? 0,
      totalCount,
    };

    this.logger.log(
      `[SupplementAssembly] getReadiness supplement=${supplementId} ` +
        `approvedCount=${approvedCount} totalCount=${totalCount} ` +
        `isReady=${isReady} hasOpenPhase=${hasOpenPhase}`,
    );

    return { approvedCount, totalCount, isReady, hasOpenPhase, breakdown };
  }

  /**
   * Aggregation helper — flatten `{ statusName, cnt }[]` raw rows into
   * a `Record<statusName, number>` lookup so the breakdown DTO can pull
   * each canonical status count by name. Mirrors
   * `BookAssemblyService.buildStatusMap` for shape parity (private to
   * each service per Q10=B isolation; the duplication is intentional).
   */
  private buildStatusMap(
    rows: { statusName: string; cnt: string }[],
  ): Record<string, number> {
    const out: Record<string, number> = {};
    for (const row of rows) {
      const parsed = parseInt(row.cnt, 10);
      out[row.statusName] = Number.isFinite(parsed) ? parsed : 0;
    }
    return out;
  }

  // ===================================================================
  // Public API — Display State (book-state)
  // ===================================================================

  /**
   * Compute the display state for a supplement so the FE
   * `BookAssemblyDashboard` / `VersionCard` can render the correct
   * lock badge AND surface the "จัดการ" (manage) overflow menu — the
   * menu only mounts when `state === 'published_latest'`.
   *
   * State derivation:
   *   - `no_book`            — supplement not booked AND no active draft
   *   - `draft`              — supplement not booked AND an active
   *                            (preparing | ready) draft exists
   *   - `frozen_historical`  — supplement booked AND NOT leaf (locked
   *                            by a strictly-newer-booked sibling per
   *                            the §15 linear-chain predicate)
   *   - `published_latest`   — supplement booked AND leaf (head of the
   *                            §15 lineage chain)
   *
   * `isLeaf` is decided by `BookLockService.assertEditable(..., 'develo
   * pment_plan_supplement', em)` in a try/catch. The service throws
   * `ConflictException(BOOK_HAS_NEWER_REVISION)` when a strictly-newer
   * sibling has booked at a later timestamp; we catch that specific
   * conflict and translate it to `isLeaf = false`. All other exceptions
   * propagate.
   *
   * `hasActiveDraftDependency` / `blockedProjectCount` are hard-coded
   * Wave-A defaults — supplement does not have a cross-book project
   * leaf-tracking structure equivalent to `book_project_lineage` today.
   * If a future wave introduces SUPPLEMENT lineage edges, these can be
   * derived analogously to `BookAssemblyService.getBookDisplayState`.
   *
   * CLAUDE.md compliance:
   *   - §15 — leaf-ness uses the §15.2 / §15.3 linear-chain predicate
   *           via `BookLockService`. No book mutation.
   *   - §17.2 — advisory only; this endpoint MUST NOT gate any workflow
   *           transition. It only drives FE affordance visibility.
   *   - §18 — no orphan-cleanup interaction; pure read.
   */
  async getBookDisplayState(
    supplementId: string,
    userId: string,
  ): Promise<SupplementBookDisplayStateDto> {
    // Auth — read scope (staff + admin + super-admin) mirrors every
    // other read endpoint in this service.
    await this.loadAndValidateWorkHistory(userId, READ_ROLES);

    // 404 on missing / soft-deleted supplement. `withDeleted: false` is
    // the @DeleteDateColumn default — set explicitly for clarity.
    const supplement = await this.supplementRepo.findOne({
      where: { id: supplementId },
      withDeleted: false,
    });
    if (!supplement) {
      throw new NotFoundException(
        `ไม่พบรอบเพิ่มเติม (DevelopmentPlanSupplement ${supplementId})`,
      );
    }

    // Leaf detection — delegate to BookLockService which encodes the
    // §15 linear-chain-by-bookedAt predicate (any non-soft-deleted,
    // booked sibling under the same plan with `bookedAt > self.bookedAt`
    // locks us). Drafts (bookedAt IS NULL) auto-report as leaf per the
    // service contract.
    let isLeaf: boolean;
    try {
      await this.bookLockService.assertEditable(
        supplementId,
        'development_plan_supplement',
        this.supplementRepo.manager,
      );
      isLeaf = true;
    } catch (err) {
      // Only translate the canonical BOOK_HAS_NEWER_REVISION conflict
      // into `isLeaf = false`. Any other failure (DB outage, schema
      // drift) MUST propagate so we don't silently mislabel a frozen
      // book as a leaf.
      if (
        err instanceof ConflictException &&
        typeof err.message === 'string' &&
        err.message.includes('BOOK_HAS_NEWER_REVISION')
      ) {
        isLeaf = false;
      } else {
        throw err;
      }
    }

    // State machine — supplement booked ⇒ published_latest | frozen_
    // historical (split by leaf); not booked ⇒ draft | no_book (split
    // by presence of an active draft).
    let state: SupplementBookDisplayStateEnum;
    if (supplement.isBooked) {
      state = isLeaf
        ? SupplementBookDisplayStateEnum.PUBLISHED_LATEST
        : SupplementBookDisplayStateEnum.FROZEN_HISTORICAL;
    } else {
      const activeDraft = await this.findActiveDraft(supplementId);
      state = activeDraft
        ? SupplementBookDisplayStateEnum.DRAFT
        : SupplementBookDisplayStateEnum.NO_BOOK;
    }

    this.logger.log(
      `[SupplementAssembly] getBookDisplayState supplement=${supplementId} ` +
        `isBooked=${supplement.isBooked} isLeaf=${isLeaf} state=${state}`,
    );

    return {
      supplementId,
      isLeaf,
      state,
      // Wave-A defaulting — see DTO docblock.
      hasActiveDraftDependency: false,
      blockedProjectCount: 0,
    };
  }

  /**
   * Generate Part 3 (auto-rendered detail PDF) by delegating to
   * `SupplementPdfService.generateSupplementPdfBuffer`. NO new renderer
   * — the existing approved-finalize renderer is reused with
   * `variant='approved'` so the output matches the eventual merged book.
   *
   * The generated buffer is written to disk by the file service under
   * the active draft's target version folder, then the draft row is
   * updated with `source='generated'`.
   */
  async generatePart3(
    supplementId: string,
    userId: string,
  ): Promise<SupplementAssemblyDraftDto> {
    const workHistory = await this.loadAndValidateWorkHistory(
      userId,
      ADMIN_ROLES,
    );

    return this.dataSource.transaction(async (manager) => {
      await this.bookLockService.assertEditable(
        supplementId,
        'development_plan_supplement',
        manager,
      );

      const { supplement, plan } = await this.loadSupplementOrFail(
        supplementId,
        manager,
      );
      const draft = await this.loadActiveDraftOrFail(supplementId, manager);

      // Load approved SPGs (preview-time set used for Part 3 generation).
      // This intentionally mirrors the finalize predicate so the
      // generated Part 3 PDF reflects the same body as the eventual
      // merge will print.
      const approvedProjects = await this.pdfService.listSupplementProjectsForPdf(
        supplementId,
        { approvedOnly: true, em: manager },
      );
      if (approvedProjects.length === 0) {
        throw new BadRequestException(
          'ยังไม่มีโครงการอนุมัติในรอบนี้ ไม่สามารถสร้างส่วนที่ 3 ได้',
        );
      }

      const generatedByName = await this.resolveWorkHistoryDisplayName(
        workHistory,
        manager,
      );

      // Reuse the existing renderer (Q-critical: DO NOT write a new one).
      const buffer = await this.pdfService.generateSupplementPdfBuffer({
        supplement,
        plan,
        projects: approvedProjects,
        selectedColumns: [
          'index',
          'title',
          'objective',
          'target',
          'budget',
          'expectedResult',
          'mainAgency',
        ],
        variant: 'approved',
        generatedAt: new Date(),
        generatedByName,
        // SPG agency-only (§5.1) → responsibleAgency known. Mirrors the
        // existing finalizeSupplementApproved override.
        reportType: 'inAuthority',
      });

      const targetVersion = await this.computeNextVersion(
        supplementId,
        manager,
      );
      // Wave 3 BE-WRITERS — plan-rooted file-service API requires the
      // SupplementLocation (planId + supplementNumber + supplementId).
      const part3Location = await this.resolveLocation(supplementId, manager);
      this.fileService.ensureVersionFolders(part3Location, targetVersion);
      const filename = `part-3.pdf`;
      this.fileService.writePart(part3Location, targetVersion, 3, buffer);

      draft.part3Status = SupplementAssemblyPartUploadStatus.GENERATED;
      draft.part3Source = SupplementAssemblyPartSource.GENERATED;
      draft.part3OriginalFileName = filename;
      draft.part3GeneratedAt = new Date();
      draft.assemblyStatus = this.computeDraftStatus(draft);

      const saved = await manager.save(SupplementAssemblyDraft, draft);

      this.logger.log(
        `[SupplementAssembly] generatePart3 supplement=${supplementId} version=${targetVersion} projects=${approvedProjects.length}`,
      );
      return this.toDraftDto(saved);
    });
  }

  /**
   * Reuse a part from an older version into the active draft. Copies
   * the source part file into the current draft's target version folder
   * via the file service. Wave A scope per Q4=C only supports the
   * trivial case where the source version exists for this supplement.
   */
  async reusePart(
    supplementId: string,
    userId: string,
    partNumber: number,
    fromVersion: number,
  ): Promise<SupplementAssemblyDraftDto> {
    await this.loadAndValidateWorkHistory(userId, ADMIN_ROLES);
    this.fileService.validatePartNumber(partNumber);
    this.fileService.validateVersionNumber(fromVersion);

    return this.dataSource.transaction(async (manager) => {
      await this.bookLockService.assertEditable(
        supplementId,
        'development_plan_supplement',
        manager,
      );

      const draft = await this.loadActiveDraftOrFail(supplementId, manager);

      const sourceVersion = await manager.findOne(SupplementAssemblyVersion, {
        where: {
          developmentPlanSupplementId: supplementId,
          versionNumber: fromVersion,
        },
      });
      if (!sourceVersion) {
        throw new NotFoundException(
          `ไม่พบเวอร์ชัน v${fromVersion} ของรอบเพิ่มเติมนี้`,
        );
      }

      const targetVersion = await this.computeNextVersion(
        supplementId,
        manager,
      );
      // Wave 3 BE-WRITERS — plan-rooted file-service API.
      const reuseLocation = await this.resolveLocation(supplementId, manager);
      this.fileService.ensureVersionFolders(reuseLocation, targetVersion);
      this.fileService.copyPartFromVersion(
        reuseLocation,
        fromVersion,
        targetVersion,
        partNumber,
      );

      const filename = `part-${partNumber}.pdf`;
      const now = new Date();
      if (partNumber === 1) {
        draft.part1Status = SupplementAssemblyPartUploadStatus.REUSED;
        draft.part1Source = SupplementAssemblyPartSource.REUSED;
        draft.part1OriginalFileName = filename;
        draft.part1UploadedAt = now;
      } else if (partNumber === 2) {
        draft.part2Status = SupplementAssemblyPartUploadStatus.REUSED;
        draft.part2Source = SupplementAssemblyPartSource.REUSED;
        draft.part2OriginalFileName = filename;
        draft.part2UploadedAt = now;
      } else {
        draft.part3Status = SupplementAssemblyPartUploadStatus.REUSED;
        draft.part3Source = SupplementAssemblyPartSource.REUSED;
        draft.part3OriginalFileName = filename;
        draft.part3GeneratedAt = now;
      }
      draft.assemblyStatus = this.computeDraftStatus(draft);
      const saved = await manager.save(SupplementAssemblyDraft, draft);

      this.logger.log(
        `[SupplementAssembly] reusePart supplement=${supplementId} part=${partNumber} fromV=${fromVersion} targetV=${targetVersion}`,
      );
      return this.toDraftDto(saved);
    });
  }

  /**
   * Read a part file from the active draft's target version folder.
   * Read-only; bypasses §15 lock per §15.5.
   */
  async viewDraftPart(
    supplementId: string,
    userId: string,
    partNumber: number,
  ): Promise<Buffer> {
    await this.loadAndValidateWorkHistory(userId, READ_ROLES);
    this.fileService.validatePartNumber(partNumber);

    const draft = await this.findActiveDraft(supplementId);
    if (!draft) {
      throw new NotFoundException(
        'ไม่พบ draft รวมเล่มที่กำลังดำเนินการสำหรับรอบเพิ่มเติมนี้',
      );
    }

    // Wave 3 BE-WRITERS — plan-rooted file-service API requires
    // SupplementLocation. Use the default repo manager (no caller-tx).
    const location = await this.resolveLocation(
      supplementId,
      this.supplementRepo.manager,
    );
    const targetVersion = await this.computeNextVersion(supplementId);
    return this.fileService.readPart(location, targetVersion, partNumber);
  }

  /**
   * Concatenated merge preview (Part1 + Part2 + Part3). Read-only,
   * pre-finalize. Useful for FE_02 confirmation modal.
   */
  async preview(supplementId: string, userId: string): Promise<Buffer> {
    await this.loadAndValidateWorkHistory(userId, READ_ROLES);

    const draft = await this.findActiveDraft(supplementId);
    if (!draft) {
      throw new NotFoundException(
        'ไม่พบ draft รวมเล่มที่กำลังดำเนินการสำหรับรอบเพิ่มเติมนี้',
      );
    }
    if (!this.areAllPartsReady(draft)) {
      throw new BadRequestException(
        'กรุณาอัปโหลด/สร้างไฟล์ครบทั้ง 3 ส่วนก่อนพรีวิวเล่มรวม',
      );
    }

    // Wave 3 BE-WRITERS — plan-rooted file-service API.
    const previewLocation = await this.resolveLocation(
      supplementId,
      this.supplementRepo.manager,
    );
    const targetVersion = await this.computeNextVersion(supplementId);
    const part1 = this.fileService.readPart(previewLocation, targetVersion, 1);
    const part2 = this.fileService.readPart(previewLocation, targetVersion, 2);
    const part3 = this.fileService.readPart(previewLocation, targetVersion, 3);
    return this.mergePdfBuffers([part1, part2, part3]);
  }

  // ===================================================================
  // Public API — Finalize (§18.2.1 CRITICAL)
  // ===================================================================

  /**
   * Finalize the active draft into a new persisted version.
   *
   * CRITICAL TRANSACTIONAL FLOW (§18.2.1):
   *   1. authority guards (role + workStatus)
   *   2. pessimistic_write lock on supplement; load + plan
   *   3. §15 lock check (`BookLockService.assertEditable`)
   *   4. idempotency — if already booked, return latest version
   *   5. load + validate active draft (must be READY)
   *   6. load approved SPGs (zero → 400 BEFORE cascade)
   *   7. compute next version number (per-supplement)
   *   8. write merged buffer to disk
   *   9. insert version row + version-projects join (Q1=C)
   *   10. *** §18.2.1 cascade BEFORE isBooked flip ***
   *   11. flip `supplement.isBooked = true`
   *   12. mark draft as MERGED
   *   13. return version DTO
   *
   * If ANY step (including the cascade — e.g.
   * `ORPHAN_CASCADE_HAS_LIVE_DESCENDANT`) throws, the entire transaction
   * rolls back: no version row, no isBooked flip, no draft.merged flip.
   * On-disk files written in step 8 are non-transactional but the DB
   * stays consistent (next finalize attempt overwrites — acceptable
   * per workflow doc Edge Cases).
   */
  async merge(
    supplementId: string,
    userId: string,
  ): Promise<SupplementAssemblyVersionDto> {
    // Step 1 — Authority guards (outside the transaction so role lookup
    // doesn't pollute the lock window).
    const workHistory = await this.loadAndValidateWorkHistory(
      userId,
      ADMIN_ROLES,
    );

    return this.dataSource.transaction(async (manager) => {
      // Step 2 — Pessimistic write lock on supplement + plan load. We
      // deliberately do NOT pass `relations` with `lock` (PostgreSQL +
      // TypeORM versioning fragility); load relation in a second pass.
      const lockedSupplement = await manager.findOne(
        DevelopmentPlanSupplement,
        {
          where: { id: supplementId },
          lock: { mode: 'pessimistic_write' },
        },
      );
      if (!lockedSupplement || lockedSupplement.deletedAt) {
        throw new NotFoundException(
          `ไม่พบรอบเพิ่มเติม (DevelopmentPlanSupplement ${supplementId})`,
        );
      }
      const supplementWithPlan = await manager.findOne(
        DevelopmentPlanSupplement,
        {
          where: { id: lockedSupplement.id },
          relations: ['developmentPlan'],
        },
      );
      if (!supplementWithPlan || !supplementWithPlan.developmentPlan) {
        throw new NotFoundException(
          `ไม่พบ DevelopmentPlan แม่ของรอบเพิ่มเติม ${supplementId}`,
        );
      }
      lockedSupplement.developmentPlan = supplementWithPlan.developmentPlan;

      // Step 4 — Idempotency. If already booked, return existing latest.
      // (Step ordering follows the spec; we run this before the §15
      // lock check so a stale §15 state on an already-booked round does
      // not produce a misleading 409.)
      if (lockedSupplement.isBooked) {
        // wave-supplement-assembly-metadata-parity / BE-01 — eager-load
        // createdBy.user so the idempotent re-merge response carries the
        // same shape as a fresh merge.
        // wave-supplement-convergence-milestone-3-multi-version / BE-01
        // (2026-05-25) — also eager-load deprecatedBy.user; idempotent
        // re-merge on a corrected-then-re-merged supplement should
        // return the same audit-chain projection as the canonical read.
        const latest = await manager.findOne(SupplementAssemblyVersion, {
          where: { developmentPlanSupplementId: supplementId },
          relations: [
            'createdBy',
            'createdBy.user',
            'deprecatedBy',
            'deprecatedBy.user',
          ],
          order: { versionNumber: 'DESC' },
        });
        if (latest) {
          return this.toVersionDto(latest);
        }
        // Defensive: marked booked but no version row exists. Don't
        // silently re-finalize — surface for human investigation.
        throw new ConflictException(
          'รอบเพิ่มเติมนี้ถูกทำเครื่องหมายว่ารวมเล่มแล้ว แต่ไม่พบเวอร์ชันใน supplement_assembly_versions',
        );
      }

      // Step 3 — §15 lock check (after idempotency short-circuit so an
      // already-booked round is never blocked).
      await this.bookLockService.assertEditable(
        supplementId,
        'development_plan_supplement',
        manager,
      );

      // Step 5 — Load + validate active draft.
      const draft = await manager.findOne(SupplementAssemblyDraft, {
        where: [
          {
            developmentPlanSupplementId: supplementId,
            assemblyStatus: SupplementAssemblyDraftStatus.READY,
          },
          {
            developmentPlanSupplementId: supplementId,
            assemblyStatus: SupplementAssemblyDraftStatus.PREPARING,
          },
        ],
      });
      if (!draft) {
        throw new BadRequestException(
          'NO_READY_DRAFT: ยังไม่มี draft รวมเล่มที่พร้อมรวมสำหรับรอบเพิ่มเติมนี้',
        );
      }
      if (!this.areAllPartsReady(draft)) {
        throw new BadRequestException(
          'NO_READY_DRAFT: ยังอัปโหลด/สร้างไฟล์ไม่ครบทั้ง 3 ส่วน',
        );
      }

      // Step 6 — Load approved SPGs (zero → 400 BEFORE cascade).
      const approvedProjects = await this.pdfService.listSupplementProjectsForPdf(
        supplementId,
        { approvedOnly: true, em: manager },
      );
      if (approvedProjects.length === 0) {
        throw new BadRequestException(
          'NO_APPROVED_PROJECTS: ยังไม่มีโครงการอนุมัติในรอบนี้',
        );
      }

      // Step 7 — Compute next version (per-supplement, Q9=A).
      const nextVersion = await this.computeNextVersion(supplementId, manager);

      // Step 8 — Write merged buffer to disk.
      // Wave 3 BE-WRITERS — plan-rooted file-service API. We already
      // hold `lockedSupplement.developmentPlan` from Step 2, so build
      // the location locally without a second DB roundtrip.
      const mergeLocation: SupplementLocation = {
        planId: lockedSupplement.developmentPlan.id,
        supplementId: lockedSupplement.id,
        supplementNumber: lockedSupplement.supplementNumber,
      };
      this.fileService.ensureVersionFolders(mergeLocation, nextVersion);
      const part1Buffer = this.fileService.readPart(
        mergeLocation,
        nextVersion,
        1,
      );
      const part2Buffer = this.fileService.readPart(
        mergeLocation,
        nextVersion,
        2,
      );
      const part3Buffer = this.fileService.readPart(
        mergeLocation,
        nextVersion,
        3,
      );
      // wave-supplement-assembly-metadata-parity / BE-01 — use the
      // pageCount-emitting merge variant so the version row carries
      // `totalPages` without a second PDFDocument.load roundtrip.
      // `mergedPageCount` is null only on the (defensive) catch path
      // inside `mergePdfBuffersWithMeta` for the single-buffer
      // shortcut — the standard 3-buffer path always yields a number.
      const { buffer: mergedBuffer, pageCount: mergedPageCount } =
        await this.mergePdfBuffersWithMeta([
          part1Buffer,
          part2Buffer,
          part3Buffer,
        ]);
      // `mergedPath` is the RELATIVE KEY (umbrella §7.2) — persisted
      // verbatim to `supplement_assembly_versions.merged_file_path`.
      const mergedPath = this.fileService.writeMerged(
        mergeLocation,
        nextVersion,
        mergedBuffer,
      );
      const mergedSha256 = this.fileService.sha256(mergedBuffer);

      // Step 10 — *** §18.2.1 CASCADE BEFORE isBooked FLIP ***
      // Runs inside the SAME transaction. Throws abort the entire
      // finalize (including the freshly-written version row below).
      const cascadeResult =
        await this.orphanCleanupService.cascadeOnBookFinalize(
          lockedSupplement,
          'SUPPLEMENT',
          manager,
          userId,
        );
      this.logger.log(
        `[SupplementAssembly] merge cascade supplement=${supplementId} pg=${cascadeResult.pgCount} rpg=${cascadeResult.rpgCount}`,
      );

      // Step 9 — Insert version row + version-projects join (Q1=C
      // lightweight join). The version row is inserted AFTER the
      // cascade so a cascade-throw (e.g. ORPHAN_CASCADE_HAS_LIVE_
      // DESCENDANT) rolls back cleanly without leaving an orphan
      // version FK target.
      // wave-supplement-assembly-metadata-parity / BE-01 — three new
      // metadata columns are populated inline. The snapshot pulls the
      // Thai `title` field off `SupplementProjectGroup` in the same
      // order as the version-projects join (i + 1 page number), which
      // matches the main-plan part3 snapshot contract byte-for-byte.
      const part3Snapshot = approvedProjects.map((p) => p.title);
      // wave-supplement-convergence-milestone-3-multi-version / BE-01
      // (2026-05-25) — propagate the draft's correction lineage onto the
      // new version row so the FE history list can render the audit
      // chain ("v2 was produced by correction_part3 on date X with
      // reason Y"). For a fresh v1 (draft created via `createDraft`,
      // not `correct`) both fields are NULL on the draft and therefore
      // NULL on the version row — same shape as the main-plan precedent
      // at `book-assembly.service.ts:1145-1146`.
      const versionRow = manager.create(SupplementAssemblyVersion, {
        developmentPlanSupplementId: supplementId,
        versionNumber: nextVersion,
        status: SupplementAssemblyVersionStatus.COMPLETED,
        correctionMode: draft.correctionMode ?? null,
        correctionReason: draft.correctionReason ?? null,
        mergedFilePath: mergedPath,
        mergedFileSha256: mergedSha256,
        createdById: workHistory.id,
        part3ProjectCount: approvedProjects.length,
        part3ProjectSnapshot: part3Snapshot,
        totalPages: mergedPageCount,
        metadataJson: {
          approvedSpgIds: approvedProjects.map((p) => p.id),
          parts: {
            part1: {
              source: draft.part1Source,
              filename: draft.part1OriginalFileName,
            },
            part2: {
              source: draft.part2Source,
              filename: draft.part2OriginalFileName,
            },
            part3: {
              source: draft.part3Source,
              filename: draft.part3OriginalFileName,
            },
          },
        },
      });
      const savedVersion = await manager.save(
        SupplementAssemblyVersion,
        versionRow,
      );

      // wave-supplement-convergence-milestone-4-lineage / BE-01
      // (2026-05-25) — populate the SPG lineage table inside the same
      // transaction. Runs AFTER savedVersion so the new leaf row has a
      // valid `supplementAssemblyVersionId` FK target. Mirrors
      // BookAssemblyService.populateLineageForMerge at
      // book-assembly.service.ts:1172 (CTO M4 Option B — segregated
      // DAG, do NOT import from book-assembly).
      await this.populateLineageForSupplementMerge(
        savedVersion.id,
        approvedProjects.map((p) => p.id),
        manager,
      );

      // wave-supplement-convergence-milestone-2-spg-booked-fields /
      // BE-01 (2026-05-25) — §20 parity with PG/RPG. Stamp the booked
      // state on every approved SPG in the snapshot BEFORE the version-
      // projects join writes per-row pageNumbers so the SPG row carries
      // (isBooked=true, bookedAt=now, pageNumber=N) in one consistent
      // post-finalize state. Mirrors BookAssemblyService.merge() which
      // writes isBooked/bookedAt on PG/RPG inside the same transaction.
      // The cascade in Step 10 only touches NON-Approved SPGs, so the
      // approvedProjects set is intact here.
      const finalizeBookedAt = new Date();
      await manager.getRepository(SupplementProjectGroup).update(
        { id: In(approvedProjects.map((p) => p.id)) },
        { isBooked: true, bookedAt: finalizeBookedAt },
      );

      // Version-projects join — pageNumber 1..N matching the renderer
      // sort. The cascade re-snapshot guarantee is satisfied because we
      // re-queried approved SPGs in step 6 BEFORE writing pageNumbers
      // (and cascade only touches NON-Approved SPGs, leaving the set
      // intact).
      for (let i = 0; i < approvedProjects.length; i += 1) {
        const spg = approvedProjects[i];
        const join = manager.create(SupplementAssemblyVersionProject, {
          versionId: savedVersion.id,
          supplementProjectGroupId: spg.id,
          pageNumber: i + 1,
        });
        await manager.save(SupplementAssemblyVersionProject, join);
      }

      // Step 11 — Flip supplement.isBooked = true. MUST run AFTER
      // cascade per §18.2.1.
      // wave-lineage-linear-chain-by-bookedAt / BE-01 — stamp
      // `bookedAt = now()` alongside `isBooked = true` so the §15
      // linear-chain-by-bookedAt predicate orders this supplement's
      // finalize moment correctly in the cross-category lock timeline.
      lockedSupplement.isBooked = true;
      lockedSupplement.bookedAt = new Date();
      await manager.save(DevelopmentPlanSupplement, lockedSupplement);

      // Step 12 — Mark draft as MERGED (terminal).
      draft.assemblyStatus = SupplementAssemblyDraftStatus.MERGED;
      await manager.save(SupplementAssemblyDraft, draft);

      this.logger.log(
        `[SupplementAssembly] merge supplement=${supplementId} version=${nextVersion} approvedSpgs=${approvedProjects.length}`,
      );

      // NOTE on post-commit notifications: the orphan cleanup service
      // buffers per-PG reset notifications keyed on the host book id.
      // PLAN / REVISION cleanups own that fanout. For SUPPLEMENT scope,
      // §18.7 explicitly silences SPG soft-delete notifications, so we
      // intentionally do NOT drain the buffer here — there is nothing
      // to dispatch by design.

      // wave-supplement-assembly-metadata-parity / BE-01 — re-fetch
      // inside the transaction so the response carries the eager-loaded
      // `createdBy.user` relation. Without this re-fetch the FE renders
      // a blank creator name on the version card immediately after the
      // merge POST returns (the bug this wave fixes). Mirrors main-plan
      // precedent at `book-assembly.service.ts:1171-1174`.
      // wave-supplement-convergence-milestone-3-multi-version / BE-01
      // (2026-05-25) — projection is uniform across read paths; include
      // `deprecatedBy.user` for symmetry. A freshly-merged version is
      // always COMPLETED so `deprecatedBy` resolves null, but the
      // relation lookup keeps the DTO shape stable for FE consumers.
      const fullVersion = await manager.findOne(SupplementAssemblyVersion, {
        where: { id: savedVersion.id },
        relations: [
          'createdBy',
          'createdBy.user',
          'deprecatedBy',
          'deprecatedBy.user',
        ],
      });

      return this.toVersionDto(fullVersion ?? savedVersion);
    });
  }

  // ===================================================================
  // Public API — Read versions
  // ===================================================================

  /**
   * List all versions (most recent first). Read-only.
   *
   * Returns BOTH COMPLETED and DEPRECATED rows so the FE history list
   * (wave-supplement-convergence-milestone-3-multi-version / FE-01) can
   * render the full lineage chain — e.g. "v2 (ปัจจุบัน)" stacked above
   * "v1 (ยกเลิกแล้ว)". Sort order is `versionNumber DESC` so the latest
   * row is first; deprecated rows interleave naturally by their original
   * version number.
   */
  async getVersions(
    supplementId: string,
    userId: string,
  ): Promise<SupplementAssemblyVersionDto[]> {
    await this.loadAndValidateWorkHistory(userId, READ_ROLES);
    // wave-supplement-assembly-metadata-parity / BE-01 — eager-load
    // createdBy.user so the FE version card can surface the creator
    // display name. Mirrors main-plan precedent.
    // wave-supplement-convergence-milestone-3-multi-version / BE-01
    // (2026-05-25) — also eager-load deprecatedBy.user so the history
    // list can attribute each retired version to the operator who
    // cancelled or corrected it.
    const rows = await this.versionRepo.find({
      where: { developmentPlanSupplementId: supplementId },
      relations: [
        'createdBy',
        'createdBy.user',
        'deprecatedBy',
        'deprecatedBy.user',
      ],
      order: { versionNumber: 'DESC' },
    });
    return rows.map((r) => this.toVersionDto(r));
  }

  /**
   * Return the current effective version for the FE selector, or null.
   *
   * Resolution order (mirror of `BookAssemblyService.getCurrentVersion`,
   * book-assembly.service.ts:1754-1796):
   *   1. The COMPLETED version row, if one exists. The partial UNIQUE
   *      index `idx_single_completed_per_supplement` (DB-01 of this M3
   *      wave) guarantees AT MOST one COMPLETED row per supplement, so
   *      `findOne` is deterministic.
   *   2. If no COMPLETED row exists (an in-flight correction has
   *      deprecated v1 and v2 has not yet been merged), fall back to
   *      the DEPRECATED row referenced by the active draft's
   *      `previousVersionId`. This preserves the FE's "what was the
   *      last live book?" view while the new draft is being assembled.
   *   3. Return null when neither resolves (e.g. fresh supplement with
   *      no version row yet) — HTTP 200 with body `null`, NOT 404, so
   *      the FE loadState() does not surface a spurious error toast.
   *
   * Pre-M3 behavior (MAX(versionNumber) only) is intentionally replaced
   * because it returned a DEPRECATED row as "current" after a
   * correction-spawn-without-merge — which broke every read site keyed
   * on "the active book" (PDF download links, version-card title).
   */
  async getCurrentVersion(
    supplementId: string,
    userId: string,
  ): Promise<SupplementAssemblyVersionDto | null> {
    await this.loadAndValidateWorkHistory(userId, READ_ROLES);
    // Step 1 — COMPLETED row.
    const completed = await this.versionRepo.findOne({
      where: {
        developmentPlanSupplementId: supplementId,
        status: SupplementAssemblyVersionStatus.COMPLETED,
      },
      relations: [
        'createdBy',
        'createdBy.user',
        'deprecatedBy',
        'deprecatedBy.user',
      ],
    });
    if (completed) {
      return this.enrichWithDownstreamFork(completed);
    }
    // Step 2 — active-draft fallback to the previous (DEPRECATED) row.
    const activeDraft = await this.draftRepo.findOne({
      where: [
        {
          developmentPlanSupplementId: supplementId,
          assemblyStatus: SupplementAssemblyDraftStatus.PREPARING,
        },
        {
          developmentPlanSupplementId: supplementId,
          assemblyStatus: SupplementAssemblyDraftStatus.READY,
        },
      ],
    });
    if (activeDraft?.previousVersionId) {
      const previous = await this.versionRepo.findOne({
        where: { id: activeDraft.previousVersionId },
        relations: [
          'createdBy',
          'createdBy.user',
          'deprecatedBy',
          'deprecatedBy.user',
        ],
      });
      if (previous) {
        return this.enrichWithDownstreamFork(previous);
      }
    }
    // Step 3 — no row at all.
    return null;
  }

  /**
   * §14.11 (read-side) — wrap toVersionDto and set the advisory
   * hasDownstreamFork flag (§17.2). Current-version / version-by-number reads
   * only; never on the list endpoint (avoids N×snapshot exists() queries).
   */
  private async enrichWithDownstreamFork(
    v: SupplementAssemblyVersion,
  ): Promise<SupplementAssemblyVersionDto> {
    const dto = this.toVersionDto(v);
    dto.hasDownstreamFork = await this.computeHasDownstreamFork(
      v.part3ProjectSnapshot ?? [],
      this.dataSource.manager,
    );
    return dto;
  }

  /**
   * §14.11 — collect the snapshot project ids that have a live (non-soft-
   * deleted) downstream fork (prev_project_type='supplement', §14.7). SINGLE
   * source of truth shared by the cancel + CORRECTION_PART3 throw-guards (which
   * surface the ids in the 409 body) AND the read-side hasDownstreamFork flag,
   * so the pre-emptive FE disable can never disagree with the throw. Reuses
   * LineageLockService — no parallel query.
   */
  private async collectDownstreamForkIds(
    snapshotIds: string[],
    manager: EntityManager,
  ): Promise<string[]> {
    const blocking: string[] = [];
    for (const projectId of snapshotIds) {
      const forked = await this.lineageLockService.hasNonDeletedDescendant(
        projectId,
        'supplement',
        manager,
      );
      if (forked) blocking.push(projectId);
    }
    return blocking;
  }

  /**
   * §14.11 (read-side) — boolean form of collectDownstreamForkIds, short-
   * circuiting on the first fork.
   */
  private async computeHasDownstreamFork(
    snapshotIds: string[],
    manager: EntityManager,
  ): Promise<boolean> {
    for (const projectId of snapshotIds) {
      if (
        await this.lineageLockService.hasNonDeletedDescendant(
          projectId,
          'supplement',
          manager,
        )
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Return the version row for a specific version number, or 404.
   */
  async getVersionByNumber(
    supplementId: string,
    userId: string,
    versionNumber: number,
  ): Promise<SupplementAssemblyVersionDto> {
    await this.loadAndValidateWorkHistory(userId, READ_ROLES);
    this.fileService.validateVersionNumber(versionNumber);
    // wave-supplement-convergence-milestone-3-multi-version / BE-01
    // (2026-05-25) — eager-load deprecatedBy.user so a request for a
    // historical (retired) version returns the same audit-chain shape
    // as the history list.
    const row = await this.versionRepo.findOne({
      where: {
        developmentPlanSupplementId: supplementId,
        versionNumber: versionNumber,
      },
      relations: [
        'createdBy',
        'createdBy.user',
        'deprecatedBy',
        'deprecatedBy.user',
      ],
    });
    if (!row) {
      throw new NotFoundException(
        `ไม่พบเวอร์ชัน v${versionNumber} ของรอบเพิ่มเติมนี้`,
      );
    }
    return this.enrichWithDownstreamFork(row);
  }

  /**
   * Read the merged PDF buffer for a published version.
   */
  async downloadMerged(
    supplementId: string,
    userId: string,
    versionNumber: number,
  ): Promise<Buffer> {
    await this.loadAndValidateWorkHistory(userId, READ_ROLES);
    this.fileService.validateVersionNumber(versionNumber);
    // 404 if version row does not exist.
    const row = await this.versionRepo.findOne({
      where: {
        developmentPlanSupplementId: supplementId,
        versionNumber: versionNumber,
      },
    });
    if (!row) {
      throw new NotFoundException(
        `ไม่พบเวอร์ชัน v${versionNumber} ของรอบเพิ่มเติมนี้`,
      );
    }
    // Wave 3 BE-WRITERS/READERS — read from the stored merged path
    // (legacy abs OR new relative key — both resolved by
    // `StoragePathService.resolveStored`).
    return this.fileService.readMergedFileByStored(row.mergedFilePath);
  }

  /**
   * Read a specific part buffer from a published version.
   */
  async downloadPart(
    supplementId: string,
    userId: string,
    versionNumber: number,
    partNumber: number,
  ): Promise<Buffer> {
    await this.loadAndValidateWorkHistory(userId, READ_ROLES);
    this.fileService.validateVersionNumber(versionNumber);
    this.fileService.validatePartNumber(partNumber);
    const row = await this.versionRepo.findOne({
      where: {
        developmentPlanSupplementId: supplementId,
        versionNumber: versionNumber,
      },
    });
    if (!row) {
      throw new NotFoundException(
        `ไม่พบเวอร์ชัน v${versionNumber} ของรอบเพิ่มเติมนี้`,
      );
    }
    // Wave 3 BE-WRITERS — part paths are recomputed from
    // (location, version, partNumber) since SPG versions don't persist
    // per-part columns. Resolve location via supplement→plan.
    const downloadLocation = await this.resolveLocation(
      supplementId,
      this.supplementRepo.manager,
    );
    return this.fileService.readPart(downloadLocation, versionNumber, partNumber);
  }

  /**
   * Wave 3 BE-WRITERS — controller helper. Returns the absolute path
   * to the merged supplement book for streaming. Resolves the stored
   * value (legacy abs OR new relative key — umbrella §7.3).
   */
  async getMergedAbsolutePath(
    supplementId: string,
    versionNumber: number,
  ): Promise<string> {
    this.fileService.validateVersionNumber(versionNumber);
    const row = await this.versionRepo.findOne({
      where: {
        developmentPlanSupplementId: supplementId,
        versionNumber,
      },
    });
    if (!row) {
      throw new NotFoundException(
        `ไม่พบเวอร์ชัน v${versionNumber} ของรอบเพิ่มเติมนี้`,
      );
    }
    return this.fileService.getAbsolutePathByStored(row.mergedFilePath);
  }

  /**
   * Wave 3 BE-WRITERS — controller helper. Returns the absolute path
   * to a per-part file for streaming. Since SPG versions don't persist
   * per-part columns, the key is recomputed from
   * (location, versionNumber, partNumber).
   */
  async getPartAbsolutePath(
    supplementId: string,
    versionNumber: number,
    partNumber: number,
  ): Promise<string> {
    this.fileService.validateVersionNumber(versionNumber);
    this.fileService.validatePartNumber(partNumber);
    const row = await this.versionRepo.findOne({
      where: {
        developmentPlanSupplementId: supplementId,
        versionNumber,
      },
    });
    if (!row) {
      throw new NotFoundException(
        `ไม่พบเวอร์ชัน v${versionNumber} ของรอบเพิ่มเติมนี้`,
      );
    }
    const location = await this.resolveLocation(
      supplementId,
      this.supplementRepo.manager,
    );
    return this.fileService.getAbsolutePartPath(location, versionNumber, partNumber);
  }

  // ===================================================================
  // Internals
  // ===================================================================

  /**
   * Shared upload path for Part 1 / Part 2. Generation of Part 3 lives
   * in its own method because it invokes the PDF renderer.
   */
  private async uploadPartInternal(
    supplementId: string,
    userId: string,
    partNumber: PartNumber,
    buffer: Buffer,
    filename: string,
    source: SupplementAssemblyPartSource,
  ): Promise<SupplementAssemblyDraftDto> {
    await this.loadAndValidateWorkHistory(userId, ADMIN_ROLES);
    this.validatePdfContent(buffer, filename);

    return this.dataSource.transaction(async (manager) => {
      await this.loadSupplementOrFail(supplementId, manager);
      await this.bookLockService.assertEditable(
        supplementId,
        'development_plan_supplement',
        manager,
      );

      const draft = await this.loadActiveDraftOrFail(supplementId, manager);
      const targetVersion = await this.computeNextVersion(
        supplementId,
        manager,
      );
      // Wave 3 BE-WRITERS — plan-rooted file-service API.
      const uploadLocation = await this.resolveLocation(supplementId, manager);
      this.fileService.ensureVersionFolders(uploadLocation, targetVersion);
      this.fileService.writePart(
        uploadLocation,
        targetVersion,
        partNumber,
        buffer,
      );

      const now = new Date();
      if (partNumber === 1) {
        draft.part1Status = SupplementAssemblyPartUploadStatus.UPLOADED;
        draft.part1Source = source;
        draft.part1OriginalFileName = filename;
        draft.part1UploadedAt = now;
      } else if (partNumber === 2) {
        draft.part2Status = SupplementAssemblyPartUploadStatus.UPLOADED;
        draft.part2Source = source;
        draft.part2OriginalFileName = filename;
        draft.part2UploadedAt = now;
      } else {
        draft.part3Status = SupplementAssemblyPartUploadStatus.UPLOADED;
        draft.part3Source = source;
        draft.part3OriginalFileName = filename;
        draft.part3GeneratedAt = now;
      }

      draft.assemblyStatus = this.computeDraftStatus(draft);
      const saved = await manager.save(SupplementAssemblyDraft, draft);

      this.logger.log(
        `[SupplementAssembly] uploadPart${partNumber} supplement=${supplementId} version=${targetVersion}`,
      );
      return this.toDraftDto(saved);
    });
  }

  /**
   * Load and validate the operator's current WorkHistory + role +
   * workStatus. Mirrors the BookAssembly precedent (§2 + §4.1 + §18.3).
   */
  private async loadAndValidateWorkHistory(
    userId: string,
    allowedRoles: string[],
  ): Promise<WorkHistory> {
    if (!userId) {
      throw new UnauthorizedException('Missing authenticated userId');
    }
    const workHistory = await this.workHistoryRepo.findOne({
      where: { user: { id: userId }, isCurrent: true },
      relations: ['role', 'workStatus', 'user'],
    });
    if (!workHistory) {
      throw new NotFoundException(`WorkHistory not found for user ${userId}`);
    }
    if (workHistory.workStatus?.name !== 'approved') {
      throw new UnauthorizedException(
        'คุณยังไม่ได้รับสิทธิ์ในการดำเนินการ (workStatus ต้องเป็น approved)',
      );
    }
    if (!allowedRoles.includes(workHistory.role?.name)) {
      throw new ForbiddenException(
        'เฉพาะ admin หรือ super-admin เท่านั้นที่สามารถดำเนินการนี้ได้',
      );
    }
    return workHistory;
  }

  /**
   * Wave 3 BE-WRITERS — load supplement (+ parent plan) and return the
   * `SupplementLocation` shape required by the plan-rooted
   * `SupplementAssemblyFileService` API (umbrella §7.1).
   *
   * `loadSupplementOrFail` is preserved for callers that just need the
   * entities; this helper wraps it for callers that need the location.
   */
  private async resolveLocation(
    supplementId: string,
    manager: EntityManager,
  ): Promise<SupplementLocation> {
    const { supplement, plan } = await this.loadSupplementOrFail(
      supplementId,
      manager,
    );
    return {
      planId: plan.id,
      supplementId: supplement.id,
      supplementNumber: supplement.supplementNumber,
    };
  }

  /**
   * Load supplement (+ parent plan) or throw 404. Used by every
   * mutating method to make the §15 / §16.3 chain available.
   */
  private async loadSupplementOrFail(
    supplementId: string,
    manager: EntityManager,
  ): Promise<{
    supplement: DevelopmentPlanSupplement;
    plan: DevelopmentPlan;
  }> {
    const supplement = await manager.findOne(DevelopmentPlanSupplement, {
      where: { id: supplementId },
      relations: ['developmentPlan'],
    });
    if (!supplement || supplement.deletedAt) {
      throw new NotFoundException(
        `ไม่พบรอบเพิ่มเติม (DevelopmentPlanSupplement ${supplementId})`,
      );
    }
    if (!supplement.developmentPlan) {
      throw new NotFoundException(
        `ไม่พบ DevelopmentPlan แม่ของรอบเพิ่มเติม ${supplementId}`,
      );
    }
    return { supplement, plan: supplement.developmentPlan };
  }

  private async loadActiveDraftOrFail(
    supplementId: string,
    manager: EntityManager,
  ): Promise<SupplementAssemblyDraft> {
    // wave-supplement-assembly-metadata-parity / BE-01 — eager-load
    // createdBy.user so mutating endpoints return a DTO that already
    // carries the nested creator projection.
    const draft = await manager.findOne(SupplementAssemblyDraft, {
      where: [
        {
          developmentPlanSupplementId: supplementId,
          assemblyStatus: SupplementAssemblyDraftStatus.PREPARING,
        },
        {
          developmentPlanSupplementId: supplementId,
          assemblyStatus: SupplementAssemblyDraftStatus.READY,
        },
      ],
      relations: ['createdBy', 'createdBy.user'],
    });
    if (!draft) {
      throw new NotFoundException(
        'ไม่พบ draft รวมเล่มที่กำลังดำเนินการ กรุณาสร้าง draft ใหม่',
      );
    }
    return draft;
  }

  private async findActiveDraft(
    supplementId: string,
  ): Promise<SupplementAssemblyDraft | null> {
    // wave-supplement-assembly-metadata-parity / BE-01 — eager-load
    // createdBy.user so the FE DraftPanel can render the creator name.
    return this.draftRepo.findOne({
      where: [
        {
          developmentPlanSupplementId: supplementId,
          assemblyStatus: SupplementAssemblyDraftStatus.PREPARING,
        },
        {
          developmentPlanSupplementId: supplementId,
          assemblyStatus: SupplementAssemblyDraftStatus.READY,
        },
      ],
      relations: ['createdBy', 'createdBy.user'],
    });
  }

  // -------------------------------------------------------------------
  // Correction-flow helpers (wave-supplement-correction-workflow / BE-01)
  // -------------------------------------------------------------------

  /**
   * Operator-authorization gate for the supplement correction (and any
   * future deprecation) flow. Mirrors `BookAssemblyService.validate
   * DeprecationAuth` byte-for-spirit per Q3=B isolation (DO NOT import
   * from `book-assembly`). Performs the SAME five checks in the SAME
   * order so the FE shared input control behaves identically across
   * surfaces:
   *   1. WorkHistory exists for the current user.
   *   2. `workStatus = 'approved'` (§2).
   *   3. role IN ('admin', 'super-admin') (§4.1 / §18.3).
   *   4. `confirmed === true` (explicit confirmation gate).
   *   5. retry-lock + last-6-digit citizenId match.
   *
   * On a citizenId mismatch the failure is recorded against an in-
   * memory tracker keyed by `userId` (§17.11-equivalent integrity gate
   * — not bypassable by role); after 3 failures the operator is locked
   * out for 15 minutes. Successful match clears the counter.
   *
   * Note: the BookAssembly precedent passes a mutable `audit` record
   * to capture failure reasons for `DeprecationAuditLog`. Supplement
   * has no parallel audit log table yet (deferred per BE-01 task §4
   * Out of Scope), so this helper omits the audit-bag parameter to
   * keep the signature minimal.
   */
  private async validateSupplementDeprecationAuth(
    confirmed: boolean,
    citizenIdSuffix: string,
    userId: string,
    manager: EntityManager,
  ): Promise<{ workHistory: WorkHistory; identityMasked: string }> {
    // 1. Load WorkHistory.
    const workHistory = await manager.findOne(WorkHistory, {
      where: { user: { id: userId }, isCurrent: true },
      relations: ['role', 'workStatus', 'user'],
    });
    if (!workHistory) {
      throw new NotFoundException(`WorkHistory not found for user ${userId}`);
    }

    // 2. workStatus gate.
    if (workHistory.workStatus?.name !== 'approved') {
      throw new UnauthorizedException(
        'คุณยังไม่ได้รับสิทธิ์ในการดำเนินการ (workStatus ต้องเป็น approved)',
      );
    }

    // 3. Role gate.
    if (!ADMIN_ROLES.includes(workHistory.role?.name)) {
      throw new ForbiddenException(
        'เฉพาะ admin หรือ super-admin เท่านั้นที่สามารถดำเนินการนี้ได้',
      );
    }

    // 4. Explicit confirmation gate.
    if (!confirmed) {
      throw new BadRequestException('กรุณายืนยันการดำเนินการ (confirmed = true)');
    }

    // 5a. Retry-lock check.
    this.assertIdentityNotLocked(userId);

    // 5b. citizenId suffix match. We MUST use `usersService.findOne`
    // (not the User repo directly) — the `citizen_id` column is
    // encrypted at rest per W89, and `usersService.findOne` runs the
    // decryption pass via `decryptUserPii`. A bare repo read would
    // compare ciphertext against the operator-supplied plaintext suffix
    // and always 401 even with the correct ID.
    const user = await this.usersService.findOne(userId);
    if (!user?.citizenId) {
      throw new UnauthorizedException(
        'ไม่พบข้อมูลบัตรประชาชนของผู้ดำเนินการ',
      );
    }

    const actualSuffix = user.citizenId.slice(-6);
    const maskedSuffix = `****${citizenIdSuffix.slice(-2)}`;
    if (actualSuffix !== citizenIdSuffix) {
      this.recordIdentityFailure(userId);
      throw new UnauthorizedException('รหัสบัตรประชาชน 6 หลักสุดท้ายไม่ถูกต้อง');
    }

    // Clear retry counter on success.
    this.identityAttempts.delete(userId);
    return { workHistory, identityMasked: maskedSuffix };
  }

  /**
   * Identity-verification retry guard. Throws when the operator is
   * currently locked out (3 failed attempts within the 15-minute
   * window). Mirrors `BookAssemblyService.assertIdentityNotLocked`.
   */
  private assertIdentityNotLocked(userId: string): void {
    const record = this.identityAttempts.get(userId);
    if (!record) return;
    if (record.lockedUntil && record.lockedUntil > new Date()) {
      const remaining = Math.ceil(
        (record.lockedUntil.getTime() - Date.now()) / 60000,
      );
      throw new ForbiddenException(
        `การดำเนินการถูกล็อกชั่วคราว โปรดลองอีกครั้งในอีก ${remaining} นาที`,
      );
    }
  }

  /**
   * Record a failed identity-verification attempt and arm the lock if
   * the threshold is hit. Mirrors `BookAssemblyService.record
   * IdentityFailure`.
   */
  private recordIdentityFailure(userId: string): void {
    const record = this.identityAttempts.get(userId) ?? { count: 0 };
    record.count += 1;
    if (record.count >= MAX_IDENTITY_ATTEMPTS) {
      record.lockedUntil = new Date(Date.now() + IDENTITY_LOCK_MS);
      this.logger.warn(
        `[SupplementAssembly] identity verification locked for user ${userId} after ${record.count} failed attempts`,
      );
    }
    this.identityAttempts.set(userId, record);
  }

  /**
   * Load the current COMPLETED supplement-assembly version with a
   * pessimistic write lock so a concurrent merge / cancel / second
   * correct cannot race. Mirrors `BookAssemblyService.loadCompleted
   * VersionForUpdate`. The supplement-version uniqueness constraint
   * (`uniq_sav_supplement_version` on `(developmentPlanSupplementId,
   * versionNumber)`) does NOT guarantee one COMPLETED row per
   * supplement, but the merge path only writes COMPLETED on success,
   * so in steady state there is at most one — we load the most recent.
   */
  private async loadCompletedVersionForUpdate(
    supplementId: string,
    manager: EntityManager,
  ): Promise<SupplementAssemblyVersion> {
    const version = await manager.findOne(SupplementAssemblyVersion, {
      where: {
        developmentPlanSupplementId: supplementId,
        status: SupplementAssemblyVersionStatus.COMPLETED,
      },
      lock: { mode: 'pessimistic_write' },
      order: { versionNumber: 'DESC' },
    });
    if (!version) {
      throw new NotFoundException(
        'ไม่พบเวอร์ชันที่เสร็จสมบูรณ์สำหรับรอบเพิ่มเติมนี้',
      );
    }
    return version;
  }

  /**
   * Q1=a full-reset helper #1 — clear `pageNumber` on every SPG in the
   * deprecated version's `part3ProjectSnapshot`. Mirrors
   * `BookAssemblyService.resetProjectBooking` shape for `RevisedProject
   * Group` / `ProjectGroup` but adapted to `SupplementProjectGroup`'s
   * narrower column set.
   *
   * wave-supplement-convergence-milestone-2-spg-booked-fields / BE-01
   * (2026-05-25) — UPGRADED to clear `isBooked` + `bookedAt` alongside
   * `pageNumber`, achieving §20 parity with
   * `BookAssemblyService.resetProjectBooking` (book-assembly.service.ts
   * lines 2973-2991). Prior to DB-01 of this wave, SPG had no
   * `is_booked` / `booked_at` columns and the helper cleared only
   * `pageNumber` (the supplement-level `isBooked` was the booking
   * unit). DB-01 added the columns; this method now mirrors PG/RPG
   * byte-for-byte. The supplement-level `isBooked` / `bookedAt` reset
   * is still performed by `resetSupplementState` below (separate
   * concern — book-level vs row-level state).
   *
   * The `snapshot` parameter is the `part3ProjectSnapshot` array (Thai
   * titles) from the deprecated version row. We use the parallel
   * `metadataJson.approvedSpgIds` array (UUIDs) when present, because
   * the title-keyed `In(...)` would silently miss SPGs whose title was
   * edited between merge and correct. Title-based reset stays as a
   * defensive fallback for legacy rows lacking the UUID array.
   */
  private async resetSupplementProjectBooking(
    snapshot: string[],
    manager: EntityManager,
    version?: SupplementAssemblyVersion,
  ): Promise<void> {
    if (!snapshot || snapshot.length === 0) {
      // Nothing to reset; defensive no-op (empty deprecated version).
      return;
    }

    const approvedSpgIds =
      (version?.metadataJson as Record<string, unknown> | null)?.[
        'approvedSpgIds'
      ];
    const repo = manager.getRepository(SupplementProjectGroup);

    if (Array.isArray(approvedSpgIds) && approvedSpgIds.length > 0) {
      // Preferred path — UUID-keyed reset. Stable across title edits.
      await repo.update(
        { id: In(approvedSpgIds as string[]) },
        { isBooked: false, bookedAt: null, pageNumber: null },
      );
      return;
    }

    // Fallback path — title-keyed reset. Only used for legacy version
    // rows that pre-date the `metadataJson.approvedSpgIds` write. Safe
    // because supplement creation already prevents duplicate titles
    // per the SPG add flow.
    await repo.update(
      { title: In(snapshot) },
      { isBooked: false, bookedAt: null, pageNumber: null },
    );
  }

  /**
   * Q1=a full-reset helper #2 — roll the `DevelopmentPlanSupplement`
   * row back to its pre-finalize state. Mirrors `BookAssemblyService.
   * resetPlanState` for the supplement entity.
   *
   * CRITICAL — clearing `bookedAt` removes this supplement from the
   * §15 Model A linear-chain predicate. Without this clear, an older
   * sibling under the same plan would still see the supplement as a
   * strictly-newer-booked chain entry and remain locked despite the
   * correction. The mirror of this clause for revision rollback lives
   * at `book-assembly.service.ts:3013-3016`.
   *
   * Unlike `BookAssemblyService.resetPlanState` we do NOT toggle an
   * `isOpen` flag — `DevelopmentPlanSupplement.isOpen` is the round-
   * open flag and is independent of the booking state.
   */
  private async resetSupplementState(
    supplementId: string,
    manager: EntityManager,
  ): Promise<void> {
    await manager.getRepository(DevelopmentPlanSupplement).update(
      { id: supplementId },
      { isBooked: false, bookedAt: null },
    );
  }

  /**
   * Safely extract the `filename` field for a given part number from a
   * version's `metadataJson.parts.partN.filename`. Returns `null` when
   * the metadata is missing or shaped differently (pre-metadata version
   * rows). Mirrors the shape written by `merge()` at the top of this
   * service.
   */
  private readPartFilenameFromMetadata(
    version: SupplementAssemblyVersion,
    partNumber: PartNumber,
  ): string | null {
    const meta = version.metadataJson as Record<string, unknown> | null;
    if (!meta || typeof meta !== 'object') return null;
    const parts = meta['parts'];
    if (!parts || typeof parts !== 'object') return null;
    const partEntry = (parts as Record<string, unknown>)[`part${partNumber}`];
    if (!partEntry || typeof partEntry !== 'object') return null;
    const fname = (partEntry as Record<string, unknown>)['filename'];
    return typeof fname === 'string' ? fname : null;
  }

  /**
   * Q8=A / Q9=A — next version = MAX(version) + 1 FILTERED by
   * supplementId. Per-supplement monotonic. Uses parameterized SQL via
   * the QueryBuilder so the index on `(development_plan_supplement_id,
   * version)` is used for the lookup.
   */
  private async computeNextVersion(
    supplementId: string,
    manager?: EntityManager,
  ): Promise<number> {
    const repo = manager
      ? manager.getRepository(SupplementAssemblyVersion)
      : this.versionRepo;
    const latest = await repo.findOne({
      where: { developmentPlanSupplementId: supplementId },
      order: { versionNumber: 'DESC' },
    });
    return latest ? latest.versionNumber + 1 : 1;
  }

  /**
   * Promote a draft to READY when all three parts are present
   * (uploaded / generated / reused). Otherwise stay in PREPARING.
   * Idempotent — safe to call on an already-READY draft.
   */
  private computeDraftStatus(args: {
    part1Status: SupplementAssemblyPartUploadStatus;
    part2Status: SupplementAssemblyPartUploadStatus;
    part3Status: SupplementAssemblyPartUploadStatus;
  }): SupplementAssemblyDraftStatus {
    if (this.areAllPartsReady(args)) {
      return SupplementAssemblyDraftStatus.READY;
    }
    return SupplementAssemblyDraftStatus.PREPARING;
  }

  private areAllPartsReady(args: {
    part1Status: SupplementAssemblyPartUploadStatus;
    part2Status: SupplementAssemblyPartUploadStatus;
    part3Status: SupplementAssemblyPartUploadStatus;
  }): boolean {
    return (
      this.isPartReady(args.part1Status) &&
      this.isPartReady(args.part2Status) &&
      this.isPartReady(args.part3Status)
    );
  }

  private isPartReady(s: SupplementAssemblyPartUploadStatus): boolean {
    return (
      s === SupplementAssemblyPartUploadStatus.UPLOADED ||
      s === SupplementAssemblyPartUploadStatus.GENERATED ||
      s === SupplementAssemblyPartUploadStatus.REUSED
    );
  }

  private validatePdfContent(buffer: Buffer, filename: string): void {
    const pdfMagicBytes = Buffer.from('%PDF-');
    if (buffer.length < 5 || !buffer.subarray(0, 5).equals(pdfMagicBytes)) {
      throw new BadRequestException(
        `ไฟล์ "${filename}" ไม่ใช่เอกสาร PDF ที่ถูกต้อง`,
      );
    }
  }

  /**
   * Resolve a human-readable display name for the operator. Used as the
   * "จัดทำโดย" cover-page line on generated Part 3 buffers. Falls back
   * to '-' when the user record is incomplete.
   */
  private async resolveWorkHistoryDisplayName(
    workHistory: WorkHistory,
    manager: EntityManager,
  ): Promise<string> {
    if (!workHistory.user?.id) {
      return '-';
    }
    const user = await manager.findOne(User, {
      where: { id: workHistory.user.id },
      select: ['id', 'firstname', 'lastname'],
    });
    if (!user) return '-';
    const display = `${user.firstname ?? ''} ${user.lastname ?? ''}`.trim();
    return display.length > 0 ? display : '-';
  }

  /**
   * Merge multiple PDF buffers into one (pdf-lib copyPages). Mirrors
   * BookAssembly's private helper of the same name.
   *
   * wave-supplement-assembly-metadata-parity / BE-01 — callers that need
   * the merged page count for version-row metadata should use
   * `mergePdfBuffersWithMeta` instead. This helper is retained as a
   * thin wrapper to preserve the existing preview-path signature.
   */
  private async mergePdfBuffers(buffers: Buffer[]): Promise<Buffer> {
    const { buffer } = await this.mergePdfBuffersWithMeta(buffers);
    return buffer;
  }

  /**
   * wave-supplement-assembly-metadata-parity / BE-01 — variant of
   * `mergePdfBuffers` that also returns the merged page count. Used by
   * `merge()` to populate `SupplementAssemblyVersion.totalPages`
   * without re-loading the buffer a second time.
   *
   * On any pdf-lib parse failure during page-count extraction (defensive
   * — the merge itself is the source-of-truth gate), `pageCount` is
   * returned as `null` so the merge transaction does NOT roll back on a
   * read-side metadata blip. Mirrors main-plan precedent (which uses
   * a separate `PDFDocument.load` call and would also surface a null/
   * undefined-leaning failure mode).
   */
  private async mergePdfBuffersWithMeta(
    buffers: Buffer[],
  ): Promise<{ buffer: Buffer; pageCount: number | null }> {
    if (buffers.length === 0) {
      throw new BadRequestException('No PDF buffers provided for merging');
    }
    if (buffers.length === 1) {
      let pageCount: number | null = null;
      try {
        const pdf = await PDFDocument.load(buffers[0]);
        pageCount = pdf.getPageCount();
      } catch (e) {
        this.logger.warn(
          `[SupplementAssembly] failed to read pageCount on single-buffer merge: ${
            (e as Error).message
          }`,
        );
      }
      return { buffer: buffers[0], pageCount };
    }
    const mergedPdf = await PDFDocument.create();
    for (const buffer of buffers) {
      const pdf = await PDFDocument.load(buffer);
      const copiedPages = await mergedPdf.copyPages(
        pdf,
        pdf.getPageIndices(),
      );
      copiedPages.forEach((page) => mergedPdf.addPage(page));
    }
    const pageCount = mergedPdf.getPageCount();
    const mergedBytes = await mergedPdf.save();
    return { buffer: Buffer.from(mergedBytes), pageCount };
  }

  // -------------------------------------------------------------------
  // Lineage helpers — wave-supplement-convergence-milestone-4-lineage
  // (CTO M4 decision Option B — dual segregated DAG)
  // -------------------------------------------------------------------

  /**
   * Populate `supplement_project_lineage` for every approved SPG in the
   * just-merged supplement version. Mirrors
   * `BookAssemblyService.populateLineageForMerge` (book-assembly.service.ts:
   * 2674-2715) byte-for-spirit; per Q3=B segregated DAG we do NOT import
   * from `book-assembly` and we operate on the supplement-side table only.
   *
   * Write order is CRITICAL:
   *   1. Find the SPG's current leaf row (if any).
   *   2. Clear the old leaf BEFORE inserting the new one — the partial
   *      unique index `idx_spl_one_leaf_per_spg` enforces "at most one
   *      leaf per SPG" and the insert-first ordering would violate it.
   *   3. Insert the new leaf row referencing the old leaf's version id
   *      as `parentSupplementAssemblyVersionId` (null on v1 merges).
   *
   * Must be invoked INSIDE the caller's transaction so a rollback of
   * the merge also rolls back the lineage rows.
   */
  private async populateLineageForSupplementMerge(
    supplementVersionId: string,
    approvedSpgIds: string[],
    manager: EntityManager,
  ): Promise<void> {
    if (!approvedSpgIds || approvedSpgIds.length === 0) return;

    const lineageRepo = manager.getRepository(SupplementProjectLineage);

    for (const spgId of approvedSpgIds) {
      const oldLeaf = await lineageRepo.findOne({
        where: {
          supplementProjectGroupId: spgId,
          isCurrentLeaf: true,
        },
      });

      // Clear old leaf BEFORE insert — partial unique constraint.
      if (oldLeaf) {
        oldLeaf.isCurrentLeaf = false;
        await lineageRepo.save(oldLeaf);
      }

      const newRow = lineageRepo.create({
        supplementProjectGroupId: spgId,
        supplementAssemblyVersionId: supplementVersionId,
        parentSupplementAssemblyVersionId:
          oldLeaf?.supplementAssemblyVersionId ?? null,
        isCurrentLeaf: true,
      });
      await lineageRepo.save(newRow);
    }

    this.logger.log(
      `[SupplementAssembly] lineage populated for ${approvedSpgIds.length} SPGs → versionId=${supplementVersionId}`,
    );
  }

  /**
   * Roll the SPG-lineage leaf pointers back to the cancelled version's
   * parent. Mirrors `BookAssemblyService.restoreLineageAfterCancel`
   * (book-assembly.service.ts:2722-2760) byte-for-spirit.
   *
   * Algorithm:
   *   1. Find every leaf row whose `supplementAssemblyVersionId` matches
   *      the cancelled version.
   *   2. Clear `isCurrentLeaf = false` on each (the cancelled version is
   *      no longer a leaf — and per partial unique we must clear BEFORE
   *      promoting the parent).
   *   3. If the leaf had a parent, find the parent's lineage row for the
   *      same SPG and restore `isCurrentLeaf = true` so the leaf pointer
   *      rolls back to the previous published version.
   *
   * Must be invoked INSIDE the caller's transaction so a cancel rollback
   * also rolls back the leaf-pointer flips.
   *
   * Called from:
   *   - `cancelPublishedVersion` (admin cancel of a COMPLETED version)
   *   - `correct(CORRECTION_PART3)` Q1=a full-reset cascade — keeps the
   *     leaf pointer consistent with the deprecated state immediately
   *     instead of relying on the eventual new-version merge to repair it.
   *     (Part 1 / Part 2 correction does NOT touch lineage because the
   *     Part 3 snapshot — and therefore the SPG set — is preserved.)
   */
  private async restoreLineageAfterSupplementCancel(
    cancelledVersionId: string,
    manager: EntityManager,
  ): Promise<void> {
    const lineageRepo = manager.getRepository(SupplementProjectLineage);

    const cancelledLeaves = await lineageRepo.find({
      where: {
        supplementAssemblyVersionId: cancelledVersionId,
        isCurrentLeaf: true,
      },
    });

    if (cancelledLeaves.length === 0) return;

    for (const leaf of cancelledLeaves) {
      // Clear THIS leaf first — partial unique requires it before we
      // can promote the parent row to is_current_leaf=true for the
      // same SPG.
      leaf.isCurrentLeaf = false;
      await lineageRepo.save(leaf);

      if (leaf.parentSupplementAssemblyVersionId) {
        const parentRow = await lineageRepo.findOne({
          where: {
            supplementProjectGroupId: leaf.supplementProjectGroupId,
            supplementAssemblyVersionId:
              leaf.parentSupplementAssemblyVersionId,
          },
        });
        if (parentRow) {
          parentRow.isCurrentLeaf = true;
          await lineageRepo.save(parentRow);
        }
      }
    }

    this.logger.log(
      `[SupplementAssembly] lineage restored for ${cancelledLeaves.length} SPGs after cancel of versionId=${cancelledVersionId}`,
    );
  }

  // -------------------------------------------------------------------
  // DTO mappers
  // -------------------------------------------------------------------

  private toDraftDto(d: SupplementAssemblyDraft): SupplementAssemblyDraftDto {
    return {
      id: d.id,
      developmentPlanSupplementId: d.developmentPlanSupplementId,
      assemblyStatus: d.assemblyStatus,

      part1Status: d.part1Status,
      part1Source: d.part1Source,
      part1OriginalFileName: d.part1OriginalFileName,
      part1UploadedAt: d.part1UploadedAt
        ? d.part1UploadedAt.toISOString()
        : null,

      part2Status: d.part2Status,
      part2Source: d.part2Source,
      part2OriginalFileName: d.part2OriginalFileName,
      part2UploadedAt: d.part2UploadedAt
        ? d.part2UploadedAt.toISOString()
        : null,

      part3Status: d.part3Status,
      part3Source: d.part3Source,
      part3OriginalFileName: d.part3OriginalFileName,
      part3GeneratedAt: d.part3GeneratedAt
        ? d.part3GeneratedAt.toISOString()
        : null,

      createdById: d.createdById,
      createdAt: d.createdAt.toISOString(),
      updatedAt: d.updatedAt.toISOString(),
      createdBy: this.projectCreatedBy(d.createdBy),
    };
  }

  private toVersionDto(
    v: SupplementAssemblyVersion,
  ): SupplementAssemblyVersionDto {
    return {
      id: v.id,
      developmentPlanSupplementId: v.developmentPlanSupplementId,
      versionNumber: v.versionNumber,
      status: v.status,
      mergedFilePath: v.mergedFilePath,
      mergedFileSha256: v.mergedFileSha256,
      mergedAt: v.mergedAt ? v.mergedAt.toISOString() : v.createdAt.toISOString(),
      createdById: v.createdById,
      metadataJson: v.metadataJson,
      createdAt: v.createdAt.toISOString(),
      part3ProjectCount: v.part3ProjectCount ?? null,
      part3ProjectSnapshot: v.part3ProjectSnapshot ?? null,
      totalPages: v.totalPages ?? null,
      createdBy: this.projectCreatedBy(v.createdBy),
      // wave-supplement-convergence-milestone-3-multi-version / BE-01
      // (2026-05-25) — correction-lineage + deprecation projection.
      // Backfilled for legacy rows as null (pre-correction-wave versions
      // never carry these columns). The deprecation timestamp is
      // serialised as ISO-8601 string to match the rest of the DTO.
      correctionMode: v.correctionMode ?? null,
      correctionReason: v.correctionReason ?? null,
      deprecatedAt: v.deprecatedAt ? v.deprecatedAt.toISOString() : null,
      deprecatedById: v.deprecatedById ?? null,
      deprecationReason: v.deprecationReason ?? null,
      deprecatedBy: v.deprecatedBy
        ? (this.projectCreatedBy(v.deprecatedBy) ?? null)
        : null,
    };
  }

  /**
   * wave-supplement-assembly-metadata-parity / BE-01 — shared mapper that
   * projects a `WorkHistory` relation (optionally with a nested `user`)
   * into the DTO-side `{ id, user?: { prefix, firstName, lastName } }`
   * shape. Returns `undefined` when the relation is not loaded so the
   * envelope stays unchanged on read paths that omit eager-load.
   *
   * Note the `firstname` → `firstName` / `lastname` → `lastName` casing
   * shift — the DB column is lowercase (see `User.firstname`) but the
   * DTO contract mirrors the main-plan precedent which camelCases the
   * fields for the FE.
   */
  private projectCreatedBy(
    wh: WorkHistory | null | undefined,
  ):
    | {
        id: string;
        user?: { prefix?: string; firstName?: string; lastName?: string };
      }
    | undefined {
    if (!wh) return undefined;
    return {
      id: wh.id,
      user: wh.user
        ? {
            prefix: wh.user.prefix,
            firstName: wh.user.firstname,
            lastName: wh.user.lastname,
          }
        : undefined,
    };
  }
}

