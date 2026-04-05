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
import { DataSource, In, Repository } from 'typeorm';
import { PDFDocument } from 'pdf-lib';

import { BookAssemblyDraft } from './entities/book-assembly-draft.entity';
import { BookAssemblyVersion } from './entities/book-assembly-version.entity';
import { DeprecationAuditLog } from './entities/deprecation-audit-log.entity';
import {
  AssemblyDraftStatus,
  BookAssemblySourceType,
  BookAssemblyVersionStatus,
  CorrectionMode,
  DeprecationAuditAction,
  PartSource,
  PartUploadStatus,
} from './enums/book-assembly.enums';

import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';
import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { DevelopmentPlanRevision } from 'src/development-plan-revision/entities/development-plan-revision.entity';
import { PlanPhase } from 'src/plan-phase/entities/plan-phase.entity';

import { UsersService } from 'src/users/users.service';
import { PdfService } from 'src/pdf/pdf.service';
import { WebsocketService } from 'src/websocket/websocket/websocket.service';
import { UnifiedProjectMapper } from 'src/project-groups/dto/unified-project-display.dto';
import { handleException } from 'src/util/handleException';

import { BookAssemblyFileService } from './book-assembly-file.service';
import { CancelBookDto } from './dto/cancel-book.dto';
import { CorrectBookDto } from './dto/correct-book.dto';
import { VersionResponseDto } from './dto/version-response.dto';

/** Roles permitted to perform assembly write actions (Spec Section 10.1) */
const ADMIN_ROLES = ['admin', 'super-admin'];

/** Roles permitted to view / download (Spec Section 10.1) */
const READ_ROLES = ['staff', 'admin', 'super-admin'];

/** Max identity-verification failures before lock (Spec Section 11.4) */
const MAX_IDENTITY_ATTEMPTS = 3;

/** Lock duration after exceeding retry limit */
const IDENTITY_LOCK_MS = 15 * 60 * 1000; // 15 minutes

@Injectable()
export class BookAssemblyService {
  private readonly logger = new Logger(BookAssemblyService.name);

  /** In-memory identity-verification retry tracker */
  private readonly identityAttempts = new Map<
    string,
    { count: number; lockedUntil?: Date }
  >();

  constructor(
    @InjectRepository(BookAssemblyDraft)
    private readonly draftRepo: Repository<BookAssemblyDraft>,

    @InjectRepository(BookAssemblyVersion)
    private readonly versionRepo: Repository<BookAssemblyVersion>,

    @InjectRepository(WorkHistory)
    private readonly workHistoryRepo: Repository<WorkHistory>,

    @InjectRepository(ProjectGroup)
    private readonly projectGroupRepo: Repository<ProjectGroup>,

    @InjectRepository(RevisedProjectGroup)
    private readonly revisedProjectGroupRepo: Repository<RevisedProjectGroup>,

    @InjectRepository(DevelopmentPlan)
    private readonly devPlanRepo: Repository<DevelopmentPlan>,

    @InjectRepository(DevelopmentPlanRevision)
    private readonly devPlanRevisionRepo: Repository<DevelopmentPlanRevision>,

    @InjectRepository(PlanPhase)
    private readonly planPhaseRepo: Repository<PlanPhase>,

    @InjectRepository(DeprecationAuditLog)
    private readonly auditLogRepo: Repository<DeprecationAuditLog>,

    private readonly usersService: UsersService,
    private readonly pdfService: PdfService,
    private readonly websocketService: WebsocketService,
    private readonly fileService: BookAssemblyFileService,
    private readonly dataSource: DataSource,
  ) {}

  // ===========================================================================
  // Draft Management
  // ===========================================================================

