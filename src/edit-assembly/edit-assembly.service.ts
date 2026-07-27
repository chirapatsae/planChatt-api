// ===================================================================
// EditAssemblyService — Wave A2 / BE-01 (OPTION-A-FULL-SPLIT)
// ===================================================================
//
// Orchestration service for the STANDALONE Edit-Revision Assembly
// subsystem (Wave A2 of OPTION-A-FULL-SPLIT). Owns the in-flight
// Part1 → Part2 → Part3 → finalize state machine for
// `DevelopmentPlanRevision` rooted books (revisionType = edit) and the
// correction / cancellation workflows that supersede or rollback a
// COMPLETED version.
//
// Locked decisions referenced inline:
//   - Q3=B  — standalone; this service MUST NOT import from
//             `src/book-assembly/`, `src/main-assembly/`, or
//             `src/supplement-assembly/`. Every enum / DTO / entity that
//             the legacy `BookAssemblyService` shared via discriminator
//             is duplicated under `src/edit-assembly/`. The lone
//             exception is `BookAssemblyFileService` (shared
//             infrastructure for on-disk file layout — same exemption
//             noted in `main-assembly.service.ts`).
//   - §18.2.1 — `merge()` is the new EDIT_REVISION finalize trigger
//             surface; the §18 cascade fires INSIDE the transaction,
//             BEFORE `DevelopmentPlanRevision.isBooked = true` /
//             `bookedAt`. Cascade kind is `'REVISION'` (NOT `'PLAN'`).
//   - §20  — cancel of a published EDIT version is ALLOWED (the only
//             §20.4 exempt cell is `MAIN_PLAN.cancel`).
//             `cancelPublishedVersion` mirrors the legacy
//             `BookAssemblyService.cancel` flow for revision sources:
//             deprecate version, reset RPG booking, reset revision
//             state (`isBooked=false`, `bookedAt=null`, `isOpen=true`),
//             restore lineage, fire §18 cancel cascade.
//
// Co-existence note (Wave A2 transition window):
//   - The legacy `BookAssemblyService` continues to handle EDIT_REVISION
//     traffic via `book_assembly_*` tables until FE-01 atomically
//     switches every edit-revision FE client to this service.
//   - The DB-01 backfill copied existing rows into `edit_assembly_*`
//     with the SAME UUIDs so both stores observe the same versions
//     (live data count = 0 at authoring time; backfill is structural
//     future-proofing).
//   - Until FE switch: only ONE of the two services receives writes
//     per request, so divergence cannot accumulate.
//   - CLEANUP-01 (later wave) drops the legacy tables once telemetry
//     shows zero traffic to `book-assembly` EDIT_REVISION endpoints.
//
// CLAUDE.md compliance:
//   - §2   workStatus = 'approved' — re-checked at service entry per
//          method.
//   - §4.1 / §18.3  authority inheritance — admin + super-admin only.
//   - §12  audit — the §18 cascade (NOT this service) writes
//          `tracking_status` rows. This service writes only
//          `edit_assembly_*` tables + the revision's `isBooked` /
//          `bookedAt` / `isOpen` flags.
//   - §15  `BookLockService.assertEditable(revisionId,
//          'development_plan_revision', em)` runs BEFORE every mutating
//          call. The thrown `BOOK_HAS_NEWER_REVISION` propagates as-is
//          (NO MAIN_BOOK_FROZEN translation — that's MAIN-specific).
//   - §16.3  `reportFormat` resolved via the parent plan (`revision →
//          plan` JOIN); never overridden.
//   - §17  no AI side-effects.
//   - §18.2.1  cascade BEFORE `isBooked = true`, atomic transaction.
//          Any throw (e.g. `ORPHAN_CASCADE_HAS_LIVE_DESCENDANT`) rolls
//          back the entire merge. Cancel cascade fires INSIDE the
//          cancel transaction, BEFORE the deprecate write commits.
// ===================================================================

import * as fs from 'fs';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { PDFDocument } from 'pdf-lib';

import { EditAssemblyDraft } from './entities/edit-assembly-draft.entity';
import { EditAssemblyVersion } from './entities/edit-assembly-version.entity';
import { EditAssemblyVersionProject } from './entities/edit-assembly-version-project.entity';
import { EditProjectLineage } from './entities/edit-project-lineage.entity';
import {
  EditAssemblyCorrectionMode,
  EditAssemblyDraftStatus,
  EditAssemblyPartSource,
  EditAssemblyPartUploadStatus,
  EditAssemblyVersionStatus,
} from './enums/edit-assembly.enums';

import { CorrectEditBookDto } from './dto/correct-edit-book.dto';
import { CancelEditBookDto } from './dto/cancel-edit-book.dto';
import { EditAssemblyDraftDto } from './dto/edit-assembly-draft-response.dto';
import { EditAssemblyVersionDto } from './dto/edit-assembly-version-response.dto';
import {
  EditBookDisplayStateDto,
  EditBookDisplayStateEnum,
} from './dto/edit-book-display-state.dto';
import {
  EditReadinessBreakdownDto,
  EditReadinessDto,
} from './dto/edit-readiness.dto';

import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';
import { RevisedEquipmentProjectGroup } from 'src/revised-equipment-project-group/entities/revised-equipment-project-group.entity';
import { DevelopmentPlanRevision } from 'src/development-plan-revision/entities/development-plan-revision.entity';
import { User } from 'src/users/entities/user.entity';
import { ReportFormat } from 'src/development-plan/types/report-format.enum';
import { STATUS_NAMES } from 'src/common/status-names';
import { UnifiedProjectMapper } from 'src/project-groups/dto/unified-project-display.dto';

import { UsersService } from 'src/users/users.service';
import { PdfService } from 'src/pdf/pdf.service';
import { Por03PdfService } from 'src/pdf/por03-pdf.service';
import { WebsocketService } from 'src/websocket/websocket/websocket.service';
import { BookLockService } from 'src/common/book-lock/book-lock.service';
import { OrphanCleanupService } from 'src/orphan-cleanup/orphan-cleanup.service';
import { LineageLockService } from 'src/common/lineage-lock/lineage-lock.service';
import { StoragePathService } from 'src/storage/storage-path.service';
import {
  BookAssemblyFileService,
  BookAssemblyLocation,
} from 'src/book-assembly/book-assembly-file.service';
//   ^ NOTE on the lone `book-assembly/` import above: Q3=B forbids
//   importing the legacy SERVICE / ENTITIES / ENUMS / DTOs from
//   `src/book-assembly/`. The file-system layer (`BookAssemblyFileService`
//   + the `BookAssemblyLocation` TYPE) is an infrastructure component
//   shared by all subsystems because the on-disk storage layout
//   `main-plan-{planId}/edit/edit-{revNo}-{revId}/v{N}/...` is canonical
//   and the file service is the single source of truth for STORAGE_ROOT-
//   relative key resolution (per the BE-WRITERS wave umbrella §7.1).
//   Same exemption as `main-assembly.service.ts`.

/** Roles permitted to perform edit-assembly write actions (§4.1 / §18.3). */
const ADMIN_ROLES = ['admin', 'super-admin'];

/** Roles permitted to view / download. */
const READ_ROLES = ['staff', 'admin', 'super-admin'];

/** Max identity-verification failures before lock. */
const MAX_IDENTITY_ATTEMPTS = 3;

/** Lock duration after exceeding retry limit. */
const IDENTITY_LOCK_MS = 15 * 60 * 1000;

/**
 * Readiness denominator exclusion list. Mirrors
 * `BookAssemblyService.READINESS_EXCLUSION_STATUSES` byte-for-byte.
 *
 *   - Ready      — pre-submission; never part of the in-flight deficit.
 *   - Pull_Back  — owner withdrew; §18 cascade auto-resets on finalize.
 *   - Rejected   — W67 workflow exit ("เกินศักยภาพ"); routed to the
 *                  out-authority pipeline.
 */
const READINESS_EXCLUSION_STATUSES: readonly string[] = [
  STATUS_NAMES.READY,
  STATUS_NAMES.PULL_BACK,
  STATUS_NAMES.REJECTED,
] as const;

@Injectable()
export class EditAssemblyService {
  private readonly logger = new Logger(EditAssemblyService.name);

  /** In-memory identity-verification retry tracker. */
  private readonly identityAttempts = new Map<
    string,
    { count: number; lockedUntil?: Date }
  >();

  constructor(
    @InjectRepository(EditAssemblyDraft)
    private readonly draftRepo: Repository<EditAssemblyDraft>,

    @InjectRepository(EditAssemblyVersion)
    private readonly versionRepo: Repository<EditAssemblyVersion>,

    @InjectRepository(EditAssemblyVersionProject)
    private readonly versionProjectRepo: Repository<EditAssemblyVersionProject>,

    @InjectRepository(EditProjectLineage)
    private readonly lineageRepo: Repository<EditProjectLineage>,

    @InjectRepository(WorkHistory)
    private readonly workHistoryRepo: Repository<WorkHistory>,

    @InjectRepository(RevisedProjectGroup)
    private readonly revisedProjectGroupRepo: Repository<RevisedProjectGroup>,

    @InjectRepository(RevisedEquipmentProjectGroup)
    private readonly relpgRepo: Repository<RevisedEquipmentProjectGroup>,

    @InjectRepository(DevelopmentPlanRevision)
    private readonly devPlanRevisionRepo: Repository<DevelopmentPlanRevision>,

    @InjectRepository(User)
    private readonly userRepo: Repository<User>,

    private readonly usersService: UsersService,
    private readonly pdfService: PdfService,
    // wave-edit-change-assembly-por03-append (2026-06-04) — Approved-only
    // revision ผ.03 (RELPG OLD-vs-NEW) render core for the merge/preview
    // append. PdfModule (already imported) exports Por03PdfService.
    private readonly por03Service: Por03PdfService,
    private readonly websocketService: WebsocketService,
    private readonly fileService: BookAssemblyFileService,
    private readonly storagePathService: StoragePathService,
    private readonly bookLockService: BookLockService,
    private readonly orphanCleanupService: OrphanCleanupService,
    // §14.11 — cancel-time descendant guard. Reuses the canonical
    // §14 lineage machinery (no parallel query) to block a version
    // cancel when any snapshot project was forked into a later book.
    private readonly lineageLockService: LineageLockService,
    private readonly dataSource: DataSource,
  ) {}

  // ===================================================================
  // Sidebar Counts
  // ===================================================================

  /**
   * Counts the number of `DevelopmentPlanRevision` rows that are
   * "actionable" for the admin "รวมเล่มแก้ไข" sidebar badge — i.e.
   * live EDIT revisions an admin can still assemble / finalize.
   *
   * Restored 2026-05-29 after §20.10 CLEANUP wave removed the legacy
   * `GET /v1/book-assembly/counts` endpoint without porting the
   * count semantic to the standalone subsystems. Mirrors
   * `SupplementAssemblyService.getActionableCount` byte-for-spirit
   * with two differences: (a) the discriminator is
   * `revisionType.name = 'แก้ไข'` (EDIT, not SUPPLEMENT), and
   * (b) the sibling probe is the corresponding revision-table probe.
   *
   * Role gate (§4.1, §17.2):
   *   - admin + super-admin → live count
   *   - any other role     → silent `0`
   *
   * Filter:
   *   - parent `plan.is_latest = true` — only revisions under the
   *     active plan
   *   - `r.revisionType.name = 'แก้ไข'`
   *   - `r.is_latest = true`
   *   - `r.is_booked = false`
   *   - no newer non-deleted sibling EDIT revision under the same
   *     plan (mirrors the supplement convention)
   *
   * 2026-06-04 — DROPPED the `r.is_open = true` filter. Assembly is a
   * POST-close step: the admin closes the round, then assembles. Gating
   * the "รวมเล่ม" badge on `is_open = true` made it vanish exactly when
   * assembly becomes due (round closed, not yet booked), so the admin had
   * no cue to assemble. Now mirrors MAIN_PLAN `getActionableCount`, which
   * counts purely on `is_booked = false` (a plan has no `is_open` column).
   * The "เปิดรอบ" badge (`hasOpenEditRevision`) covers the open phase; the
   * "รวมเล่ม" badge covers not-yet-booked — open OR closed.
   *
   * §17.2 — pure read, advisory only; MUST NOT gate workflow.
   */
  async getActionableCount(callerRole: string | undefined): Promise<number> {
    if (callerRole !== 'admin' && callerRole !== 'super-admin') {
      return 0;
    }
    return this.devPlanRevisionRepo
      .createQueryBuilder('r')
      .innerJoin('r.revisionType', 'rt')
      .innerJoin('r.developmentPlan', 'plan')
      .where('plan.is_latest = :planLatest', { planLatest: true })
      .andWhere('rt.name = :revisionType', { revisionType: 'แก้ไข' })
      .andWhere('r.is_latest = :isLatest', { isLatest: true })
      .andWhere('r.is_booked = :isBooked', { isBooked: false })
      .andWhere(
        `NOT EXISTS (
          SELECT 1
          FROM development_plan_revision r2
          INNER JOIN revision_type rt2 ON rt2.id = r2.revision_type_id
          WHERE r2.development_plan_id = plan.id
            AND r2.id <> r.id
            AND r2.created_at > r.created_at
            AND r2.deleted_at IS NULL
            AND rt2.name = :revisionType
        )`,
      )
      .getCount();
  }

