// ===================================================================
// ChangeAssemblyService — Wave A3 / BE-01 (OPTION-A-FULL-SPLIT)
// ===================================================================
//
// Orchestration service for the STANDALONE Change-Revision Assembly
// subsystem (Wave A3 of OPTION-A-FULL-SPLIT). Owns the in-flight
// Part1 → Part2 → Part3 → finalize state machine for
// `DevelopmentPlanRevision` rooted books (revisionType = change) and the
// correction / cancellation workflows that supersede or rollback a
// COMPLETED version.
//
// Locked decisions referenced inline:
//   - Q3=B  — standalone; this service MUST NOT import from
//             `src/book-assembly/`, `src/main-assembly/`,
//             `src/edit-assembly/`, or `src/supplement-assembly/`. Every
//             enum / DTO / entity that the legacy `BookAssemblyService`
//             shared via discriminator is duplicated under
//             `src/change-assembly/`. The lone exception is
//             `BookAssemblyFileService` (shared infrastructure for
//             on-disk file layout — same exemption noted in
//             `main-assembly.service.ts` and `edit-assembly.service.ts`).
//   - §18.2.1 — `merge()` is the new CHANGE_REVISION finalize trigger
//             surface; the §18 cascade fires INSIDE the transaction,
//             BEFORE `DevelopmentPlanRevision.isBooked = true` /
//             `bookedAt`. Cascade kind is `'REVISION'` (NOT `'PLAN'`).
//             Same cascade kind as EDIT — both are revision-style books.
//   - §20  — cancel of a published CHANGE version is ALLOWED (the only
//             §20.4 exempt cell is `MAIN_PLAN.cancel`).
//             `cancelPublishedVersion` mirrors the legacy
//             `BookAssemblyService.cancel` flow for revision sources
//             and the Wave A2 EDIT precedent: deprecate version, reset
//             RPG booking, reset revision state (`isBooked=false`,
//             `bookedAt=null`, `isOpen=true`), restore lineage, fire
//             §18 cancel cascade.
//
// Co-existence note (Wave A3 transition window):
//   - The legacy `BookAssemblyService` continues to handle CHANGE_REVISION
//     traffic via `book_assembly_*` tables until FE-01 atomically
//     switches every change-revision FE client to this service.
//   - The DB-01 backfill copied existing rows into `change_assembly_*`
//     with the SAME UUIDs so both stores observe the same versions
//     (live data count = 0 at authoring time; backfill is structural
//     future-proofing).
//   - Until FE switch: only ONE of the two services receives writes
//     per request, so divergence cannot accumulate.
//   - CLEANUP-01 (later wave) drops the legacy tables once telemetry
//     shows zero traffic to `book-assembly` CHANGE_REVISION endpoints.
//
// CLAUDE.md compliance:
//   - §2   workStatus = 'approved' — re-checked at service entry per
//          method.
//   - §4.1 / §18.3  authority inheritance — admin + super-admin only.
//   - §12  audit — the §18 cascade (NOT this service) writes
//          `tracking_status` rows. This service writes only
//          `change_assembly_*` tables + the revision's `isBooked` /
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

import { ChangeAssemblyDraft } from './entities/change-assembly-draft.entity';
import { ChangeAssemblyVersion } from './entities/change-assembly-version.entity';
import { ChangeAssemblyVersionProject } from './entities/change-assembly-version-project.entity';
import { ChangeProjectLineage } from './entities/change-project-lineage.entity';
import {
  ChangeAssemblyCorrectionMode,
  ChangeAssemblyDraftStatus,
  ChangeAssemblyPartSource,
  ChangeAssemblyPartUploadStatus,
  ChangeAssemblyVersionStatus,
} from './enums/change-assembly.enums';

import { CorrectChangeBookDto } from './dto/correct-change-book.dto';
import { CancelChangeBookDto } from './dto/cancel-change-book.dto';
import { ChangeAssemblyDraftDto } from './dto/change-assembly-draft-response.dto';
import { ChangeAssemblyVersionDto } from './dto/change-assembly-version-response.dto';
import {
  ChangeBookDisplayStateDto,
  ChangeBookDisplayStateEnum,
} from './dto/change-book-display-state.dto';
import {
  ChangeReadinessBreakdownDto,
  ChangeReadinessDto,
} from './dto/change-readiness.dto';

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
//   `main-plan-{planId}/change/change-{revNo}-{revId}/v{N}/...` is
//   canonical and the file service is the single source of truth for
//   STORAGE_ROOT-relative key resolution (per the BE-WRITERS wave
//   umbrella §7.1). Same exemption as `main-assembly.service.ts` and
//   `edit-assembly.service.ts`.

/** Roles permitted to perform change-assembly write actions (§4.1 / §18.3). */
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
export class ChangeAssemblyService {
  private readonly logger = new Logger(ChangeAssemblyService.name);

  /** In-memory identity-verification retry tracker. */
  private readonly identityAttempts = new Map<
    string,
    { count: number; lockedUntil?: Date }
  >();

  constructor(
    @InjectRepository(ChangeAssemblyDraft)
    private readonly draftRepo: Repository<ChangeAssemblyDraft>,

    @InjectRepository(ChangeAssemblyVersion)
    private readonly versionRepo: Repository<ChangeAssemblyVersion>,

    @InjectRepository(ChangeAssemblyVersionProject)
    private readonly versionProjectRepo: Repository<ChangeAssemblyVersionProject>,

    @InjectRepository(ChangeProjectLineage)
    private readonly lineageRepo: Repository<ChangeProjectLineage>,

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
    // §14.11 — cancel-time descendant guard (reuses canonical §14
    // lineage machinery; no parallel query).
    private readonly lineageLockService: LineageLockService,
    private readonly dataSource: DataSource,
  ) {}