  /**
   * Creates a new assembly draft for a source context.
   * Only one active (non-merged) draft per source context (Edge Case #2).
   */
  async createDraft(
    sourceType: BookAssemblySourceType,
    sourceId: string,
    userId: string,
  ): Promise<BookAssemblyDraft> {
    try {
      const workHistory = await this.loadAndValidateWorkHistory(userId, ADMIN_ROLES);

      // Reject if an active draft already exists
      const existingDraft = await this.draftRepo.findOne({
        where: {
          sourceType,
          sourceId,
          assemblyStatus: In([AssemblyDraftStatus.PREPARING, AssemblyDraftStatus.READY]),
        },
      });
      if (existingDraft) {
        throw new ConflictException(
          'มี draft ที่กำลังดำเนินการอยู่แล้วสำหรับแหล่งข้อมูลนี้ กรุณาดำเนินการต่อหรือยกเลิก draft เดิมก่อน',
        );
      }

      // Determine next version number
      const maxVersion = await this.versionRepo
        .createQueryBuilder('v')
        .select('MAX(v.versionNumber)', 'max')
        .where('v.sourceType = :sourceType', { sourceType })
        .andWhere('v.sourceId = :sourceId', { sourceId })
        .getRawOne();
      const targetVersion = (maxVersion?.max ?? 0) + 1;

      // Create folder structure
      this.fileService.createVersionFolders(sourceType, sourceId, targetVersion);

      // Create draft record
      const draft = this.draftRepo.create({
        sourceType,
        sourceId,
        targetVersion,
        previousVersionId: null,
        correctionMode: null,
        correctionReason: null,
        part1Status: PartUploadStatus.PENDING,
        part2Status: PartUploadStatus.PENDING,
        part3Status: PartUploadStatus.PENDING,
        assemblyStatus: AssemblyDraftStatus.PREPARING,
        createdById: workHistory.id,
      });

      const saved = await this.draftRepo.save(draft);
      this.logger.log(
        `Created draft for ${sourceType}/${sourceId} targetVersion=${targetVersion} [draftId=${saved.id}]`,
      );
      return saved;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * Returns the current active (non-merged) draft for a source context, or null.
   */
  async getActiveDraft(
    sourceType: BookAssemblySourceType,
    sourceId: string,
    userId: string,
  ): Promise<BookAssemblyDraft | null> {
    try {
      await this.loadAndValidateWorkHistory(userId, READ_ROLES);

      return await this.draftRepo.findOne({
        where: {
          sourceType,
          sourceId,
          assemblyStatus: In([AssemblyDraftStatus.PREPARING, AssemblyDraftStatus.READY]),
        },
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * Discards an active draft. No version is created. No booking state changes.
   */
  async discardDraft(
    sourceType: BookAssemblySourceType,
    sourceId: string,
    userId: string,
  ): Promise<void> {
    try {
      await this.loadAndValidateWorkHistory(userId, ADMIN_ROLES);

      const draft = await this.loadActiveDraft(sourceType, sourceId);
      await this.draftRepo.remove(draft);
      this.logger.log(`Discarded draft ${draft.id} for ${sourceType}/${sourceId}`);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  // ===========================================================================
  // Part Upload / Generation
  // ===========================================================================

  /**
   * Uploads Part 1 or Part 2 PDF (multipart/form-data).
   * Re-upload replaces previous file (Edge Case #3).
   */
  async uploadPart(
    sourceType: BookAssemblySourceType,
    sourceId: string,
    partNumber: 1 | 2,
    file: Express.Multer.File,
    userId: string,
  ): Promise<BookAssemblyDraft> {
    try {
      const workHistory = await this.loadAndValidateWorkHistory(userId, ADMIN_ROLES);

      if (!file || !file.buffer || file.buffer.length === 0) {
        throw new BadRequestException('กรุณาอัพโหลดไฟล์ PDF');
      }

      // Fix V3: defense-in-depth — validate PDF magic bytes in addition to MIME type
      this.validatePdfContent(file.buffer, file.originalname);

      const draft = await this.loadActiveDraft(sourceType, sourceId);

      // Save file to versioned folder
      const filePath = this.fileService.savePartFile(
        sourceType,
        sourceId,
        draft.targetVersion,
        partNumber,
        file.buffer,
      );

      // Update draft part status
      if (partNumber === 1) {
        draft.part1Status = PartUploadStatus.UPLOADED;
        draft.part1FilePath = filePath;
        draft.part1OriginalFileName = file.originalname;
        draft.part1UploadedAt = new Date();
        draft.part1UploadedById = workHistory.id;
      } else {
        draft.part2Status = PartUploadStatus.UPLOADED;
        draft.part2FilePath = filePath;
        draft.part2OriginalFileName = file.originalname;
        draft.part2UploadedAt = new Date();
        draft.part2UploadedById = workHistory.id;
      }

      // Check readiness
      this.updateAssemblyStatus(draft);

      return await this.draftRepo.save(draft);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * Generates Part 3 (project listing PDF) from approved projects.
   * Queries approved projects based on source context.
   */
  async generatePart3(
    sourceType: BookAssemblySourceType,
    sourceId: string,
    userId: string,
  ): Promise<BookAssemblyDraft> {
    try {
      await this.loadAndValidateWorkHistory(userId, ADMIN_ROLES);
      const draft = await this.loadActiveDraft(sourceType, sourceId);

      // Send progress
      await this.notifyProgress(userId, sourceId, 10, 'starting', 'กำลังเริ่มสร้างส่วนที่ 3...');

      // Query approved projects
      const { projects, projectIds } = await this.queryApprovedProjects(sourceType, sourceId);

      if (projects.length === 0) {
        throw new BadRequestException(
          'ไม่พบโครงการที่อนุมัติแล้วสำหรับแหล่งข้อมูลนี้ (Edge Case #7)',
        );
      }

      await this.notifyProgress(userId, sourceId, 30, 'preparing', `กำลังเตรียมข้อมูล ${projects.length} โครงการ...`);
      await this.notifyProgress(userId, sourceId, 40, 'generating', 'กำลังสร้างไฟล์ PDF ส่วนที่ 3...');

      // Generate PDF with page tracking
      let pdfResult: { buffer: Buffer; pageMap: Map<string, number> };

      if (sourceType === BookAssemblySourceType.MAIN_PLAN) {
        pdfResult = await this.pdfService.generateProjectReportWithPageTracking(
          projects,
          ['index', 'title', 'objective', 'target', 'budget', 'expectedResult', 'mainAgency'],
          { developmentPlanId: sourceId },
        );
      } else {
        pdfResult = await this.pdfService.generateRevisionApprovedReportWithPageTracking(
          sourceId,
          ['index', 'title', 'objective', 'target', 'budget', 'expectedResult', 'mainAgency'],
        );
      }

      await this.notifyProgress(userId, sourceId, 70, 'generated', 'สร้างไฟล์ PDF ส่วนที่ 3 สำเร็จ');

      // Save to versioned folder
      const filePath = this.fileService.savePartFile(
        sourceType,
        sourceId,
        draft.targetVersion,
        3,
        pdfResult.buffer,
      );

      // Update draft
      draft.part3Status = PartUploadStatus.GENERATED;
      draft.part3FilePath = filePath;
      draft.part3GeneratedAt = new Date();
      draft.part3ProjectSnapshot = projectIds;
      // Fix D2: persist pageMap so merge() can assign pageNumber per project
      draft.part3PageMap = Object.fromEntries(pdfResult.pageMap);

      this.updateAssemblyStatus(draft);

      const saved = await this.draftRepo.save(draft);
      await this.notifyProgress(userId, sourceId, 100, 'completed', 'สร้างส่วนที่ 3 สำเร็จแล้ว!');
      return saved;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * Reuses a part from a specified previous version (copies file — Spec Section 13.1).
   */
  async reusePart(
    sourceType: BookAssemblySourceType,
    sourceId: string,
    partNumber: 1 | 2 | 3,
    fromVersionNumber: number,
    userId: string,
  ): Promise<BookAssemblyDraft> {
    try {
      const workHistory = await this.loadAndValidateWorkHistory(userId, ADMIN_ROLES);
      const draft = await this.loadActiveDraft(sourceType, sourceId);

      // Verify the source version exists
      const sourceVersion = await this.versionRepo.findOne({
        where: { sourceType, sourceId, versionNumber: fromVersionNumber },
      });
      if (!sourceVersion) {
        throw new NotFoundException(
          `ไม่พบเวอร์ชัน v${fromVersionNumber} สำหรับ ${sourceType}/${sourceId}`,
        );
      }

      // Copy the file
      const copiedPath = this.fileService.copyPartFromVersion(
        sourceType,
        sourceId,
        fromVersionNumber,
        draft.targetVersion,
        partNumber,
      );

      // Update draft part status
      if (partNumber === 1) {
        draft.part1Status = PartUploadStatus.REUSED;
        draft.part1FilePath = copiedPath;
        draft.part1OriginalFileName = sourceVersion.part1OriginalFileName;
        draft.part1UploadedAt = new Date();
        draft.part1UploadedById = workHistory.id;
      } else if (partNumber === 2) {
        draft.part2Status = PartUploadStatus.REUSED;
        draft.part2FilePath = copiedPath;
        draft.part2OriginalFileName = sourceVersion.part2OriginalFileName;
        draft.part2UploadedAt = new Date();
        draft.part2UploadedById = workHistory.id;
      } else {
        draft.part3Status = PartUploadStatus.REUSED;
        draft.part3FilePath = copiedPath;
        draft.part3GeneratedAt = new Date();
        // Carry over the project snapshot and pageMap from the reused version
        draft.part3ProjectSnapshot = sourceVersion.part3ProjectSnapshot;
        // Fix D2: carry pageMap so merge() can assign pageNumber
        draft.part3PageMap = sourceVersion.part3PageMap ?? null;
      }

      this.updateAssemblyStatus(draft);
      return await this.draftRepo.save(draft);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  // ===========================================================================
  // Preview & Merge
  // ===========================================================================

  /**
   * Preview merged PDF. Read-only — no state changes, no version creation (Spec Section 4.3).
   * Returns the merged buffer for streaming.
   */
  async preview(
    sourceType: BookAssemblySourceType,
    sourceId: string,
    userId: string,
  ): Promise<Buffer> {
    try {
      await this.loadAndValidateWorkHistory(userId, ADMIN_ROLES);
      const draft = await this.loadActiveDraft(sourceType, sourceId);

      if (draft.assemblyStatus !== AssemblyDraftStatus.READY) {
        throw new BadRequestException(
          'ยังไม่สามารถดูตัวอย่างได้ กรุณาเตรียมส่วนที่ 1, 2 และ 3 ให้เรียบร้อยก่อน',
        );
      }

      const part1 = this.fileService.readPartFile(sourceType, sourceId, draft.targetVersion, 1);
      const part2 = this.fileService.readPartFile(sourceType, sourceId, draft.targetVersion, 2);
      const part3 = this.fileService.readPartFile(sourceType, sourceId, draft.targetVersion, 3);

      return await this.mergePdfBuffers([part1, part2, part3]);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * Returns the absolute file path for an individual draft part (for inline preview).
   * Read-only — no state changes.
   */
  async getDraftPartFile(
    sourceType: BookAssemblySourceType,
    sourceId: string,
    partNumber: 1 | 2 | 3,
    userId: string,
  ): Promise<{ absPath: string; filename: string }> {
    try {
      await this.loadAndValidateWorkHistory(userId, READ_ROLES);

      const draft = await this.draftRepo.findOne({
        where: {
          sourceType,
          sourceId,
          assemblyStatus: In([AssemblyDraftStatus.PREPARING, AssemblyDraftStatus.READY]),
        },
      });
      if (!draft) {
        throw new NotFoundException('ไม่พบ draft ที่กำลังดำเนินการ');
      }

      const filePath =
        partNumber === 1 ? draft.part1FilePath :
        partNumber === 2 ? draft.part2FilePath :
        draft.part3FilePath;

      if (!filePath) {
        throw new NotFoundException('ไม่พบไฟล์สำหรับส่วนนี้');
      }

      this.fileService.assertPathWithinStorageRoot(filePath);

      if (!fs.existsSync(filePath)) {
        throw new NotFoundException('ไม่พบไฟล์บนระบบ');
      }

      return { absPath: filePath, filename: `draft-part-${partNumber}.pdf` };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * Execute merge — creates a version, updates booking state (Spec Section 4.1 Step 6).
   * CRITICAL: all mutations in a single transaction.
   */
  async merge(
    sourceType: BookAssemblySourceType,
    sourceId: string,
    userId: string,
  ): Promise<BookAssemblyVersion> {
    try {
      const workHistory = await this.loadAndValidateWorkHistory(userId, ADMIN_ROLES);

      return await this.dataSource.transaction(async (manager) => {
        // 1. Load and validate draft
        const draft = await manager.findOne(BookAssemblyDraft, {
          where: {
            sourceType,
            sourceId,
            assemblyStatus: AssemblyDraftStatus.READY,
          },
        });
        if (!draft) {
          throw new BadRequestException(
            'ไม่พบ draft ที่พร้อมรวมเล่ม กรุณาเตรียมส่วนที่ 1, 2 และ 3 ให้ครบถ้วนก่อน',
          );
        }

        await this.notifyProgress(userId, sourceId, 10, 'starting', 'กำลังเริ่มรวมเล่ม...');

        // 2. Read all 3 part files
        const part1 = this.fileService.readPartFile(sourceType, sourceId, draft.targetVersion, 1);
        const part2 = this.fileService.readPartFile(sourceType, sourceId, draft.targetVersion, 2);
        const part3 = this.fileService.readPartFile(sourceType, sourceId, draft.targetVersion, 3);

        await this.notifyProgress(userId, sourceId, 30, 'merging', 'กำลังรวมไฟล์ PDF...');

        // 3. Merge PDFs
        const mergedBuffer = await this.mergePdfBuffers([part1, part2, part3]);
        const mergedPdf = await PDFDocument.load(mergedBuffer);
        const totalPages = mergedPdf.getPageCount();

        // 4. Save merged PDF
        const mergedFilePath = this.fileService.saveMergedFile(
          sourceType, sourceId, draft.targetVersion, mergedBuffer,
        );

        await this.notifyProgress(userId, sourceId, 50, 'booking', 'กำลังจองโครงการ...');

        // Fix D1: validation guard — pageMap must exist for merge
        if (!draft.part3PageMap || Object.keys(draft.part3PageMap).length === 0) {
          throw new InternalServerErrorException(
            'ไม่พบข้อมูล pageMap สำหรับการรวมเล่ม กรุณาสร้างส่วนที่ 3 ใหม่',
          );
        }

        // 5. Update project booking state — Fix D1: assign pageNumber per project
        const projectIds = draft.part3ProjectSnapshot ?? [];
        const pageMap = draft.part3PageMap;

        if (projectIds.length > 0) {
          const repo = sourceType === BookAssemblySourceType.MAIN_PLAN
            ? manager.getRepository(ProjectGroup)
            : manager.getRepository(RevisedProjectGroup);

          for (const projectId of projectIds) {
            await repo.update(
              { id: projectId },
              {
                isBooked: true,
                bookedAt: new Date(),
                pageNumber: pageMap[projectId] ?? null,
              },
            );
          }
        }

        // 6. Update plan state
        if (sourceType === BookAssemblySourceType.MAIN_PLAN) {
          await manager.getRepository(DevelopmentPlan).update(
            { id: sourceId },
            { isBooked: true },
          );
          // 7. PlanPhase.isMerged = true (main plan only — Edge Case #12)
          await manager.getRepository(PlanPhase).update(
            { developmentPlan: { id: sourceId } },
            { isMerged: true },
          );
        } else {
          await manager.getRepository(DevelopmentPlanRevision).update(
            { id: sourceId },
            { isBooked: true },
          );
        }

        await this.notifyProgress(userId, sourceId, 70, 'saving', 'กำลังบันทึกข้อมูล...');

        // 8. Create BookAssemblyVersion record
        // Assert non-null: all part file paths must be set when assembly status = ready
        const versionData: Partial<BookAssemblyVersion> = {
          sourceType,
          sourceId,
          versionNumber: draft.targetVersion,
          status: BookAssemblyVersionStatus.COMPLETED,
          correctionMode: draft.correctionMode,
          correctionReason: draft.correctionReason,
          part1FilePath: draft.part1FilePath!,
          part1Source: this.toPartSource(draft.part1Status),
          part1OriginalFileName: draft.part1OriginalFileName,
          part2FilePath: draft.part2FilePath!,
          part2Source: this.toPartSource(draft.part2Status),
          part2OriginalFileName: draft.part2OriginalFileName,
          part3FilePath: draft.part3FilePath!,
          part3Source: this.toPartSource(draft.part3Status),
          part3ProjectSnapshot: draft.part3ProjectSnapshot ?? [],
          part3ProjectCount: projectIds.length,
          // Fix D2: persist pageMap on version for future Part 3 reuse
          part3PageMap: draft.part3PageMap,
          mergedFilePath,
          mergedAt: new Date(),
          totalPages,
          createdById: workHistory.id,
        };
        const version = manager.create(BookAssemblyVersion, versionData);
        const savedVersion = await manager.save(BookAssemblyVersion, version);

        // 9. Mark draft as merged
        draft.assemblyStatus = AssemblyDraftStatus.MERGED;
        await manager.save(BookAssemblyDraft, draft);

        // 10. Write metadata.json (non-transactional file write — OK since DB is committed)
        this.writeVersionMetadata(draft, savedVersion);

        await this.notifyProgress(userId, sourceId, 100, 'completed', 'รวมเล่มสำเร็จแล้ว!');

        this.logger.log(
          `Merged v${draft.targetVersion} for ${sourceType}/${sourceId} ` +
          `[versionId=${savedVersion.id}, projects=${projectIds.length}, pages=${totalPages}]`,
        );

        // Reload with relations so DTO can include createdBy user name
        const fullVersion = await manager.findOne(BookAssemblyVersion, {
          where: { id: savedVersion.id },
          relations: ['createdBy', 'createdBy.user'],
        });
        return fullVersion ?? savedVersion;
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  // ===========================================================================
  // Cancellation
  // ===========================================================================

  /**
   * Cancel (deprecate) the current completed version + full booking reset + reopen plan.
   * Spec Section 7.
   */
  async cancel(
    sourceType: BookAssemblySourceType,
    sourceId: string,
    dto: CancelBookDto,
    userId: string,
  ): Promise<void> {
    const audit = this.buildAuditSkeleton(sourceType, sourceId);

    try {
      await this.dataSource.transaction(async (manager) => {
        // 1-4. Validate operator (role, workStatus, confirmation, identity)
        const { workHistory, identityMasked } = await this.validateDeprecationAuth(
          dto.confirmed,
          dto.citizenIdSuffix,
          dto.reason,
          userId,
          audit,
          manager,
        );

        // 5. Load current completed version with lock
        const currentVersion = await this.loadCompletedVersionForUpdate(
          sourceType, sourceId, audit, manager,
        );

        // 6. Deprecate
        await manager.update(BookAssemblyVersion, currentVersion.id, {
          status: BookAssemblyVersionStatus.DEPRECATED,
          deprecatedAt: new Date(),
          deprecatedById: workHistory.id,
          deprecationReason: dto.reason,
        });

        // 7. Reset project booking
        await this.resetProjectBooking(sourceType, currentVersion.part3ProjectSnapshot, manager);

        // 8. Reset plan state + reopen
        await this.resetPlanState(sourceType, sourceId, manager);

        // 9. Reset PlanPhase.isMerged (main plan only — Edge Case #12)
        if (sourceType === BookAssemblySourceType.MAIN_PLAN) {
          await manager.getRepository(PlanPhase).update(
            { developmentPlan: { id: sourceId } },
            { isMerged: false },
          );
        }

        // 10. Write SUCCESS audit in same transaction
        audit.action = DeprecationAuditAction.SUCCESS;
        audit.reason = dto.reason;
        audit.identityVerified = true;
        audit.identityMasked = identityMasked;
        audit.operatorWorkHistoryId = workHistory.id;
        audit.operatorRole = workHistory.role?.name;
        await manager.save(DeprecationAuditLog, this.buildAuditEntity(audit, currentVersion.id));

        this.logger.log(
          `Cancelled v${currentVersion.versionNumber} for ${sourceType}/${sourceId} by user ${userId}`,
        );
      });
    } catch (error) {
      // Persist FAILURE audit in separate transaction
      await this.persistFailedAudit(audit);
      handleException(this.logger, error);
    }
  }

  // ===========================================================================
  // Correction
  // ===========================================================================

  /**
   * Correct current version — deprecate + create draft for next version.
   * Mode determines whether project booking is reset (Spec Section 8).
   */
  async correct(
    sourceType: BookAssemblySourceType,
    sourceId: string,
    dto: CorrectBookDto,
    userId: string,
  ): Promise<BookAssemblyDraft> {
    // Validate correction mode is not cancellation (that uses the /cancel endpoint)
    if (dto.correctionMode === CorrectionMode.CANCELLATION) {
      throw new BadRequestException(
        'ใช้ endpoint /cancel สำหรับการยกเลิกเล่ม ไม่ใช่ /correct',
      );
    }

    const audit = this.buildAuditSkeleton(sourceType, sourceId);

    try {
      return await this.dataSource.transaction(async (manager) => {
        // 1-4. Validate operator
        const { workHistory, identityMasked } = await this.validateDeprecationAuth(
          dto.confirmed,
          dto.citizenIdSuffix,
          dto.reason,
          userId,
          audit,
          manager,
        );

        // 5. Load current completed version with lock
        const currentVersion = await this.loadCompletedVersionForUpdate(
          sourceType, sourceId, audit, manager,
        );

        // 6. Deprecate current version
        await manager.update(BookAssemblyVersion, currentVersion.id, {
          status: BookAssemblyVersionStatus.DEPRECATED,
          deprecatedAt: new Date(),
          deprecatedById: workHistory.id,
          deprecationReason: dto.reason,
        });

        const isFullReset = dto.correctionMode === CorrectionMode.CORRECTION_PART3;

        // 7. Conditionally reset (Part 3 correction = full reset, Part 1/2 = no reset)
        if (isFullReset) {
          await this.resetProjectBooking(sourceType, currentVersion.part3ProjectSnapshot, manager);
          await this.resetPlanState(sourceType, sourceId, manager);
          if (sourceType === BookAssemblySourceType.MAIN_PLAN) {
            await manager.getRepository(PlanPhase).update(
              { developmentPlan: { id: sourceId } },
              { isMerged: false },
            );
          }
        }

        // 8. Create new draft
        const nextVersion = currentVersion.versionNumber + 1;
        this.fileService.createVersionFolders(sourceType, sourceId, nextVersion);

        const draft = manager.create(BookAssemblyDraft, {
          sourceType,
          sourceId,
          targetVersion: nextVersion,
          previousVersionId: currentVersion.id,
          correctionMode: dto.correctionMode,
          correctionReason: dto.reason,
          part1Status: PartUploadStatus.PENDING,
          part2Status: PartUploadStatus.PENDING,
          part3Status: PartUploadStatus.PENDING,
          assemblyStatus: AssemblyDraftStatus.PREPARING,
          createdById: workHistory.id,
        });

        // 9. Auto-reuse parts that are NOT being corrected
        const correctingPart = dto.correctionMode === CorrectionMode.CORRECTION_PART1 ? 1
          : dto.correctionMode === CorrectionMode.CORRECTION_PART2 ? 2
          : 3; // CORRECTION_PART3

        for (const pn of [1, 2, 3] as const) {
          if (pn === correctingPart) continue; // User must upload/generate this part fresh
          if (pn === 3 && isFullReset) continue; // Part 3 must be regenerated on full reset

          try {
            const copiedPath = this.fileService.copyPartFromVersion(
              sourceType, sourceId, currentVersion.versionNumber, nextVersion, pn,
            );
            if (pn === 1) {
              draft.part1Status = PartUploadStatus.REUSED;
              draft.part1FilePath = copiedPath;
              draft.part1OriginalFileName = currentVersion.part1OriginalFileName;
              draft.part1UploadedAt = new Date();
              draft.part1UploadedById = workHistory.id;
            } else if (pn === 2) {
              draft.part2Status = PartUploadStatus.REUSED;
              draft.part2FilePath = copiedPath;
              draft.part2OriginalFileName = currentVersion.part2OriginalFileName;
              draft.part2UploadedAt = new Date();
              draft.part2UploadedById = workHistory.id;
            } else {
              draft.part3Status = PartUploadStatus.REUSED;
              draft.part3FilePath = copiedPath;
              draft.part3GeneratedAt = new Date();
              draft.part3ProjectSnapshot = currentVersion.part3ProjectSnapshot;
              // Fix D2: carry pageMap so merge() can assign pageNumber
              draft.part3PageMap = currentVersion.part3PageMap ?? null;
            }
          } catch (copyError) {
            this.logger.warn(
              `Failed to reuse part-${pn} from v${currentVersion.versionNumber}: ${copyError?.message}`,
            );
            // Part stays PENDING — user must provide it
          }
        }

        this.updateAssemblyStatus(draft);
        const savedDraft = await manager.save(BookAssemblyDraft, draft);

        // 10. Write SUCCESS audit in same transaction
        audit.action = DeprecationAuditAction.SUCCESS;
        audit.reason = dto.reason;
        audit.identityVerified = true;
        audit.identityMasked = identityMasked;
        audit.operatorWorkHistoryId = workHistory.id;
        audit.operatorRole = workHistory.role?.name;
        await manager.save(DeprecationAuditLog, this.buildAuditEntity(audit, currentVersion.id));

        this.logger.log(
          `Correction initiated: ${sourceType}/${sourceId} v${currentVersion.versionNumber} → ` +
          `draft v${nextVersion} [mode=${dto.correctionMode}]`,
        );

        return savedDraft;
      });
    } catch (error) {
      await this.persistFailedAudit(audit);
      handleException(this.logger, error);
    }
  }

  // ===========================================================================
  // Version History & Downloads
  // ===========================================================================

  /**
   * List all versions for a source context, newest first (Spec Section 14.4).
   */
  async getVersions(
    sourceType: BookAssemblySourceType,
    sourceId: string,
    userId: string,
  ): Promise<VersionResponseDto[]> {
    try {
      await this.loadAndValidateWorkHistory(userId, READ_ROLES);

      const versions = await this.versionRepo.find({
        where: { sourceType, sourceId },
        order: { versionNumber: 'DESC' },
        relations: ['createdBy', 'createdBy.user'],
      });

      const appUrl = process.env.APP_URL ?? '';
      return versions.map((v) => VersionResponseDto.fromEntity(v, appUrl));
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * Get a specific version by number.
   */
  async getVersionByNumber(
    sourceType: BookAssemblySourceType,
    sourceId: string,
    versionNumber: number,
    userId: string,
  ): Promise<VersionResponseDto> {
    try {
      await this.loadAndValidateWorkHistory(userId, READ_ROLES);

      const version = await this.versionRepo.findOne({
        where: { sourceType, sourceId, versionNumber },
        relations: ['createdBy', 'createdBy.user'],
      });
      if (!version) {
        throw new NotFoundException(
          `ไม่พบเวอร์ชัน v${versionNumber} สำหรับ ${sourceType}/${sourceId}`,
        );
      }

      const appUrl = process.env.APP_URL ?? '';
      return VersionResponseDto.fromEntity(version, appUrl);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * Get the current completed version (or 404 if none).
   */
  async getCurrentVersion(
    sourceType: BookAssemblySourceType,
    sourceId: string,
    userId: string,
  ): Promise<VersionResponseDto> {
    try {
      await this.loadAndValidateWorkHistory(userId, READ_ROLES);

      const version = await this.versionRepo.findOne({
        where: { sourceType, sourceId, status: BookAssemblyVersionStatus.COMPLETED },
        relations: ['createdBy', 'createdBy.user'],
      });
      if (!version) {
        throw new NotFoundException(
          `ไม่มีเวอร์ชันที่เสร็จสมบูรณ์สำหรับ ${sourceType}/${sourceId}`,
        );
      }

      const appUrl = process.env.APP_URL ?? '';
      return VersionResponseDto.fromEntity(version, appUrl);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * Returns the absolute path to the merged PDF for streaming.
   */
  getMergedPdfPath(
    sourceType: BookAssemblySourceType,
    sourceId: string,
    versionNumber: number,
  ): string {
    return this.fileService.getAbsoluteMergedPath(sourceType, sourceId, versionNumber);
  }

  /**
   * Returns the absolute path to an individual part PDF for streaming.
   */
  getPartPdfPath(
    sourceType: BookAssemblySourceType,
    sourceId: string,
    versionNumber: number,
    partNumber: number,
  ): string {
    return this.fileService.getAbsolutePartPath(sourceType, sourceId, versionNumber, partNumber);
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  /**
   * Loads and validates the operator's WorkHistory.
   */
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

  /**
   * Fix V3: Validates that a buffer starts with the PDF magic bytes (%PDF-).
   * Defense-in-depth: MIME type can be spoofed; magic bytes are harder to fake.
   */
  private validatePdfContent(buffer: Buffer, filename: string): void {
    const pdfMagicBytes = Buffer.from('%PDF-');
    if (buffer.length < 5 || !buffer.subarray(0, 5).equals(pdfMagicBytes)) {
      throw new BadRequestException(
        `ไฟล์ "${filename}" ไม่ใช่เอกสาร PDF ที่ถูกต้อง`,
      );
    }
  }

  /**
   * Loads an active (non-merged) draft or throws.
   */
  private async loadActiveDraft(
    sourceType: BookAssemblySourceType,
    sourceId: string,
  ): Promise<BookAssemblyDraft> {
    const draft = await this.draftRepo.findOne({
      where: {
        sourceType,
        sourceId,
        assemblyStatus: In([AssemblyDraftStatus.PREPARING, AssemblyDraftStatus.READY]),
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
   * Checks whether all 3 parts are ready and updates `assemblyStatus` accordingly.
   */
  private updateAssemblyStatus(draft: BookAssemblyDraft): void {
    const part1Ready = draft.part1Status !== PartUploadStatus.PENDING;
    const part2Ready = draft.part2Status !== PartUploadStatus.PENDING;
    const part3Ready = draft.part3Status !== PartUploadStatus.PENDING;

    if (part1Ready && part2Ready && part3Ready) {
      draft.assemblyStatus = AssemblyDraftStatus.READY;
    } else if (draft.assemblyStatus === AssemblyDraftStatus.READY) {
      // A re-upload of one part while others are still ready? Keep READY.
      // But if a part reverted to pending, go back to PREPARING.
      draft.assemblyStatus = AssemblyDraftStatus.PREPARING;
    }
  }

  /**
   * Converts a draft PartUploadStatus to the version's PartSource enum.
   */
  private toPartSource(status: PartUploadStatus): PartSource {
    switch (status) {
      case PartUploadStatus.UPLOADED:
        return PartSource.UPLOADED;
      case PartUploadStatus.GENERATED:
        return PartSource.GENERATED;
      case PartUploadStatus.REUSED:
        return PartSource.REUSED;
      default:
        return PartSource.UPLOADED; // fallback
    }
  }

  /**
   * Queries approved projects for Part 3 generation.
   */
  private async queryApprovedProjects(
    sourceType: BookAssemblySourceType,
    sourceId: string,
  ): Promise<{ projects: any[]; projectIds: string[] }> {
    if (sourceType === BookAssemblySourceType.MAIN_PLAN) {
      const rows = await this.projectGroupRepo
        .createQueryBuilder('pg')
        .leftJoinAndSelect('pg.createdBy', 'createdBy')
        .leftJoinAndSelect('createdBy.user', 'createdByUser')
        .leftJoinAndSelect('createdBy.amphoe', 'amphoe')
        .leftJoinAndSelect('createdBy.localAdministrativeOrganization', 'lao')
        .leftJoinAndSelect('pg.strategy', 'strategy')
        .leftJoinAndSelect('pg.tactic', 'tactic')
        .leftJoinAndSelect('pg.plan', 'plan')
        .leftJoinAndSelect('pg.developmentPlan', 'developmentPlan')
        .leftJoinAndSelect('pg.budgets', 'budgets')
        .leftJoinAndSelect('pg.trackingStatus', 'ts')
        .leftJoinAndSelect('ts.statusId', 'status')
        .leftJoinAndSelect('pg.responsibleAgency', 'responsibleAgency')
        .leftJoinAndSelect('pg.originAgencyId', 'originAgencyId')
        .leftJoinAndSelect('originAgencyId.amphoe', 'originAgencyAmphoe')
        .leftJoinAndSelect('pg.revisedProjectGroups', 'rpg')
        .where('pg.developmentPlan.id = :sourceId', { sourceId })
        .andWhere('pg.responsibleAgency IS NOT NULL')
        .andWhere('pg.isBooked = :isBooked', { isBooked: false })
        .andWhere('pg.isDraft = :isDraft', { isDraft: false })
        .andWhere('pg.deletedAt IS NULL')
        .andWhere('ts.isLatest = :isLatest', { isLatest: true })
        .andWhere('status.name = :statusName', { statusName: 'Approved' })
        .andWhere('rpg.id IS NULL')
        .orderBy('strategy.id', 'ASC')
        .getMany();

      const projects = rows.map((p) => UnifiedProjectMapper.fromProjectGroup(p));
      const projectIds = projects.map((p) => p.id);
      return { projects, projectIds };
    } else {
      // edit_revision or change_revision
      const rows = await this.revisedProjectGroupRepo
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
        .leftJoinAndSelect('rp.budgets', 'budgets')
        .leftJoinAndSelect('rp.trackingStatus', 'ts')
        .leftJoinAndSelect('ts.statusId', 'status')
        .leftJoinAndSelect('rp.responsibleAgency', 'responsibleAgency')
        .leftJoinAndSelect('rp.originAgencyId', 'originAgencyId')
        .leftJoinAndSelect('originAgencyId.amphoe', 'originAgencyAmphoe')
        .where('dpr.id = :sourceId', { sourceId })
        .andWhere('rp.responsibleAgency IS NOT NULL')
        .andWhere('rp.isBooked = :isBooked', { isBooked: false })
        .andWhere('ts.isLatest = :isLatest', { isLatest: true })
        .andWhere('status.name = :statusName', { statusName: 'Approved' })
        .andWhere('rp.deletedAt IS NULL')
        .orderBy('strategy.id', 'ASC')
        .getMany();

      const projects = rows.map((p) => UnifiedProjectMapper.fromRevisedProjectGroup(p));
      const projectIds = projects.map((p) => p.id);
      return { projects, projectIds };
    }
  }

  /**
   * Resets project booking flags for all projects in the version snapshot.
   */
  private async resetProjectBooking(
    sourceType: BookAssemblySourceType,
    projectIds: string[],
    manager: any,
  ): Promise<void> {
    if (!projectIds || projectIds.length === 0) return;

    if (sourceType === BookAssemblySourceType.MAIN_PLAN) {
      await manager.getRepository(ProjectGroup).update(
        { id: In(projectIds) },
        { isBooked: false, bookedAt: null, pageNumber: null },
      );
    } else {
      await manager.getRepository(RevisedProjectGroup).update(
        { id: In(projectIds) },
        { isBooked: false, bookedAt: null, pageNumber: null },
      );
    }
  }

  /**
   * Resets plan state (isBooked = false) and reopens (isOpen = true for revision).
   */
  private async resetPlanState(
    sourceType: BookAssemblySourceType,
    sourceId: string,
    manager: any,
  ): Promise<void> {
    if (sourceType === BookAssemblySourceType.MAIN_PLAN) {
      await manager.getRepository(DevelopmentPlan).update(
        { id: sourceId },
        { isBooked: false },
      );
    } else {
      await manager.getRepository(DevelopmentPlanRevision).update(
        { id: sourceId },
        { isBooked: false, isOpen: true },
      );
    }
  }

  /**
   * Validates all deprecation authorization steps (Spec Section 11.3).
   * Steps: role check, confirmation, identity verification.
   * Returns the validated workHistory and masked identity string.
   */
  private async validateDeprecationAuth(
    confirmed: boolean,
    citizenIdSuffix: string,
    reason: string,
    userId: string,
    audit: Record<string, any>,
    manager: any,
  ): Promise<{ workHistory: WorkHistory; identityMasked: string }> {
    // 1. Load WorkHistory + validate workStatus
    const workHistory = await manager.findOne(WorkHistory, {
      where: { user: { id: userId }, isCurrent: true },
      relations: ['role', 'workStatus'],
    });
    if (!workHistory) {
      audit.failureReason = 'WorkHistory not found';
      throw new NotFoundException(`WorkHistory not found for user ${userId}`);
    }
    audit.operatorWorkHistoryId = workHistory.id;
    audit.operatorRole = workHistory.role?.name;

    if (workHistory.workStatus?.name !== 'approved') {
      audit.failureReason = 'workStatus is not approved';
      throw new UnauthorizedException(
        'คุณยังไม่ได้รับสิทธิ์ในการดำเนินการ (workStatus ต้องเป็น approved)',
      );
    }

    // 2. Role check
    if (!ADMIN_ROLES.includes(workHistory.role?.name)) {
      audit.failureReason = `Role '${workHistory.role?.name}' is not permitted`;
      throw new ForbiddenException(
        'เฉพาะ admin หรือ super-admin เท่านั้นที่สามารถดำเนินการนี้ได้',
      );
    }

    // 3. Explicit confirmation
    if (!confirmed) {
      audit.failureReason = 'Explicit confirmation was not provided';
      throw new BadRequestException('กรุณายืนยันการดำเนินการ (confirmed = true)');
    }

    // 4. Identity verification retry lock
    this.assertIdentityNotLocked(userId);

    // 5. Identity verification
    const user = await this.usersService.findOne(userId);
    if (!user?.citizenId) {
      audit.failureReason = 'Citizen ID not found for operator';
      throw new UnauthorizedException('ไม่พบข้อมูลบัตรประชาชนของผู้ดำเนินการ');
    }

    const actualSuffix = user.citizenId.slice(-6);
    const maskedSuffix = `****${citizenIdSuffix.slice(-2)}`;

    if (actualSuffix !== citizenIdSuffix) {
      audit.identityVerified = false;
      audit.identityMasked = maskedSuffix;
      audit.failureReason = 'Citizen ID suffix mismatch';
      this.recordIdentityFailure(userId);
      throw new UnauthorizedException('รหัสบัตรประชาชน 6 หลักสุดท้ายไม่ถูกต้อง');
    }

    // Success — clear retry counter
    audit.identityVerified = true;
    audit.identityMasked = maskedSuffix;
    this.identityAttempts.delete(userId);

    return { workHistory, identityMasked: maskedSuffix };
  }

  /**
   * Loads the current COMPLETED version with pessimistic write lock.
   */
  private async loadCompletedVersionForUpdate(
    sourceType: BookAssemblySourceType,
    sourceId: string,
    audit: Record<string, any>,
    manager: any,
  ): Promise<BookAssemblyVersion> {
    const version = await manager.findOne(BookAssemblyVersion, {
      where: { sourceType, sourceId, status: BookAssemblyVersionStatus.COMPLETED },
      lock: { mode: 'pessimistic_write' },
    });
    if (!version) {
      audit.failureReason = 'No completed version found';
      throw new NotFoundException(
        'ไม่พบเวอร์ชันที่เสร็จสมบูรณ์สำหรับ source นี้',
      );
    }
    audit.versionId = version.id;
    return version;
  }

  // ---------------------------------------------------------------------------
  // Identity verification retry tracking
  // ---------------------------------------------------------------------------

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
        `Identity verification locked for user ${userId} after ${record.count} failed attempts`,
      );
    }
    this.identityAttempts.set(userId, record);
  }

  // ---------------------------------------------------------------------------
  // Audit helpers
  // ---------------------------------------------------------------------------

  private buildAuditSkeleton(
    sourceType: BookAssemblySourceType,
    sourceId: string,
  ): Record<string, any> {
    return {
      action: DeprecationAuditAction.FAILED,
      versionId: null,
      sourceType,
      sourceId,
      operatorWorkHistoryId: null,
      operatorRole: null,
      identityVerified: false,
      identityMasked: null,
      reason: null,
      failureReason: null,
    };
  }

  private buildAuditEntity(audit: Record<string, any>, versionId: string): Partial<DeprecationAuditLog> {
    return {
      action: audit.action,
      versionId: versionId ?? audit.versionId,
      sourceType: audit.sourceType,
      sourceId: audit.sourceId,
      operatorWorkHistoryId: audit.operatorWorkHistoryId,
      operatorRole: audit.operatorRole,
      identityVerified: audit.identityVerified,
      identityMasked: audit.identityMasked,
      reason: audit.reason,
      failureReason: audit.failureReason,
    };
  }

  /**
   * Persists a FAILED audit record in a separate transaction (fault-tolerant).
   */
  private async persistFailedAudit(audit: Record<string, any>): Promise<void> {
    try {
      // Only persist if we have enough context
      if (!audit.sourceType || !audit.sourceId) return;

      await this.dataSource.transaction(async (manager) => {
        await manager.save(DeprecationAuditLog, {
          action: DeprecationAuditAction.FAILED,
          versionId: audit.versionId ?? '00000000-0000-0000-0000-000000000000', // placeholder if unknown
          sourceType: audit.sourceType,
          sourceId: audit.sourceId,
          operatorWorkHistoryId: audit.operatorWorkHistoryId ?? '00000000-0000-0000-0000-000000000000',
          operatorRole: audit.operatorRole ?? 'unknown',
          identityVerified: audit.identityVerified ?? false,
          identityMasked: audit.identityMasked ?? null,
          reason: audit.reason ?? null,
          failureReason: audit.failureReason ?? null,
        });
      });
    } catch (auditError) {
      this.logger.error(
        `CRITICAL: Failed to persist failure audit: ${auditError?.message}`,
        auditError?.stack,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // PDF merge (internal — pdf-lib)
  // ---------------------------------------------------------------------------

  /**
   * Merges multiple PDF buffers into one.
   * Uses pdf-lib directly (PdfService.mergePdfBuffers is private).
   */
  private async mergePdfBuffers(buffers: Buffer[]): Promise<Buffer> {
    if (buffers.length === 0) throw new Error('No PDF buffers provided for merging');
    if (buffers.length === 1) return buffers[0];
    const mergedPdf = await PDFDocument.create();
    for (const buffer of buffers) {
      const pdf = await PDFDocument.load(buffer);
      const copiedPages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
      copiedPages.forEach((page) => mergedPdf.addPage(page));
    }
    const mergedBytes = await mergedPdf.save();
    return Buffer.from(mergedBytes);
  }

  // ---------------------------------------------------------------------------
  // WebSocket + Metadata
  // ---------------------------------------------------------------------------

  private async notifyProgress(
    userId: string,
    sourceId: string,
    percentage: number,
    stage: string,
    message: string,
  ): Promise<void> {
    try {
      await this.websocketService.notifyPdfGenerationProgress({
        userId,
        developmentPlanId: sourceId,
        progress: { percentage, stage, message },
      });
    } catch {
      // Non-fatal
    }
  }

  private writeVersionMetadata(draft: BookAssemblyDraft, version: BookAssemblyVersion): void {
    try {
      const metadata = {
        version: version.versionNumber,
        sourceType: version.sourceType,
        sourceId: version.sourceId,
        status: version.status,
        correctionMode: version.correctionMode,
        correctionReason: version.correctionReason,
        parts: {
          part1: {
            source: version.part1Source,
            originalFileName: version.part1OriginalFileName,
            uploadedBy: draft.part1UploadedById,
            uploadedAt: draft.part1UploadedAt?.toISOString() ?? null,
          },
          part2: {
            source: version.part2Source,
            originalFileName: version.part2OriginalFileName,
            uploadedBy: draft.part2UploadedById,
            uploadedAt: draft.part2UploadedAt?.toISOString() ?? null,
          },
          part3: {
            source: version.part3Source,
            projectCount: version.part3ProjectCount,
            projectIds: version.part3ProjectSnapshot,
            generatedAt: draft.part3GeneratedAt?.toISOString() ?? null,
          },
        },
        merged: {
          fileName: `official-book-v${version.versionNumber}.pdf`,
          mergedAt: version.mergedAt?.toISOString() ?? null,
          totalPages: version.totalPages,
        },
        createdBy: version.createdById,
        createdAt: version.createdAt?.toISOString() ?? null,
        deprecatedAt: null,
        deprecatedBy: null,
        deprecationReason: null,
      };
      this.fileService.writeMetadataJson(
        version.sourceType,
        version.sourceId,
        version.versionNumber,
        metadata,
      );
    } catch (err) {
      this.logger.warn(`Failed to write metadata.json: ${err?.message}`);
    }
  }
}