  // ===================================================================
  // Public API — Draft management
  // ===================================================================

  /**
   * Creates a new assembly draft for a development plan revision.
   * Only one active (non-merged) draft per revision.
   */
  async createDraft(
    developmentPlanRevisionId: string,
    userId: string,
  ): Promise<EditAssemblyDraftDto> {
    const workHistory = await this.loadAndValidateWorkHistory(userId, ADMIN_ROLES);

    // §15 revision freeze guard.
    await this.assertEditBookNotFrozen(developmentPlanRevisionId);

    // Reject if an active draft already exists.
    const existingDraft = await this.draftRepo.findOne({
      where: {
        developmentPlanRevisionId,
        assemblyStatus: In([
          EditAssemblyDraftStatus.PREPARING,
          EditAssemblyDraftStatus.READY,
        ]),
      },
    });
    if (existingDraft) {
      throw new ConflictException(
        'มี draft ที่กำลังดำเนินการอยู่แล้วสำหรับเล่มฉบับแก้ไขนี้ กรุณาดำเนินการต่อหรือยกเลิก draft เดิมก่อน',
      );
    }

    // Handle CANCELED draft — same behavior as BookAssemblyService.
    const canceledDraft = await this.draftRepo.findOne({
      where: {
        developmentPlanRevisionId,
        assemblyStatus: EditAssemblyDraftStatus.CANCELED,
      },
      order: { canceledAt: 'DESC' },
    });
    if (canceledDraft) {
      const completedVersion = await this.versionRepo.findOne({
        where: {
          developmentPlanRevisionId,
          status: EditAssemblyVersionStatus.COMPLETED,
        },
      });
      if (completedVersion) {
        // Orphan: silently purge and continue.
        await this.draftRepo.remove(canceledDraft);
        this.logger.log(
          `Silently purged orphaned canceled draft ${canceledDraft.id} for revision=${developmentPlanRevisionId}`,
        );
      } else {
        throw new ConflictException({
          message: 'มี draft ที่ยกเลิกแล้วอยู่ กรุณากู้คืนหรือลบทิ้งก่อนสร้างใหม่',
          errorCode: 'CANCELED_DRAFT_EXISTS',
          canceledDraftId: canceledDraft.id,
        });
      }
    }

    // Determine next version number (per-revision).
    const maxVersion = await this.versionRepo
      .createQueryBuilder('v')
      .select('MAX(v.versionNumber)', 'max')
      .where('v.developmentPlanRevisionId = :id', { id: developmentPlanRevisionId })
      .getRawOne<{ max: number | null }>();
    const targetVersion = (maxVersion?.max ?? 0) + 1;

    // Link to the most recently DEPRECATED version (cancel-book linkage).
    const deprecatedVersion = await this.versionRepo.findOne({
      where: {
        developmentPlanRevisionId,
        status: EditAssemblyVersionStatus.DEPRECATED,
      },
      order: { versionNumber: 'DESC' },
    });

    // Create folder structure (reuses the canonical revision-rooted layout).
    const draftLocation = await this.resolveEditLocation(developmentPlanRevisionId);
    this.fileService.createVersionFolders(draftLocation, targetVersion);

    const draft = this.draftRepo.create({
      developmentPlanRevisionId,
      targetVersion,
      previousVersionId: deprecatedVersion?.id ?? null,
      correctionMode: null,
      correctionReason: null,
      part1Status: EditAssemblyPartUploadStatus.PENDING,
      part2Status: EditAssemblyPartUploadStatus.PENDING,
      part3Status: EditAssemblyPartUploadStatus.PENDING,
      assemblyStatus: EditAssemblyDraftStatus.PREPARING,
      createdById: workHistory.id,
    });

    const saved = await this.draftRepo.save(draft);
    this.logger.log(
      `Created edit-revision draft revision=${developmentPlanRevisionId} v${targetVersion} draftId=${saved.id}`,
    );
    return this.toDraftDto(saved);
  }

  /**
   * Returns the current active (non-merged) draft for a development
   * plan revision, or null.
   */
  async getActiveDraft(
    developmentPlanRevisionId: string,
    userId: string,
  ): Promise<EditAssemblyDraftDto | null> {
    await this.loadAndValidateWorkHistory(userId, READ_ROLES);
    const draft = await this.draftRepo.findOne({
      where: {
        developmentPlanRevisionId,
        assemblyStatus: In([
          EditAssemblyDraftStatus.PREPARING,
          EditAssemblyDraftStatus.READY,
        ]),
      },
      relations: ['createdBy', 'createdBy.user'],
    });
    return draft ? this.toDraftDto(draft) : null;
  }

  /**
   * Soft-deletes an active draft (status → CANCELED).
   *
   * Wave A2 / BE-01 — restoration of a deprecated version on discard
   * mirrors the `BookAssemblyService.discardDraft` semantics but is
   * deferred to a later wave to keep this initial split lean. The MVP
   * surface only flips the draft to CANCELED; restore is exposed via
   * the separate `restoreDraft` endpoint per the supplement precedent.
   */
  async discardDraft(
    developmentPlanRevisionId: string,
    userId: string,
  ): Promise<{ message: string; draftId: string }> {
    const workHistory = await this.loadAndValidateWorkHistory(userId, ADMIN_ROLES);
    const draft = await this.loadActiveDraftOrFail(developmentPlanRevisionId);

    draft.assemblyStatus = EditAssemblyDraftStatus.CANCELED;
    draft.canceledAt = new Date();
    draft.canceledById = workHistory.id;
    await this.draftRepo.save(draft);

    this.logger.log(
      `Discarded edit-revision draft revision=${developmentPlanRevisionId} draftId=${draft.id}`,
    );
    return { message: 'ยกเลิก draft เรียบร้อยแล้ว', draftId: draft.id };
  }

  // ===================================================================
  // Public API — Canceled-draft management (CLEANUP wave port from
  // BookAssemblyService.{getCanceledDraft,restoreDraft,purgeCanceledDraft})
  // ===================================================================
  //
  // §15 note: NONE of the three methods below call the BookLockService
  // freeze guard. Rationale (mirrors the legacy BookAssemblyService
  // behavior): a canceled-draft read / restore / purge does NOT write
  // to the protected DevelopmentPlanRevision row; it only flips
  // `draft.assemblyStatus` (or hard-deletes a draft row). Per §15.5
  // "flag-only operations are exempt" in spirit, these draft-row
  // mutations are not §15-protected book mutations.

  /**
   * Returns the most recent canceled draft for a development plan
   * revision, or null. Loads `canceledBy.user` relation for display.
   *
   * Mirrors `BookAssemblyService.getCanceledDraft` (book-assembly.service.ts
   * lines 548-568). READ_ROLES — staff + admin + super-admin.
   */
  async getCanceledDraft(
    developmentPlanRevisionId: string,
    userId: string,
  ): Promise<EditAssemblyDraft | null> {
    await this.loadAndValidateWorkHistory(userId, READ_ROLES);

    return this.draftRepo.findOne({
      where: {
        developmentPlanRevisionId,
        assemblyStatus: EditAssemblyDraftStatus.CANCELED,
      },
      order: { canceledAt: 'DESC' },
      relations: ['canceledBy', 'canceledBy.user'],
    });
  }

  /**
   * Restores the most recent canceled draft to active status.
   * Recomputes `assemblyStatus` from the current part statuses.
   *
   * Mirrors `BookAssemblyService.restoreDraft` (book-assembly.service.ts
   * lines 574-634). ADMIN_ROLES — admin + super-admin only.
   *
   *   - 404 if no CANCELED draft exists for the revision.
   *   - 409 ACTIVE_DRAFT_EXISTS if a PREPARING / READY draft is already
   *     present (cannot have two active drafts simultaneously).
   */
  async restoreDraft(
    developmentPlanRevisionId: string,
    userId: string,
  ): Promise<EditAssemblyDraft> {
    await this.loadAndValidateWorkHistory(userId, ADMIN_ROLES);

    // 1. Load the most recent CANCELED draft.
    const canceledDraft = await this.draftRepo.findOne({
      where: {
        developmentPlanRevisionId,
        assemblyStatus: EditAssemblyDraftStatus.CANCELED,
      },
      order: { canceledAt: 'DESC' },
    });
    if (!canceledDraft) {
      throw new NotFoundException('ไม่พบ draft ที่ถูกยกเลิก');
    }

    // 2. Reject if an active draft already exists.
    const activeDraft = await this.draftRepo.findOne({
      where: {
        developmentPlanRevisionId,
        assemblyStatus: In([
          EditAssemblyDraftStatus.PREPARING,
          EditAssemblyDraftStatus.READY,
        ]),
      },
    });
    if (activeDraft) {
      throw new ConflictException({
        message: 'กู้คืนไม่ได้ มี draft ที่กำลังดำเนินการอยู่แล้ว',
        errorCode: 'ACTIVE_DRAFT_EXISTS',
      });
    }

    // 3. Recompute assemblyStatus from current part statuses.
    const part1Ready =
      canceledDraft.part1Status === EditAssemblyPartUploadStatus.UPLOADED ||
      canceledDraft.part1Status === EditAssemblyPartUploadStatus.REUSED;
    const part2Ready =
      canceledDraft.part2Status === EditAssemblyPartUploadStatus.UPLOADED ||
      canceledDraft.part2Status === EditAssemblyPartUploadStatus.REUSED;
    const part3Ready =
      canceledDraft.part3Status === EditAssemblyPartUploadStatus.GENERATED ||
      canceledDraft.part3Status === EditAssemblyPartUploadStatus.REUSED;

    canceledDraft.assemblyStatus =
      part1Ready && part2Ready && part3Ready
        ? EditAssemblyDraftStatus.READY
        : EditAssemblyDraftStatus.PREPARING;

    // 4. Clear canceled fields.
    canceledDraft.canceledAt = null;
    canceledDraft.canceledById = null;

    const restored = await this.draftRepo.save(canceledDraft);
    this.logger.log(
      `Restored edit-revision draft ${restored.id} for revision=${developmentPlanRevisionId} → ${restored.assemblyStatus}`,
    );
    return restored;
  }

  /**
   * Permanently hard-deletes the most recent canceled draft record.
   * Only CANCELED drafts can be purged. Disk files are NOT deleted (the
   * version folders may still hold reusable parts).
   *
   * Mirrors `BookAssemblyService.purgeCanceledDraft` (book-assembly.service.ts
   * lines 640-667). ADMIN_ROLES — admin + super-admin only.
   */
  async purgeCanceledDraft(
    developmentPlanRevisionId: string,
    userId: string,
  ): Promise<void> {
    await this.loadAndValidateWorkHistory(userId, ADMIN_ROLES);

    const canceledDraft = await this.draftRepo.findOne({
      where: {
        developmentPlanRevisionId,
        assemblyStatus: EditAssemblyDraftStatus.CANCELED,
      },
      order: { canceledAt: 'DESC' },
    });
    if (!canceledDraft) {
      throw new NotFoundException('ไม่พบ draft ที่ถูกยกเลิก');
    }

    await this.draftRepo.remove(canceledDraft);
    this.logger.log(
      `Purged canceled edit-revision draft ${canceledDraft.id} for revision=${developmentPlanRevisionId}`,
    );
  }

