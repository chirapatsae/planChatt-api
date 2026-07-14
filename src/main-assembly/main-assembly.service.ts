// ===================================================================
// MainAssemblyService — Wave A1 / BE-01 (OPTION-A-FULL-SPLIT)
// ===================================================================
//
// Orchestration service for the STANDALONE Main-Plan Assembly subsystem
// (Wave A1 of OPTION-A-FULL-SPLIT). Owns the in-flight Part1 → Part2 →
// Part3 → finalize state machine for `DevelopmentPlan` rooted books and
// the correction workflow that supersedes a COMPLETED version with a
// new draft.
//
// Locked decisions referenced inline:
//   - Q3=B  — standalone; this service MUST NOT import from
//             `src/book-assembly/`. Every enum / DTO / entity that the
//             legacy `BookAssemblyService` shared via discriminator is
//             duplicated under `src/main-assembly/`.
//   - §18.2.1 — `merge()` is the new MAIN_PLAN finalize trigger
//             surface; the §18 cascade fires INSIDE the transaction,
//             BEFORE `DevelopmentPlan.isBooked = true` / `bookedAt`.
//   - §20  — cancel of a published main-plan version is FORBIDDEN
//             (mirrors `BookAssemblyService.cancel` Rule 4b at
//             book-assembly.service.ts:1213-1221). The §20 carve-out
//             for MAIN_PLAN does NOT permit rollback — only correction.
//
// Co-existence note (Wave A1 transition window):
//   - The legacy `BookAssemblyService` continues to handle MAIN_PLAN
//     traffic via `book_assembly_*` tables until FE-01 atomically
//     switches every main-plan FE client to this service.
//   - The DB-01 backfill copied existing rows into `main_assembly_*`
//     with the SAME UUIDs so both stores observe the same versions.
//   - Until FE switch: only ONE of the two services receives writes
//     per request, so divergence cannot accumulate.
//   - CLEANUP-01 (later wave) drops the legacy tables once telemetry
//     shows zero traffic to `book-assembly` MAIN_PLAN endpoints.
//
// CLAUDE.md compliance:
//   - §2   workStatus = 'approved' — re-checked at service entry per
//          method.
//   - §4.1 / §18.3  authority inheritance — admin + super-admin only.
//   - §12  audit — the §18 cascade (NOT this service) writes
//          `tracking_status` rows. This service writes only
//          `main_assembly_*` tables + the plan's `isBooked` /
//          `bookedAt` / `PlanPhase.isMerged` flags.
//   - §15  `BookLockService.assertEditable(planId, 'development_plan',
//          em)` runs BEFORE every mutating call. The thrown
//          `BOOK_HAS_NEWER_REVISION` is translated into the legacy
//          `MAIN_BOOK_FROZEN` public error code for client parity.
//   - §16.3  `reportFormat` resolved via the parent plan; never
//          overridden.
//   - §17  no AI side-effects.
//   - §18.2.1  cascade BEFORE `isBooked = true`, atomic transaction.
//          Any throw (e.g. `ORPHAN_CASCADE_HAS_LIVE_DESCENDANT`) rolls
//          back the entire merge.
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
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

import { MainAssemblyDraft } from './entities/main-assembly-draft.entity';
import { MainAssemblyVersion } from './entities/main-assembly-version.entity';
import { MainAssemblyVersionProject } from './entities/main-assembly-version-project.entity';
import { MainProjectLineage } from './entities/main-project-lineage.entity';
import {
  MainAssemblyCorrectionMode,
  MainAssemblyDraftStatus,
  MainAssemblyPartSource,
  MainAssemblyPartUploadStatus,
  MainAssemblyVersionStatus,
} from './enums/main-assembly.enums';

import { CorrectMainBookDto } from './dto/correct-main-book.dto';
import { CancelMainBookDto } from './dto/cancel-main-book.dto';
import { MainAssemblyDraftDto } from './dto/main-assembly-draft-response.dto';
import { MainAssemblyVersionDto } from './dto/main-assembly-version-response.dto';
import { MainBookDisplayStateDto, MainBookDisplayStateEnum } from './dto/main-book-display-state.dto';
import { MainReadinessBreakdownDto, MainReadinessDto } from './dto/main-readiness.dto';

import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { PlanPhase } from 'src/plan-phase/entities/plan-phase.entity';
import { User } from 'src/users/entities/user.entity';
// §21.2 — both-sources merge gate counts Approved equipment toward
// the agency-side floor (interchangeable with agency-origin PG).
// Equipment is agency-origin-only by §5.3 construction.
import { EquipmentProjectGroup } from 'src/equipment-project-group/entities/equipment-project-group.entity';
import { ReportFormat } from 'src/development-plan/types/report-format.enum';
import { STATUS_NAMES } from 'src/common/status-names';
import { UnifiedProjectMapper } from 'src/project-groups/dto/unified-project-display.dto';

import { UsersService } from 'src/users/users.service';
import { PdfService } from 'src/pdf/pdf.service';
import { Por03PdfService } from 'src/pdf/por03-pdf.service';
import { WebsocketService } from 'src/websocket/websocket/websocket.service';
import {
  BookLockService,
  BOOK_HAS_NEWER_REVISION,
} from 'src/common/book-lock/book-lock.service';
// §14.11 — correction-time descendant guard for CORRECTION_PART3.
import { LineageLockService } from 'src/common/lineage-lock/lineage-lock.service';
import { OrphanCleanupService } from 'src/orphan-cleanup/orphan-cleanup.service';
import { StoragePathService } from 'src/storage/storage-path.service';
import {
  BookAssemblyFileService,
  BookAssemblyLocation,
} from 'src/book-assembly/book-assembly-file.service';
//   ^ NOTE on the lone `book-assembly/` import above: Q3=B forbids
//   importing the legacy SERVICE / ENTITIES / ENUMS / DTOs from
//   `src/book-assembly/`. The file-system layer (`BookAssemblyFileService`
//   + the `BookAssemblyLocation` TYPE) is an infrastructure component
//   shared by both subsystems because the on-disk storage layout
//   `main-plan-{planId}/v{N}/...` is canonical and the file service is
//   the single source of truth for STORAGE_ROOT-relative key resolution
//   (per the BE-WRITERS wave umbrella §7.1). Duplicating the file
//   service would create two divergent path resolvers and is explicitly
//   out of scope for Wave A1. The file service is type-only stateless
//   I/O — no business logic crosses the boundary.

/** Roles permitted to perform main-assembly write actions (§4.1 / §18.3). */
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
export class MainAssemblyService {
  private readonly logger = new Logger(MainAssemblyService.name);

  /** In-memory identity-verification retry tracker. */
  private readonly identityAttempts = new Map<
    string,
    { count: number; lockedUntil?: Date }
  >();

  constructor(
    @InjectRepository(MainAssemblyDraft)
    private readonly draftRepo: Repository<MainAssemblyDraft>,

    @InjectRepository(MainAssemblyVersion)
    private readonly versionRepo: Repository<MainAssemblyVersion>,

    @InjectRepository(MainAssemblyVersionProject)
    private readonly versionProjectRepo: Repository<MainAssemblyVersionProject>,

    @InjectRepository(MainProjectLineage)
    private readonly lineageRepo: Repository<MainProjectLineage>,

    @InjectRepository(WorkHistory)
    private readonly workHistoryRepo: Repository<WorkHistory>,

    @InjectRepository(ProjectGroup)
    private readonly projectGroupRepo: Repository<ProjectGroup>,

    @InjectRepository(DevelopmentPlan)
    private readonly devPlanRepo: Repository<DevelopmentPlan>,

    @InjectRepository(PlanPhase)
    private readonly planPhaseRepo: Repository<PlanPhase>,

    @InjectRepository(User)
    private readonly userRepo: Repository<User>,

    // §21.2 — Approved equipment count (agency-side, sibling of agency PG).
    @InjectRepository(EquipmentProjectGroup)
    private readonly equipmentRepo: Repository<EquipmentProjectGroup>,

    private readonly usersService: UsersService,
    private readonly pdfService: PdfService,
    private readonly por03Service: Por03PdfService,
    private readonly websocketService: WebsocketService,
    private readonly fileService: BookAssemblyFileService,
    private readonly storagePathService: StoragePathService,
    private readonly bookLockService: BookLockService,
    private readonly lineageLockService: LineageLockService,
    private readonly orphanCleanupService: OrphanCleanupService,
    private readonly dataSource: DataSource,
  ) {}

  // ===================================================================
  // Sidebar Counts
  // ===================================================================

  /**
   * Counts the number of `DevelopmentPlan` rows that are "actionable"
   * for the admin "รวมเล่ม" sidebar badge — i.e. live main-plan books
   * that an admin can still assemble / finalize.
   *
   * Restored 2026-05-29 after §20.10 CLEANUP wave removed the legacy
   * `GET /v1/book-assembly/counts` endpoint without porting the
   * count semantic to the standalone subsystems. Mirrors
   * `SupplementAssemblyService.getActionableCount` byte-for-spirit:
   *
   * Role gate (§4.1, §17.2):
   *   - admin + super-admin → live count
   *   - any other role     → silent `0` (no 403; mirrors the
   *                          `fallbackZero` convention used by
   *                          `useSidebarCounts`)
   *
   * Filter:
   *   - `is_latest = true`  — only the active development plan
   *   - `is_booked = false` — admin has not finalized yet
   *   - `deleted_at IS NULL`— soft-deleted plans drop out
   *
   * Plans do not have an `is_open` column the way revisions /
   * supplements do — the plan is implicitly open until merged, which
   * is exactly what `is_booked = false` expresses.
   *
   * §17.2 — pure read, advisory only; MUST NOT gate workflow.
   */
  async getActionableCount(callerRole: string | undefined): Promise<number> {
    if (callerRole !== 'admin' && callerRole !== 'super-admin') {
      return 0;
    }
    return this.devPlanRepo
      .createQueryBuilder('p')
      .where('p.is_latest = :isLatest', { isLatest: true })
      .andWhere('p.is_booked = :isBooked', { isBooked: false })
      .getCount();
  }

  // ===================================================================
  // Public API — Draft management
  // ===================================================================

  /**
   * Creates a new assembly draft for a development plan.
   * Only one active (non-merged) draft per plan.
   */
  async createDraft(
    developmentPlanId: string,
    userId: string,
  ): Promise<MainAssemblyDraftDto> {
    const workHistory = await this.loadAndValidateWorkHistory(userId, ADMIN_ROLES);

    // §15 main-plan freeze guard.
    await this.assertMainBookNotFrozen(developmentPlanId);

    // Reject if an active draft already exists.
    const existingDraft = await this.draftRepo.findOne({
      where: {
        developmentPlanId,
        assemblyStatus: In([
          MainAssemblyDraftStatus.PREPARING,
          MainAssemblyDraftStatus.READY,
        ]),
      },
    });
    if (existingDraft) {
      throw new ConflictException(
        'มี draft ที่กำลังดำเนินการอยู่แล้วสำหรับเล่มแผนหลักนี้ กรุณาดำเนินการต่อหรือยกเลิก draft เดิมก่อน',
      );
    }

    // Handle CANCELED draft — same behavior as BookAssemblyService.
    const canceledDraft = await this.draftRepo.findOne({
      where: {
        developmentPlanId,
        assemblyStatus: MainAssemblyDraftStatus.CANCELED,
      },
      order: { canceledAt: 'DESC' },
    });
    if (canceledDraft) {
      const completedVersion = await this.versionRepo.findOne({
        where: {
          developmentPlanId,
          status: MainAssemblyVersionStatus.COMPLETED,
        },
      });
      if (completedVersion) {
        // Orphan: silently purge and continue.
        await this.draftRepo.remove(canceledDraft);
        this.logger.log(
          `Silently purged orphaned canceled draft ${canceledDraft.id} for plan=${developmentPlanId}`,
        );
      } else {
        throw new ConflictException({
          message: 'มี draft ที่ยกเลิกแล้วอยู่ กรุณากู้คืนหรือลบทิ้งก่อนสร้างใหม่',
          errorCode: 'CANCELED_DRAFT_EXISTS',
          canceledDraftId: canceledDraft.id,
        });
      }
    }

    // Determine next version number (per-plan).
    const maxVersion = await this.versionRepo
      .createQueryBuilder('v')
      .select('MAX(v.versionNumber)', 'max')
      .where('v.developmentPlanId = :id', { id: developmentPlanId })
      .getRawOne<{ max: number | null }>();
    const targetVersion = (maxVersion?.max ?? 0) + 1;

    // Link to the most recently DEPRECATED version (cancel-book linkage).
    const deprecatedVersion = await this.versionRepo.findOne({
      where: {
        developmentPlanId,
        status: MainAssemblyVersionStatus.DEPRECATED,
      },
      order: { versionNumber: 'DESC' },
    });

    // Create folder structure (reuses the canonical plan-rooted layout).
    const draftLocation: BookAssemblyLocation = {
      kind: 'MAIN_PLAN',
      planId: developmentPlanId,
    };
    this.fileService.createVersionFolders(draftLocation, targetVersion);

    const draft = this.draftRepo.create({
      developmentPlanId,
      targetVersion,
      previousVersionId: deprecatedVersion?.id ?? null,
      correctionMode: null,
      correctionReason: null,
      part1Status: MainAssemblyPartUploadStatus.PENDING,
      part2Status: MainAssemblyPartUploadStatus.PENDING,
      part3Status: MainAssemblyPartUploadStatus.PENDING,
      assemblyStatus: MainAssemblyDraftStatus.PREPARING,
      createdById: workHistory.id,
    });

    const saved = await this.draftRepo.save(draft);
    this.logger.log(
      `Created main-plan draft plan=${developmentPlanId} v${targetVersion} draftId=${saved.id}`,
    );
    return await this.toDraftDto(saved);
  }

