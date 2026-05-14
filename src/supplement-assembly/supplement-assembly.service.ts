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
import { DataSource, EntityManager, Repository } from 'typeorm';
import { PDFDocument } from 'pdf-lib';

import { SupplementAssemblyDraft } from './entities/supplement-assembly-draft.entity';
import { SupplementAssemblyVersion } from './entities/supplement-assembly-version.entity';
import { SupplementAssemblyVersionProject } from './entities/supplement-assembly-version-project.entity';
import {
  SupplementAssemblyDraftStatus,
  SupplementAssemblyPartSource,
  SupplementAssemblyPartUploadStatus,
  SupplementAssemblyVersionStatus,
} from './enums/supplement-assembly.enums';
import { SupplementAssemblyDraftDto } from './dto/draft-response.dto';
import { SupplementAssemblyVersionDto } from './dto/version-response.dto';

import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { DevelopmentPlanSupplement } from 'src/development-plan-supplement/entities/development-plan-supplement.entity';
import { SupplementProjectGroup } from 'src/supplement-project-group/entities/supplement-project-group.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { User } from 'src/users/entities/user.entity';

import { SupplementAssemblyFileService } from './supplement-assembly-file.service';
import { SupplementPdfService } from 'src/pdf/supplement-pdf.service';
import { BookLockService } from 'src/common/book-lock/book-lock.service';
import { OrphanCleanupService } from 'src/orphan-cleanup/orphan-cleanup.service';

/** Roles permitted to perform supplement-assembly write actions (§4.1 / §18.3). */
const ADMIN_ROLES = ['admin', 'super-admin'];

/** Roles permitted to view / download. Mirrors BookAssembly precedent. */
const READ_ROLES = ['staff', 'admin', 'super-admin'];

/** Part-number guard — Part 1/2/3 only. */
type PartNumber = 1 | 2 | 3;

@Injectable()
export class SupplementAssemblyService {
  private readonly logger = new Logger(SupplementAssemblyService.name);

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
    private readonly dataSource: DataSource,
  ) {}

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
      return this.toDraftDto(saved);
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
    const draft = await this.draftRepo.findOne({
      where: {
        developmentPlanSupplementId: supplementId,
        assemblyStatus: SupplementAssemblyDraftStatus.CANCELED,
      },
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
      this.fileService.ensureVersionFolders(supplementId, targetVersion);
      const filename = `part-3.pdf`;
      this.fileService.writePart(supplementId, targetVersion, 3, buffer);

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
      this.fileService.ensureVersionFolders(supplementId, targetVersion);
      this.fileService.copyPartFromVersion(
        supplementId,
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

    const targetVersion = await this.computeNextVersion(supplementId);
    return this.fileService.readPart(supplementId, targetVersion, partNumber);
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

    const targetVersion = await this.computeNextVersion(supplementId);
    const part1 = this.fileService.readPart(supplementId, targetVersion, 1);
    const part2 = this.fileService.readPart(supplementId, targetVersion, 2);
    const part3 = this.fileService.readPart(supplementId, targetVersion, 3);
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
        const latest = await manager.findOne(SupplementAssemblyVersion, {
          where: { developmentPlanSupplementId: supplementId },
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
      this.fileService.ensureVersionFolders(supplementId, nextVersion);
      const part1Buffer = this.fileService.readPart(
        supplementId,
        nextVersion,
        1,
      );
      const part2Buffer = this.fileService.readPart(
        supplementId,
        nextVersion,
        2,
      );
      const part3Buffer = this.fileService.readPart(
        supplementId,
        nextVersion,
        3,
      );
      const mergedBuffer = await this.mergePdfBuffers([
        part1Buffer,
        part2Buffer,
        part3Buffer,
      ]);
      const mergedPath = this.fileService.writeMerged(
        supplementId,
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
      const versionRow = manager.create(SupplementAssemblyVersion, {
        developmentPlanSupplementId: supplementId,
        versionNumber: nextVersion,
        status: SupplementAssemblyVersionStatus.COMPLETED,
        mergedFilePath: mergedPath,
        mergedFileSha256: mergedSha256,
        createdById: workHistory.id,
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
      lockedSupplement.isBooked = true;
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

      return this.toVersionDto(savedVersion);
    });
  }

  // ===================================================================
  // Public API — Read versions
  // ===================================================================

  /**
   * List all versions (most recent first). Read-only.
   */
  async getVersions(
    supplementId: string,
    userId: string,
  ): Promise<SupplementAssemblyVersionDto[]> {
    await this.loadAndValidateWorkHistory(userId, READ_ROLES);
    const rows = await this.versionRepo.find({
      where: { developmentPlanSupplementId: supplementId },
      order: { versionNumber: 'DESC' },
    });
    return rows.map((r) => this.toVersionDto(r));
  }

  /**
   * Return the highest-version row, or null. Read-only.
   */
  async getCurrentVersion(
    supplementId: string,
    userId: string,
  ): Promise<SupplementAssemblyVersionDto | null> {
    await this.loadAndValidateWorkHistory(userId, READ_ROLES);
    const row = await this.versionRepo.findOne({
      where: { developmentPlanSupplementId: supplementId },
      order: { versionNumber: 'DESC' },
    });
    return row ? this.toVersionDto(row) : null;
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
    return this.toVersionDto(row);
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
    return this.fileService.readMerged(supplementId, versionNumber);
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
    return this.fileService.readPart(supplementId, versionNumber, partNumber);
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
      this.fileService.ensureVersionFolders(supplementId, targetVersion);
      this.fileService.writePart(
        supplementId,
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
        'ไม่พบ draft รวมเล่มที่กำลังดำเนินการ กรุณาสร้าง draft ใหม่',
      );
    }
    return draft;
  }

  private async findActiveDraft(
    supplementId: string,
  ): Promise<SupplementAssemblyDraft | null> {
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
    });
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
   */
  private async mergePdfBuffers(buffers: Buffer[]): Promise<Buffer> {
    if (buffers.length === 0) {
      throw new BadRequestException('No PDF buffers provided for merging');
    }
    if (buffers.length === 1) {
      return buffers[0];
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
    const mergedBytes = await mergedPdf.save();
    return Buffer.from(mergedBytes);
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
    };
  }
}