  // ===================================================================
  // Public API — Part upload / generation
  // ===================================================================

  /**
   * Uploads Part 1 or Part 2 PDF.
   */
  async uploadPart(
    developmentPlanRevisionId: string,
    partNumber: 1 | 2,
    file: Express.Multer.File,
    userId: string,
  ): Promise<EditAssemblyDraftDto> {
    const workHistory = await this.loadAndValidateWorkHistory(userId, ADMIN_ROLES);

    if (!file || !file.buffer || file.buffer.length === 0) {
      throw new BadRequestException('กรุณาอัพโหลดไฟล์ PDF');
    }

    // Defense-in-depth — validate PDF magic bytes.
    this.validatePdfContent(file.buffer, file.originalname);

    // §15 revision freeze guard.
    await this.assertEditBookNotFrozen(developmentPlanRevisionId);

    const draft = await this.loadActiveDraftOrFail(developmentPlanRevisionId);

    const uploadLocation = await this.resolveEditLocation(developmentPlanRevisionId);
    const filePath = this.fileService.savePartFile(
      uploadLocation,
      draft.targetVersion,
      partNumber,
      file.buffer,
    );

    if (partNumber === 1) {
      draft.part1Status = EditAssemblyPartUploadStatus.UPLOADED;
      draft.part1FilePath = filePath;
      draft.part1OriginalFileName = file.originalname;
      draft.part1UploadedAt = new Date();
      draft.part1UploadedById = workHistory.id;
    } else {
      draft.part2Status = EditAssemblyPartUploadStatus.UPLOADED;
      draft.part2FilePath = filePath;
      draft.part2OriginalFileName = file.originalname;
      draft.part2UploadedAt = new Date();
      draft.part2UploadedById = workHistory.id;
    }

    this.updateAssemblyStatus(draft);
    const saved = await this.draftRepo.save(draft);
    return this.toDraftDto(saved);
  }

  /**
   * Generates Part 3 (project listing PDF) from Approved RPGs in this
   * revision round.
   *
   * §16-aware: branches on parent plan `reportFormat` for sort order.
   */
  async generatePart3(
    developmentPlanRevisionId: string,
    userId: string,
  ): Promise<EditAssemblyDraftDto> {
    await this.loadAndValidateWorkHistory(userId, ADMIN_ROLES);

    // §15 revision freeze guard.
    await this.assertEditBookNotFrozen(developmentPlanRevisionId);

    const draft = await this.loadActiveDraftOrFail(developmentPlanRevisionId);

    await this.notifyProgress(userId, developmentPlanRevisionId, 10, 'starting', 'กำลังเริ่มสร้างส่วนที่ 3...');

    const { projects, projectIds, pageMap } = await this.queryAndRenderPart3(
      developmentPlanRevisionId,
      userId,
    );

    if (projects.length === 0) {
      throw new BadRequestException(
        'ไม่พบโครงการที่อนุมัติแล้วสำหรับเล่มฉบับแก้ไขนี้',
      );
    }

    // Bake the ผ.03 (equipment revision) section INTO the Part 3 file so the
    // saved ส่วนที่ 3 IS the complete revision section (ผ.02 โครงการ + ผ.03
    // ครุภัณฑ์ = one document) — mirroring the MAIN/combined-draft behavior.
    // ผ.02 restarts at page 1 (§21.3.4); ผ.03 continues from its page count.
    // Degrades to ผ.02-only when no Approved RELPG exists. merge/preview then
    // just concatenate the parts (they do NOT re-append ผ.03).
    const por02Buffer = pageMap.buffer;
    const por02PageCount = (await PDFDocument.load(por02Buffer)).getPageCount();
    const por03 =
      await this.por03Service.renderApprovedRevisionScopedPor03Buffer(
        developmentPlanRevisionId,
        por02PageCount,
      );
    const part3Buffer = por03
      ? await this.mergePdfBuffers([por02Buffer, por03.buffer])
      : por02Buffer;

    const generateLocation = await this.resolveEditLocation(developmentPlanRevisionId);
    const filePath = this.fileService.savePartFile(
      generateLocation,
      draft.targetVersion,
      3,
      part3Buffer,
    );

    draft.part3Status = EditAssemblyPartUploadStatus.GENERATED;
    draft.part3FilePath = filePath;
    draft.part3GeneratedAt = new Date();
    draft.part3ProjectSnapshot = projectIds;
    draft.part3PageMap = Object.fromEntries(pageMap.pageMap);

    this.updateAssemblyStatus(draft);
    const saved = await this.draftRepo.save(draft);
    await this.notifyProgress(userId, developmentPlanRevisionId, 100, 'completed', 'สร้างส่วนที่ 3 สำเร็จแล้ว!');
    return this.toDraftDto(saved);
  }

  /**
   * Reuses a part from a specified previous version (copies file).
   */
  async reusePart(
    developmentPlanRevisionId: string,
    partNumber: 1 | 2 | 3,
    fromVersionNumber: number,
    userId: string,
  ): Promise<EditAssemblyDraftDto> {
    const workHistory = await this.loadAndValidateWorkHistory(userId, ADMIN_ROLES);
    const draft = await this.loadActiveDraftOrFail(developmentPlanRevisionId);

    const sourceVersion = await this.versionRepo.findOne({
      where: { developmentPlanRevisionId, versionNumber: fromVersionNumber },
    });
    if (!sourceVersion) {
      throw new NotFoundException(
        `ไม่พบเวอร์ชัน v${fromVersionNumber} สำหรับเล่มฉบับแก้ไขนี้`,
      );
    }

    const reuseLocation = await this.resolveEditLocation(developmentPlanRevisionId);
    const copiedPath = this.fileService.copyPartFromVersion(
      reuseLocation,
      fromVersionNumber,
      draft.targetVersion,
      partNumber,
    );

    if (partNumber === 1) {
      draft.part1Status = EditAssemblyPartUploadStatus.REUSED;
      draft.part1FilePath = copiedPath;
      draft.part1OriginalFileName = sourceVersion.part1OriginalFileName;
      draft.part1UploadedAt = new Date();
      draft.part1UploadedById = workHistory.id;
    } else if (partNumber === 2) {
      draft.part2Status = EditAssemblyPartUploadStatus.REUSED;
      draft.part2FilePath = copiedPath;
      draft.part2OriginalFileName = sourceVersion.part2OriginalFileName;
      draft.part2UploadedAt = new Date();
      draft.part2UploadedById = workHistory.id;
    } else {
      draft.part3Status = EditAssemblyPartUploadStatus.REUSED;
      draft.part3FilePath = copiedPath;
      draft.part3GeneratedAt = new Date();
      draft.part3ProjectSnapshot = sourceVersion.part3ProjectSnapshot;
      // Wave A2 / BE-01 — page map is now sourced from the version-
      // projects join (denormalized) instead of inline JSONB. Reuse
      // queries the join for the source version's mapping so the merge
      // path keeps writing rows consistently.
      const sourceJoin = await this.versionProjectRepo.find({
        where: { versionId: sourceVersion.id },
        select: ['revisedProjectGroupId', 'pageNumber'],
      });
      draft.part3PageMap = Object.fromEntries(
        sourceJoin.map((r) => [r.revisedProjectGroupId, r.pageNumber]),
      );
    }

    this.updateAssemblyStatus(draft);
    const saved = await this.draftRepo.save(draft);
    return this.toDraftDto(saved);
  }

  // ===================================================================
  // Public API — Preview & merge
  // ===================================================================

  async preview(developmentPlanRevisionId: string, userId: string): Promise<Buffer> {
    await this.loadAndValidateWorkHistory(userId, ADMIN_ROLES);
    const draft = await this.loadActiveDraftOrFail(developmentPlanRevisionId);

    if (draft.assemblyStatus !== EditAssemblyDraftStatus.READY) {
      throw new BadRequestException(
        'ยังไม่สามารถดูตัวอย่างได้ กรุณาเตรียมส่วนที่ 1, 2 และ 3 ให้เรียบร้อยก่อน',
      );
    }
    if (!draft.part1FilePath || !draft.part2FilePath || !draft.part3FilePath) {
      throw new BadRequestException('Draft parts incomplete — cannot preview');
    }
    const part1 = this.fileService.readPartFileByStored(draft.part1FilePath);
    const part2 = this.fileService.readPartFileByStored(draft.part2FilePath);
    const part3 = this.fileService.readPartFileByStored(draft.part3FilePath);

    // ผ.03 (equipment revision) is BAKED into Part 3 by generatePart3, so the
    // preview just concatenates the parts — no separate ผ.03 render/append
    // (that would duplicate the section). Part 3 already carries ผ.02 + ผ.03.
    return this.mergePdfBuffers([part1, part2, part3]);
  }