  /**
   * Returns the current active (non-merged) draft for a development
   * plan, or null.
   */
  async getActiveDraft(
    developmentPlanId: string,
    userId: string,
  ): Promise<MainAssemblyDraftDto | null> {
    await this.loadAndValidateWorkHistory(userId, READ_ROLES);
    const draft = await this.draftRepo.findOne({
      where: {
        developmentPlanId,
        assemblyStatus: In([
          MainAssemblyDraftStatus.PREPARING,
          MainAssemblyDraftStatus.READY,
        ]),
      },
      relations: ['createdBy', 'createdBy.user'],
    });
    return draft ? await this.toDraftDto(draft) : null;
  }

  /**
   * Soft-deletes an active draft (status → CANCELED).
   *
   * Wave A1 / BE-01 — restoration of a deprecated version on discard
   * mirrors the `BookAssemblyService.discardDraft` semantics but is
   * deferred to a later wave to keep this initial split lean. The MVP
   * surface only flips the draft to CANCELED; restore is exposed via
   * the separate `restoreDraft` endpoint per the supplement precedent.
   */
  async discardDraft(
    developmentPlanId: string,
    userId: string,
  ): Promise<{ message: string; draftId: string }> {
    const workHistory = await this.loadAndValidateWorkHistory(userId, ADMIN_ROLES);
    const draft = await this.loadActiveDraftOrFail(developmentPlanId);

    draft.assemblyStatus = MainAssemblyDraftStatus.CANCELED;
    draft.canceledAt = new Date();
    draft.canceledById = workHistory.id;
    await this.draftRepo.save(draft);

    this.logger.log(
      `Discarded main-plan draft plan=${developmentPlanId} draftId=${draft.id}`,
    );
    return { message: 'ยกเลิก draft เรียบร้อยแล้ว', draftId: draft.id };
  }

  // ===================================================================
  // Public API — Canceled-draft management (CLEANUP wave port from
  // BookAssemblyService.{getCanceledDraft,restoreDraft,purgeCanceledDraft})
  // ===================================================================
  //
  // §15 note: NONE of the three methods below call
  // `assertMainBookNotFrozen`. Rationale (mirrors the legacy
  // BookAssemblyService behavior): a canceled-draft read / restore /
  // purge does NOT write to the protected DevelopmentPlan row; it only
  // flips `draft.assemblyStatus` (or hard-deletes a draft row). Per §15.5
  // "flag-only operations are exempt" in spirit, these draft-row
  // mutations are not §15-protected book mutations.