  // ===================================================================
  // Sidebar Counts
  // ===================================================================

  /**
   * Counts the number of `DevelopmentPlanRevision` rows that are
   * "actionable" for the admin "รวมเล่มเปลี่ยนแปลง" sidebar badge.
   *
   * Restored 2026-05-29 after §20.10 CLEANUP wave removed the legacy
   * `GET /v1/book-assembly/counts` endpoint. Behavioural twin of
   * `EditAssemblyService.getActionableCount` — the only difference
   * is the revision-type discriminator
   * (`revisionType.name = 'เปลี่ยนแปลง'`). See that method's docs
   * for filter rationale.
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
      .andWhere('rt.name = :revisionType', { revisionType: 'เปลี่ยนแปลง' })
      .andWhere('r.is_latest = :isLatest', { isLatest: true })
      // 2026-06-04 — DROPPED `r.is_open = true` (twin of the EDIT change):
      // assembly is a POST-close step; gating on is_open made the "รวมเล่ม"
      // badge vanish right when assembly becomes due. Counts on is_booked =
      // false (open OR closed), mirroring MAIN_PLAN. See EditAssemblyService.
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
  ): Promise<ChangeAssemblyDraftDto> {
    const workHistory = await this.loadAndValidateWorkHistory(userId, ADMIN_ROLES);

    // §15 revision freeze guard.
    await this.assertChangeBookNotFrozen(developmentPlanRevisionId);

    // Reject if an active draft already exists.
    const existingDraft = await this.draftRepo.findOne({
      where: {
        developmentPlanRevisionId,
        assemblyStatus: In([
          ChangeAssemblyDraftStatus.PREPARING,
          ChangeAssemblyDraftStatus.READY,
        ]),
      },
    });
    if (existingDraft) {
      throw new ConflictException(
        'มี draft ที่กำลังดำเนินการอยู่แล้วสำหรับเล่มฉบับเปลี่ยนแปลงนี้ กรุณาดำเนินการต่อหรือยกเลิก draft เดิมก่อน',
      );
    }

    // Handle CANCELED draft — same behavior as BookAssemblyService.
    const canceledDraft = await this.draftRepo.findOne({
      where: {
        developmentPlanRevisionId,
        assemblyStatus: ChangeAssemblyDraftStatus.CANCELED,
      },
      order: { canceledAt: 'DESC' },
    });
    if (canceledDraft) {
      const completedVersion = await this.versionRepo.findOne({
        where: {
          developmentPlanRevisionId,
          status: ChangeAssemblyVersionStatus.COMPLETED,
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
        status: ChangeAssemblyVersionStatus.DEPRECATED,
      },
      order: { versionNumber: 'DESC' },
    });

    // Create folder structure (reuses the canonical revision-rooted layout).
    const draftLocation = await this.resolveChangeLocation(developmentPlanRevisionId);
    this.fileService.createVersionFolders(draftLocation, targetVersion);

    const draft = this.draftRepo.create({
      developmentPlanRevisionId,
      targetVersion,
      previousVersionId: deprecatedVersion?.id ?? null,
      correctionMode: null,
      correctionReason: null,
      part1Status: ChangeAssemblyPartUploadStatus.PENDING,
      part2Status: ChangeAssemblyPartUploadStatus.PENDING,
      part3Status: ChangeAssemblyPartUploadStatus.PENDING,
      assemblyStatus: ChangeAssemblyDraftStatus.PREPARING,
      createdById: workHistory.id,
    });

    const saved = await this.draftRepo.save(draft);
    this.logger.log(
      `Created change-revision draft revision=${developmentPlanRevisionId} v${targetVersion} draftId=${saved.id}`,
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
  ): Promise<ChangeAssemblyDraftDto | null> {
    await this.loadAndValidateWorkHistory(userId, READ_ROLES);
    const draft = await this.draftRepo.findOne({
      where: {
        developmentPlanRevisionId,
        assemblyStatus: In([
          ChangeAssemblyDraftStatus.PREPARING,
          ChangeAssemblyDraftStatus.READY,
        ]),
      },
      relations: ['createdBy', 'createdBy.user'],
    });
    return draft ? this.toDraftDto(draft) : null;
  }

  /**
   * Soft-deletes an active draft (status → CANCELED).
   *
   * Wave A3 / BE-01 — restoration of a deprecated version on discard
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

    draft.assemblyStatus = ChangeAssemblyDraftStatus.CANCELED;
    draft.canceledAt = new Date();
    draft.canceledById = workHistory.id;
    await this.draftRepo.save(draft);

    this.logger.log(
      `Discarded change-revision draft revision=${developmentPlanRevisionId} draftId=${draft.id}`,
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
  ): Promise<ChangeAssemblyDraft | null> {
    await this.loadAndValidateWorkHistory(userId, READ_ROLES);

    return this.draftRepo.findOne({
      where: {
        developmentPlanRevisionId,
        assemblyStatus: ChangeAssemblyDraftStatus.CANCELED,
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
  ): Promise<ChangeAssemblyDraft> {
    await this.loadAndValidateWorkHistory(userId, ADMIN_ROLES);

    // 1. Load the most recent CANCELED draft.
    const canceledDraft = await this.draftRepo.findOne({
      where: {
        developmentPlanRevisionId,
        assemblyStatus: ChangeAssemblyDraftStatus.CANCELED,
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
          ChangeAssemblyDraftStatus.PREPARING,
          ChangeAssemblyDraftStatus.READY,
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
      canceledDraft.part1Status === ChangeAssemblyPartUploadStatus.UPLOADED ||
      canceledDraft.part1Status === ChangeAssemblyPartUploadStatus.REUSED;
    const part2Ready =
      canceledDraft.part2Status === ChangeAssemblyPartUploadStatus.UPLOADED ||
      canceledDraft.part2Status === ChangeAssemblyPartUploadStatus.REUSED;
    const part3Ready =
      canceledDraft.part3Status === ChangeAssemblyPartUploadStatus.GENERATED ||
      canceledDraft.part3Status === ChangeAssemblyPartUploadStatus.REUSED;

    canceledDraft.assemblyStatus =
      part1Ready && part2Ready && part3Ready
        ? ChangeAssemblyDraftStatus.READY
        : ChangeAssemblyDraftStatus.PREPARING;

    // 4. Clear canceled fields.
    canceledDraft.canceledAt = null;
    canceledDraft.canceledById = null;

    const restored = await this.draftRepo.save(canceledDraft);
    this.logger.log(
      `Restored change-revision draft ${restored.id} for revision=${developmentPlanRevisionId} → ${restored.assemblyStatus}`,
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
        assemblyStatus: ChangeAssemblyDraftStatus.CANCELED,
      },
      order: { canceledAt: 'DESC' },
    });
    if (!canceledDraft) {
      throw new NotFoundException('ไม่พบ draft ที่ถูกยกเลิก');
    }

    await this.draftRepo.remove(canceledDraft);
    this.logger.log(
      `Purged canceled change-revision draft ${canceledDraft.id} for revision=${developmentPlanRevisionId}`,
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
  ): Promise<ChangeAssemblyDraftDto> {
    const workHistory = await this.loadAndValidateWorkHistory(userId, ADMIN_ROLES);

    if (!file || !file.buffer || file.buffer.length === 0) {
      throw new BadRequestException('กรุณาอัพโหลดไฟล์ PDF');
    }

    // Defense-in-depth — validate PDF magic bytes.
    this.validatePdfContent(file.buffer, file.originalname);

    // §15 revision freeze guard.
    await this.assertChangeBookNotFrozen(developmentPlanRevisionId);

    const draft = await this.loadActiveDraftOrFail(developmentPlanRevisionId);

    const uploadLocation = await this.resolveChangeLocation(developmentPlanRevisionId);
    const filePath = this.fileService.savePartFile(
      uploadLocation,
      draft.targetVersion,
      partNumber,
      file.buffer,
    );

    if (partNumber === 1) {
      draft.part1Status = ChangeAssemblyPartUploadStatus.UPLOADED;
      draft.part1FilePath = filePath;
      draft.part1OriginalFileName = file.originalname;
      draft.part1UploadedAt = new Date();
      draft.part1UploadedById = workHistory.id;
    } else {
      draft.part2Status = ChangeAssemblyPartUploadStatus.UPLOADED;
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
  ): Promise<ChangeAssemblyDraftDto> {
    await this.loadAndValidateWorkHistory(userId, ADMIN_ROLES);

    // §15 revision freeze guard.
    await this.assertChangeBookNotFrozen(developmentPlanRevisionId);

    const draft = await this.loadActiveDraftOrFail(developmentPlanRevisionId);

    await this.notifyProgress(userId, developmentPlanRevisionId, 10, 'starting', 'กำลังเริ่มสร้างส่วนที่ 3...');

    const { projects, projectIds, pageMap } = await this.queryAndRenderPart3(
      developmentPlanRevisionId,
      userId,
    );

    if (projects.length === 0) {
      throw new BadRequestException(
        'ไม่พบโครงการที่อนุมัติแล้วสำหรับเล่มฉบับเปลี่ยนแปลงนี้',
      );
    }

    const generateLocation = await this.resolveChangeLocation(developmentPlanRevisionId);
    const filePath = this.fileService.savePartFile(
      generateLocation,
      draft.targetVersion,
      3,
      pageMap.buffer,
    );

    draft.part3Status = ChangeAssemblyPartUploadStatus.GENERATED;
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
  ): Promise<ChangeAssemblyDraftDto> {
    const workHistory = await this.loadAndValidateWorkHistory(userId, ADMIN_ROLES);
    const draft = await this.loadActiveDraftOrFail(developmentPlanRevisionId);

    const sourceVersion = await this.versionRepo.findOne({
      where: { developmentPlanRevisionId, versionNumber: fromVersionNumber },
    });
    if (!sourceVersion) {
      throw new NotFoundException(
        `ไม่พบเวอร์ชัน v${fromVersionNumber} สำหรับเล่มฉบับเปลี่ยนแปลงนี้`,
      );
    }

    const reuseLocation = await this.resolveChangeLocation(developmentPlanRevisionId);
    const copiedPath = this.fileService.copyPartFromVersion(
      reuseLocation,
      fromVersionNumber,
      draft.targetVersion,
      partNumber,
    );

    if (partNumber === 1) {
      draft.part1Status = ChangeAssemblyPartUploadStatus.REUSED;
      draft.part1FilePath = copiedPath;
      draft.part1OriginalFileName = sourceVersion.part1OriginalFileName;
      draft.part1UploadedAt = new Date();
      draft.part1UploadedById = workHistory.id;
    } else if (partNumber === 2) {
      draft.part2Status = ChangeAssemblyPartUploadStatus.REUSED;
      draft.part2FilePath = copiedPath;
      draft.part2OriginalFileName = sourceVersion.part2OriginalFileName;
      draft.part2UploadedAt = new Date();
      draft.part2UploadedById = workHistory.id;
    } else {
      draft.part3Status = ChangeAssemblyPartUploadStatus.REUSED;
      draft.part3FilePath = copiedPath;
      draft.part3GeneratedAt = new Date();
      draft.part3ProjectSnapshot = sourceVersion.part3ProjectSnapshot;
      // Wave A3 / BE-01 — page map is now sourced from the version-
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

    if (draft.assemblyStatus !== ChangeAssemblyDraftStatus.READY) {
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

    // wave-edit-change-assembly-por03-append (§5.3 Phase 3 / §21.3 /
    // §17.2) — append the formal ผ.03 revision section (RELPG OLD-vs-NEW),
    // Approved-only + STRATEGY_BASED-only, read-only. ผ.02 Part 3 ของ
    // EDIT/CHANGE เริ่มนับหน้า 1 ใหม่ (§21.3.4) — ผ.03 ต่อจาก Part 3
    // จึง offset = pageCount(part3) เท่านั้น (ไม่รวม part1/part2). Degrades to null when no
    // Approved RELPG exists → ผ.02 book is produced verbatim.
    const por03Offset = (await PDFDocument.load(part3)).getPageCount();
    const por03 = await this.por03Service.renderApprovedRevisionScopedPor03Buffer(
      developmentPlanRevisionId,
      por03Offset,
    );
    return this.mergePdfBuffers(
      por03 ? [part1, part2, part3, por03.buffer] : [part1, part2, part3],
    );
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
  ): Promise<ChangeAssemblyVersionDto> {
    const workHistory = await this.loadAndValidateWorkHistory(userId, ADMIN_ROLES);

    return this.dataSource.transaction(async (manager) => {
      // §15 revision freeze guard (inside transaction).
      await this.assertChangeBookNotFrozen(developmentPlanRevisionId, manager);

      // 1. Load + validate draft.
      const draft = await manager.findOne(ChangeAssemblyDraft, {
        where: {
          developmentPlanRevisionId,
          assemblyStatus: ChangeAssemblyDraftStatus.READY,
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
      const mergeLocation = await this.resolveChangeLocation(
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
      // verbatim (no behavior change). §21.3.4 — CHANGE ผ.02 Part 3
      // restarts at 1, so offset = pageCount(part3); the printed footer
      // on ผ.03 page `i` reads `por03Offset + i`. The returned
      // `equipmentIds`/`pageMap` ARE consumed below to stamp RELPG
      // `is_booked` / `booked_at` / `page_number` per row.
      const por03Offset = (await PDFDocument.load(part3)).getPageCount();
      const por03 =
        await this.por03Service.renderApprovedRevisionScopedPor03Buffer(
          developmentPlanRevisionId,
          por03Offset,
        );
      const mergedBuffer = await this.mergePdfBuffers(
        por03 ? [part1, part2, part3, por03.buffer] : [part1, part2, part3],
      );
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
      // Cascade kind is 'REVISION' (NOT 'PLAN' like MAIN). Same kind as
      // EDIT — both EDIT and CHANGE are revision-style books.
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
        `[ChangeAssembly] merge cascade revision=${developmentPlanRevisionId} pg=${cascadeResult.pgCount} rpg=${cascadeResult.rpgCount}`,
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

      // 6b. Equipment (ผ.03 revision) booking stamp on Approved RELPGs.
      //     Mirrors `edit-assembly.service.ts` step 6b (the EDIT/CHANGE
      //     sub-types share the same RELPG lineage discriminator
      //     `'revised_equipment'`). §21.3.4 — CHANGE ผ.02 Part 3
      //     restarts at 1, so absolutePage(id) = por03Offset + local.
      //     §12 — booking flip is NOT a status transition; no
      //     TrackingStatus row written.
      if (por03 && por03.equipmentIds.length > 0) {
        const relpgIds = por03.equipmentIds;
        const relpgBookedAt = new Date();
        const relpgPages: (number | null)[] = relpgIds.map((id) => {
          const local = por03.pageMap.get(id);
          return local === undefined ? null : por03Offset + local;
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
          `[ChangeAssembly] merge stamped isBooked + page_number on ${relpgIds.length} RELPG row(s) revision=${developmentPlanRevisionId}`,
        );
      }

      // 7. Revision booking flip. Mirrors the legacy
      //    `BookAssemblyService.merge` path for revision sources —
      //    `bookedAt` is set so the §15 strict-`>` predicate kicks in.
      //    Note: unlike MAIN, CHANGE does NOT touch any `PlanPhase` row
      //    (revisions don't have PlanPhases — they have `isOpen`
      //    on the revision itself, which finalize flips to false).
      await manager.getRepository(DevelopmentPlanRevision).update(
        { id: developmentPlanRevisionId },
        { isBooked: true, bookedAt: new Date(), isOpen: false },
      );

      await this.notifyProgress(userId, developmentPlanRevisionId, 70, 'saving', 'กำลังบันทึกข้อมูล...');

      // 8. Insert version row (NO inline part3_page_map per Wave A3).
      const versionRow = manager.create(ChangeAssemblyVersion, {
        developmentPlanRevisionId,
        versionNumber: draft.targetVersion,
        status: ChangeAssemblyVersionStatus.COMPLETED,
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
      const savedVersion = await manager.save(ChangeAssemblyVersion, versionRow);

      // 9. Write the version-projects join (Wave A3 page_map
      // denormalization — replaces the legacy inline JSONB).
      const joinRepo = manager.getRepository(ChangeAssemblyVersionProject);
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
      draft.assemblyStatus = ChangeAssemblyDraftStatus.MERGED;
      await manager.save(ChangeAssemblyDraft, draft);

      // 11. Populate per-RPG lineage.
      await this.populateLineageForMerge(projectIds, savedVersion.id, manager);

      await this.notifyProgress(userId, developmentPlanRevisionId, 100, 'completed', 'รวมเล่มสำเร็จแล้ว!');

      this.logger.log(
        `[ChangeAssembly] merge revision=${developmentPlanRevisionId} v${draft.targetVersion} projects=${projectIds.length} pages=${totalPages}`,
      );

      const full = await manager.findOne(ChangeAssemblyVersion, {
        where: { id: savedVersion.id },
        relations: ['createdBy', 'createdBy.user'],
      });
      return this.toVersionDto(full ?? savedVersion);
    });
  }

  // ===================================================================
  // Public API — Cancel published version (§20.2 LIVE for CHANGE)
  // ===================================================================

  /**
   * §20.2 — cancelling a PUBLISHED CHANGE_REVISION version is LIVE.
   * The only §20.4 exempt cell is `MAIN_PLAN.cancel`; CHANGE supports
   * cancel via this endpoint.
   *
   * Flow (mirrors `BookAssemblyService.cancel` for revision sources,
   * the Wave A2 EDIT precedent, and `SupplementAssemblyService.cancelPublishedVersion`):
   *   1. Authorize operator (role, workStatus, confirmed, citizenIdSuffix).
   *   2. §15 lock guard on the revision (inside the transaction).
   *   3. Load the COMPLETED version with a pessimistic write lock.
   *   4. Descendant guard — block if any child lineage row references
   *      this version as a `parentChangeAssemblyVersionId` AND is still
   *      a current leaf.
   *   5. Mark version DEPRECATED + persist deprecation audit fields.
   *   6. Reset every RPG in the snapshot: `isBooked=false`,
   *      `bookedAt=null`, `pageNumber=null`.
   *   7. Reset revision state: `isBooked=false`, `bookedAt=null`,
   *      `isOpen=true` (re-open so staff can rework). Clearing
   *      `bookedAt` removes the revision from the §15.3 strict-`>`
   *      sibling probe, releasing any older sibling under the same
   *      plan that was locked by this row.
   *   8. Restore parent leaf in `change_project_lineage` for every RPG
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
   * Per the supplement / EDIT precedent (`SupplementAssemblyService`,
   * `EditAssemblyService`), the audit log write is OPTIONAL for the
   * standalone subsystems — it writes to the shared
   * `deprecation_audit_log` table when the helper is wired. Wave A3 /
   * BE-01 defers the explicit audit-log write to a follow-up (same
   * pattern as supplement and EDIT) — the `validateDeprecationAuth`
   * chain itself records the SUCCESS / FAILURE outcome via
   * service-level logging.
   */
  async cancelPublishedVersion(
    developmentPlanRevisionId: string,
    versionId: string,
    dto: CancelChangeBookDto,
    userId: string,
  ): Promise<void> {
    return this.dataSource.transaction(async (manager) => {
      // §15 revision freeze guard (inside transaction).
      await this.assertChangeBookNotFrozen(developmentPlanRevisionId, manager);

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
      const currentVersion = await manager.findOne(ChangeAssemblyVersion, {
        where: {
          id: versionId,
          developmentPlanRevisionId,
          status: ChangeAssemblyVersionStatus.COMPLETED,
        },
        lock: { mode: 'pessimistic_write' },
      });
      if (!currentVersion) {
        throw new NotFoundException(
          'ไม่พบเวอร์ชันที่เสร็จสมบูรณ์ตามรหัสที่ระบุสำหรับเล่มฉบับเปลี่ยนแปลงนี้',
        );
      }

      // 3. Descendant guard — block if any child lineage row references
      //    this version AND is still a current leaf. Mirrors the legacy
      //    `BookProjectLineage` BOOK_HAS_DESCENDANT_PUBLISHED check.
      const lineageRepo = manager.getRepository(ChangeProjectLineage);
      const hasDescendants = await lineageRepo.exists({
        where: {
          parentChangeAssemblyVersionId: currentVersion.id,
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
      //     in this version's snapshot was forked into a LATER book (live
      //     §14 descendant, prev_project_type='revised'). Cancelling here
      //     would un-book the forked source while the downstream fork still
      //     points at it, leaving the source permanently §14-locked and the
      //     lineage "ขาดช่วง". The operator must remove the downstream fork
      //     first. Reuses the shared collectDownstreamForkIds helper — the
      //     SAME source of truth as the read-side hasDownstreamFork DTO flag
      //     (computeHasDownstreamFork) so the pre-emptive FE disable can never
      //     disagree with this throw. Runs INSIDE the transaction, BEFORE the
      //     deprecate write.
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
      await manager.update(ChangeAssemblyVersion, currentVersion.id, {
        status: ChangeAssemblyVersionStatus.DEPRECATED,
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
        `[ChangeAssembly] cancelPublishedVersion revision=${developmentPlanRevisionId} v${currentVersion.versionNumber} by user=${userId}`,
      );
    });
  }

  // ===================================================================
  // Public API — Correct (deprecate current + spawn new draft)
  // ===================================================================

  /**
   * Deprecate the current COMPLETED change-revision version and spawn a
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
   * endpoint per the supplement / book-assembly / edit precedent).
   */
  async correct(
    developmentPlanRevisionId: string,
    dto: CorrectChangeBookDto,
    userId: string,
  ): Promise<ChangeAssemblyDraftDto> {
    if (
      dto.correctionMode !== ChangeAssemblyCorrectionMode.CORRECTION_PART1 &&
      dto.correctionMode !== ChangeAssemblyCorrectionMode.CORRECTION_PART2 &&
      dto.correctionMode !== ChangeAssemblyCorrectionMode.CORRECTION_PART3
    ) {
      throw new BadRequestException(
        'correctionMode ต้องเป็น correction_part1, correction_part2 หรือ correction_part3',
      );
    }

    return this.dataSource.transaction(async (manager) => {
      // §15 revision freeze guard.
      await this.assertChangeBookNotFrozen(developmentPlanRevisionId, manager);

      // 1. Operator authorization.
      const { workHistory } = await this.validateDeprecationAuth(
        dto.confirmed,
        dto.citizenIdSuffix,
        userId,
        manager,
      );

      // 2. Load current COMPLETED version with pessimistic write lock.
      const currentVersion = await manager.findOne(ChangeAssemblyVersion, {
        where: {
          developmentPlanRevisionId,
          status: ChangeAssemblyVersionStatus.COMPLETED,
        },
        lock: { mode: 'pessimistic_write' },
        order: { versionNumber: 'DESC' },
      });
      if (!currentVersion) {
        throw new NotFoundException(
          'ไม่พบเวอร์ชันที่เสร็จสมบูรณ์สำหรับเล่มฉบับเปลี่ยนแปลงนี้',
        );
      }

      // 3. Block if a CANCELED draft is parked (must restore/purge first).
      const canceledDraft = await manager.findOne(ChangeAssemblyDraft, {
        where: {
          developmentPlanRevisionId,
          assemblyStatus: ChangeAssemblyDraftStatus.CANCELED,
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
      const activeDraft = await manager.findOne(ChangeAssemblyDraft, {
        where: {
          developmentPlanRevisionId,
          assemblyStatus: In([
            ChangeAssemblyDraftStatus.PREPARING,
            ChangeAssemblyDraftStatus.READY,
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
        dto.correctionMode === ChangeAssemblyCorrectionMode.CORRECTION_PART3;

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
      await manager.update(ChangeAssemblyVersion, currentVersion.id, {
        status: ChangeAssemblyVersionStatus.DEPRECATED,
        deprecatedAt: new Date(),
        deprecatedById: workHistory.id,
        deprecationReason: dto.reason,
      });

      // 5. CORRECTION_PART3 full reset (§20 parity with MAIN / EDIT).
      if (isFullReset) {
        // 5a. Reset RPG booking on every RPG in the deprecated snapshot.
        const snapshotIds = currentVersion.part3ProjectSnapshot ?? [];
        if (snapshotIds.length > 0) {
          await manager.getRepository(RevisedProjectGroup).update(
            { id: In(snapshotIds) },
            { isBooked: false, bookedAt: null, pageNumber: null },
          );
        }
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
        // Note: CHANGE does NOT have PlanPhase rows to reset (revisions
        // don't have phases — revisions have `isOpen` on themselves,
        // which we already flipped to true in step 5b).
      }

      // 6. Create new draft.
      const nextVersion = currentVersion.versionNumber + 1;
      const correctLocation = await this.resolveChangeLocation(
        developmentPlanRevisionId,
        manager,
      );
      this.fileService.createVersionFolders(correctLocation, nextVersion);

      const draft = manager.create(ChangeAssemblyDraft, {
        developmentPlanRevisionId,
        targetVersion: nextVersion,
        previousVersionId: currentVersion.id,
        correctionMode: dto.correctionMode,
        correctionReason: dto.reason,
        part1Status: ChangeAssemblyPartUploadStatus.PENDING,
        part2Status: ChangeAssemblyPartUploadStatus.PENDING,
        part3Status: ChangeAssemblyPartUploadStatus.PENDING,
        assemblyStatus: ChangeAssemblyDraftStatus.PREPARING,
        createdById: workHistory.id,
      });

      // 7. Auto-reuse parts that are NOT being corrected.
      const correctingPart =
        dto.correctionMode === ChangeAssemblyCorrectionMode.CORRECTION_PART1
          ? 1
          : dto.correctionMode === ChangeAssemblyCorrectionMode.CORRECTION_PART2
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
            draft.part1Status = ChangeAssemblyPartUploadStatus.REUSED;
            draft.part1FilePath = copiedPath;
            draft.part1OriginalFileName = currentVersion.part1OriginalFileName;
            draft.part1UploadedAt = now;
            draft.part1UploadedById = workHistory.id;
          } else if (pn === 2) {
            draft.part2Status = ChangeAssemblyPartUploadStatus.REUSED;
            draft.part2FilePath = copiedPath;
            draft.part2OriginalFileName = currentVersion.part2OriginalFileName;
            draft.part2UploadedAt = now;
            draft.part2UploadedById = workHistory.id;
          } else {
            // Only reachable on CORRECTION_PART1 / CORRECTION_PART2
            // (PART3 full reset `continue`s above).
            draft.part3Status = ChangeAssemblyPartUploadStatus.REUSED;
            draft.part3FilePath = copiedPath;
            draft.part3GeneratedAt = now;
            draft.part3ProjectSnapshot = currentVersion.part3ProjectSnapshot;
            // Wave A3 — repopulate page_map from the deprecated
            // version-projects join (NOT from inline JSONB).
            const sourceJoin = await manager
              .getRepository(ChangeAssemblyVersionProject)
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
            `[ChangeAssembly] correct: failed to reuse part-${pn} from v${currentVersion.versionNumber}: ${
              (copyError as Error)?.message
            }`,
          );
        }
      }

      this.updateAssemblyStatus(draft);
      const saved = await manager.save(ChangeAssemblyDraft, draft);

      this.logger.log(
        `[ChangeAssembly] correct revision=${developmentPlanRevisionId} v${currentVersion.versionNumber} → draft v${nextVersion} mode=${dto.correctionMode} isFullReset=${isFullReset}`,
      );

      const full = await manager.findOne(ChangeAssemblyDraft, {
        where: { id: saved.id },
        relations: ['createdBy', 'createdBy.user'],
      });
      return this.toDraftDto(full ?? saved);
    });
  }

  // ===================================================================
  // Public API — Read versions
  // ===================================================================

  async getVersions(
    developmentPlanRevisionId: string,
    userId: string,
  ): Promise<ChangeAssemblyVersionDto[]> {
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
   * Resolution order (mirrors main / supplement / edit precedent):
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
  ): Promise<ChangeAssemblyVersionDto | null> {
    await this.loadAndValidateWorkHistory(userId, READ_ROLES);

    // Step 1 — COMPLETED.
    const completed = await this.versionRepo.findOne({
      where: {
        developmentPlanRevisionId,
        status: ChangeAssemblyVersionStatus.COMPLETED,
      },
      relations: ['createdBy', 'createdBy.user'],
    });
    if (completed) return this.enrichWithDownstreamFork(completed);

    // Step 2 — DEPRECATED via active draft's previousVersionId.
    const activeDraft = await this.draftRepo.findOne({
      where: {
        developmentPlanRevisionId,
        assemblyStatus: In([
          ChangeAssemblyDraftStatus.PREPARING,
          ChangeAssemblyDraftStatus.READY,
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
    v: ChangeAssemblyVersion,
  ): Promise<ChangeAssemblyVersionDto> {
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
  ): Promise<ChangeAssemblyVersionDto> {
    await this.loadAndValidateWorkHistory(userId, READ_ROLES);
    const version = await this.versionRepo.findOne({
      where: { developmentPlanRevisionId, versionNumber },
      relations: ['createdBy', 'createdBy.user'],
    });
    if (!version) {
      throw new NotFoundException(
        `ไม่พบเวอร์ชัน v${versionNumber} สำหรับเล่มฉบับเปลี่ยนแปลงนี้`,
      );
    }
    return this.enrichWithDownstreamFork(version);
  }

  // ===================================================================
  // Public API — Readiness + book display state
  // ===================================================================

  /**
   * Approval-progress readiness used by the FE assembly gate. Mirrors
   * `BookAssemblyService.getRevisionRoundReadiness` for CHANGE sources.
   */
  async getReadiness(
    developmentPlanRevisionId: string,
    userId: string,
  ): Promise<ChangeReadinessDto> {
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

    // Approved RELPG (ครุภัณฑ์ ผ.03) count — mirrors the RPG approvedCount
    // scope above (same revision key, same Approved-only / isLatest /
    // deletedAt predicate, same relation-alias join trackingStatus →
    // statusId). §10 scope bound to the revision passed in (never global);
    // §17.2 advisory pure read. RELPG tracking FK on tracking_status is
    // `revised_equipment_project_group_id` (§12), resolved here via the
    // `relpg.trackingStatus` relation alias.
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

    // CHANGE uses `DevelopmentPlanRevision.isOpen` (single-row predicate)
    // — mirrors `BookAssemblyService.getRevisionRoundReadiness` and the
    // EDIT precedent.
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

    const breakdown: ChangeReadinessBreakdownDto = {
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
  ): Promise<ChangeBookDisplayStateDto> {
    await this.loadAndValidateWorkHistory(userId, READ_ROLES);

    const dto = new ChangeBookDisplayStateDto();
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
      dto.state = ChangeBookDisplayStateEnum.FROZEN_HISTORICAL;
      return dto;
    }

    const completed = await this.versionRepo.findOne({
      where: {
        developmentPlanRevisionId,
        status: ChangeAssemblyVersionStatus.COMPLETED,
      },
    });
    if (completed) {
      dto.state = ChangeBookDisplayStateEnum.PUBLISHED_LATEST;
      return dto;
    }

    const hasActiveDraft = await this.draftRepo.exists({
      where: {
        developmentPlanRevisionId,
        assemblyStatus: In([
          ChangeAssemblyDraftStatus.PREPARING,
          ChangeAssemblyDraftStatus.READY,
        ]),
      },
    });
    dto.state = hasActiveDraft
      ? ChangeBookDisplayStateEnum.DRAFT
      : ChangeBookDisplayStateEnum.NO_BOOK;
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
          ChangeAssemblyDraftStatus.PREPARING,
          ChangeAssemblyDraftStatus.READY,
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
  ): Promise<ChangeAssemblyDraft> {
    const repo = manager ? manager.getRepository(ChangeAssemblyDraft) : this.draftRepo;
    const draft = await repo.findOne({
      where: {
        developmentPlanRevisionId,
        assemblyStatus: In([
          ChangeAssemblyDraftStatus.PREPARING,
          ChangeAssemblyDraftStatus.READY,
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
  private async assertChangeBookNotFrozen(
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
   * `BookAssemblyLocation` of kind `'CHANGE_REVISION'`. The file service
   * requires `planId` + `revisionNumber` + `revisionId` to construct the
   * canonical `main-plan-{planId}/change/change-{revNo}-{revId}/v{N}/`
   * layout.
   */
  private async resolveChangeLocation(
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
      kind: 'CHANGE_REVISION',
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
        `[ChangeAssembly] identity verification locked for user ${userId} after ${record.count} failed attempts`,
      );
    }
    this.identityAttempts.set(userId, record);
  }

  // ===================================================================
  // Private helpers — lineage
  // ===================================================================

  /**
   * Populates the `change_project_lineage` leaf chain for every RPG in
   * the snapshot after a successful merge. Mirrors
   * `EditAssemblyService.populateLineageForMerge` /
   * `MainAssemblyService.populateLineageForMerge` minus the
   * `projectType` discriminator (table membership IS the type).
   */
  private async populateLineageForMerge(
    projectIds: string[],
    newVersionId: string,
    manager: EntityManager,
  ): Promise<void> {
    if (!projectIds || projectIds.length === 0) return;
    const lineageRepo = manager.getRepository(ChangeProjectLineage);

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
        changeAssemblyVersionId: newVersionId,
        parentChangeAssemblyVersionId: currentLeaf
          ? currentLeaf.changeAssemblyVersionId
          : null,
        isCurrentLeaf: true,
      });
      await lineageRepo.save(newRow);
    }

    this.logger.log(
      `[ChangeAssembly] lineage populated for ${projectIds.length} RPGs → versionId=${newVersionId}`,
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
    const lineageRepo = manager.getRepository(ChangeProjectLineage);

    for (const projectId of projectIds) {
      const cancelledRow = await lineageRepo.findOne({
        where: {
          revisedProjectGroupId: projectId,
          changeAssemblyVersionId: cancelledVersionId,
        },
      });
      if (!cancelledRow) continue;

      cancelledRow.isCurrentLeaf = false;
      await lineageRepo.save(cancelledRow);

      if (cancelledRow.parentChangeAssemblyVersionId) {
        const parentRow = await lineageRepo.findOne({
          where: {
            revisedProjectGroupId: projectId,
            changeAssemblyVersionId: cancelledRow.parentChangeAssemblyVersionId,
          },
        });
        if (parentRow) {
          parentRow.isCurrentLeaf = true;
          await lineageRepo.save(parentRow);
        }
      }
    }
    this.logger.log(
      `[ChangeAssembly] lineage restored for ${projectIds.length} RPGs after deprecation of versionId=${cancelledVersionId}`,
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
    // `generateRevisionApprovedReportWithPageTracking` (NOT the main-plan
    // variant) so revision-specific PDF chrome is applied. CHANGE shares
    // this PDF generator with EDIT — the legacy book-assembly branch
    // `sourceType === MAIN_PLAN ? generateProjectReportWithPageTracking :
    // generateRevisionApprovedReportWithPageTracking` covers BOTH
    // EDIT_REVISION and CHANGE_REVISION via the else branch.
    const pdfResult = await this.pdfService.generateRevisionApprovedReportWithPageTracking(
      developmentPlanRevisionId,
      ['index', 'title', 'objective', 'target', 'budget', 'expectedResult', 'mainAgency'],
    );

    return { projects, projectIds, pageMap: pdfResult };
  }

  // ===================================================================
  // Private helpers — small utilities
  // ===================================================================

  private updateAssemblyStatus(draft: ChangeAssemblyDraft): void {
    const part1Ready = draft.part1Status !== ChangeAssemblyPartUploadStatus.PENDING;
    const part2Ready = draft.part2Status !== ChangeAssemblyPartUploadStatus.PENDING;
    const part3Ready = draft.part3Status !== ChangeAssemblyPartUploadStatus.PENDING;

    if (part1Ready && part2Ready && part3Ready) {
      draft.assemblyStatus = ChangeAssemblyDraftStatus.READY;
    } else if (draft.assemblyStatus === ChangeAssemblyDraftStatus.READY) {
      draft.assemblyStatus = ChangeAssemblyDraftStatus.PREPARING;
    }
  }

  private toPartSource(status: ChangeAssemblyPartUploadStatus): ChangeAssemblyPartSource {
    switch (status) {
      case ChangeAssemblyPartUploadStatus.UPLOADED:
        return ChangeAssemblyPartSource.UPLOADED;
      case ChangeAssemblyPartUploadStatus.GENERATED:
        return ChangeAssemblyPartSource.GENERATED;
      case ChangeAssemblyPartUploadStatus.REUSED:
        return ChangeAssemblyPartSource.REUSED;
      default:
        return ChangeAssemblyPartSource.UPLOADED;
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

  private toDraftDto(d: ChangeAssemblyDraft): ChangeAssemblyDraftDto {
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

  private toVersionDto(v: ChangeAssemblyVersion): ChangeAssemblyVersionDto {
    const appUrl = process.env.APP_URL ?? '';
    const prefix = `${appUrl}/v1/change-assembly/${v.developmentPlanRevisionId}`;
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