  /**
   * Execute merge — creates a version + version_projects rows, populates
   * the lineage table, and flips revision booking state. ALL mutations
   * happen in a single transaction.
   *
   * §18.2.1 trigger surface: the orphan cleanup cascade fires INSIDE
   * the transaction BEFORE the `isBooked = true` write so non-Approved
   * / non-Rejected RPGs get cleaned up atomically. Cascade kind is
   * `'REVISION'` (NOT `'PLAN'`).
   */
  async merge(
    developmentPlanRevisionId: string,
    userId: string,
  ): Promise<EditAssemblyVersionDto> {
    const workHistory = await this.loadAndValidateWorkHistory(userId, ADMIN_ROLES);

    return this.dataSource.transaction(async (manager) => {
      // §15 revision freeze guard (inside transaction).
      await this.assertEditBookNotFrozen(developmentPlanRevisionId, manager);

      // 1. Load + validate draft.
      const draft = await manager.findOne(EditAssemblyDraft, {
        where: {
          developmentPlanRevisionId,
          assemblyStatus: EditAssemblyDraftStatus.READY,
        },
      });
      if (!draft) {
        throw new BadRequestException(
          'ไม่พบ draft ที่พร้อมรวมเล่ม กรุณาเตรียมส่วนที่ 1, 2 และ 3 ให้ครบถ้วนก่อน',
        );
      }
      if (!draft.part1FilePath || !draft.part2FilePath || !draft.part3FilePath) {
        throw new BadRequestException('Draft parts incomplete — cannot merge');
      }
      if (!draft.part3PageMap || Object.keys(draft.part3PageMap).length === 0) {
        throw new InternalServerErrorException(
          'ไม่พบข้อมูล pageMap สำหรับการรวมเล่ม กรุณาสร้างส่วนที่ 3 ใหม่',
        );
      }

      await this.notifyProgress(userId, developmentPlanRevisionId, 10, 'starting', 'กำลังเริ่มรวมเล่ม...');

      // 2. Read parts.
      const mergeLocation = await this.resolveEditLocation(
        developmentPlanRevisionId,
        manager,
      );
      const part1 = this.fileService.readPartFileByStored(draft.part1FilePath);
      const part2 = this.fileService.readPartFileByStored(draft.part2FilePath);
      const part3 = this.fileService.readPartFileByStored(draft.part3FilePath);

      await this.notifyProgress(userId, developmentPlanRevisionId, 30, 'merging', 'กำลังรวมไฟล์ PDF...');

      // 3. Merge — append the formal ผ.03 revision section (§5.3 Phase 3,
      // §21.3). Approved-only, STRATEGY_BASED-only, read-only (§17.2 — NO
      // tracking/AI/audit writes). The render degrades to null when no
      // Approved RELPG exists, in which case the ผ.02 book is produced
      // verbatim (no behavior change). §21.3.4 — EDIT ผ.02 Part 3
      // restarts at 1, so offset = pageCount(part3); the printed footer
      // on ผ.03 page `i` reads `por03Offset + i`. The returned
      // `equipmentIds`/`pageMap` ARE consumed below to stamp RELPG
      // `is_booked` / `booked_at` / `page_number` per row — the §20.2
      // Phase 3 deferral note is lifted by the booking-stamp step.
      // ผ.03 is BAKED into Part 3 by generatePart3 — do NOT append it again
      // (that would duplicate the section). Re-render ผ.03 ONLY to recover the
      // equipment ids + per-row LOCAL page numbers for the booking stamp below;
      // the buffer itself is discarded. ผ.02 page count (where ผ.03 starts in
      // Part 3) = Part 3 pages − ผ.03 pages, so absolute page = por02PageCount
      // + local, matching the footer baked into Part 3.
      const por03 =
        await this.por03Service.renderApprovedRevisionScopedPor03Buffer(
          developmentPlanRevisionId,
          0,
        );
      const part3PageCount = (await PDFDocument.load(part3)).getPageCount();
      const por03PageCount = por03
        ? (await PDFDocument.load(por03.buffer)).getPageCount()
        : 0;
      const por02PageCount = part3PageCount - por03PageCount;
      const mergedBuffer = await this.mergePdfBuffers([part1, part2, part3]);
      const mergedPdf = await PDFDocument.load(mergedBuffer);
      const totalPages = mergedPdf.getPageCount();

      // 4. Save merged file (relative key persisted on version row).
      const mergedFilePath = this.fileService.saveMergedFile(
        mergeLocation,
        draft.targetVersion,
        mergedBuffer,
      );

      await this.notifyProgress(userId, developmentPlanRevisionId, 50, 'booking', 'กำลังจองโครงการ...');

      // 5. §18.2.1 — orphan-cleanup cascade BEFORE isBooked flip.
      // Cascade kind is 'REVISION' (NOT 'PLAN' like MAIN).
      const revision = await manager.getRepository(DevelopmentPlanRevision).findOne({
        where: { id: developmentPlanRevisionId },
      });
      if (!revision) {
        throw new NotFoundException(
          `DevelopmentPlanRevision not found for id=${developmentPlanRevisionId}`,
        );
      }
      const cascadeResult = await this.orphanCleanupService.cascadeOnBookFinalize(
        revision,
        'REVISION',
        manager,
        userId,
      );
      this.logger.log(
        `[EditAssembly] merge cascade revision=${developmentPlanRevisionId} pg=${cascadeResult.pgCount} rpg=${cascadeResult.rpgCount}`,
      );

      // 6. RPG booking flips on Approved RPGs.
      const projectIds = draft.part3ProjectSnapshot ?? [];
      const pageMap = draft.part3PageMap;

      if (projectIds.length > 0) {
        const rpgRepo = manager.getRepository(RevisedProjectGroup);
        for (const projectId of projectIds) {
          await rpgRepo.update(
            { id: projectId },
            {
              isBooked: true,
              bookedAt: new Date(),
              pageNumber: pageMap[projectId] ?? null,
            },
          );
        }
      }

      // 6b. Equipment (ผ.03 revision) booking stamp on Approved RELPGs
      //     that the renderer included in the appended section. Parallels
      //     the MAIN `EquipmentProjectGroup` stamp at
      //     `main-assembly.service.ts:1017` and the RPG stamp above.
      //     §21.3.4 — EDIT ผ.02 Part 3 restarts at 1, so absolutePage(id)
      //     = por03Offset + local. §12 — booking flip is NOT a status
      //     transition; no TrackingStatus row written. Raw SQL UPDATE
      //     keeps `RevisedEquipmentProjectGroup` out of the edit-assembly
      //     module beyond the §20.10.3 shared-infra channel.
      if (por03 && por03.equipmentIds.length > 0) {
        const relpgIds = por03.equipmentIds;
        const relpgBookedAt = new Date();
        const relpgPages: (number | null)[] = relpgIds.map((id) => {
          const local = por03.pageMap.get(id);
          return local === undefined ? null : por02PageCount + local;
        });
        await manager.query(
          `UPDATE revised_equipment_project_groups e
             SET is_booked = true,
                 booked_at = $1,
                 page_number = u.page_number
           FROM unnest($2::uuid[], $3::int[]) AS u(id, page_number)
           WHERE e.id = u.id`,
          [relpgBookedAt, relpgIds, relpgPages],
        );
        this.logger.log(
          `[EditAssembly] merge stamped isBooked + page_number on ${relpgIds.length} RELPG row(s) revision=${developmentPlanRevisionId}`,
        );
      }

      // 7. Revision booking flip. Mirrors the legacy
      //    `BookAssemblyService.merge` path for revision sources —
      //    `bookedAt` is set so the §15 strict-`>` predicate kicks in.
      //    Note: unlike MAIN, EDIT does NOT touch any `PlanPhase` row
      //    (revisions don't have PlanPhases — they have `isOpen`
      //    on the revision itself, which finalize flips to false).
      await manager.getRepository(DevelopmentPlanRevision).update(
        { id: developmentPlanRevisionId },
        { isBooked: true, bookedAt: new Date(), isOpen: false },
      );

      await this.notifyProgress(userId, developmentPlanRevisionId, 70, 'saving', 'กำลังบันทึกข้อมูล...');

      // 8. Insert version row (NO inline part3_page_map per Wave A2).
      const versionRow = manager.create(EditAssemblyVersion, {
        developmentPlanRevisionId,
        versionNumber: draft.targetVersion,
        status: EditAssemblyVersionStatus.COMPLETED,
        correctionMode: draft.correctionMode,
        correctionReason: draft.correctionReason,
        part1FilePath: draft.part1FilePath,
        part1Source: this.toPartSource(draft.part1Status),
        part1OriginalFileName: draft.part1OriginalFileName,
        part2FilePath: draft.part2FilePath,
        part2Source: this.toPartSource(draft.part2Status),
        part2OriginalFileName: draft.part2OriginalFileName,
        part3FilePath: draft.part3FilePath,
        part3Source: this.toPartSource(draft.part3Status),
        part3ProjectSnapshot: projectIds,
        part3ProjectCount: projectIds.length,
        mergedFilePath,
        mergedAt: new Date(),
        totalPages,
        createdById: workHistory.id,
      });
      const savedVersion = await manager.save(EditAssemblyVersion, versionRow);

      // 8b. Snapshot the stamped RELPG id set onto the version row's
      //     metadataJson so the cancel / correct un-stamp path (BE-01)
      //     can UUID-key the reset. Mirrors the supplement
      //     `metadataJson.approvedSpgIds` precedent. §17.2 — this is a
      //     pure read-of-render-result; no TrackingStatus / ai_* write.
      if (por03 && por03.equipmentIds.length > 0) {
        const currentMeta =
          (savedVersion.metadataJson as Record<string, unknown>) ?? {};
        await manager.update(EditAssemblyVersion, savedVersion.id, {
          metadataJson: { ...currentMeta, approvedRelpgIds: por03.equipmentIds },
        });
      }

      // 9. Write the version-projects join (Wave A2 page_map
      // denormalization — replaces the legacy inline JSONB).
      const joinRepo = manager.getRepository(EditAssemblyVersionProject);
      for (const projectId of projectIds) {
        await joinRepo.save(
          joinRepo.create({
            versionId: savedVersion.id,
            revisedProjectGroupId: projectId,
            pageNumber: pageMap[projectId] ?? 0,
          }),
        );
      }

      // 10. Mark draft as merged.
      draft.assemblyStatus = EditAssemblyDraftStatus.MERGED;
      await manager.save(EditAssemblyDraft, draft);

      // 11. Populate per-RPG lineage.
      await this.populateLineageForMerge(projectIds, savedVersion.id, manager);

      await this.notifyProgress(userId, developmentPlanRevisionId, 100, 'completed', 'รวมเล่มสำเร็จแล้ว!');

      this.logger.log(
        `[EditAssembly] merge revision=${developmentPlanRevisionId} v${draft.targetVersion} projects=${projectIds.length} pages=${totalPages}`,
      );

      const full = await manager.findOne(EditAssemblyVersion, {
        where: { id: savedVersion.id },
        relations: ['createdBy', 'createdBy.user'],
      });
      return this.toVersionDto(full ?? savedVersion);
    });
  }

  // ===================================================================
  // Public API — Cancel published version (§20.2 LIVE for EDIT)
  // ===================================================================