  /**
   * Returns the most recent canceled draft for a development plan, or
   * null. Loads `canceledBy.user` relation for display.
   *
   * Mirrors `BookAssemblyService.getCanceledDraft` (book-assembly.service.ts
   * lines 548-568). READ_ROLES — staff + admin + super-admin.
   */
  async getCanceledDraft(
    developmentPlanId: string,
    userId: string,
  ): Promise<MainAssemblyDraft | null> {
    await this.loadAndValidateWorkHistory(userId, READ_ROLES);

    return this.draftRepo.findOne({
      where: {
        developmentPlanId,
        assemblyStatus: MainAssemblyDraftStatus.CANCELED,
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
   *   - 404 if no CANCELED draft exists for the plan.
   *   - 409 ACTIVE_DRAFT_EXISTS if a PREPARING / READY draft is already
   *     present (cannot have two active drafts simultaneously).
   */
  async restoreDraft(
    developmentPlanId: string,
    userId: string,
  ): Promise<MainAssemblyDraft> {
    await this.loadAndValidateWorkHistory(userId, ADMIN_ROLES);

    // 1. Load the most recent CANCELED draft.
    const canceledDraft = await this.draftRepo.findOne({
      where: {
        developmentPlanId,
        assemblyStatus: MainAssemblyDraftStatus.CANCELED,
      },
      order: { canceledAt: 'DESC' },
    });
    if (!canceledDraft) {
      throw new NotFoundException('ไม่พบ draft ที่ถูกยกเลิก');
    }

    // 2. Reject if an active draft already exists.
    const activeDraft = await this.draftRepo.findOne({
      where: {
        developmentPlanId,
        assemblyStatus: In([
          MainAssemblyDraftStatus.PREPARING,
          MainAssemblyDraftStatus.READY,
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
      canceledDraft.part1Status === MainAssemblyPartUploadStatus.UPLOADED ||
      canceledDraft.part1Status === MainAssemblyPartUploadStatus.REUSED;
    const part2Ready =
      canceledDraft.part2Status === MainAssemblyPartUploadStatus.UPLOADED ||
      canceledDraft.part2Status === MainAssemblyPartUploadStatus.REUSED;
    const part3Ready =
      canceledDraft.part3Status === MainAssemblyPartUploadStatus.GENERATED ||
      canceledDraft.part3Status === MainAssemblyPartUploadStatus.REUSED;

    canceledDraft.assemblyStatus =
      part1Ready && part2Ready && part3Ready
        ? MainAssemblyDraftStatus.READY
        : MainAssemblyDraftStatus.PREPARING;

    // 4. Clear canceled fields.
    canceledDraft.canceledAt = null;
    canceledDraft.canceledById = null;

    const restored = await this.draftRepo.save(canceledDraft);
    this.logger.log(
      `Restored main-plan draft ${restored.id} for plan=${developmentPlanId} → ${restored.assemblyStatus}`,
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
    developmentPlanId: string,
    userId: string,
  ): Promise<void> {
    await this.loadAndValidateWorkHistory(userId, ADMIN_ROLES);

    const canceledDraft = await this.draftRepo.findOne({
      where: {
        developmentPlanId,
        assemblyStatus: MainAssemblyDraftStatus.CANCELED,
      },
      order: { canceledAt: 'DESC' },
    });
    if (!canceledDraft) {
      throw new NotFoundException('ไม่พบ draft ที่ถูกยกเลิก');
    }

    await this.draftRepo.remove(canceledDraft);
    this.logger.log(
      `Purged canceled main-plan draft ${canceledDraft.id} for plan=${developmentPlanId}`,
    );
  }

  // ===================================================================
  // Public API — Part upload / generation
  // ===================================================================

  /**
   * Uploads Part 1 or Part 2 PDF.
   */
  async uploadPart(
    developmentPlanId: string,
    partNumber: 1 | 2,
    file: Express.Multer.File,
    userId: string,
  ): Promise<MainAssemblyDraftDto> {
    const workHistory = await this.loadAndValidateWorkHistory(userId, ADMIN_ROLES);

    if (!file || !file.buffer || file.buffer.length === 0) {
      throw new BadRequestException('กรุณาอัพโหลดไฟล์ PDF');
    }

    // Defense-in-depth — validate PDF magic bytes.
    this.validatePdfContent(file.buffer, file.originalname);

    // §15 main-plan freeze guard.
    await this.assertMainBookNotFrozen(developmentPlanId);

    const draft = await this.loadActiveDraftOrFail(developmentPlanId);

    const uploadLocation: BookAssemblyLocation = {
      kind: 'MAIN_PLAN',
      planId: developmentPlanId,
    };
    const filePath = this.fileService.savePartFile(
      uploadLocation,
      draft.targetVersion,
      partNumber,
      file.buffer,
    );

    if (partNumber === 1) {
      draft.part1Status = MainAssemblyPartUploadStatus.UPLOADED;
      draft.part1FilePath = filePath;
      draft.part1OriginalFileName = file.originalname;
      draft.part1UploadedAt = new Date();
      draft.part1UploadedById = workHistory.id;
    } else {
      draft.part2Status = MainAssemblyPartUploadStatus.UPLOADED;
      draft.part2FilePath = filePath;
      draft.part2OriginalFileName = file.originalname;
      draft.part2UploadedAt = new Date();
      draft.part2UploadedById = workHistory.id;
    }

    this.updateAssemblyStatus(draft);
    const saved = await this.draftRepo.save(draft);
    return await this.toDraftDto(saved);
  }

  /**
   * Generates Part 3 (project listing PDF) from Approved projects.
   *
   * §16-aware: branches on parent plan `reportFormat` for sort order.
   */
  async generatePart3(
    developmentPlanId: string,
    userId: string,
  ): Promise<MainAssemblyDraftDto> {
    await this.loadAndValidateWorkHistory(userId, ADMIN_ROLES);

    // §15 main-plan freeze guard.
    await this.assertMainBookNotFrozen(developmentPlanId);

    // §21.2 — both-sources merge gate (ABSOLUTE, no role bypass).
    // Re-asserted here so admins cannot pre-bake a Part 3 that merge
    // would later reject. Mirrors the merge() assertion.
    await this.assertBothSourcesContribute(developmentPlanId);

    const draft = await this.loadActiveDraftOrFail(developmentPlanId);

    await this.notifyProgress(userId, developmentPlanId, 10, 'starting', 'กำลังเริ่มสร้างส่วนที่ 3...');

    // §21.3.2 / BE-02 Surface B — Standalone Part 3 preview must also
    // render continuous page numbers from whichever of P1 / P2 are
    // uploaded at the time of this call. Degrades to 0 when neither
    // is uploaded yet. If P1 or P2 is re-uploaded later with a
    // different page count, this standalone file becomes stale until
    // the user re-invokes generatePart3 — the dashboard's Part 3
    // GENERATED status signals that regeneration may be needed.
    const standaloneOffset = await this.computeStandalonePart3Offset(draft);
    this.logger.log(
      `[MainAssembly] generatePart3 standaloneOffset=${standaloneOffset} plan=${developmentPlanId}`,
    );

    const { projects, projectIds, pageMap } = await this.queryAndRenderPart3(
      developmentPlanId,
      userId,
      standaloneOffset,
    );

    if (projects.length === 0) {
      throw new BadRequestException(
        'ไม่พบโครงการที่อนุมัติแล้วสำหรับเล่มแผนหลักนี้',
      );
    }

    // Phase 3 (2026-05-31) — append the formal ผ.03 section to Part 3
    // at generate time. The renderer footer renders ผ.02-style page
    // numbers continuing the ผ.02 sequence via `pageOffset` = standalone
    // offset (P1+P2 if uploaded) + page count of `pageMap.buffer`. The
    // ผ.03 footers therefore continue the running count in the standalone
    // preview, satisfying §21.3.2 Surface B. Read-only (§17.2), degrades
    // to null when no Approved equipment exists.
    const por02PageCount = (await PDFDocument.load(pageMap.buffer)).getPageCount();
    const por03 = await this.por03Service.renderApprovedPlanScopedPor03Buffer(
      developmentPlanId,
      standaloneOffset + por02PageCount,
    );
    const part3Buffer = por03
      ? await this.mergePdfBuffers([pageMap.buffer, por03.buffer])
      : pageMap.buffer;
    // BE-04 — equipmentId → 1-based LOCAL page within the ผ.03 buffer
    // (divider = local page 1). Persisted on the draft so `merge()` can
    // recover the per-equipment absolute page without re-rendering.
    const equipmentIds = por03?.equipmentIds ?? [];
    const equipmentPageMap = por03?.pageMap ?? new Map<string, number>();

    const generateLocation: BookAssemblyLocation = {
      kind: 'MAIN_PLAN',
      planId: developmentPlanId,
    };
    const filePath = this.fileService.savePartFile(
      generateLocation,
      draft.targetVersion,
      3,
      part3Buffer,
    );

    draft.part3Status = MainAssemblyPartUploadStatus.GENERATED;
    draft.part3FilePath = filePath;
    draft.part3GeneratedAt = new Date();
    draft.part3ProjectSnapshot = projectIds;
    draft.part3PageMap = Object.fromEntries(pageMap.pageMap);
    // BE-04 — equipment snapshot + per-equipment local page map persisted
    // on the draft for the merge step to consume.
    draft.part3EquipmentSnapshot = equipmentIds;
    draft.part3EquipmentPageMap = Object.fromEntries(equipmentPageMap);

    this.updateAssemblyStatus(draft);
    const saved = await this.draftRepo.save(draft);
    await this.notifyProgress(userId, developmentPlanId, 100, 'completed', 'สร้างส่วนที่ 3 สำเร็จแล้ว!');
    return await this.toDraftDto(saved);
  }

  /**
   * Reuses a part from a specified previous version (copies file).
   */
  async reusePart(
    developmentPlanId: string,
    partNumber: 1 | 2 | 3,
    fromVersionNumber: number,
    userId: string,
  ): Promise<MainAssemblyDraftDto> {
    const workHistory = await this.loadAndValidateWorkHistory(userId, ADMIN_ROLES);
    const draft = await this.loadActiveDraftOrFail(developmentPlanId);

    const sourceVersion = await this.versionRepo.findOne({
      where: { developmentPlanId, versionNumber: fromVersionNumber },
    });
    if (!sourceVersion) {
      throw new NotFoundException(
        `ไม่พบเวอร์ชัน v${fromVersionNumber} สำหรับเล่มแผนหลักนี้`,
      );
    }

    const reuseLocation: BookAssemblyLocation = {
      kind: 'MAIN_PLAN',
      planId: developmentPlanId,
    };
    const copiedPath = this.fileService.copyPartFromVersion(
      reuseLocation,
      fromVersionNumber,
      draft.targetVersion,
      partNumber,
    );

    if (partNumber === 1) {
      draft.part1Status = MainAssemblyPartUploadStatus.REUSED;
      draft.part1FilePath = copiedPath;
      draft.part1OriginalFileName = sourceVersion.part1OriginalFileName;
      draft.part1UploadedAt = new Date();
      draft.part1UploadedById = workHistory.id;
    } else if (partNumber === 2) {
      draft.part2Status = MainAssemblyPartUploadStatus.REUSED;
      draft.part2FilePath = copiedPath;
      draft.part2OriginalFileName = sourceVersion.part2OriginalFileName;
      draft.part2UploadedAt = new Date();
      draft.part2UploadedById = workHistory.id;
    } else {
      draft.part3Status = MainAssemblyPartUploadStatus.REUSED;
      draft.part3FilePath = copiedPath;
      draft.part3GeneratedAt = new Date();
      draft.part3ProjectSnapshot = sourceVersion.part3ProjectSnapshot;
      // 2026-05-31 (Part 3 SET-staleness, draft-side) — propagate the
      // equipment snapshot from the reused source version so the
      // reused draft is staleness-comparable. Defensive `?? []` for
      // legacy version rows that predate the equipment snapshot column.
      draft.part3EquipmentSnapshot =
        sourceVersion.part3EquipmentSnapshot ?? [];
      // Wave A1 / BE-01 — page map is now sourced from the version-
      // projects join (denormalized) instead of inline JSONB. Reuse
      // queries the join for the source version's mapping so the merge
      // path keeps writing rows consistently.
      const sourceJoin = await this.versionProjectRepo.find({
        where: { versionId: sourceVersion.id },
        select: ['projectGroupId', 'pageNumber'],
      });
      draft.part3PageMap = Object.fromEntries(
        sourceJoin.map((r) => [r.projectGroupId, r.pageNumber]),
      );
    }

    this.updateAssemblyStatus(draft);
    const saved = await this.draftRepo.save(draft);
    return await this.toDraftDto(saved);
  }

  // ===================================================================
  // Public API — Preview & merge
  // ===================================================================

  async preview(developmentPlanId: string, userId: string): Promise<Buffer> {
    await this.loadAndValidateWorkHistory(userId, ADMIN_ROLES);
    const draft = await this.loadActiveDraftOrFail(developmentPlanId);

    if (draft.assemblyStatus !== MainAssemblyDraftStatus.READY) {
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
    return this.mergePdfBuffers([part1, part2, part3]);
  }

  /**
   * Execute merge — creates a version + version_projects rows, populates
   * the lineage table, and flips plan booking state. ALL mutations
   * happen in a single transaction.
   *
   * §18.2.1 trigger surface: the orphan cleanup cascade fires INSIDE
   * the transaction BEFORE the `isBooked = true` write so non-Approved
   * / non-Rejected projects get reset to `Ready` atomically.
   */
  async merge(
    developmentPlanId: string,
    userId: string,
  ): Promise<MainAssemblyVersionDto> {
    const workHistory = await this.loadAndValidateWorkHistory(userId, ADMIN_ROLES);

    return this.dataSource.transaction(async (manager) => {
      // §15 main-plan freeze guard (inside transaction).
      await this.assertMainBookNotFrozen(developmentPlanId, manager);

      // §21.2 — both-sources merge gate (ABSOLUTE, no role bypass).
      // Runs AFTER §15 freeze check so a frozen plan still 403s first.
      // The gate uses fresh queries (not the captured FE counts) — the
      // FE may be stale by the time the user clicks Merge.
      await this.assertBothSourcesContribute(developmentPlanId);

      // 1. Load + validate draft.
      const draft = await manager.findOne(MainAssemblyDraft, {
        where: {
          developmentPlanId,
          assemblyStatus: MainAssemblyDraftStatus.READY,
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

      await this.notifyProgress(userId, developmentPlanId, 10, 'starting', 'กำลังเริ่มรวมเล่ม...');

      // 2. Read parts.
      const mergeLocation: BookAssemblyLocation = {
        kind: 'MAIN_PLAN',
        planId: developmentPlanId,
      };
      const part1 = this.fileService.readPartFileByStored(draft.part1FilePath);
      const part2 = this.fileService.readPartFileByStored(draft.part2FilePath);
      const part3FromDisk = this.fileService.readPartFileByStored(draft.part3FilePath);

      await this.notifyProgress(userId, developmentPlanId, 30, 'merging', 'กำลังรวมไฟล์ PDF...');

      // Phase 3 (2026-05-31) — page-numbering convention for MAIN_PLAN
      // (per user direction): the assembled MAIN book numbers pages
      // CONTINUOUSLY from Part 1's first page to Part 3's last page.
      // Standalone Part 3 preview keeps the "start at 1" behavior so the
      // preview reads naturally. To achieve both, we RE-RENDER Part 3
      // in-memory at merge time with `initialPageOffset = pageCount(part1
      // + part2)` so the baked footer numbers shift to continue the
      // assembled book's running count. The on-disk Part 3 file is
      // UNCHANGED (preview still starts at 1).
      //
      // Edit / Change / Supplement assemblies do NOT enter this branch
      // (they live in EditAssemblyService / ChangeAssemblyService /
      // SupplementAssemblyService) — their Part 3 keeps the "start at 1"
      // numbering verbatim per the user direction.
      const part1PageCount = (await PDFDocument.load(part1)).getPageCount();
      const part2PageCount = (await PDFDocument.load(part2)).getPageCount();
      const mainOffset = part1PageCount + part2PageCount;
      const { pageMap: rerenderedPart3, projectIds: rerenderedProjectIds } =
        await this.queryAndRenderPart3(developmentPlanId, userId, mainOffset);
      // Append the formal ผ.03 with the SAME offset accumulated past the
      // re-rendered ผ.02 body, so equipment footers continue the count
      // unbroken into the ผ.03 section.
      const por02PageCount = (await PDFDocument.load(rerenderedPart3.buffer)).getPageCount();
      const por03 = await this.por03Service.renderApprovedPlanScopedPor03Buffer(
        developmentPlanId,
        mainOffset + por02PageCount,
      );
      const part3 = por03
        ? await this.mergePdfBuffers([rerenderedPart3.buffer, por03.buffer])
        : rerenderedPart3.buffer;
      const equipmentIds: string[] = por03?.equipmentIds ?? [];
      // Replace the draft-persisted page maps with the freshly-rendered
      // ones — the draft snapshot used Part-3-local numbers (start at 1),
      // but the merged book uses continuous absolute numbers (start at
      // mainOffset + 1). Stamped values must match the printed book.
      const pageMapFromMerge = new Map<string, number>(rerenderedPart3.pageMap);
      const equipmentPageMapFromMerge = por03?.pageMap ?? new Map<string, number>();
      // Sanity — the re-rendered project id set should match the snapshot
      // on the draft. If not, log + fall through (merge continues; some
      // booking stamps may be off if Approved status changed since
      // generatePart3 — that's a stale-snapshot scenario, not a phase-3
      // bug). Suppress unused-var warning when set matches.
      if (
        rerenderedProjectIds.length !== (draft.part3ProjectSnapshot ?? []).length
      ) {
        this.logger.warn(
          `[MainAssembly] merge: Part 3 project count changed since generatePart3 (snapshot=${(draft.part3ProjectSnapshot ?? []).length}, rerender=${rerenderedProjectIds.length})`,
        );
      }
      // Silence unused-var warning — `part3FromDisk` only used for
      // hypothetical fallback (not taken in current MAIN_PLAN path).
      void part3FromDisk;

      // 4. Merge — part3 (re-rendered above) already contains ผ.03.
      const partBuffers: Buffer[] = [part1, part2, part3];
      const combinedBuffer = await this.mergePdfBuffers(partBuffers);

      // Equipment booking absolute pages — use the freshly-rendered
      // ผ.03 pageMap. It's 1-based RELATIVE to the ผ.03 sub-buffer; add
      // `(mainOffset + por02PageCount)` to convert to the ABSOLUTE book
      // page. (`equipmentPageMapFromMerge` keys = equipmentId → local.)
      const por03LocalPageMap = equipmentPageMapFromMerge;
      const por03SectionStartOffset = mainOffset + por02PageCount;

      // Phase 3 (2026-05-31 user direction) — page numbers are baked at
      // SOURCE by each part's own pdfmake footer (ผ.01/ผ.02 bottom-right
      // bold THSarabun; ผ.03 received `pageOffset = ผ.02 page count` at
      // generatePart3 time so its footer renders CONTINUOUS numbers in
      // the same style). No post-merge global page-number pass needed —
      // doing one here would draw a second number over the existing
      // baked ones (user-reported overlap defect).
      const mergedBuffer = combinedBuffer;
      const mergedPdf = await PDFDocument.load(mergedBuffer);
      const totalPages = mergedPdf.getPageCount();

      // 4c. Save merged file (relative key persisted on version row).
      const mergedFilePath = this.fileService.saveMergedFile(
        mergeLocation,
        draft.targetVersion,
        mergedBuffer,
      );

      // §21.3.3 / BE-02 Surface C — Persist the OFFSET-STAMPED Part 3
      // buffer to disk under the same (planId, versionNumber,
      // partNumber=3) key. This OVERWRITES the standalone-offset Part 3
      // file saved at generatePart3 time so the per-part download
      // `/v1/main-assembly/:planId/versions/:n/parts/3` returns a file
      // whose page numbers match the merged book download byte-for-byte.
      //
      // The merge transaction is atomic with respect to DB writes; the
      // file system is not transactional. If the transaction aborts
      // after this overwrite, the standalone-offset Part 3 file is gone
      // — but the version row is not saved either, so no consumer
      // references the lost file. The next merge attempt re-renders
      // and overwrites at the same path.
      const persistedOffsetPart3Path = this.fileService.savePartFile(
        mergeLocation,
        draft.targetVersion,
        3,
        part3,
      );
      this.logger.log(
        `[MainAssembly] merge persistedOffsetPart3 path=${persistedOffsetPart3Path} offset=${mainOffset} plan=${developmentPlanId}`,
      );

      await this.notifyProgress(userId, developmentPlanId, 50, 'booking', 'กำลังจองโครงการ...');

      // 5. §18.2.1 — orphan-cleanup cascade BEFORE isBooked flip.
      const plan = await manager.getRepository(DevelopmentPlan).findOne({
        where: { id: developmentPlanId },
      });
      if (!plan) {
        throw new NotFoundException(
          `DevelopmentPlan not found for id=${developmentPlanId}`,
        );
      }
      const cascadeResult = await this.orphanCleanupService.cascadeOnBookFinalize(
        plan,
        'PLAN',
        manager,
        userId,
      );
      this.logger.log(
        `[MainAssembly] merge cascade plan=${developmentPlanId} pg=${cascadeResult.pgCount} rpg=${cascadeResult.rpgCount}`,
      );

      // 6. Project booking flips on Approved PGs. `pageMapFromMerge`
      // already holds ABSOLUTE book pages (re-rendered with mainOffset),
      // matching what the user sees in the printed footer.
      const projectIds = draft.part3ProjectSnapshot ?? [];
      if (projectIds.length > 0) {
        const pgRepo = manager.getRepository(ProjectGroup);
        for (const projectId of projectIds) {
          await pgRepo.update(
            { id: projectId },
            {
              isBooked: true,
              bookedAt: new Date(),
              pageNumber: pageMapFromMerge.get(projectId) ?? null,
            },
          );
        }
      }

      // 6b. Equipment (ผ.03) booking stamp on the Approved equipment rows
      //     that the renderer included in the appended section. Parallels
      //     the PG booking flip above; §5.3 booking columns live on
      //     `EquipmentProjectGroup`. §12 — a booking flip is NOT a status
      //     transition, so NO TrackingStatus row is written here (the §18
      //     cascade above already reset non-Approved equipment to `Ready`;
      //     these rows are Approved and stay Approved).
      //     BE-04 (2026-05-30) — `pageNumber` now carries the ABSOLUTE
      //     book page (GROUP-LEVEL granularity: all rows in the same
      //     Category/Tactic/Plan or Issue group share the group's first
      //     page), replacing the prior best-effort NULL placeholder.
      //     absolutePage(id) = por03SectionStartOffset + localPage(id)
      //     where localPage is the renderer's 1-based page within
      //     por03.buffer. A row missing from the map (should not occur)
      //     degrades to NULL. Stamped via a single `unnest`-driven bulk
      //     UPDATE (ids[], pages[]) inside the finalize transaction;
      //     raw query keeps the equipment entity out of main-assembly
      //     beyond the §20.10.3 shared-infra channel.
      if (equipmentIds.length > 0) {
        const equipmentBookedAt = new Date();
        const absolutePages: (number | null)[] = equipmentIds.map((id) => {
          const local = por03LocalPageMap.get(id);
          return local === undefined
            ? null
            : por03SectionStartOffset + local;
        });
        await manager.query(
          `UPDATE equipment_project_groups e
             SET is_booked = true,
                 booked_at = $1,
                 page_number = u.page_number
           FROM unnest($2::uuid[], $3::int[]) AS u(id, page_number)
           WHERE e.id = u.id`,
          [equipmentBookedAt, equipmentIds, absolutePages],
        );
        this.logger.log(
          `[MainAssembly] merge stamped isBooked + page_number on ${equipmentIds.length} equipment row(s) plan=${developmentPlanId} (sectionStart=${por03SectionStartOffset})`,
        );
      }

      // 7. Plan booking + PlanPhase merged flip.
      await manager.getRepository(DevelopmentPlan).update(
        { id: developmentPlanId },
        { isBooked: true, bookedAt: new Date() },
      );
      await manager.getRepository(PlanPhase).update(
        { developmentPlan: { id: developmentPlanId } },
        { isMerged: true },
      );

      await this.notifyProgress(userId, developmentPlanId, 70, 'saving', 'กำลังบันทึกข้อมูล...');

      // 8. Insert version row (NO inline part3_page_map per Wave A1).
      const versionRow = manager.create(MainAssemblyVersion, {
        developmentPlanId,
        versionNumber: draft.targetVersion,
        status: MainAssemblyVersionStatus.COMPLETED,
        correctionMode: draft.correctionMode,
        correctionReason: draft.correctionReason,
        part1FilePath: draft.part1FilePath,
        part1Source: this.toPartSource(draft.part1Status),
        part1OriginalFileName: draft.part1OriginalFileName,
        part2FilePath: draft.part2FilePath,
        part2Source: this.toPartSource(draft.part2Status),
        part2OriginalFileName: draft.part2OriginalFileName,
        // §21.3.3 / BE-02 Surface C — reference the offset-stamped Part 3
        // file persisted above, NOT the draft's standalone-offset file.
        // The per-part download endpoint serves the version row's path.
        part3FilePath: persistedOffsetPart3Path,
        part3Source: this.toPartSource(draft.part3Status),
        part3ProjectSnapshot: projectIds,
        part3ProjectCount: projectIds.length,
        // §21.4 — equipment UUID snapshot for read-time staleness diff.
        // Falls back to the draft's snapshot if the fresh equipmentIds
        // happen to be empty (defensive — should match in steady state).
        part3EquipmentSnapshot:
          equipmentIds.length > 0
            ? equipmentIds
            : (draft.part3EquipmentSnapshot ?? []),
        mergedFilePath,
        mergedAt: new Date(),
        totalPages,
        createdById: workHistory.id,
      });
      const savedVersion = await manager.save(MainAssemblyVersion, versionRow);

      // 9. Write the version-projects join (Wave A1 page_map
      // denormalization — replaces the legacy inline JSONB).
      const joinRepo = manager.getRepository(MainAssemblyVersionProject);
      for (const projectId of projectIds) {
        await joinRepo.save(
          joinRepo.create({
            versionId: savedVersion.id,
            projectGroupId: projectId,
            pageNumber: pageMapFromMerge.get(projectId) ?? 0,
          }),
        );
      }

      // 10. Mark draft as merged.
      draft.assemblyStatus = MainAssemblyDraftStatus.MERGED;
      await manager.save(MainAssemblyDraft, draft);

      // 11. Populate per-PG lineage.
      await this.populateLineageForMerge(projectIds, savedVersion.id, manager);

      await this.notifyProgress(userId, developmentPlanId, 100, 'completed', 'รวมเล่มสำเร็จแล้ว!');

      this.logger.log(
        `[MainAssembly] merge plan=${developmentPlanId} v${draft.targetVersion} projects=${projectIds.length} pages=${totalPages}`,
      );

      const full = await manager.findOne(MainAssemblyVersion, {
        where: { id: savedVersion.id },
        relations: ['createdBy', 'createdBy.user'],
      });
      return this.toVersionDto(full ?? savedVersion);
    });
  }

  // ===================================================================
  // Public API — Cancel published version (§20 EXEMPTION)
  // ===================================================================

  /**
   * §20.4 EXEMPTION — cancelling a PUBLISHED MAIN_PLAN version is
   * FORBIDDEN. Main-plan books, once finalized, are immutable. To make
   * any correction, open an EDIT or CHANGE revision round under this
   * plan.
   *
   * Mirrors `BookAssemblyService.cancel` Rule 4b at
   * book-assembly.service.ts:1213-1221. The 403 error code
   * `MAIN_BOOK_CANNOT_ROLLBACK` is preserved byte-for-byte for FE
   * client parity.
   *
   * The signature accepts the dto + versionId for API surface
   * consistency with the supplement equivalent (which DOES allow
   * cancel) but rejects unconditionally.
   */
  async cancelPublishedVersion(
    developmentPlanId: string,
    versionId: string,
    _dto: CancelMainBookDto,
    _userId: string,
  ): Promise<void> {
    this.logger.warn(
      `[MainAssembly] cancelPublishedVersion REJECTED plan=${developmentPlanId} version=${versionId} — MAIN_BOOK_CANNOT_ROLLBACK`,
    );
    throw new ForbiddenException({
      code: 'MAIN_BOOK_CANNOT_ROLLBACK',
      message:
        'เล่มแผนหลักที่เผยแพร่แล้วไม่สามารถยกเลิกได้ หากต้องการแก้ไข กรุณาเปิดรอบแก้ไขหรือเปลี่ยนแปลง',
    });
  }

  // ===================================================================
  // Public API — Correct (deprecate current + spawn new draft)
  // ===================================================================

  /**
   * Deprecate the current COMPLETED main-plan version and spawn a new
   * PREPARING draft pre-populated with the parts NOT being corrected.
   *
   * Mode semantics:
   *   - CORRECTION_PART1 / CORRECTION_PART2 — surgical correction. Part 3
   *     and the un-targeted part are auto-REUSED; PGs UNAFFECTED.
   *   - CORRECTION_PART3 — FULL RESET. Every PG in the deprecated
   *     version's snapshot has its `isBooked` / `bookedAt` / `pageNumber`
   *     cleared. The plan flips `isBooked = false` / `bookedAt = null`
   *     so the §15 chain releases. Every `PlanPhase` row under the plan
   *     flips `isMerged = false`. Part 3 stays PENDING in the new draft.
   *
   * The `cancellation` mode is intentionally unreachable: the DTO enum
   * excludes it (cancel of a published main-plan version is permanently
   * forbidden — see `cancelPublishedVersion`).
   */
  async correct(
    developmentPlanId: string,
    dto: CorrectMainBookDto,
    userId: string,
  ): Promise<MainAssemblyDraftDto> {
    if (
      dto.correctionMode !== MainAssemblyCorrectionMode.CORRECTION_PART1 &&
      dto.correctionMode !== MainAssemblyCorrectionMode.CORRECTION_PART2 &&
      dto.correctionMode !== MainAssemblyCorrectionMode.CORRECTION_PART3
    ) {
      throw new BadRequestException(
        'correctionMode ต้องเป็น correction_part1, correction_part2 หรือ correction_part3',
      );
    }

    return this.dataSource.transaction(async (manager) => {
      // §15 main-plan freeze guard.
      await this.assertMainBookNotFrozen(developmentPlanId, manager);

      // 1. Operator authorization (role, workStatus, confirmed,
      //    citizenIdSuffix match w/ retry lock).
      const { workHistory } = await this.validateDeprecationAuth(
        dto.confirmed,
        dto.citizenIdSuffix,
        userId,
        manager,
      );

      // 2. Load current COMPLETED version with pessimistic write lock.
      const currentVersion = await manager.findOne(MainAssemblyVersion, {
        where: {
          developmentPlanId,
          status: MainAssemblyVersionStatus.COMPLETED,
        },
        lock: { mode: 'pessimistic_write' },
        order: { versionNumber: 'DESC' },
      });
      if (!currentVersion) {
        throw new NotFoundException(
          'ไม่พบเวอร์ชันที่เสร็จสมบูรณ์สำหรับเล่มแผนหลักนี้',
        );
      }

      // 3. Block if a CANCELED draft is parked (must restore/purge first).
      const canceledDraft = await manager.findOne(MainAssemblyDraft, {
        where: {
          developmentPlanId,
          assemblyStatus: MainAssemblyDraftStatus.CANCELED,
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
      const activeDraft = await manager.findOne(MainAssemblyDraft, {
        where: {
          developmentPlanId,
          assemblyStatus: In([
            MainAssemblyDraftStatus.PREPARING,
            MainAssemblyDraftStatus.READY,
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
        dto.correctionMode === MainAssemblyCorrectionMode.CORRECTION_PART3;

      // 3c. §14.11 correction-time descendant guard. CORRECTION_PART3
      //     un-books every PG in the deprecated version's snapshot
      //     (step 5a). If ANY of those PGs was forked into a LATER book
      //     (live §14 descendant, prev_project_type='original' — an RPG
      //     under a revision/change/supplement round), un-booking it here
      //     would strand the forked source: the downstream fork still
      //     points at it, so the source stays permanently §14-locked while
      //     its booked standing is gone ("ขาดช่วง"). MAIN cancel is §20.4
      //     EXEMPT (returns 403 MAIN_BOOK_CANNOT_ROLLBACK), so this is the
      //     only un-book path on MAIN that needs the guard. Reuses
      //     LineageLockService — no parallel query. Runs INSIDE the
      //     transaction, BEFORE the deprecate/un-book writes. PART1/PART2
      //     leave PGs booked, so they are NOT guarded.
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
      await manager.update(MainAssemblyVersion, currentVersion.id, {
        status: MainAssemblyVersionStatus.DEPRECATED,
        deprecatedAt: new Date(),
        deprecatedById: workHistory.id,
        deprecationReason: dto.reason,
      });

      // 5. CORRECTION_PART3 full reset (§20 parity).
      if (isFullReset) {
        // 5a. Reset PG booking on every PG in the deprecated snapshot.
        const snapshotIds = currentVersion.part3ProjectSnapshot ?? [];
        if (snapshotIds.length > 0) {
          await manager.getRepository(ProjectGroup).update(
            { id: In(snapshotIds) },
            { isBooked: false, bookedAt: null, pageNumber: null },
          );
        }
        // 5b. Reset plan state (clear bookedAt so §15 chain releases).
        await manager.getRepository(DevelopmentPlan).update(
          { id: developmentPlanId },
          { isBooked: false, bookedAt: null },
        );
        // 5c. Reset PlanPhase.isMerged flag across all phases.
        await manager.getRepository(PlanPhase).update(
          { developmentPlan: { id: developmentPlanId } },
          { isMerged: false },
        );
        // 5d. Roll back lineage leaf pointers on every PG in the
        //     deprecated snapshot so leaf state stays coherent with
        //     the version's deprecation.
        await this.restoreLineageAfterCancel(
          snapshotIds,
          currentVersion.id,
          manager,
        );
      }

      // 6. Create new draft.
      const nextVersion = currentVersion.versionNumber + 1;
      const correctLocation: BookAssemblyLocation = {
        kind: 'MAIN_PLAN',
        planId: developmentPlanId,
      };
      this.fileService.createVersionFolders(correctLocation, nextVersion);

      const draft = manager.create(MainAssemblyDraft, {
        developmentPlanId,
        targetVersion: nextVersion,
        previousVersionId: currentVersion.id,
        correctionMode: dto.correctionMode,
        correctionReason: dto.reason,
        part1Status: MainAssemblyPartUploadStatus.PENDING,
        part2Status: MainAssemblyPartUploadStatus.PENDING,
        part3Status: MainAssemblyPartUploadStatus.PENDING,
        assemblyStatus: MainAssemblyDraftStatus.PREPARING,
        createdById: workHistory.id,
      });

      // 7. Auto-reuse parts that are NOT being corrected.
      const correctingPart =
        dto.correctionMode === MainAssemblyCorrectionMode.CORRECTION_PART1
          ? 1
          : dto.correctionMode === MainAssemblyCorrectionMode.CORRECTION_PART2
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
            draft.part1Status = MainAssemblyPartUploadStatus.REUSED;
            draft.part1FilePath = copiedPath;
            draft.part1OriginalFileName = currentVersion.part1OriginalFileName;
            draft.part1UploadedAt = now;
            draft.part1UploadedById = workHistory.id;
          } else if (pn === 2) {
            draft.part2Status = MainAssemblyPartUploadStatus.REUSED;
            draft.part2FilePath = copiedPath;
            draft.part2OriginalFileName = currentVersion.part2OriginalFileName;
            draft.part2UploadedAt = now;
            draft.part2UploadedById = workHistory.id;
          } else {
            // Only reachable on CORRECTION_PART1 / CORRECTION_PART2
            // (PART3 full reset `continue`s above).
            draft.part3Status = MainAssemblyPartUploadStatus.REUSED;
            draft.part3FilePath = copiedPath;
            draft.part3GeneratedAt = now;
            draft.part3ProjectSnapshot = currentVersion.part3ProjectSnapshot;
            // 2026-05-31 (Part 3 SET-staleness, draft-side) — propagate
            // the equipment snapshot from the deprecated version so the
            // reused draft is staleness-comparable. Defensive `?? []`
            // for legacy version rows that predate the equipment
            // snapshot column (treated as empty set; no drift expected).
            draft.part3EquipmentSnapshot =
              currentVersion.part3EquipmentSnapshot ?? [];
            // Wave A1 — repopulate page_map from the deprecated
            // version-projects join (NOT from inline JSONB).
            const sourceJoin = await manager
              .getRepository(MainAssemblyVersionProject)
              .find({
                where: { versionId: currentVersion.id },
                select: ['projectGroupId', 'pageNumber'],
              });
            draft.part3PageMap = Object.fromEntries(
              sourceJoin.map((r) => [r.projectGroupId, r.pageNumber]),
            );
          }
        } catch (copyError) {
          this.logger.warn(
            `[MainAssembly] correct: failed to reuse part-${pn} from v${currentVersion.versionNumber}: ${
              (copyError as Error)?.message
            }`,
          );
        }
      }

      this.updateAssemblyStatus(draft);
      const saved = await manager.save(MainAssemblyDraft, draft);

      this.logger.log(
        `[MainAssembly] correct plan=${developmentPlanId} v${currentVersion.versionNumber} → draft v${nextVersion} mode=${dto.correctionMode} isFullReset=${isFullReset}`,
      );

      const full = await manager.findOne(MainAssemblyDraft, {
        where: { id: saved.id },
        relations: ['createdBy', 'createdBy.user'],
      });
      return await this.toDraftDto(full ?? saved);
    });
  }

  // ===================================================================
  // Public API — Read versions
  // ===================================================================

  async getVersions(
    developmentPlanId: string,
    userId: string,
  ): Promise<MainAssemblyVersionDto[]> {
    await this.loadAndValidateWorkHistory(userId, READ_ROLES);
    const rows = await this.versionRepo.find({
      where: { developmentPlanId },
      order: { versionNumber: 'DESC' },
      relations: ['createdBy', 'createdBy.user', 'deprecatedBy', 'deprecatedBy.user'],
    });
    return rows.map((r) => this.toVersionDto(r));
  }

  /**
   * Returns the current effective version.
   *
   * Resolution order (mirrors supplement BE-01 of M3 + book-assembly):
   *   1. The COMPLETED version, if one exists (partial unique index
   *      guarantees at most one).
   *   2. If no COMPLETED row exists (in-flight correction), fall back
   *      to the DEPRECATED row referenced by the active draft's
   *      `previousVersionId`.
   *   3. null otherwise — HTTP 200 with body `null`, NOT 404, so the
   *      FE `loadState()` does not surface a spurious error toast.
   */
  async getCurrentVersion(
    developmentPlanId: string,
    userId: string,
  ): Promise<MainAssemblyVersionDto | null> {
    await this.loadAndValidateWorkHistory(userId, READ_ROLES);

    // Step 1 — COMPLETED.
    const completed = await this.versionRepo.findOne({
      where: {
        developmentPlanId,
        status: MainAssemblyVersionStatus.COMPLETED,
      },
      relations: ['createdBy', 'createdBy.user'],
    });
    if (completed) {
      // §21.4 — enrich the detail-endpoint payload with the staleness
      // signal. Skipped on the list endpoint to avoid N+1.
      return this.enrichWithStaleness(this.toVersionDto(completed), completed);
    }

    // Step 2 — DEPRECATED via active draft's previousVersionId.
    const activeDraft = await this.draftRepo.findOne({
      where: {
        developmentPlanId,
        assemblyStatus: In([
          MainAssemblyDraftStatus.PREPARING,
          MainAssemblyDraftStatus.READY,
        ]),
      },
    });
    if (activeDraft?.previousVersionId) {
      const previous = await this.versionRepo.findOne({
        where: { id: activeDraft.previousVersionId },
        relations: ['createdBy', 'createdBy.user'],
      });
      if (previous) {
        return this.enrichWithStaleness(this.toVersionDto(previous), previous);
      }
    }

    return null;
  }

  async getVersionByNumber(
    developmentPlanId: string,
    versionNumber: number,
    userId: string,
  ): Promise<MainAssemblyVersionDto> {
    await this.loadAndValidateWorkHistory(userId, READ_ROLES);
    const version = await this.versionRepo.findOne({
      where: { developmentPlanId, versionNumber },
      relations: ['createdBy', 'createdBy.user'],
    });
    if (!version) {
      throw new NotFoundException(
        `ไม่พบเวอร์ชัน v${versionNumber} สำหรับเล่มแผนหลักนี้`,
      );
    }
    // §21.4 — enrich the single-version detail with the staleness diff.
    return this.enrichWithStaleness(this.toVersionDto(version), version);
  }

  // ===================================================================
  // Public API — Readiness + book display state
  // ===================================================================

  /**
   * Approval-progress readiness used by the FE assembly gate. Mirrors
   * the main-plan branch of `BookAssemblyService.getRevisionReadiness`.
   */
  async getReadiness(
    developmentPlanId: string,
    userId: string,
  ): Promise<MainReadinessDto> {
    await this.loadAndValidateWorkHistory(userId, READ_ROLES);

    const totalCount = await this.projectGroupRepo
      .createQueryBuilder('pg')
      .innerJoin('pg.trackingStatus', 'ts')
      .innerJoin('ts.statusId', 'status')
      .where('pg.developmentPlan = :id', { id: developmentPlanId })
      .andWhere('pg.deletedAt IS NULL')
      .andWhere('pg.isDraft = :isDraft', { isDraft: false })
      .andWhere('ts.isLatest = :isLatest', { isLatest: true })
      .andWhere('status.name NOT IN (:...excluded)', {
        excluded: READINESS_EXCLUSION_STATUSES,
      })
      .getCount();

    const approvedCount = await this.projectGroupRepo
      .createQueryBuilder('pg')
      .innerJoin('pg.trackingStatus', 'ts')
      .innerJoin('ts.statusId', 'status')
      .where('pg.developmentPlan = :id', { id: developmentPlanId })
      .andWhere('pg.deletedAt IS NULL')
      .andWhere('ts.isLatest = :isLatest', { isLatest: true })
      .andWhere('status.name = :name', { name: STATUS_NAMES.APPROVED })
      .getCount();

    const openPhaseExists = await this.planPhaseRepo
      .createQueryBuilder('pp')
      .where('pp.developmentPlan = :id', { id: developmentPlanId })
      .andWhere('pp.isOpen = :isOpen', { isOpen: true })
      .getExists();

    const hasOpenPhase = openPhaseExists;

    // Origin breakdown.
    const agencyCount = await this.projectGroupRepo
      .createQueryBuilder('pg')
      .innerJoin('pg.createdBy', 'wh')
      .innerJoin('wh.amphoe', 'amp')
      .innerJoin('wh.localAdministrativeOrganization', 'lao')
      .innerJoin('pg.trackingStatus', 'ts')
      .innerJoin('ts.statusId', 'status')
      .where('pg.developmentPlan = :id', { id: developmentPlanId })
      .andWhere('pg.deletedAt IS NULL')
      .andWhere('pg.isDraft = :isDraft', { isDraft: false })
      .andWhere('ts.isLatest = :isLatest', { isLatest: true })
      .andWhere('status.name NOT IN (:...excluded)', {
        excluded: READINESS_EXCLUSION_STATUSES,
      })
      .andWhere('amp.id = :amphoeId', { amphoeId: '3001' })
      .andWhere('lao.id = :laoId', { laoId: '3001027' })
      .getCount();
    const laoCount = totalCount - agencyCount;

    // §21.2 both-sources merge gate — per-source Approved sub-counts.
    // Agency Approved (§1 classification on creator WorkHistory):
    const approvedAgencyCount = await this.projectGroupRepo
      .createQueryBuilder('pg')
      .innerJoin('pg.createdBy', 'wh')
      .innerJoin('wh.amphoe', 'amp')
      .innerJoin('wh.localAdministrativeOrganization', 'lao')
      .innerJoin('pg.trackingStatus', 'ts')
      .innerJoin('ts.statusId', 'status')
      .where('pg.developmentPlan = :id', { id: developmentPlanId })
      .andWhere('pg.deletedAt IS NULL')
      .andWhere('pg.isDraft = :isDraft', { isDraft: false })
      .andWhere('ts.isLatest = :isLatest', { isLatest: true })
      .andWhere('status.name = :name', { name: STATUS_NAMES.APPROVED })
      .andWhere('amp.id = :amphoeId', { amphoeId: '3001' })
      .andWhere('lao.id = :laoId', { laoId: '3001027' })
      .getCount();
    // LAO Approved = total Approved − Agency Approved.
    const approvedLaoCount = approvedCount - approvedAgencyCount;

    // Approved equipment (§5.3) — agency-origin only by construction.
    // Mirrors the EXISTS clause used in por03-pdf.service.ts approved
    // equipment query. We count rows whose latest tracking row is Approved.
    const approvedEquipmentCount = await this.equipmentRepo
      .createQueryBuilder('eq')
      .innerJoin(
        'tracking_status',
        'ts',
        'ts.equipment_project_group_id = eq.id AND ts.is_latest = true',
      )
      .innerJoin('status', 'status', 'status.id = ts.status_id')
      .where('eq.development_plan_id = :id', { id: developmentPlanId })
      .andWhere('eq.deleted_at IS NULL')
      .andWhere('status.name = :name', { name: STATUS_NAMES.APPROVED })
      .getCount();

    // §21.2 — readiness gate. Single-อปท (หนองกระทุ่ม): the plan-
    // coordination ("การประสานแผน" / LAO) source is retired, so ALL
    // projects are agency-origin and `approvedLaoCount` is always 0.
    // The old both-sources requirement (`approvedLaoCount > 0`) is dropped
    // — the gate is now single-source: every project approved, the plan's
    // phase closed, and at least one approved project/equipment present.
    const agencySideContribution = approvedAgencyCount + approvedEquipmentCount;
    const isReady =
      approvedCount === totalCount &&
      totalCount > 0 &&
      !hasOpenPhase &&
      agencySideContribution > 0;

    // Status counts.
    const statusRows: { statusName: string; cnt: string }[] = await this.projectGroupRepo
      .createQueryBuilder('pg')
      .select('status.name', 'statusName')
      .addSelect('COUNT(pg.id)', 'cnt')
      .innerJoin('pg.trackingStatus', 'ts')
      .innerJoin('ts.statusId', 'status')
      .where('pg.developmentPlan = :id', { id: developmentPlanId })
      .andWhere('pg.deletedAt IS NULL')
      .andWhere('ts.isLatest = :isLatest', { isLatest: true })
      .groupBy('status.name')
      .getRawMany();
    const statusMap: Record<string, number> = {};
    for (const row of statusRows) {
      statusMap[row.statusName] = parseInt(row.cnt, 10);
    }

    const breakdown: MainReadinessBreakdownDto = {
      agencyCount,
      laoCount,
      // §21.2 — new per-source Approved sub-counts.
      approvedAgencyCount,
      approvedLaoCount,
      approvedEquipmentCount,
      pendingCount: statusMap[STATUS_NAMES.PENDING] ?? 0,
      verifiedCount: statusMap[STATUS_NAMES.VERIFIED] ?? 0,
      pendingApprovalCount: statusMap[STATUS_NAMES.PENDING_APPROVAL] ?? 0,
      approvedCount: statusMap[STATUS_NAMES.APPROVED] ?? 0,
      readyCount: statusMap[STATUS_NAMES.READY] ?? 0,
      returnedForRevisionCount: statusMap[STATUS_NAMES.RETURNED_FOR_REVISION] ?? 0,
      pullBackCount: statusMap[STATUS_NAMES.PULL_BACK] ?? 0,
      rejectedCount: statusMap[STATUS_NAMES.REJECTED] ?? 0,
      totalCount,
    };

    return { approvedCount, totalCount, isReady, hasOpenPhase, breakdown };
  }

  /**
   * §21.2 — Re-asserts the both-sources merge gate without the role
   * check that `getReadiness` performs. Used by `merge` and
   * `generatePart3` as defense-in-depth; FE has already enforced via
   * the disabled merge button but BE cannot trust FE.
   *
   * Throws `409 NO_APPROVED_PROJECTS` with a structured body when the
   * gate fails. Single-อปท: readiness is single-source (all projects are
   * agency-origin), so the former both-sources requirement is dropped.
   *
   * Constraints:
   *   - §21.2.2 — ABSOLUTE GATE. No role bypass; super-admin hits the
   *     same 409.
   *   - §17.2 — advisory in spirit, integrity in enforcement.
   *   - The gate runs AFTER `assertMainBookNotFrozen` so a frozen
   *     plan still 403s first per §15 precedence.
   */
  private async assertBothSourcesContribute(
    developmentPlanId: string,
  ): Promise<void> {
    // Use a fictitious user id with READ_ROLES — but we cannot avoid
    // the loadAndValidateWorkHistory call inside getReadiness. Instead,
    // recompute the four counts inline (cheap; same queries as above
    // but factored). Keeping a private inline implementation avoids
    // introducing a parameter to getReadiness that would skip its role
    // gate.
    const totalCount = await this.projectGroupRepo
      .createQueryBuilder('pg')
      .innerJoin('pg.trackingStatus', 'ts')
      .innerJoin('ts.statusId', 'status')
      .where('pg.developmentPlan = :id', { id: developmentPlanId })
      .andWhere('pg.deletedAt IS NULL')
      .andWhere('pg.isDraft = :isDraft', { isDraft: false })
      .andWhere('ts.isLatest = :isLatest', { isLatest: true })
      .andWhere('status.name NOT IN (:...excluded)', {
        excluded: READINESS_EXCLUSION_STATUSES,
      })
      .getCount();

    const approvedCount = await this.projectGroupRepo
      .createQueryBuilder('pg')
      .innerJoin('pg.trackingStatus', 'ts')
      .innerJoin('ts.statusId', 'status')
      .where('pg.developmentPlan = :id', { id: developmentPlanId })
      .andWhere('pg.deletedAt IS NULL')
      .andWhere('ts.isLatest = :isLatest', { isLatest: true })
      .andWhere('status.name = :name', { name: STATUS_NAMES.APPROVED })
      .getCount();

    const approvedAgencyCount = await this.projectGroupRepo
      .createQueryBuilder('pg')
      .innerJoin('pg.createdBy', 'wh')
      .innerJoin('wh.amphoe', 'amp')
      .innerJoin('wh.localAdministrativeOrganization', 'lao')
      .innerJoin('pg.trackingStatus', 'ts')
      .innerJoin('ts.statusId', 'status')
      .where('pg.developmentPlan = :id', { id: developmentPlanId })
      .andWhere('pg.deletedAt IS NULL')
      .andWhere('pg.isDraft = :isDraft', { isDraft: false })
      .andWhere('ts.isLatest = :isLatest', { isLatest: true })
      .andWhere('status.name = :name', { name: STATUS_NAMES.APPROVED })
      .andWhere('amp.id = :amphoeId', { amphoeId: '3001' })
      .andWhere('lao.id = :laoId', { laoId: '3001027' })
      .getCount();
    const approvedLaoCount = approvedCount - approvedAgencyCount;

    const approvedEquipmentCount = await this.equipmentRepo
      .createQueryBuilder('eq')
      .innerJoin(
        'tracking_status',
        'ts',
        'ts.equipment_project_group_id = eq.id AND ts.is_latest = true',
      )
      .innerJoin('status', 'status', 'status.id = ts.status_id')
      .where('eq.development_plan_id = :id', { id: developmentPlanId })
      .andWhere('eq.deleted_at IS NULL')
      .andWhere('status.name = :name', { name: STATUS_NAMES.APPROVED })
      .getCount();

    const openPhaseExists = await this.planPhaseRepo
      .createQueryBuilder('pp')
      .where('pp.developmentPlan = :id', { id: developmentPlanId })
      .andWhere('pp.isOpen = :isOpen', { isOpen: true })
      .getExists();

    // Single-อปท (หนองกระทุ่ม): plan-coordination (LAO) source retired —
    // readiness is single-source. Drop the `approvedLaoCount > 0` term
    // (always 0 now); require every project approved + at least one
    // approved project/equipment present, and the phase closed.
    const agencySideContribution = approvedAgencyCount + approvedEquipmentCount;
    const isReady =
      approvedCount === totalCount &&
      totalCount > 0 &&
      !openPhaseExists &&
      agencySideContribution > 0;

    if (!isReady) {
      throw new ConflictException({
        code: 'NO_APPROVED_PROJECTS',
        message:
          'เล่มแผนหลักต้องมีโครงการที่อนุมัติแล้วอย่างน้อย 1 รายการ และทุกโครงการต้องได้รับการอนุมัติก่อน จึงจะรวมเล่มได้',
        breakdown: {
          approvedLaoCount,
          approvedAgencyCount,
          approvedEquipmentCount,
          approvedCount,
          totalCount,
          hasOpenPhase: openPhaseExists,
        },
      });
    }
  }

  /**
   * Display-state envelope for the assembly dashboard.
   *
   * Wave A1 / BE-01 — main-plan books have no per-PG cross-book leaf
   * tracking (the §14 lineage lives on RPG only). `isLeaf` is therefore
   * derived from §15: a main plan with any non-soft-deleted revision /
   * supplement child is FROZEN_HISTORICAL. Otherwise we surface
   * NO_BOOK / DRAFT / PUBLISHED_LATEST based on the version+draft state.
   */
  async getBookDisplayState(
    developmentPlanId: string,
    userId: string,
  ): Promise<MainBookDisplayStateDto> {
    await this.loadAndValidateWorkHistory(userId, READ_ROLES);

    const dto = new MainBookDisplayStateDto();
    dto.developmentPlanId = developmentPlanId;
    dto.hasActiveDraftDependency = false;
    dto.blockedProjectCount = 0;

    // §15 freeze — if BookLockService throws, the plan is locked.
    try {
      await this.bookLockService.assertEditable(
        developmentPlanId,
        'development_plan',
        this.devPlanRepo.manager,
      );
      dto.isLeaf = true;
    } catch {
      dto.isLeaf = false;
      dto.state = MainBookDisplayStateEnum.FROZEN_HISTORICAL;
      return dto;
    }

    const completed = await this.versionRepo.findOne({
      where: {
        developmentPlanId,
        status: MainAssemblyVersionStatus.COMPLETED,
      },
    });
    if (completed) {
      dto.state = MainBookDisplayStateEnum.PUBLISHED_LATEST;
      return dto;
    }

    const hasActiveDraft = await this.draftRepo.exists({
      where: {
        developmentPlanId,
        assemblyStatus: In([
          MainAssemblyDraftStatus.PREPARING,
          MainAssemblyDraftStatus.READY,
        ]),
      },
    });
    dto.state = hasActiveDraft
      ? MainBookDisplayStateEnum.DRAFT
      : MainBookDisplayStateEnum.NO_BOOK;
    return dto;
  }

  // ===================================================================
  // Public API — File path resolution (controller streams from these)
  // ===================================================================

  async getMergedPdfPath(
    developmentPlanId: string,
    versionNumber: number,
  ): Promise<string> {
    const version = await this.versionRepo.findOne({
      where: { developmentPlanId, versionNumber },
    });
    if (!version || !version.mergedFilePath) {
      throw new NotFoundException(`ไม่พบไฟล์เล่มรวม v${versionNumber}`);
    }
    return this.fileService.getAbsolutePathByStored(version.mergedFilePath);
  }

  async getPartPdfPath(
    developmentPlanId: string,
    versionNumber: number,
    partNumber: 1 | 2 | 3,
  ): Promise<string> {
    this.fileService.validatePartNumber(partNumber);
    const version = await this.versionRepo.findOne({
      where: { developmentPlanId, versionNumber },
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
    developmentPlanId: string,
    partNumber: 1 | 2 | 3,
    userId: string,
  ): Promise<{ absPath: string; filename: string }> {
    await this.loadAndValidateWorkHistory(userId, READ_ROLES);
    const draft = await this.draftRepo.findOne({
      where: {
        developmentPlanId,
        assemblyStatus: In([
          MainAssemblyDraftStatus.PREPARING,
          MainAssemblyDraftStatus.READY,
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
    developmentPlanId: string,
    manager?: EntityManager,
  ): Promise<MainAssemblyDraft> {
    const repo = manager ? manager.getRepository(MainAssemblyDraft) : this.draftRepo;
    const draft = await repo.findOne({
      where: {
        developmentPlanId,
        assemblyStatus: In([
          MainAssemblyDraftStatus.PREPARING,
          MainAssemblyDraftStatus.READY,
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
   * §15 main-plan freeze guard. Delegates to `BookLockService` which
   * encodes the canonical predicate (any non-soft-deleted child
   * locks the plan). Translates `BOOK_HAS_NEWER_REVISION` into the
   * legacy `MAIN_BOOK_FROZEN` public error code for FE client parity.
   */
  private async assertMainBookNotFrozen(
    developmentPlanId: string,
    manager?: EntityManager,
  ): Promise<void> {
    const em = manager ?? this.devPlanRepo.manager;
    try {
      await this.bookLockService.assertEditable(
        developmentPlanId,
        'development_plan',
        em,
      );
    } catch (err) {
      const msg =
        err instanceof Error && typeof err.message === 'string' ? err.message : '';
      if (msg.startsWith(BOOK_HAS_NEWER_REVISION)) {
        throw new ForbiddenException({
          code: 'MAIN_BOOK_FROZEN',
          message:
            'เล่มแผนหลักนี้ถูกตรึงแล้ว เนื่องจากมีรอบแก้ไข/เปลี่ยนแปลง/เพิ่มเติมที่เชื่อมโยงอยู่',
        });
      }
      throw err;
    }
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
        `[MainAssembly] identity verification locked for user ${userId} after ${record.count} failed attempts`,
      );
    }
    this.identityAttempts.set(userId, record);
  }

  // ===================================================================
  // Private helpers — lineage
  // ===================================================================

  /**
   * Populates the `main_project_lineage` leaf chain for every PG in the
   * snapshot after a successful merge. Mirrors
   * `BookAssemblyService.populateLineageForMerge` minus the
   * `projectType` discriminator (table membership IS the type).
   */
  private async populateLineageForMerge(
    projectIds: string[],
    newVersionId: string,
    manager: EntityManager,
  ): Promise<void> {
    if (!projectIds || projectIds.length === 0) return;
    const lineageRepo = manager.getRepository(MainProjectLineage);

    for (const projectId of projectIds) {
      const currentLeaf = await lineageRepo.findOne({
        where: { projectGroupId: projectId, isCurrentLeaf: true },
      });
      if (currentLeaf) {
        currentLeaf.isCurrentLeaf = false;
        await lineageRepo.save(currentLeaf);
      }
      const newRow = lineageRepo.create({
        projectGroupId: projectId,
        mainAssemblyVersionId: newVersionId,
        parentMainAssemblyVersionId: currentLeaf
          ? currentLeaf.mainAssemblyVersionId
          : null,
        isCurrentLeaf: true,
      });
      await lineageRepo.save(newRow);
    }

    this.logger.log(
      `[MainAssembly] lineage populated for ${projectIds.length} PGs → versionId=${newVersionId}`,
    );
  }

  /**
   * After deprecating a version (via `correct` PART3 full reset),
   * restore parent leaf status on every PG in the cancelled snapshot.
   */
  private async restoreLineageAfterCancel(
    projectIds: string[],
    cancelledVersionId: string,
    manager: EntityManager,
  ): Promise<void> {
    if (!projectIds || projectIds.length === 0) return;
    const lineageRepo = manager.getRepository(MainProjectLineage);

    for (const projectId of projectIds) {
      const cancelledRow = await lineageRepo.findOne({
        where: {
          projectGroupId: projectId,
          mainAssemblyVersionId: cancelledVersionId,
        },
      });
      if (!cancelledRow) continue;

      cancelledRow.isCurrentLeaf = false;
      await lineageRepo.save(cancelledRow);

      if (cancelledRow.parentMainAssemblyVersionId) {
        const parentRow = await lineageRepo.findOne({
          where: {
            projectGroupId: projectId,
            mainAssemblyVersionId: cancelledRow.parentMainAssemblyVersionId,
          },
        });
        if (parentRow) {
          parentRow.isCurrentLeaf = true;
          await lineageRepo.save(parentRow);
        }
      }
    }
    this.logger.log(
      `[MainAssembly] lineage restored for ${projectIds.length} PGs after deprecation of versionId=${cancelledVersionId}`,
    );
  }

  // ===================================================================
  // Private helpers — Part 3 generation
  // ===================================================================

  private async queryAndRenderPart3(
    developmentPlanId: string,
    _userId: string,
    /**
     * Phase 3 — initial page offset baked into the Part 3 footer. For
     * standalone Part 3 preview (generatePart3) this is 0 so footers
     * start at 1. For MAIN_PLAN merge it is `pageCount(part1+part2)` so
     * Part 3 footers continue the assembled book's running count.
     */
    initialPageOffset: number = 0,
  ): Promise<{
    projects: any[];
    projectIds: string[];
    pageMap: { buffer: Buffer; pageMap: Map<string, number> };
  }> {
    // §16 — resolve reportFormat for sort order.
    const plan = await this.devPlanRepo.findOne({
      where: { id: developmentPlanId },
      select: ['id', 'reportFormat'],
    });
    if (!plan) {
      throw new NotFoundException(`DevelopmentPlan not found for id=${developmentPlanId}`);
    }
    const reportFormat = plan.reportFormat ?? ReportFormat.STRATEGY_BASED;

    const qb = this.projectGroupRepo
      .createQueryBuilder('pg')
      .leftJoinAndSelect('pg.createdBy', 'createdBy')
      .leftJoinAndSelect('createdBy.user', 'createdByUser')
      .leftJoinAndSelect('createdBy.amphoe', 'amphoe')
      .leftJoinAndSelect('createdBy.localAdministrativeOrganization', 'lao')
      .leftJoinAndSelect('pg.strategy', 'strategy')
      .leftJoinAndSelect('pg.tactic', 'tactic')
      .leftJoinAndSelect('pg.plan', 'plan')
      .leftJoinAndSelect('pg.developmentIssue', 'developmentIssue')
      .leftJoinAndSelect('pg.developmentPlan', 'developmentPlan')
      .leftJoinAndSelect('pg.budgets', 'budgets')
      .leftJoinAndSelect('pg.trackingStatus', 'ts')
      .leftJoinAndSelect('ts.statusId', 'status')
      .leftJoinAndSelect('pg.responsibleAgency', 'responsibleAgency')
      .leftJoinAndSelect('pg.originAgencyId', 'originAgencyId')
      .leftJoinAndSelect('originAgencyId.amphoe', 'originAgencyAmphoe')
      .leftJoinAndSelect('pg.revisedProjectGroups', 'rpg')
      .where('pg.developmentPlan.id = :id', { id: developmentPlanId })
      .andWhere('pg.responsibleAgency IS NOT NULL')
      .andWhere('pg.isBooked = :isBooked', { isBooked: false })
      .andWhere('pg.isDraft = :isDraft', { isDraft: false })
      .andWhere('pg.deletedAt IS NULL')
      .andWhere('ts.isLatest = :isLatest', { isLatest: true })
      .andWhere('status.name = :name', { name: STATUS_NAMES.APPROVED })
      .andWhere('rpg.id IS NULL');

    if (reportFormat === ReportFormat.ISSUE_BASED) {
      qb.orderBy('developmentIssue.sortOrder', 'ASC');
    } else {
      qb.orderBy('strategy.id', 'ASC');
    }

    const rows = await qb.getMany();
    const projects = rows.map((p) => UnifiedProjectMapper.fromProjectGroup(p));
    const projectIds = projects.map((p) => p.id);

    if (projects.length === 0) {
      return { projects, projectIds, pageMap: { buffer: Buffer.alloc(0), pageMap: new Map() } };
    }

    const pdfResult = await this.pdfService.generateProjectReportWithPageTracking(
      projects,
      ['index', 'title', 'objective', 'target', 'budget', 'expectedResult', 'mainAgency'],
      { developmentPlanId, initialPageOffset },
    );

    return { projects, projectIds, pageMap: pdfResult };
  }

  /**
   * §21.3.2 / BE-02 Surface B — Computes the page offset for the
   * standalone Part 3 preview based on whichever of P1 / P2 are
   * currently uploaded on the draft. Returns 0 when neither part is
   * uploaded yet (graceful degrade).
   *
   * Read-only; pure I/O against the draft's on-disk part files via
   * `BookAssemblyFileService`. Used by `generatePart3` to thread an
   * `initialPageOffset` into the Part 3 renderer so the standalone
   * file footers match what the merged book will eventually show.
   *
   * Constraints:
   *   - §17.5 — no auto-recompute. The offset is captured at the
   *     moment `generatePart3` is invoked; if P1 / P2 changes after
   *     this call, the standalone file becomes stale until the user
   *     re-invokes generatePart3.
   *   - §20.10.3 — file-service exemption: shared infrastructure I/O.
   */
  private async computeStandalonePart3Offset(
    draft: MainAssemblyDraft,
  ): Promise<number> {
    let offset = 0;
    if (draft.part1FilePath) {
      try {
        const p1 = this.fileService.readPartFileByStored(draft.part1FilePath);
        offset += (await PDFDocument.load(p1)).getPageCount();
      } catch (err) {
        this.logger.warn(
          `[MainAssembly] computeStandalonePart3Offset: failed to read P1 (${draft.part1FilePath}) — treating as absent. err=${(err as Error).message}`,
        );
      }
    }
    if (draft.part2FilePath) {
      try {
        const p2 = this.fileService.readPartFileByStored(draft.part2FilePath);
        offset += (await PDFDocument.load(p2)).getPageCount();
      } catch (err) {
        this.logger.warn(
          `[MainAssembly] computeStandalonePart3Offset: failed to read P2 (${draft.part2FilePath}) — treating as absent. err=${(err as Error).message}`,
        );
      }
    }
    return offset;
  }

  // ===================================================================
  // Private helpers — small utilities
  // ===================================================================

  private updateAssemblyStatus(draft: MainAssemblyDraft): void {
    const part1Ready = draft.part1Status !== MainAssemblyPartUploadStatus.PENDING;
    const part2Ready = draft.part2Status !== MainAssemblyPartUploadStatus.PENDING;
    const part3Ready = draft.part3Status !== MainAssemblyPartUploadStatus.PENDING;

    if (part1Ready && part2Ready && part3Ready) {
      draft.assemblyStatus = MainAssemblyDraftStatus.READY;
    } else if (draft.assemblyStatus === MainAssemblyDraftStatus.READY) {
      draft.assemblyStatus = MainAssemblyDraftStatus.PREPARING;
    }
  }

  private toPartSource(status: MainAssemblyPartUploadStatus): MainAssemblyPartSource {
    switch (status) {
      case MainAssemblyPartUploadStatus.UPLOADED:
        return MainAssemblyPartSource.UPLOADED;
      case MainAssemblyPartUploadStatus.GENERATED:
        return MainAssemblyPartSource.GENERATED;
      case MainAssemblyPartUploadStatus.REUSED:
        return MainAssemblyPartSource.REUSED;
      default:
        return MainAssemblyPartSource.UPLOADED;
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

  /**
   * THE HEADLINE — single post-merge GLOBAL page-number pass.
   *
   * Loads the WHOLE combined book (ผ.01 → ผ.02 → ผ.03), then draws a
   * sequential page number `N` (N = pageIndex + 1, running 1..totalPages
   * with NO restart per section) on EVERY page. Because every page is
   * numbered in document order regardless of which source PDF it came
   * from, the appended ผ.03 section automatically CONTINUES the sequence
   * ("รันเลขหน้าต่อยันยาวลงไป").
   *
   * Font: pdf-lib's built-in `Helvetica` (a StandardFont) — no fontkit /
   * THSarabun embedding is needed because we draw a bare ASCII numeral,
   * not Thai text. This keeps the global pass dependency-free.
   *
   * Position: bottom-CENTER. The center placement is deliberate — any
   * per-part footer/number baked into ผ.01 / ผ.02 by the upstream
   * generators tends to sit bottom-right, so a bottom-center global
   * number avoids visual collision. The GLOBAL pass is the authoritative
   * page sequence for the assembled book.
   *
   * Landscape vs portrait is handled per-page: x is computed from each
   * page's OWN width via `page.getSize()`, so ผ.03 (landscape A4) and a
   * portrait ผ.02 both center correctly.
   *
   * Pure buffer transform — NO DB writes, NO transaction interaction.
   */
  private async stampGlobalPageNumbers(combined: Buffer): Promise<Buffer> {
    const doc = await PDFDocument.load(combined);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const fontSize = 11;
    const bottomMargin = 18;
    const color = rgb(0, 0, 0);

    // Position — BOTTOM-RIGHT (user direction 2026-05-31). ผ.01/ผ.02 bake
    // their per-section page numbers bottom-right already; ผ.03 has no
    // footer. Drawing the global continuous sequence bottom-right
    // OVERWRITES the per-section numbers with the unbroken 1..N sequence
    // (same position → operator sees ONE number per page, not two).
    const rightMargin = 24;
    const pages = doc.getPages();
    pages.forEach((page, index) => {
      const label = String(index + 1);
      const { width } = page.getSize();
      const textWidth = font.widthOfTextAtSize(label, fontSize);
      page.drawText(label, {
        x: width - rightMargin - textWidth,
        y: bottomMargin,
        size: fontSize,
        font,
        color,
      });
    });

    const stampedBytes = await doc.save();
    return Buffer.from(stampedBytes);
  }

  private async notifyProgress(
    userId: string,
    developmentPlanId: string,
    percentage: number,
    stage: string,
    message: string,
  ): Promise<void> {
    try {
      await this.websocketService.notifyPdfGenerationProgress({
        userId,
        developmentPlanId,
        progress: { percentage, stage, message },
      });
    } catch {
      // Non-fatal — progress events are best-effort.
    }
  }

  // ===================================================================
  // Private helpers — DTO mapping
  // ===================================================================

  private async toDraftDto(d: MainAssemblyDraft): Promise<MainAssemblyDraftDto> {
    const baseDto: MainAssemblyDraftDto = {
      id: d.id,
      developmentPlanId: d.developmentPlanId,
      assemblyStatus: d.assemblyStatus,
      part1Status: d.part1Status,
      part1OriginalFileName: d.part1OriginalFileName ?? null,
      part1UploadedAt: d.part1UploadedAt ? d.part1UploadedAt.toISOString() : null,
      part2Status: d.part2Status,
      part2OriginalFileName: d.part2OriginalFileName ?? null,
      part2UploadedAt: d.part2UploadedAt ? d.part2UploadedAt.toISOString() : null,
      part3Status: d.part3Status,
      part3GeneratedAt: d.part3GeneratedAt ? d.part3GeneratedAt.toISOString() : null,
      // 2026-05-31 — Expose the Part 3 PG snapshot on the draft DTO so
      // the FE can detect Part 3 staleness (snapshot.length vs live
      // approvedCount). Written by generatePart3 (line 685) and by the
      // CORRECTION_PART3 reuse path (line 1343). Null until Part 3 has
      // been generated/reused for the active draft.
      part3ProjectSnapshot: d.part3ProjectSnapshot ?? null,
      // 2026-05-31 (Part 3 SET-staleness, draft-side) — pass-through.
      part3EquipmentSnapshot: d.part3EquipmentSnapshot ?? null,
      // Default to non-stale; `enrichDraftWithStaleness` overrides
      // these when Part 3 has been generated/reused.
      isPart3Stale: false,
      part3StalePgCount: 0,
      part3RemovedPgCount: 0,
      part3StaleEquipmentCount: 0,
      part3RemovedEquipmentCount: 0,
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
    return this.enrichDraftWithStaleness(baseDto, d);
  }

  private toVersionDto(v: MainAssemblyVersion): MainAssemblyVersionDto {
    const appUrl = process.env.APP_URL ?? '';
    const prefix = `${appUrl}/v1/main-assembly/${v.developmentPlanId}`;
    return {
      id: v.id,
      developmentPlanId: v.developmentPlanId,
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

  /**
   * §21.4 — Computes the read-time Part 3 staleness signal for a
   * single version row by diffing the persisted snapshots against the
   * current Approved-PG / Approved-equipment sets under the same plan.
   *
   * Constraints:
   *   - §17.2 advisory — the signal MUST NOT gate any workflow
   *     transition; it informs the FE banner only.
   *   - §17.5 no auto-recompute — this is a pure read; no DB writes.
   *   - §12 / §17.3 — no `tracking_status` or `ai_*` writes.
   *   - O(N) on PG + equipment count; called only by
   *     `getCurrentVersion` / `getVersionByNumber` (not by the list
   *     endpoint `getVersions`) to avoid N+1.
   */
  private async enrichWithStaleness(
    dto: MainAssemblyVersionDto,
    v: MainAssemblyVersion,
  ): Promise<MainAssemblyVersionDto> {
    const snapshotPgIds = new Set(v.part3ProjectSnapshot ?? []);
    const snapshotEquipmentIds = new Set(v.part3EquipmentSnapshot ?? []);
    const equipmentSnapshotMissing = v.part3EquipmentSnapshot === null;

    // Current Approved PG set under the plan.
    const currentApprovedPgRows: { id: string }[] = await this.projectGroupRepo
      .createQueryBuilder('pg')
      .select('pg.id', 'id')
      .innerJoin('pg.trackingStatus', 'ts')
      .innerJoin('ts.statusId', 'status')
      .where('pg.developmentPlan = :id', { id: v.developmentPlanId })
      .andWhere('pg.deletedAt IS NULL')
      .andWhere('ts.isLatest = :isLatest', { isLatest: true })
      .andWhere('status.name = :name', { name: STATUS_NAMES.APPROVED })
      .getRawMany();
    const currentPgSet = new Set(currentApprovedPgRows.map((r) => r.id));

    let part3StaleProjectCount = 0;
    for (const id of currentPgSet) {
      if (!snapshotPgIds.has(id)) part3StaleProjectCount += 1;
    }
    let part3RemovedProjectCount = 0;
    for (const id of snapshotPgIds) {
      if (!currentPgSet.has(id)) part3RemovedProjectCount += 1;
    }

    // Current Approved equipment set under the plan — only counted
    // when the snapshot column exists (NULL = historical row).
    let part3StaleEquipmentCount = 0;
    let part3RemovedEquipmentCount = 0;
    if (!equipmentSnapshotMissing) {
      const currentApprovedEqRows: { id: string }[] = await this.equipmentRepo
        .createQueryBuilder('eq')
        .select('eq.id', 'id')
        .innerJoin(
          'tracking_status',
          'ts',
          'ts.equipment_project_group_id = eq.id AND ts.is_latest = true',
        )
        .innerJoin('status', 'status', 'status.id = ts.status_id')
        .where('eq.development_plan_id = :id', { id: v.developmentPlanId })
        .andWhere('eq.deleted_at IS NULL')
        .andWhere('status.name = :name', { name: STATUS_NAMES.APPROVED })
        .getRawMany();
      const currentEqSet = new Set(currentApprovedEqRows.map((r) => r.id));
      for (const id of currentEqSet) {
        if (!snapshotEquipmentIds.has(id)) part3StaleEquipmentCount += 1;
      }
      for (const id of snapshotEquipmentIds) {
        if (!currentEqSet.has(id)) part3RemovedEquipmentCount += 1;
      }
    }

    const isPart3Stale =
      part3StaleProjectCount +
        part3RemovedProjectCount +
        part3StaleEquipmentCount +
        part3RemovedEquipmentCount >
      0;

    // §14.11 (read-side) — advisory downstream-fork flag (§17.2). Matches the
    // CORRECTION_PART3 guard exactly: only the PG snapshot + 'original'
    // discriminator (MAIN cancel is §20.4 EXEMPT; the equipment snapshot has
    // no §14 fork relevance in the MAIN correction path). Used by the FE to
    // pre-emptively disable the CORRECTION_PART3 option.
    const hasDownstreamFork = await this.computeHasDownstreamFork(
      v.part3ProjectSnapshot ?? [],
      this.dataSource.manager,
    );

    return {
      ...dto,
      part3StaleProjectCount,
      part3RemovedProjectCount,
      part3StaleEquipmentCount,
      part3RemovedEquipmentCount,
      isPart3Stale,
      equipmentSnapshotMissing,
      hasDownstreamFork,
    };
  }

  /**
   * §14.11 — collect the snapshot PG ids that have a live (non-soft-deleted)
   * downstream fork (prev_project_type='original'). SINGLE source of truth
   * shared by the CORRECTION_PART3 throw-guard (which surfaces the ids in the
   * 409 body) AND the read-side hasDownstreamFork flag, so the pre-emptive FE
   * disable can never disagree with the throw. Reuses LineageLockService — no
   * parallel query.
   */
  private async collectDownstreamForkIds(
    snapshotIds: string[],
    manager: EntityManager,
  ): Promise<string[]> {
    const blocking: string[] = [];
    for (const projectId of snapshotIds) {
      const forked = await this.lineageLockService.hasNonDeletedDescendant(
        projectId,
        'original',
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
          'original',
          manager,
        )
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * 2026-05-31 (Part 3 SET-staleness, draft-side) — Computes the
   * read-time Part 3 staleness signal for the active DRAFT by SET-diffing
   * the persisted `part3ProjectSnapshot` / `part3EquipmentSnapshot`
   * arrays against the current Approved PG / equipment sets under the
   * same plan.
   *
   * Why SET diff (not count compare): the user-reported bug is the
   * "rollback A + approve C" tie — same count, different set. A pure
   * count compare misses it; we MUST compare membership.
   *
   * Equipment parity: the user explicitly requested equipment drift
   * to ALSO block merge + show "สร้างใหม่". Equipment IDs are now
   * captured into `part3EquipmentSnapshot` at generatePart3 time
   * (main-assembly.service.ts:689), mirroring the version-side
   * `enrichWithStaleness` (lines 2458-2531).
   *
   * Constraints:
   *   - §17.2 advisory — the signal MUST NOT gate any workflow
   *     transition; the FE uses it to gate the merge button only.
   *     The BE merge path has its own §21.2 both-sources gate and
   *     does NOT consult this signal.
   *   - §17.5 no auto-recompute — pure read; no DB writes.
   *   - §12 / §17.3 — no `tracking_status` / `ai_*` writes.
   *   - Skipped when Part 3 has not yet been generated/reused
   *     (status NOT IN {generated, reused}); returns the input DTO
   *     verbatim. No queries issued in that case.
   *   - Legacy drafts: `part3EquipmentSnapshot === null` is treated
   *     as the empty set (no drift expected — pre-equipment-snapshot
   *     rows simply have no equipment IDs to compare against).
   *
   * §20 parity scope: MAIN_PLAN only per user direction. EDIT /
   * CHANGE / SUPPLEMENT remain on the legacy count-compare or no
   * comparison; a follow-up wave will propagate this pattern uniformly.
   */
  private async enrichDraftWithStaleness(
    dto: MainAssemblyDraftDto,
    d: MainAssemblyDraft,
  ): Promise<MainAssemblyDraftDto> {
    // Skip staleness compute when Part 3 isn't generated/reused yet.
    // Returns the input DTO verbatim with all-zero / false defaults
    // already set by `toDraftDto`.
    const part3Done =
      d.part3Status === MainAssemblyPartUploadStatus.GENERATED ||
      d.part3Status === MainAssemblyPartUploadStatus.REUSED;
    if (!part3Done) {
      return dto;
    }

    const snapshotPgIds = new Set(d.part3ProjectSnapshot ?? []);
    // Legacy fallback — pre-this-change drafts have null equipment
    // snapshot; treat as empty set (no drift signal).
    const snapshotEquipmentIds = new Set(d.part3EquipmentSnapshot ?? []);

    // Current Approved PG set under the plan. Same query as the
    // version-side `enrichWithStaleness` (lines 2467-2476) and as
    // `getReadiness.approvedCount` (lines 1498-1506) — projected via
    // `.getRawMany()` instead of `.getCount()` to return the ID list.
    const currentApprovedPgRows: { id: string }[] = await this.projectGroupRepo
      .createQueryBuilder('pg')
      .select('pg.id', 'id')
      .innerJoin('pg.trackingStatus', 'ts')
      .innerJoin('ts.statusId', 'status')
      .where('pg.developmentPlan = :id', { id: d.developmentPlanId })
      .andWhere('pg.deletedAt IS NULL')
      .andWhere('ts.isLatest = :isLatest', { isLatest: true })
      .andWhere('status.name = :name', { name: STATUS_NAMES.APPROVED })
      .getRawMany();
    const currentPgSet = new Set(currentApprovedPgRows.map((r) => r.id));

    let part3StalePgCount = 0;
    for (const id of currentPgSet) {
      if (!snapshotPgIds.has(id)) part3StalePgCount += 1;
    }
    let part3RemovedPgCount = 0;
    for (const id of snapshotPgIds) {
      if (!currentPgSet.has(id)) part3RemovedPgCount += 1;
    }

    // Current Approved equipment set under the plan. Mirrors the
    // version-side `enrichWithStaleness` (lines 2493-2505) and the
    // readiness equipment query (lines 1559-1570).
    const currentApprovedEqRows: { id: string }[] = await this.equipmentRepo
      .createQueryBuilder('eq')
      .select('eq.id', 'id')
      .innerJoin(
        'tracking_status',
        'ts',
        'ts.equipment_project_group_id = eq.id AND ts.is_latest = true',
      )
      .innerJoin('status', 'status', 'status.id = ts.status_id')
      .where('eq.development_plan_id = :id', { id: d.developmentPlanId })
      .andWhere('eq.deleted_at IS NULL')
      .andWhere('status.name = :name', { name: STATUS_NAMES.APPROVED })
      .getRawMany();
    const currentEqSet = new Set(currentApprovedEqRows.map((r) => r.id));

    let part3StaleEquipmentCount = 0;
    for (const id of currentEqSet) {
      if (!snapshotEquipmentIds.has(id)) part3StaleEquipmentCount += 1;
    }
    let part3RemovedEquipmentCount = 0;
    for (const id of snapshotEquipmentIds) {
      if (!currentEqSet.has(id)) part3RemovedEquipmentCount += 1;
    }

    const isPart3Stale =
      part3StalePgCount +
        part3RemovedPgCount +
        part3StaleEquipmentCount +
        part3RemovedEquipmentCount >
      0;

    return {
      ...dto,
      isPart3Stale,
      part3StalePgCount,
      part3RemovedPgCount,
      part3StaleEquipmentCount,
      part3RemovedEquipmentCount,
    };
  }
}