  /**
   * §20.2 — cancelling a PUBLISHED EDIT_REVISION version is LIVE.
   * The only §20.4 exempt cell is `MAIN_PLAN.cancel`; EDIT supports
   * cancel via this endpoint.
   *
   * Flow (mirrors `BookAssemblyService.cancel` for revision sources
   * and `SupplementAssemblyService.cancelPublishedVersion`):
   *   1. Authorize operator (role, workStatus, confirmed, citizenIdSuffix).
   *   2. §15 lock guard on the revision (inside the transaction).
   *   3. Load the COMPLETED version with a pessimistic write lock.
   *   4. Descendant guard — block if any child lineage row references
   *      this version as a `parentEditAssemblyVersionId` AND is still
   *      a current leaf.
   *   4b. §14.11 cancel-time descendant guard — block if any RPG in the
   *      version snapshot was forked into a LATER book (live §14
   *      descendant, prev_project_type='revised'). Throws
   *      `409 BOOK_PROJECTS_REFERENCED_DOWNSTREAM` listing the blocking
   *      project ids; the operator must remove the downstream fork first.
   *      This extends §14 descendant-immutability to the book-cancel
   *      operation and prevents the orphaned/ambiguous source the
   *      cancel-no-destroy un-book would otherwise create.
   *   5. Mark version DEPRECATED + persist deprecation audit fields.
   *   6. Reset every RPG in the snapshot: `isBooked=false`,
   *      `bookedAt=null`, `pageNumber=null`.
   *   7. Reset revision state: `isBooked=false`, `bookedAt=null`,
   *      `isOpen=true` (re-open so staff can rework). Clearing
   *      `bookedAt` removes the revision from the §15.3 strict-`>`
   *      sibling probe, releasing any older sibling under the same
   *      plan that was locked by this row.
   *   8. Restore parent leaf in `edit_project_lineage` for every RPG
   *      in the cancelled snapshot.
   *
   * Cancel un-books children WITHOUT destroying them (cancel-no-destroy,
   * 2026-06-05). Per CLAUDE.md §18.2, the §18 `cascadeOnBookCancel`
   * applies ONLY to (A) BOOK softRemove (the whole revision round is
   * deleted). This is (B) an assembly VERSION cancel that REOPENS the
   * revision for rework — steps 5-7 un-book the snapshot RPGs and restore
   * lineage, leaving the RPG rows LIVE and reusable (mirrors
   * CORRECTION_PART3 and the SupplementAssembly precedent). It does NOT
   * fire the §18 cascade.
   *
   * NOTE on deprecation audit log: the legacy
   * `BookAssemblyService.cancel` writes a `DeprecationAuditLog` row.
   * Per the supplement precedent (`SupplementAssemblyService`), the
   * audit log write is OPTIONAL for the standalone subsystems — it
   * writes to the shared `deprecation_audit_log` table when the
   * helper is wired. Wave A2 / BE-01 defers the explicit audit-log
   * write to a follow-up (same pattern as supplement) — the
   * `validateDeprecationAuth` chain itself records the SUCCESS /
   * FAILURE outcome via service-level logging.
   */
  async cancelPublishedVersion(
    developmentPlanRevisionId: string,
    versionId: string,
    dto: CancelEditBookDto,
    userId: string,
  ): Promise<void> {
    return this.dataSource.transaction(async (manager) => {
      // §15 revision freeze guard (inside transaction).
      await this.assertEditBookNotFrozen(developmentPlanRevisionId, manager);

      // 1. Operator authorization (role, workStatus, confirmed,
      //    citizenIdSuffix match w/ retry lock).
      const { workHistory } = await this.validateDeprecationAuth(
        dto.confirmed,
        dto.citizenIdSuffix,
        userId,
        manager,
      );

      // 2. Load the targeted COMPLETED version (matching versionId AND
      //    revisionId AND status=COMPLETED) with a pessimistic write
      //    lock. We resolve by versionId to give the controller an
      //    explicit handle on the version being cancelled.
      const currentVersion = await manager.findOne(EditAssemblyVersion, {
        where: {
          id: versionId,
          developmentPlanRevisionId,
          status: EditAssemblyVersionStatus.COMPLETED,
        },
        lock: { mode: 'pessimistic_write' },
      });
      if (!currentVersion) {
        throw new NotFoundException(
          'ไม่พบเวอร์ชันที่เสร็จสมบูรณ์ตามรหัสที่ระบุสำหรับเล่มฉบับแก้ไขนี้',
        );
      }

      // 3. Descendant guard — block if any child lineage row references
      //    this version AND is still a current leaf. Mirrors the legacy
      //    `BookProjectLineage` BOOK_HAS_DESCENDANT_PUBLISHED check.
      const lineageRepo = manager.getRepository(EditProjectLineage);
      const hasDescendants = await lineageRepo.exists({
        where: {
          parentEditAssemblyVersionId: currentVersion.id,
          isCurrentLeaf: true,
        },
      });
      if (hasDescendants) {
        throw new ForbiddenException({
          code: 'BOOK_HAS_DESCENDANT_PUBLISHED',
          message:
            'ไม่สามารถยกเลิกเล่มนี้ได้ เนื่องจากมีเล่มแก้ไข/เปลี่ยนแปลงที่เผยแพร่แล้วและพึ่งพาเล่มนี้อยู่',
        });
      }

      const snapshotIds = currentVersion.part3ProjectSnapshot ?? [];

      // 3b. §14.11 cancel-time descendant guard. Block cancel if ANY RPG
      //     in this version's snapshot was forked into a LATER book (i.e.
      //     has a live §14 descendant referencing it via
      //     prev_project_type='revised'). Cancelling here would un-book the
      //     forked source while the downstream fork still points at it,
      //     leaving the source permanently §14-locked and the lineage
      //     "ขาดช่วง" (orphaned/ambiguous source). The operator must remove
      //     the downstream fork first. Reuses the shared
      //     collectDownstreamForkIds helper — the SAME source of truth as the
      //     read-side hasDownstreamFork DTO flag, so the pre-emptive FE disable
      //     can never disagree with this throw. Runs INSIDE the transaction,
      //     BEFORE the deprecate write (atomic precondition).
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

      // 4. Deprecate the version row.
      await manager.update(EditAssemblyVersion, currentVersion.id, {
        status: EditAssemblyVersionStatus.DEPRECATED,
        deprecatedAt: new Date(),
        deprecatedById: workHistory.id,
        deprecationReason: dto.reason,
      });

      // 5. Reset RPG booking on every RPG in the cancelled snapshot.
      if (snapshotIds.length > 0) {
        await manager.getRepository(RevisedProjectGroup).update(
          { id: In(snapshotIds) },
          { isBooked: false, bookedAt: null, pageNumber: null },
        );
      }

      // 5b. Equipment (ผ.03 revision) un-stamp — symmetric to the
      //     merge-time RELPG stamp. Clears is_booked / booked_at /
      //     page_number on the RELPG ids recorded on this version's
      //     metadataJson.approvedRelpgIds (written by BE-02 at merge).
      //     Raw SQL keeps `RevisedEquipmentProjectGroup` out of the
      //     edit-assembly module per §20.10.3. §17.2 — pure column
      //     flip; NO TrackingStatus / ai_* write.
      await this.resetRelpgBooking(currentVersion, manager);

      // 6. Reset revision state — clear isBooked + bookedAt (removes
      //    the row from §15.3 strict-`>` sibling probe; releases older
      //    siblings under the same plan that were locked by this row)
      //    and re-open the revision so staff can rework.
      await manager.getRepository(DevelopmentPlanRevision).update(
        { id: developmentPlanRevisionId },
        { isBooked: false, bookedAt: null, isOpen: true },
      );

      // 7. Restore parent leaf for every RPG in the cancelled snapshot.
      await this.restoreLineageAfterCancel(
        snapshotIds,
        currentVersion.id,
        manager,
      );

      // NOTE (cancel-no-destroy, 2026-06-05): version cancel does NOT fire
      // the §18 `cascadeOnBookCancel`. Per CLAUDE.md §18.2, the §18 cancel
      // cascade is reserved for (A) BOOK softRemove (the whole revision round
      // is deleted → children genuinely orphaned). This is (B) — an assembly
      // VERSION cancel that REOPENS the revision (step 6, isOpen=true) for
      // rework. Steps 5-7 already un-book the snapshot RPGs and restore lineage,
      // leaving the RPG rows LIVE and reusable (mirrors the CORRECTION_PART3
      // full reset and the SupplementAssembly precedent). Soft-deleting the
      // children here would force agencies to re-add projects from scratch.

      this.logger.log(
        `[EditAssembly] cancelPublishedVersion revision=${developmentPlanRevisionId} v${currentVersion.versionNumber} by user=${userId}`,
      );
    });
  }

  // ===================================================================
  // Public API — Correct (deprecate current + spawn new draft)
  // ===================================================================

  /**
   * Deprecate the current COMPLETED edit-revision version and spawn a
   * new PREPARING draft pre-populated with the parts NOT being
   * corrected.
   *
   * Mode semantics:
   *   - CORRECTION_PART1 / CORRECTION_PART2 — surgical correction. Part 3
   *     and the un-targeted part are auto-REUSED; RPGs UNAFFECTED.
   *   - CORRECTION_PART3 — FULL RESET. Every RPG in the deprecated
   *     version's snapshot has its `isBooked` / `bookedAt` /
   *     `pageNumber` cleared. The revision flips `isBooked = false` /
   *     `bookedAt = null` / `isOpen = true` so the §15 chain releases
   *     and staff can rework. Part 3 stays PENDING in the new draft.
   *
   * The `cancellation` mode is intentionally unreachable here: the DTO
   * enum excludes it (cancel uses the dedicated `cancelPublishedVersion`
   * endpoint per the supplement / book-assembly precedent).
   */
  async correct(
    developmentPlanRevisionId: string,
    dto: CorrectEditBookDto,
    userId: string,
  ): Promise<EditAssemblyDraftDto> {
    if (
      dto.correctionMode !== EditAssemblyCorrectionMode.CORRECTION_PART1 &&
      dto.correctionMode !== EditAssemblyCorrectionMode.CORRECTION_PART2 &&
      dto.correctionMode !== EditAssemblyCorrectionMode.CORRECTION_PART3
    ) {
      throw new BadRequestException(
        'correctionMode ต้องเป็น correction_part1, correction_part2 หรือ correction_part3',
      );
    }

    return this.dataSource.transaction(async (manager) => {
      // §15 revision freeze guard.
      await this.assertEditBookNotFrozen(developmentPlanRevisionId, manager);

      // 1. Operator authorization.
      const { workHistory } = await this.validateDeprecationAuth(
        dto.confirmed,
        dto.citizenIdSuffix,
        userId,
        manager,
      );

      // 2. Load current COMPLETED version with pessimistic write lock.
      const currentVersion = await manager.findOne(EditAssemblyVersion, {
        where: {
          developmentPlanRevisionId,
          status: EditAssemblyVersionStatus.COMPLETED,
        },
        lock: { mode: 'pessimistic_write' },
        order: { versionNumber: 'DESC' },
      });
      if (!currentVersion) {
        throw new NotFoundException(
          'ไม่พบเวอร์ชันที่เสร็จสมบูรณ์สำหรับเล่มฉบับแก้ไขนี้',
        );
      }

      // 3. Block if a CANCELED draft is parked (must restore/purge first).
      const canceledDraft = await manager.findOne(EditAssemblyDraft, {
        where: {
          developmentPlanRevisionId,
          assemblyStatus: EditAssemblyDraftStatus.CANCELED,
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
      // 3b. Block if an active draft already exists.
      const activeDraft = await manager.findOne(EditAssemblyDraft, {
        where: {
          developmentPlanRevisionId,
          assemblyStatus: In([
            EditAssemblyDraftStatus.PREPARING,
            EditAssemblyDraftStatus.READY,
          ]),
        },
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
        dto.correctionMode === EditAssemblyCorrectionMode.CORRECTION_PART3;

      // 3c. §14.11 correction-time descendant guard (parity with the
      //     cancel guard above). CORRECTION_PART3 un-books every RPG in
      //     the deprecated version's snapshot (step 5a). If ANY of those
      //     RPGs was forked into a LATER book (live §14 descendant,
      //     prev_project_type='revised'), un-booking it here would strand
      //     the forked source: the downstream fork still points at it, so
      //     the source stays permanently §14-locked while its booked
      //     standing is gone ("ขาดช่วง"). Block exactly as cancel does.
      //     Reuses LineageLockService — no parallel query. Runs INSIDE the
      //     transaction, BEFORE the deprecate/un-book writes. PART1/PART2
      //     leave RPGs booked, so they are NOT guarded.
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

      // 4. Deprecate current version.
      await manager.update(EditAssemblyVersion, currentVersion.id, {
        status: EditAssemblyVersionStatus.DEPRECATED,
        deprecatedAt: new Date(),
        deprecatedById: workHistory.id,
        deprecationReason: dto.reason,
      });

      // 5. CORRECTION_PART3 full reset (§20 parity with MAIN).
      if (isFullReset) {
        // 5a. Reset RPG booking on every RPG in the deprecated snapshot.
        const snapshotIds = currentVersion.part3ProjectSnapshot ?? [];
        if (snapshotIds.length > 0) {
          await manager.getRepository(RevisedProjectGroup).update(
            { id: In(snapshotIds) },
            { isBooked: false, bookedAt: null, pageNumber: null },
          );
        }
        // 5a-ii. Equipment (ผ.03 revision) un-stamp — CORRECTION_PART3
        //     full-reset only (PART1/PART2 leave stamps intact).
        //     Clears RELPG booking via metadataJson.approvedRelpgIds.
        //     §20.10.3 raw SQL; §17.2 — no TrackingStatus / ai_* write.
        await this.resetRelpgBooking(currentVersion, manager);
        // 5b. Reset revision state (clear bookedAt + re-open so §15
        //     chain releases and staff can rework).
        await manager.getRepository(DevelopmentPlanRevision).update(
          { id: developmentPlanRevisionId },
          { isBooked: false, bookedAt: null, isOpen: true },
        );
        // 5c. Roll back lineage leaf pointers on every RPG in the
        //     deprecated snapshot so leaf state stays coherent with
        //     the version's deprecation.
        await this.restoreLineageAfterCancel(
          snapshotIds,
          currentVersion.id,
          manager,
        );
        // Note: EDIT does NOT have PlanPhase rows to reset (revisions
        // don't have phases — revisions have `isOpen` on themselves,
        // which we already flipped to true in step 5b).
      }

      // 6. Create new draft.
      const nextVersion = currentVersion.versionNumber + 1;
      const correctLocation = await this.resolveEditLocation(
        developmentPlanRevisionId,
        manager,
      );
      this.fileService.createVersionFolders(correctLocation, nextVersion);

      const draft = manager.create(EditAssemblyDraft, {
        developmentPlanRevisionId,
        targetVersion: nextVersion,
        previousVersionId: currentVersion.id,
        correctionMode: dto.correctionMode,
        correctionReason: dto.reason,
        part1Status: EditAssemblyPartUploadStatus.PENDING,
        part2Status: EditAssemblyPartUploadStatus.PENDING,
        part3Status: EditAssemblyPartUploadStatus.PENDING,
        assemblyStatus: EditAssemblyDraftStatus.PREPARING,
        createdById: workHistory.id,
      });

      // 7. Auto-reuse parts that are NOT being corrected.
      const correctingPart =
        dto.correctionMode === EditAssemblyCorrectionMode.CORRECTION_PART1
          ? 1
          : dto.correctionMode === EditAssemblyCorrectionMode.CORRECTION_PART2
            ? 2
            : 3;

      for (const pn of [1, 2, 3] as const) {
        if (pn === correctingPart) continue;
        if (pn === 3 && isFullReset) continue;

        try {
          const copiedPath = this.fileService.copyPartFromVersion(
            correctLocation,
            currentVersion.versionNumber,
            nextVersion,
            pn,
          );
          const now = new Date();
          if (pn === 1) {
            draft.part1Status = EditAssemblyPartUploadStatus.REUSED;
            draft.part1FilePath = copiedPath;
            draft.part1OriginalFileName = currentVersion.part1OriginalFileName;
            draft.part1UploadedAt = now;
            draft.part1UploadedById = workHistory.id;
          } else if (pn === 2) {
            draft.part2Status = EditAssemblyPartUploadStatus.REUSED;
            draft.part2FilePath = copiedPath;
            draft.part2OriginalFileName = currentVersion.part2OriginalFileName;
            draft.part2UploadedAt = now;
            draft.part2UploadedById = workHistory.id;
          } else {
            // Only reachable on CORRECTION_PART1 / CORRECTION_PART2
            // (PART3 full reset `continue`s above).
            draft.part3Status = EditAssemblyPartUploadStatus.REUSED;
            draft.part3FilePath = copiedPath;
            draft.part3GeneratedAt = now;
            draft.part3ProjectSnapshot = currentVersion.part3ProjectSnapshot;
            // Wave A2 — repopulate page_map from the deprecated
            // version-projects join (NOT from inline JSONB).
            const sourceJoin = await manager
              .getRepository(EditAssemblyVersionProject)
              .find({
                where: { versionId: currentVersion.id },
                select: ['revisedProjectGroupId', 'pageNumber'],
              });
            draft.part3PageMap = Object.fromEntries(
              sourceJoin.map((r) => [r.revisedProjectGroupId, r.pageNumber]),
            );
          }
        } catch (copyError) {
          this.logger.warn(
            `[EditAssembly] correct: failed to reuse part-${pn} from v${currentVersion.versionNumber}: ${
              (copyError as Error)?.message
            }`,
          );
        }
      }

      this.updateAssemblyStatus(draft);
      const saved = await manager.save(EditAssemblyDraft, draft);

      this.logger.log(
        `[EditAssembly] correct revision=${developmentPlanRevisionId} v${currentVersion.versionNumber} → draft v${nextVersion} mode=${dto.correctionMode} isFullReset=${isFullReset}`,
      );

      const full = await manager.findOne(EditAssemblyDraft, {
        where: { id: saved.id },
        relations: ['createdBy', 'createdBy.user'],
      });
      return this.toDraftDto(full ?? saved);
    });
  }

  /**
   * Un-stamp the RELPG (ผ.03 revision equipment) booking columns recorded
   * on a cancelled / fully-reset version's `metadataJson.approvedRelpgIds`
   * (written by BE-02 at merge time). Symmetric to the merge-time stamp;
   * clears `is_booked` / `booked_at` / `page_number` so the equipment
   * rows are not stranded booked under a deprecated version.
   *
   * §20.10.3 — raw SQL via `manager.query`, NEVER importing
   * `RevisedEquipmentProjectGroup` into the edit-assembly module.
   * §17.2 — pure column flip; NO `tracking_status` row, NO `ai_*` write,
   * NO notification dispatch.
   *
   * Legacy version rows have no `approvedRelpgIds` key (they never
   * stamped equipment), so `Array.isArray` short-circuits to a silent
   * no-op — nothing to clear.
   */
  private async resetRelpgBooking(
    version: EditAssemblyVersion,
    manager: EntityManager,
  ): Promise<void> {
    const meta = (version.metadataJson as Record<string, unknown> | null) ?? {};
    const ids = meta['approvedRelpgIds'];
    if (!Array.isArray(ids) || ids.length === 0) return;
    await manager.query(
      `UPDATE revised_equipment_project_groups
         SET is_booked = false,
             booked_at = NULL,
             page_number = NULL
       WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    this.logger.log(
      `[EditAssembly] reset ${ids.length} RELPG row(s) version=${version.id}`,
    );
  }

  // ===================================================================
  // Public API — Read versions
  // ===================================================================

  async getVersions(
    developmentPlanRevisionId: string,
    userId: string,
  ): Promise<EditAssemblyVersionDto[]> {
    await this.loadAndValidateWorkHistory(userId, READ_ROLES);
    const rows = await this.versionRepo.find({
      where: { developmentPlanRevisionId },
      order: { versionNumber: 'DESC' },
      relations: ['createdBy', 'createdBy.user', 'deprecatedBy', 'deprecatedBy.user'],
    });
    return rows.map((r) => this.toVersionDto(r));
  }

  /**
   * Returns the current effective version.
   *
   * Resolution order (mirrors main / supplement precedent):
   *   1. The COMPLETED version, if one exists (partial unique index
   *      guarantees at most one).
   *   2. If no COMPLETED row exists (in-flight correction), fall back
   *      to the DEPRECATED row referenced by the active draft's
   *      `previousVersionId`.
   *   3. null otherwise — HTTP 200 with body `null`, NOT 404, so the
   *      FE `loadState()` does not surface a spurious error toast.
   */
  async getCurrentVersion(
    developmentPlanRevisionId: string,
    userId: string,
  ): Promise<EditAssemblyVersionDto | null> {
    await this.loadAndValidateWorkHistory(userId, READ_ROLES);

    // Step 1 — COMPLETED.
    const completed = await this.versionRepo.findOne({
      where: {
        developmentPlanRevisionId,
        status: EditAssemblyVersionStatus.COMPLETED,
      },
      relations: ['createdBy', 'createdBy.user'],
    });
    if (completed) return this.enrichWithDownstreamFork(completed);

    // Step 2 — DEPRECATED via active draft's previousVersionId.
    const activeDraft = await this.draftRepo.findOne({
      where: {
        developmentPlanRevisionId,
        assemblyStatus: In([
          EditAssemblyDraftStatus.PREPARING,
          EditAssemblyDraftStatus.READY,
        ]),
      },
    });
    if (activeDraft?.previousVersionId) {
      const previous = await this.versionRepo.findOne({
        where: { id: activeDraft.previousVersionId },
        relations: ['createdBy', 'createdBy.user'],
      });
      if (previous) return this.enrichWithDownstreamFork(previous);
    }

    return null;
  }

  /**
   * §14.11 (read-side) — wrap toVersionDto and set the advisory
   * hasDownstreamFork flag (§17.2). Current-version / version-by-number reads
   * only; never on the list endpoint (avoids N×snapshot exists() queries).
   */
  private async enrichWithDownstreamFork(
    v: EditAssemblyVersion,
  ): Promise<EditAssemblyVersionDto> {
    const dto = this.toVersionDto(v);
    dto.hasDownstreamFork = await this.computeHasDownstreamFork(
      v.part3ProjectSnapshot ?? [],
      this.dataSource.manager,
    );
    return dto;
  }

  async getVersionByNumber(
    developmentPlanRevisionId: string,
    versionNumber: number,
    userId: string,
  ): Promise<EditAssemblyVersionDto> {
    await this.loadAndValidateWorkHistory(userId, READ_ROLES);
    const version = await this.versionRepo.findOne({
      where: { developmentPlanRevisionId, versionNumber },
      relations: ['createdBy', 'createdBy.user'],
    });
    if (!version) {
      throw new NotFoundException(
        `ไม่พบเวอร์ชัน v${versionNumber} สำหรับเล่มฉบับแก้ไขนี้`,
      );
    }
    return this.enrichWithDownstreamFork(version);
  }

  // ===================================================================
  // Public API — Readiness + book display state
  // ===================================================================

  /**
   * Approval-progress readiness used by the FE assembly gate. Mirrors
   * `BookAssemblyService.getRevisionRoundReadiness` for EDIT sources.
   */
  async getReadiness(
    developmentPlanRevisionId: string,
    userId: string,
  ): Promise<EditReadinessDto> {
    await this.loadAndValidateWorkHistory(userId, READ_ROLES);

    const totalCount = await this.revisedProjectGroupRepo
      .createQueryBuilder('rp')
      .innerJoin('rp.trackingStatus', 'ts')
      .innerJoin('ts.statusId', 'status')
      .where('rp.developmentPlanRevision = :id', { id: developmentPlanRevisionId })
      .andWhere('rp.deletedAt IS NULL')
      .andWhere('ts.isLatest = :isLatest', { isLatest: true })
      .andWhere('status.name NOT IN (:...excluded)', {
        excluded: READINESS_EXCLUSION_STATUSES,
      })
      .getCount();

    const approvedCount = await this.revisedProjectGroupRepo
      .createQueryBuilder('rp')
      .innerJoin('rp.trackingStatus', 'ts')
      .innerJoin('ts.statusId', 'status')
      .where('rp.developmentPlanRevision = :id', { id: developmentPlanRevisionId })
      .andWhere('rp.deletedAt IS NULL')
      .andWhere('ts.isLatest = :isLatest', { isLatest: true })
      .andWhere('status.name = :name', { name: STATUS_NAMES.APPROVED })
      .getCount();

    // Approved RELPG (ครุภัณฑ์ ผ.03) under the SAME revision scope as the RPG
    // counts above. Approved-only to mirror the §20.2 EDIT/CHANGE ผ.03 append
    // (the formal booked set) and to stay on the same "อนุมัติแล้ว" basis as
    // approvedCount above. Same join shape as the RPG counts (relation alias
    // `trackingStatus` → `statusId`); the RELPG FK on tracking_status is
    // `revised_equipment_project_group_id` (§12). Pure read — §17.2 advisory.
    const approvedEquipmentCount = await this.relpgRepo
      .createQueryBuilder('relpg')
      .innerJoin('relpg.trackingStatus', 'ts')
      .innerJoin('ts.statusId', 'status')
      .where('relpg.developmentPlanRevision = :id', {
        id: developmentPlanRevisionId,
      })
      .andWhere('relpg.deletedAt IS NULL')
      .andWhere('ts.isLatest = :isLatest', { isLatest: true })
      .andWhere('status.name = :name', { name: STATUS_NAMES.APPROVED })
      .getCount();

    // EDIT uses `DevelopmentPlanRevision.isOpen` (single-row predicate)
    // — mirrors `BookAssemblyService.getRevisionRoundReadiness`.
    const revision = await this.devPlanRevisionRepo.findOne({
      where: { id: developmentPlanRevisionId },
      select: ['id', 'isOpen'],
    });
    const hasOpenPhase = revision?.isOpen ?? false;
    const isReady = approvedCount === totalCount && totalCount > 0 && !hasOpenPhase;

    // Origin breakdown.
    const agencyCount = await this.revisedProjectGroupRepo
      .createQueryBuilder('rp')
      .innerJoin('rp.createdBy', 'wh')
      .innerJoin('wh.amphoe', 'amp')
      .innerJoin('wh.localAdministrativeOrganization', 'lao')
      .innerJoin('rp.trackingStatus', 'ts')
      .innerJoin('ts.statusId', 'status')
      .where('rp.developmentPlanRevision = :id', { id: developmentPlanRevisionId })
      .andWhere('rp.deletedAt IS NULL')
      .andWhere('ts.isLatest = :isLatest', { isLatest: true })
      .andWhere('status.name NOT IN (:...excluded)', {
        excluded: READINESS_EXCLUSION_STATUSES,
      })
      .andWhere('amp.id = :amphoeId', { amphoeId: '3001' })
      .andWhere('lao.id = :laoId', { laoId: '3001027' })
      .getCount();
    const laoCount = totalCount - agencyCount;

    // Status counts.
    const statusRows: { statusName: string; cnt: string }[] = await this.revisedProjectGroupRepo
      .createQueryBuilder('rp')
      .select('status.name', 'statusName')
      .addSelect('COUNT(rp.id)', 'cnt')
      .innerJoin('rp.trackingStatus', 'ts')
      .innerJoin('ts.statusId', 'status')
      .where('rp.developmentPlanRevision = :id', { id: developmentPlanRevisionId })
      .andWhere('rp.deletedAt IS NULL')
      .andWhere('ts.isLatest = :isLatest', { isLatest: true })
      .groupBy('status.name')
      .getRawMany();
    const statusMap: Record<string, number> = {};
    for (const row of statusRows) {
      statusMap[row.statusName] = parseInt(row.cnt, 10);
    }

    const breakdown: EditReadinessBreakdownDto = {
      agencyCount,
      laoCount,
      pendingCount: statusMap[STATUS_NAMES.PENDING] ?? 0,
      verifiedCount: statusMap[STATUS_NAMES.VERIFIED] ?? 0,
      pendingApprovalCount: statusMap[STATUS_NAMES.PENDING_APPROVAL] ?? 0,
      approvedCount: statusMap[STATUS_NAMES.APPROVED] ?? 0,
      readyCount: statusMap[STATUS_NAMES.READY] ?? 0,
      returnedForRevisionCount: statusMap[STATUS_NAMES.RETURNED_FOR_REVISION] ?? 0,
      pullBackCount: statusMap[STATUS_NAMES.PULL_BACK] ?? 0,
      rejectedCount: statusMap[STATUS_NAMES.REJECTED] ?? 0,
      totalCount,
      approvedEquipmentCount,
    };

    return { approvedCount, totalCount, isReady, hasOpenPhase, breakdown };
  }

  /**
   * Display-state envelope for the assembly dashboard.
   *
   * §15 — `isLeaf` is derived from
   * `BookLockService.assertEditable(revisionId,
   * 'development_plan_revision', em)`. A revision with any
   * strictly-newer-bookedAt sibling under the same plan (across both
   * revision + supplement tables) is FROZEN_HISTORICAL.
   */
  async getBookDisplayState(
    developmentPlanRevisionId: string,
    userId: string,
  ): Promise<EditBookDisplayStateDto> {
    await this.loadAndValidateWorkHistory(userId, READ_ROLES);

    const dto = new EditBookDisplayStateDto();
    dto.developmentPlanRevisionId = developmentPlanRevisionId;
    dto.hasActiveDraftDependency = false;
    dto.blockedProjectCount = 0;

    // §15 freeze — if BookLockService throws, the revision is locked.
    try {
      await this.bookLockService.assertEditable(
        developmentPlanRevisionId,
        'development_plan_revision',
        this.devPlanRevisionRepo.manager,
      );
      dto.isLeaf = true;
    } catch {
      dto.isLeaf = false;
      dto.state = EditBookDisplayStateEnum.FROZEN_HISTORICAL;
      return dto;
    }

    const completed = await this.versionRepo.findOne({
      where: {
        developmentPlanRevisionId,
        status: EditAssemblyVersionStatus.COMPLETED,
      },
    });
    if (completed) {
      dto.state = EditBookDisplayStateEnum.PUBLISHED_LATEST;
      return dto;
    }

    const hasActiveDraft = await this.draftRepo.exists({
      where: {
        developmentPlanRevisionId,
        assemblyStatus: In([
          EditAssemblyDraftStatus.PREPARING,
          EditAssemblyDraftStatus.READY,
        ]),
      },
    });
    dto.state = hasActiveDraft
      ? EditBookDisplayStateEnum.DRAFT
      : EditBookDisplayStateEnum.NO_BOOK;
    return dto;
  }

  // ===================================================================
  // Public API — File path resolution (controller streams from these)
  // ===================================================================

  async getMergedPdfPath(
    developmentPlanRevisionId: string,
    versionNumber: number,
  ): Promise<string> {
    const version = await this.versionRepo.findOne({
      where: { developmentPlanRevisionId, versionNumber },
    });
    if (!version || !version.mergedFilePath) {
      throw new NotFoundException(`ไม่พบไฟล์เล่มรวม v${versionNumber}`);
    }
    return this.fileService.getAbsolutePathByStored(version.mergedFilePath);
  }

  async getPartPdfPath(
    developmentPlanRevisionId: string,
    versionNumber: number,
    partNumber: 1 | 2 | 3,
  ): Promise<string> {
    this.fileService.validatePartNumber(partNumber);
    const version = await this.versionRepo.findOne({
      where: { developmentPlanRevisionId, versionNumber },
    });
    if (!version) {
      throw new NotFoundException(`ไม่พบเวอร์ชัน v${versionNumber}`);
    }
    const stored =
      partNumber === 1
        ? version.part1FilePath
        : partNumber === 2
          ? version.part2FilePath
          : version.part3FilePath;
    if (!stored) {
      throw new NotFoundException(`ไม่พบไฟล์ part-${partNumber}.pdf ในเวอร์ชัน v${versionNumber}`);
    }
    return this.fileService.getAbsolutePathByStored(stored);
  }

  async getDraftPartFile(
    developmentPlanRevisionId: string,
    partNumber: 1 | 2 | 3,
    userId: string,
  ): Promise<{ absPath: string; filename: string }> {
    await this.loadAndValidateWorkHistory(userId, READ_ROLES);
    const draft = await this.draftRepo.findOne({
      where: {
        developmentPlanRevisionId,
        assemblyStatus: In([
          EditAssemblyDraftStatus.PREPARING,
          EditAssemblyDraftStatus.READY,
        ]),
      },
    });
    if (!draft) {
      throw new NotFoundException('ไม่พบ draft ที่กำลังดำเนินการ');
    }
    const filePath =
      partNumber === 1
        ? draft.part1FilePath
        : partNumber === 2
          ? draft.part2FilePath
          : draft.part3FilePath;
    if (!filePath) {
      throw new NotFoundException('ไม่พบไฟล์สำหรับส่วนนี้');
    }
    const absPath = this.storagePathService.resolveStored(filePath);
    if (!fs.existsSync(absPath)) {
      throw new NotFoundException('ไม่พบไฟล์บนระบบ');
    }
    return { absPath, filename: `draft-part-${partNumber}.pdf` };
  }

  // ===================================================================
  // Private helpers — guards
  // ===================================================================

  private async loadAndValidateWorkHistory(
    userId: string,
    allowedRoles: string[],
  ): Promise<WorkHistory> {
    const workHistory = await this.workHistoryRepo.findOne({
      where: { user: { id: userId }, isCurrent: true },
      relations: ['role', 'workStatus'],
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
      throw new ForbiddenException('คุณไม่มีสิทธิ์ดำเนินการนี้');
    }
    return workHistory;
  }

  private validatePdfContent(buffer: Buffer, filename: string): void {
    const pdfMagicBytes = Buffer.from('%PDF-');
    if (buffer.length < 5 || !buffer.subarray(0, 5).equals(pdfMagicBytes)) {
      throw new BadRequestException(
        `ไฟล์ "${filename}" ไม่ใช่เอกสาร PDF ที่ถูกต้อง`,
      );
    }
  }

  private async loadActiveDraftOrFail(
    developmentPlanRevisionId: string,
    manager?: EntityManager,
  ): Promise<EditAssemblyDraft> {
    const repo = manager ? manager.getRepository(EditAssemblyDraft) : this.draftRepo;
    const draft = await repo.findOne({
      where: {
        developmentPlanRevisionId,
        assemblyStatus: In([
          EditAssemblyDraftStatus.PREPARING,
          EditAssemblyDraftStatus.READY,
        ]),
      },
    });
    if (!draft) {
      throw new NotFoundException(
        'ไม่พบ draft ที่กำลังดำเนินการ กรุณาสร้าง draft ใหม่',
      );
    }
    return draft;
  }

  /**
   * §15 revision freeze guard. Delegates to `BookLockService` which
   * encodes the canonical cross-category sibling predicate. Lets
   * `BOOK_HAS_NEWER_REVISION` propagate as-is (NO `MAIN_BOOK_FROZEN`
   * translation — that's MAIN-specific FE error contract per
   * CLAUDE.md §15.4).
   */
  private async assertEditBookNotFrozen(
    developmentPlanRevisionId: string,
    manager?: EntityManager,
  ): Promise<void> {
    const em = manager ?? this.devPlanRevisionRepo.manager;
    await this.bookLockService.assertEditable(
      developmentPlanRevisionId,
      'development_plan_revision',
      em,
    );
  }

  /**
   * Resolves the `(developmentPlanRevisionId)` tuple to a
   * `BookAssemblyLocation` of kind `'EDIT_REVISION'`. The file service
   * requires `planId` + `revisionNumber` + `revisionId` to construct the
   * canonical `main-plan-{planId}/edit/edit-{revNo}-{revId}/v{N}/`
   * layout.
   */
  private async resolveEditLocation(
    developmentPlanRevisionId: string,
    manager?: EntityManager,
  ): Promise<BookAssemblyLocation> {
    const repo = manager
      ? manager.getRepository(DevelopmentPlanRevision)
      : this.devPlanRevisionRepo;
    const revision = await repo.findOne({
      where: { id: developmentPlanRevisionId },
      relations: ['developmentPlan'],
    });
    if (!revision || !revision.developmentPlan) {
      throw new NotFoundException(
        `DevelopmentPlanRevision or its parent plan not found for id=${developmentPlanRevisionId}`,
      );
    }
    return {
      kind: 'EDIT_REVISION',
      planId: revision.developmentPlan.id,
      revisionNumber: revision.revisionNumber,
      revisionId: revision.id,
    };
  }

  // ===================================================================
  // Private helpers — auth chain (deprecation / correction)
  // ===================================================================

  private async validateDeprecationAuth(
    confirmed: boolean,
    citizenIdSuffix: string,
    userId: string,
    manager: EntityManager,
  ): Promise<{ workHistory: WorkHistory; identityMasked: string }> {
    const workHistory = await manager.findOne(WorkHistory, {
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
    if (!ADMIN_ROLES.includes(workHistory.role?.name)) {
      throw new ForbiddenException(
        'เฉพาะ admin หรือ super-admin เท่านั้นที่สามารถดำเนินการนี้ได้',
      );
    }
    if (!confirmed) {
      throw new BadRequestException('กรุณายืนยันการดำเนินการ (confirmed = true)');
    }

    this.assertIdentityNotLocked(userId);

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
    this.identityAttempts.delete(userId);
    return { workHistory, identityMasked: maskedSuffix };
  }

  private assertIdentityNotLocked(userId: string): void {
    const record = this.identityAttempts.get(userId);
    if (!record) return;
    if (record.lockedUntil && record.lockedUntil > new Date()) {
      const remaining = Math.ceil((record.lockedUntil.getTime() - Date.now()) / 60000);
      throw new ForbiddenException(
        `การดำเนินการถูกล็อกชั่วคราว โปรดลองอีกครั้งในอีก ${remaining} นาที`,
      );
    }
  }

  private recordIdentityFailure(userId: string): void {
    const record = this.identityAttempts.get(userId) ?? { count: 0 };
    record.count += 1;
    if (record.count >= MAX_IDENTITY_ATTEMPTS) {
      record.lockedUntil = new Date(Date.now() + IDENTITY_LOCK_MS);
      this.logger.warn(
        `[EditAssembly] identity verification locked for user ${userId} after ${record.count} failed attempts`,
      );
    }
    this.identityAttempts.set(userId, record);
  }

  // ===================================================================
  // Private helpers — lineage
  // ===================================================================

  /**
   * Populates the `edit_project_lineage` leaf chain for every RPG in
   * the snapshot after a successful merge. Mirrors
   * `MainAssemblyService.populateLineageForMerge` minus the
   * `projectType` discriminator (table membership IS the type).
   */
  private async populateLineageForMerge(
    projectIds: string[],
    newVersionId: string,
    manager: EntityManager,
  ): Promise<void> {
    if (!projectIds || projectIds.length === 0) return;
    const lineageRepo = manager.getRepository(EditProjectLineage);

    for (const projectId of projectIds) {
      const currentLeaf = await lineageRepo.findOne({
        where: { revisedProjectGroupId: projectId, isCurrentLeaf: true },
      });
      if (currentLeaf) {
        currentLeaf.isCurrentLeaf = false;
        await lineageRepo.save(currentLeaf);
      }
      const newRow = lineageRepo.create({
        revisedProjectGroupId: projectId,
        editAssemblyVersionId: newVersionId,
        parentEditAssemblyVersionId: currentLeaf
          ? currentLeaf.editAssemblyVersionId
          : null,
        isCurrentLeaf: true,
      });
      await lineageRepo.save(newRow);
    }

    this.logger.log(
      `[EditAssembly] lineage populated for ${projectIds.length} RPGs → versionId=${newVersionId}`,
    );
  }

  /**
   * After deprecating a version (via `correct` PART3 full reset OR
   * `cancelPublishedVersion`), restore parent leaf status on every RPG
   * in the cancelled snapshot.
   */
  private async restoreLineageAfterCancel(
    projectIds: string[],
    cancelledVersionId: string,
    manager: EntityManager,
  ): Promise<void> {
    if (!projectIds || projectIds.length === 0) return;
    const lineageRepo = manager.getRepository(EditProjectLineage);

    for (const projectId of projectIds) {
      const cancelledRow = await lineageRepo.findOne({
        where: {
          revisedProjectGroupId: projectId,
          editAssemblyVersionId: cancelledVersionId,
        },
      });
      if (!cancelledRow) continue;

      cancelledRow.isCurrentLeaf = false;
      await lineageRepo.save(cancelledRow);

      if (cancelledRow.parentEditAssemblyVersionId) {
        const parentRow = await lineageRepo.findOne({
          where: {
            revisedProjectGroupId: projectId,
            editAssemblyVersionId: cancelledRow.parentEditAssemblyVersionId,
          },
        });
        if (parentRow) {
          parentRow.isCurrentLeaf = true;
          await lineageRepo.save(parentRow);
        }
      }
    }
    this.logger.log(
      `[EditAssembly] lineage restored for ${projectIds.length} RPGs after deprecation of versionId=${cancelledVersionId}`,
    );
  }

  // ===================================================================
  // Private helpers — Part 3 generation
  // ===================================================================

  private async queryAndRenderPart3(
    developmentPlanRevisionId: string,
    _userId: string,
  ): Promise<{
    projects: any[];
    projectIds: string[];
    pageMap: { buffer: Buffer; pageMap: Map<string, number> };
  }> {
    // §16 — resolve reportFormat for sort order via the parent plan.
    const revision = await this.devPlanRevisionRepo.findOne({
      where: { id: developmentPlanRevisionId },
      relations: ['developmentPlan'],
    });
    if (!revision || !revision.developmentPlan) {
      throw new NotFoundException(
        `DevelopmentPlanRevision or its parent plan not found for id=${developmentPlanRevisionId}`,
      );
    }
    const reportFormat =
      revision.developmentPlan.reportFormat ?? ReportFormat.STRATEGY_BASED;

    const qb = this.revisedProjectGroupRepo
      .createQueryBuilder('rp')
      .leftJoinAndSelect('rp.developmentPlanRevision', 'dpr')
      .leftJoinAndSelect('dpr.developmentPlan', 'dp')
      .leftJoinAndSelect('rp.createdBy', 'createdBy')
      .leftJoinAndSelect('createdBy.user', 'createdByUser')
      .leftJoinAndSelect('createdBy.amphoe', 'amphoe')
      .leftJoinAndSelect('createdBy.localAdministrativeOrganization', 'lao')
      .leftJoinAndSelect('rp.strategy', 'strategy')
      .leftJoinAndSelect('rp.tactic', 'tactic')
      .leftJoinAndSelect('rp.plan', 'plan')
      .leftJoinAndSelect('rp.developmentIssue', 'developmentIssue')
      .leftJoinAndSelect('rp.budgets', 'budgets')
      .leftJoinAndSelect('rp.trackingStatus', 'ts')
      .leftJoinAndSelect('ts.statusId', 'status')
      .leftJoinAndSelect('rp.responsibleAgency', 'responsibleAgency')
      .leftJoinAndSelect('rp.originAgencyId', 'originAgencyId')
      .leftJoinAndSelect('originAgencyId.amphoe', 'originAgencyAmphoe')
      .where('dpr.id = :id', { id: developmentPlanRevisionId })
      .andWhere('rp.responsibleAgency IS NOT NULL')
      .andWhere('rp.isBooked = :isBooked', { isBooked: false })
      .andWhere('ts.isLatest = :isLatest', { isLatest: true })
      .andWhere('status.name = :name', { name: STATUS_NAMES.APPROVED })
      .andWhere('rp.deletedAt IS NULL');

    if (reportFormat === ReportFormat.ISSUE_BASED) {
      qb.orderBy('developmentIssue.sortOrder', 'ASC');
    } else {
      qb.orderBy('strategy.id', 'ASC');
    }

    const rows = await qb.getMany();
    const projects = rows.map((p) => UnifiedProjectMapper.fromRevisedProjectGroup(p));
    const projectIds = projects.map((p) => p.id);

    if (projects.length === 0) {
      return { projects, projectIds, pageMap: { buffer: Buffer.alloc(0), pageMap: new Map() } };
    }

    // Mirror `BookAssemblyService.generatePart3` revision branch — uses
    // `generateRevisionApprovedReportWithPageTracking` (not the main-plan
    // variant) so revision-specific PDF chrome is applied.
    const pdfResult = await this.pdfService.generateRevisionApprovedReportWithPageTracking(
      developmentPlanRevisionId,
      ['index', 'title', 'objective', 'target', 'budget', 'expectedResult', 'mainAgency'],
    );

    return { projects, projectIds, pageMap: pdfResult };
  }

  // ===================================================================
  // Private helpers — small utilities
  // ===================================================================

  private updateAssemblyStatus(draft: EditAssemblyDraft): void {
    const part1Ready = draft.part1Status !== EditAssemblyPartUploadStatus.PENDING;
    const part2Ready = draft.part2Status !== EditAssemblyPartUploadStatus.PENDING;
    const part3Ready = draft.part3Status !== EditAssemblyPartUploadStatus.PENDING;

    if (part1Ready && part2Ready && part3Ready) {
      draft.assemblyStatus = EditAssemblyDraftStatus.READY;
    } else if (draft.assemblyStatus === EditAssemblyDraftStatus.READY) {
      draft.assemblyStatus = EditAssemblyDraftStatus.PREPARING;
    }
  }

  private toPartSource(status: EditAssemblyPartUploadStatus): EditAssemblyPartSource {
    switch (status) {
      case EditAssemblyPartUploadStatus.UPLOADED:
        return EditAssemblyPartSource.UPLOADED;
      case EditAssemblyPartUploadStatus.GENERATED:
        return EditAssemblyPartSource.GENERATED;
      case EditAssemblyPartUploadStatus.REUSED:
        return EditAssemblyPartSource.REUSED;
      default:
        return EditAssemblyPartSource.UPLOADED;
    }
  }

  private async mergePdfBuffers(buffers: Buffer[]): Promise<Buffer> {
    if (buffers.length === 0) throw new Error('No PDF buffers provided for merging');
    if (buffers.length === 1) return buffers[0];
    const merged = await PDFDocument.create();
    for (const buffer of buffers) {
      const pdf = await PDFDocument.load(buffer);
      const copiedPages = await merged.copyPages(pdf, pdf.getPageIndices());
      copiedPages.forEach((page) => merged.addPage(page));
    }
    const mergedBytes = await merged.save();
    return Buffer.from(mergedBytes);
  }

  private async notifyProgress(
    userId: string,
    developmentPlanRevisionId: string,
    percentage: number,
    stage: string,
    message: string,
  ): Promise<void> {
    try {
      await this.websocketService.notifyPdfGenerationProgress({
        userId,
        developmentPlanId: developmentPlanRevisionId,
        progress: { percentage, stage, message },
      });
    } catch {
      // Non-fatal — progress events are best-effort.
    }
  }

  // ===================================================================
  // Private helpers — DTO mapping
  // ===================================================================

  private toDraftDto(d: EditAssemblyDraft): EditAssemblyDraftDto {
    return {
      id: d.id,
      developmentPlanRevisionId: d.developmentPlanRevisionId,
      assemblyStatus: d.assemblyStatus,
      part1Status: d.part1Status,
      part1OriginalFileName: d.part1OriginalFileName ?? null,
      part1UploadedAt: d.part1UploadedAt ? d.part1UploadedAt.toISOString() : null,
      part2Status: d.part2Status,
      part2OriginalFileName: d.part2OriginalFileName ?? null,
      part2UploadedAt: d.part2UploadedAt ? d.part2UploadedAt.toISOString() : null,
      part3Status: d.part3Status,
      part3GeneratedAt: d.part3GeneratedAt ? d.part3GeneratedAt.toISOString() : null,
      createdById: d.createdById,
      createdAt: d.createdAt ? d.createdAt.toISOString() : new Date().toISOString(),
      createdBy: d.createdBy
        ? {
            id: d.createdBy.id,
            user: d.createdBy.user
              ? {
                  prefix: d.createdBy.user.prefix,
                  firstName: d.createdBy.user.firstname,
                  lastName: d.createdBy.user.lastname,
                }
              : undefined,
          }
        : undefined,
    };
  }

  /**
   * §14.11 — collect the snapshot project ids that have a live (non-soft-
   * deleted) downstream fork (prev_project_type='revised'). SINGLE source of
   * truth shared by the cancel + CORRECTION_PART3 throw-guards (which surface
   * the ids in the 409 body) AND the read-side hasDownstreamFork flag, so the
   * pre-emptive FE disable can never disagree with the throw. Reuses
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
        'revised',
        manager,
      );
      if (forked) blocking.push(projectId);
    }
    return blocking;
  }

  /**
   * §14.11 (read-side) — boolean form of collectDownstreamForkIds, short-
   * circuiting on the first fork. Populates the advisory hasDownstreamFork DTO
   * flag (§17.2) on the current-version reads only.
   */
  private async computeHasDownstreamFork(
    snapshotIds: string[],
    manager: EntityManager,
  ): Promise<boolean> {
    for (const projectId of snapshotIds) {
      if (
        await this.lineageLockService.hasNonDeletedDescendant(
          projectId,
          'revised',
          manager,
        )
      ) {
        return true;
      }
    }
    return false;
  }

  private toVersionDto(v: EditAssemblyVersion): EditAssemblyVersionDto {
    const appUrl = process.env.APP_URL ?? '';
    const prefix = `${appUrl}/v1/edit-assembly/${v.developmentPlanRevisionId}`;
    return {
      id: v.id,
      developmentPlanRevisionId: v.developmentPlanRevisionId,
      versionNumber: v.versionNumber,
      status: v.status,
      correctionMode: v.correctionMode ?? null,
      correctionReason: v.correctionReason ?? null,
      part1Source: v.part1Source,
      part1OriginalFileName: v.part1OriginalFileName ?? null,
      part2Source: v.part2Source,
      part2OriginalFileName: v.part2OriginalFileName ?? null,
      part3Source: v.part3Source,
      part3ProjectCount: v.part3ProjectCount,
      part3ProjectSnapshot: v.part3ProjectSnapshot ?? null,
      mergedAt: v.mergedAt ? v.mergedAt.toISOString() : null,
      totalPages: v.totalPages ?? null,
      createdById: v.createdById,
      createdAt: v.createdAt ? v.createdAt.toISOString() : null,
      deprecatedAt: v.deprecatedAt ? v.deprecatedAt.toISOString() : null,
      deprecatedById: v.deprecatedById ?? null,
      deprecationReason: v.deprecationReason ?? null,
      createdBy: v.createdBy
        ? {
            id: v.createdBy.id,
            user: v.createdBy.user
              ? {
                  prefix: v.createdBy.user.prefix,
                  firstName: v.createdBy.user.firstname,
                  lastName: v.createdBy.user.lastname,
                }
              : undefined,
          }
        : undefined,
      deprecatedBy: v.deprecatedBy
        ? {
            id: v.deprecatedBy.id,
            user: v.deprecatedBy.user
              ? {
                  prefix: v.deprecatedBy.user.prefix,
                  firstName: v.deprecatedBy.user.firstname,
                  lastName: v.deprecatedBy.user.lastname,
                }
              : undefined,
          }
        : null,
      downloadUrl: `${prefix}/versions/${v.versionNumber}/download`,
      part1DownloadUrl: `${prefix}/versions/${v.versionNumber}/parts/1`,
      part2DownloadUrl: `${prefix}/versions/${v.versionNumber}/parts/2`,
      part3DownloadUrl: `${prefix}/versions/${v.versionNumber}/parts/3`,
    };
  }
}
