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

/** Roles permitted to perform dev-reset (dev utility only) */
const RESET_ROLES = ['super-admin'];

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

      // Check if a canceled draft exists
      const canceledDraft = await this.draftRepo.findOne({
        where: {
          sourceType,
          sourceId,
          assemblyStatus: AssemblyDraftStatus.CANCELED,
        },
        order: { canceledAt: 'DESC' },
      });
      if (canceledDraft) {
        // Check if a completed version exists for this context
        const completedVersion = await this.versionRepo.findOne({
          where: {
            sourceType,
            sourceId,
            status: BookAssemblyVersionStatus.COMPLETED,
          },
        });

        if (completedVersion) {
          // Orphan: silently purge the canceled draft and continue with create
          await this.draftRepo.remove(canceledDraft);
          this.logger.log(
            `Silently purged orphaned canceled draft ${canceledDraft.id} for ${sourceType}/${sourceId}`,
          );
        } else {
          // No completed version — user should choose restore or purge
          throw new ConflictException({
            message: 'มี draft ที่ยกเลิกแล้วอยู่ กรุณากู้คืนหรือลบทิ้งก่อนสร้างใหม่',
            errorCode: 'CANCELED_DRAFT_EXISTS',
            canceledDraftId: canceledDraft.id,
          });
        }
      }

      // Determine next version number
      const maxVersion = await this.versionRepo
        .createQueryBuilder('v')
        .select('MAX(v.versionNumber)', 'max')
        .where('v.sourceType = :sourceType', { sourceType })
        .andWhere('v.sourceId = :sourceId', { sourceId })
        .getRawOne();
      const targetVersion = (maxVersion?.max ?? 0) + 1;

      // Query for the most recently DEPRECATED version (cancel-book linkage)
      const deprecatedVersion = await this.versionRepo.findOne({
        where: {
          sourceType,
          sourceId,
          status: BookAssemblyVersionStatus.DEPRECATED,
        },
        order: { versionNumber: 'DESC' },
      });
      this.logger.warn(
        `createDraft: deprecatedVersion query result — ${deprecatedVersion ? `id=${deprecatedVersion.id} versionNumber=${deprecatedVersion.versionNumber}` : 'NULL (no deprecated version found)'}`,
      );

      // Create folder structure
      this.fileService.createVersionFolders(sourceType, sourceId, targetVersion);

      // Create draft record
      const draft = this.draftRepo.create({
        sourceType,
        sourceId,
        targetVersion,
        previousVersionId: deprecatedVersion?.id ?? null,
        correctionMode: null,
        correctionReason: null,
        part1Status: PartUploadStatus.PENDING,
        part2Status: PartUploadStatus.PENDING,
        part3Status: PartUploadStatus.PENDING,
        assemblyStatus: AssemblyDraftStatus.PREPARING,
        createdById: workHistory.id,
      });

      const saved = await this.draftRepo.save(draft);
      if (deprecatedVersion) {
        this.logger.log(
          `Created draft for ${sourceType}/${sourceId} targetVersion=${targetVersion} previousVersionId=${deprecatedVersion.id} (cancel-book linkage) [draftId=${saved.id}]`,
        );
      } else {
        this.logger.log(
          `Created draft for ${sourceType}/${sourceId} targetVersion=${targetVersion} [draftId=${saved.id}]`,
        );
      }
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
   * Soft-deletes an active draft by setting status to CANCELED.
   * If a restorable DEPRECATED version exists (via previousVersionId OR by context query),
   * atomically restores that version to COMPLETED within the same transaction.
   *
   * Restoration runs when correctionMode is null (cancel-book) or CORRECTION_PART3.
   * For CORRECTION_PART1/PART2, only version status is restored (no booking reset).
   */
  async discardDraft(
    sourceType: BookAssemblySourceType,
    sourceId: string,
    userId: string,
  ): Promise<{
    message: string;
    draftId: string;
    restoredVersion: VersionResponseDto | null;
  }> {
    try {
      const workHistory = await this.loadAndValidateWorkHistory(userId, ADMIN_ROLES);
      const draft = await this.loadActiveDraft(sourceType, sourceId);
      const appUrl = process.env.APP_URL ?? '';

      // Resolve the version to restore:
      // 1. Use draft.previousVersionId if set (correction or cancel-book with linkage)
      // 2. Fallback: query latest DEPRECATED version for this context
      //    (handles drafts created before the previousVersionId fix was deployed)
      let versionIdToRestore = draft.previousVersionId;

      if (!versionIdToRestore) {
        const latestDeprecated = await this.versionRepo.findOne({
          where: { sourceType, sourceId, status: BookAssemblyVersionStatus.DEPRECATED },
          order: { versionNumber: 'DESC' },
        });
        if (latestDeprecated) {
          versionIdToRestore = latestDeprecated.id;
          this.logger.warn(
            `discardDraft: previousVersionId was NULL, resolved via fallback query → ${latestDeprecated.id} (v${latestDeprecated.versionNumber})`,
          );
        }
      }

      this.logger.warn(
        `discardDraft: draft.id=${draft.id} correctionMode=${draft.correctionMode ?? 'NULL'} versionIdToRestore=${versionIdToRestore ?? 'NULL'}`,
      );

      // Atomic soft-delete + version restoration (when a restorable version exists)
      if (versionIdToRestore) {
        const result = await this.dataSource.transaction(async (manager) => {
          // a. Lock the version row (NO relations — FOR UPDATE cannot have LEFT JOINs)
          const lockedVersion = await manager
            .getRepository(BookAssemblyVersion)
            .createQueryBuilder('version')
            .setLock('pessimistic_write')
            .where('version.id = :id', { id: versionIdToRestore })
            .getOne();

          // b. Load relations separately (no lock needed — just for DTO mapping)
          const previousVersion = lockedVersion
            ? await manager.findOne(BookAssemblyVersion, {
                where: { id: versionIdToRestore },
                relations: ['createdBy', 'createdBy.user'],
              })
            : null;

          let restoredVersion: BookAssemblyVersion | null = null;

          if (previousVersion) {
            // b. Sanity check: only restore if currently DEPRECATED
            if (previousVersion.status !== BookAssemblyVersionStatus.DEPRECATED) {
              this.logger.warn(
                `discardDraft: skip restoration — version ${previousVersion.id} status is '${previousVersion.status}', not DEPRECATED`,
              );
            } else {
              // c. Safeguard: no newer version should exist for this context
              const newerVersion = await manager.findOne(BookAssemblyVersion, {
                where: { sourceType, sourceId },
                order: { versionNumber: 'DESC' },
              });

              if (newerVersion && newerVersion.versionNumber > previousVersion.versionNumber) {
                this.logger.warn(
                  `discardDraft: skip restoration — newer version v${newerVersion.versionNumber} exists`,
                );
              } else {
                // d. Restore version to COMPLETED
                previousVersion.status = BookAssemblyVersionStatus.COMPLETED;
                previousVersion.deprecatedAt = null;
                previousVersion.deprecatedById = null;
                previousVersion.deprecationReason = null;
                await manager.save(BookAssemblyVersion, previousVersion);
                restoredVersion = previousVersion;
                this.logger.warn(
                  `discardDraft: version ${previousVersion.id} restored to COMPLETED`,
                );

                // e. Restore booking state for cancel-book and CORRECTION_PART3 drafts
                const needsBookingRestore =
                  draft.correctionMode === null ||
                  draft.correctionMode === CorrectionMode.CORRECTION_PART3;

                if (needsBookingRestore) {
                  const projectIds = previousVersion.part3ProjectSnapshot ?? [];
                  const pageMap = previousVersion.part3PageMap ?? {};

                  if (projectIds.length > 0) {
                    if (sourceType === BookAssemblySourceType.MAIN_PLAN) {
                      for (const projectId of projectIds) {
                        await manager.getRepository(ProjectGroup).update(
                          { id: projectId },
                          {
                            isBooked: true,
                            bookedAt: new Date(),
                            pageNumber: pageMap[projectId] ?? null,
                          },
                        );
                      }
                    } else {
                      for (const projectId of projectIds) {
                        await manager.getRepository(RevisedProjectGroup).update(
                          { id: projectId },
                          {
                            isBooked: true,
                            bookedAt: new Date(),
                            pageNumber: pageMap[projectId] ?? null,
                          },
                        );
                      }
                    }
                    this.logger.warn(
                      `discardDraft: restored booking for ${projectIds.length} projects`,
                    );
                  }

                  // Restore plan state
                  if (sourceType === BookAssemblySourceType.MAIN_PLAN) {
                    await manager.getRepository(DevelopmentPlan).update(
                      { id: sourceId },
                      { isBooked: true },
                    );
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
                  this.logger.warn(
                    `discardDraft: restored plan/phase booking for ${sourceType}/${sourceId}`,
                  );
                }

                // f. Write restoration audit log
                await manager.save(DeprecationAuditLog, {
                  action: DeprecationAuditAction.RESTORED,
                  versionId: previousVersion.id,
                  sourceType,
                  sourceId,
                  operatorWorkHistoryId: workHistory.id,
                  operatorRole: workHistory.role?.name,
                  identityVerified: false,
                  identityMasked: null,
                  reason: 'draft discarded by operator',
                  failureReason: null,
                });
              }
            }
          } else {
            this.logger.warn(
              `discardDraft: version ${versionIdToRestore} not found in DB — skipping restoration`,
            );
          }

          // g. Soft-delete draft
          draft.assemblyStatus = AssemblyDraftStatus.CANCELED;
          draft.canceledAt = new Date();
          draft.canceledById = workHistory.id;
          await manager.save(BookAssemblyDraft, draft);

          return restoredVersion;
        });

        this.logger.warn(
          `discardDraft: complete for draft ${draft.id}` +
          (result ? ` — restored version ${result.id} to COMPLETED` : ' — no restoration'),
        );

        return {
          message: 'ยกเลิก draft เรียบร้อยแล้ว',
          draftId: draft.id,
          restoredVersion: result ? VersionResponseDto.fromEntity(result, appUrl) : null,
        };
      }

      // No restorable version found — soft-delete only (first-ever draft, or post-reset)
      this.logger.warn(
        `discardDraft: no restorable version — soft-delete only for draft ${draft.id}`,
      );
      draft.assemblyStatus = AssemblyDraftStatus.CANCELED;
      draft.canceledAt = new Date();
      draft.canceledById = workHistory.id;
      await this.draftRepo.save(draft);

      return {
        message: 'ยกเลิก draft เรียบร้อยแล้ว',
        draftId: draft.id,
        restoredVersion: null,
      };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * Returns the most recent canceled draft for a source context, or null.
   * Loads canceledBy.user relation for display.
   */
  async getCanceledDraft(
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
          assemblyStatus: AssemblyDraftStatus.CANCELED,
        },
        order: { canceledAt: 'DESC' },
        relations: ['canceledBy', 'canceledBy.user'],
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * Restores the most recent canceled draft to active status.
   * Recomputes assemblyStatus from current part statuses.
   */
  async restoreDraft(
    sourceType: BookAssemblySourceType,
    sourceId: string,
    userId: string,
  ): Promise<BookAssemblyDraft> {
    try {
      await this.loadAndValidateWorkHistory(userId, ADMIN_ROLES);

      // 1. Load most recent CANCELED draft
      const canceledDraft = await this.draftRepo.findOne({
        where: {
          sourceType,
          sourceId,
          assemblyStatus: AssemblyDraftStatus.CANCELED,
        },
        order: { canceledAt: 'DESC' },
      });
      if (!canceledDraft) {
        throw new NotFoundException('ไม่พบ draft ที่ถูกยกเลิก');
      }

      // 2. Check no active draft exists (PREPARING or READY)
      const activeDraft = await this.draftRepo.findOne({
        where: {
          sourceType,
          sourceId,
          assemblyStatus: In([AssemblyDraftStatus.PREPARING, AssemblyDraftStatus.READY]),
        },
      });
      if (activeDraft) {
        throw new ConflictException({
          message: 'กู้คืนไม่ได้ มี draft ที่กำลังดำเนินการอยู่แล้ว',
          errorCode: 'ACTIVE_DRAFT_EXISTS',
        });
      }

      // 3. Recompute assemblyStatus from part statuses (§2.7)
      const part1Ready = canceledDraft.part1Status === PartUploadStatus.UPLOADED
        || canceledDraft.part1Status === PartUploadStatus.REUSED;
      const part2Ready = canceledDraft.part2Status === PartUploadStatus.UPLOADED
        || canceledDraft.part2Status === PartUploadStatus.REUSED;
      const part3Ready = canceledDraft.part3Status === PartUploadStatus.GENERATED
        || canceledDraft.part3Status === PartUploadStatus.REUSED;

      canceledDraft.assemblyStatus = (part1Ready && part2Ready && part3Ready)
        ? AssemblyDraftStatus.READY
        : AssemblyDraftStatus.PREPARING;

      // 4. Clear canceled fields
      canceledDraft.canceledAt = null;
      canceledDraft.canceledById = null;

      const restored = await this.draftRepo.save(canceledDraft);
      this.logger.log(
        `Restored draft ${restored.id} for ${sourceType}/${sourceId} → ${restored.assemblyStatus}`,
      );
      return restored;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * Permanently hard-deletes a canceled draft record.
   * Only CANCELED drafts can be purged. Disk files are NOT deleted.
   */
  async purgeCanceledDraft(
    sourceType: BookAssemblySourceType,
    sourceId: string,
    userId: string,
  ): Promise<void> {
    try {
      await this.loadAndValidateWorkHistory(userId, ADMIN_ROLES);

      const canceledDraft = await this.draftRepo.findOne({
        where: {
          sourceType,
          sourceId,
          assemblyStatus: AssemblyDraftStatus.CANCELED,
        },
        order: { canceledAt: 'DESC' },
      });
      if (!canceledDraft) {
        throw new NotFoundException('ไม่พบ draft ที่ถูกยกเลิก');
      }

      await this.draftRepo.remove(canceledDraft);
      this.logger.log(
        `Purged canceled draft ${canceledDraft.id} for ${sourceType}/${sourceId}`,
      );
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

        // 5b. Guard: reject if a CANCELED draft exists for this context.
        // A CANCELED draft is a soft-deleted correction draft awaiting restore
        // or purge. Allowing correct() while a CANCELED draft exists would
        // violate the unique index (idx_single_active_draft_per_source) and
        // leave the system in an inconsistent state. The user must restore or
        // purge the CANCELED draft before starting a new correction.
        const canceledDraft = await manager.findOne(BookAssemblyDraft, {
          where: {
            sourceType,
            sourceId,
            assemblyStatus: AssemblyDraftStatus.CANCELED,
          },
        });
        if (canceledDraft) {
          audit.failureReason = `CANCELED_DRAFT_EXISTS: cannot start correction while canceled draft exists (id=${canceledDraft.id})`;
          throw new ConflictException({
            message:
              'มี draft ที่ยกเลิกแล้วอยู่ กรุณากู้คืนหรือลบทิ้งก่อนดำเนินการแก้ไข',
            errorCode: 'CANCELED_DRAFT_EXISTS',
            canceledDraftId: canceledDraft.id,
          });
        }

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
   * Get the current version for a source context.
   *
   * Returns:
   * - The COMPLETED version if one exists
   * - The DEPRECATED version referenced by an active draft's previousVersionId (correction/cancel flow)
   * - null if no version exists (first-ever draft, post-reset)
   *
   * Returns null (HTTP 200) instead of 404 to avoid false error signals
   * in frontend loadState() which calls this endpoint on every page load.
   */
  async getCurrentVersion(
    sourceType: BookAssemblySourceType,
    sourceId: string,
    userId: string,
  ): Promise<VersionResponseDto | null> {
    try {
      await this.loadAndValidateWorkHistory(userId, READ_ROLES);

      // Step 1: return the COMPLETED version if one exists
      const completedVersion = await this.versionRepo.findOne({
        where: { sourceType, sourceId, status: BookAssemblyVersionStatus.COMPLETED },
        relations: ['createdBy', 'createdBy.user'],
      });
      if (completedVersion) {
        const appUrl = process.env.APP_URL ?? '';
        return VersionResponseDto.fromEntity(completedVersion, appUrl);
      }

      // Step 2: no COMPLETED version — check if an active draft references a previous version
      const activeDraft = await this.draftRepo.findOne({
        where: {
          sourceType,
          sourceId,
          assemblyStatus: In([AssemblyDraftStatus.PREPARING, AssemblyDraftStatus.READY]),
        },
      });

      if (activeDraft?.previousVersionId) {
        const previousVersion = await this.versionRepo.findOne({
          where: { id: activeDraft.previousVersionId },
          relations: ['createdBy', 'createdBy.user'],
        });
        if (previousVersion) {
          const appUrl = process.env.APP_URL ?? '';
          return VersionResponseDto.fromEntity(previousVersion, appUrl);
        }
      }

      // No version exists — return null (not 404)
      return null;
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
          versionId: audit.versionId ?? null,
          sourceType: audit.sourceType,
          sourceId: audit.sourceId,
          operatorWorkHistoryId: audit.operatorWorkHistoryId ?? null,
          operatorRole: audit.operatorRole ?? null,
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

  // ===========================================================================
  // Dev Reset (development environment ONLY)
  // ===========================================================================

  /**
   * Resets all Book Assembly data for a single (sourceType, sourceId) context.
   * Dev-only utility. Deletes audit logs, drafts, versions; resets plan/project flags.
   * MUST NOT be called in production.
   *
   * Uses a single QueryRunner to ensure trigger bypass and transaction share the
   * same database connection (session_replication_role is per-connection).
   */
  async resetForTesting(
    sourceType: BookAssemblySourceType,
    sourceId: string,
    userId: string,
  ): Promise<{
    deleted: { auditLogs: number; drafts: number; versions: number };
    updated: Record<string, any>;
  }> {
    // Step 1-2: Load WorkHistory + role guard (super-admin only)
    const workHistory = await this.workHistoryRepo.findOne({
      where: { user: { id: userId }, isCurrent: true },
      relations: ['role'],
    });
    if (!workHistory) {
      throw new NotFoundException(`WorkHistory not found for user ${userId}`);
    }
    if (!RESET_ROLES.includes(workHistory.role?.name)) {
      throw new ForbiddenException(
        'เฉพาะ super-admin เท่านั้นที่สามารถดำเนินการ dev-reset ได้',
      );
    }

    this.logger.warn(
      `DEV RESET: initiated | sourceType=${sourceType} | sourceId=${sourceId} | operator=${workHistory.id}`,
    );

    // Use a single QueryRunner so trigger bypass + transaction share the same connection
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      // Disable triggers on THIS connection (before starting transaction)
      try {
        await queryRunner.query('SET session_replication_role = replica');
        this.logger.warn('DEV RESET: triggers disabled (session_replication_role = replica)');
      } catch (triggerErr) {
        this.logger.warn(
          `DEV RESET: SET session_replication_role failed (${triggerErr?.message}), attempting ALTER TABLE fallback`,
        );
        try {
          await queryRunner.query(
            'ALTER TABLE deprecation_audit_logs DISABLE TRIGGER trg_deprecation_audit_no_delete',
          );
          this.logger.warn('DEV RESET: triggers disabled via ALTER TABLE fallback');
        } catch (fallbackErr) {
          this.logger.warn(
            `DEV RESET: ALTER TABLE fallback also failed (${fallbackErr?.message}), proceeding anyway`,
          );
        }
      }

      await queryRunner.startTransaction();

      // Step 1: DELETE audit logs
      const r1 = await queryRunner.query(
        'DELETE FROM deprecation_audit_logs WHERE source_type = $1 AND source_id = $2 RETURNING id',
        [sourceType, sourceId],
      );
      const auditLogs = Array.isArray(r1) ? r1.length : 0;
      this.logger.warn(`DEV RESET: deleted audit logs: ${auditLogs} rows`);

      // Step 2: DELETE drafts
      const r2 = await queryRunner.query(
        'DELETE FROM book_assembly_drafts WHERE source_type = $1 AND source_id = $2 RETURNING id',
        [sourceType, sourceId],
      );
      const drafts = Array.isArray(r2) ? r2.length : 0;
      this.logger.warn(`DEV RESET: deleted drafts: ${drafts} rows`);

      // Step 3: DELETE versions
      const r3 = await queryRunner.query(
        'DELETE FROM book_assembly_versions WHERE source_type = $1 AND source_id = $2 RETURNING id',
        [sourceType, sourceId],
      );
      const versions = Array.isArray(r3) ? r3.length : 0;
      this.logger.warn(`DEV RESET: deleted versions: ${versions} rows`);

      // Step 4: UPDATE flags — branch on sourceType
      const updated: Record<string, any> = {};

      if (sourceType === BookAssemblySourceType.MAIN_PLAN) {
        const r4 = await queryRunner.query(
          'UPDATE project_groups SET is_booked = false, booked_at = null, page_number = null WHERE development_plan_id = $1 AND is_booked = true RETURNING id',
          [sourceId],
        );
        updated.projects = Array.isArray(r4) ? r4.length : 0;
        this.logger.warn(`DEV RESET: updated projects: ${updated.projects} rows (is_booked reset)`);

        await queryRunner.query(
          'UPDATE development_plans SET is_booked = false WHERE id = $1',
          [sourceId],
        );
        updated.plan = true;
        this.logger.warn('DEV RESET: updated plan: is_booked = false');

        const r6 = await queryRunner.query(
          'UPDATE plan_phases SET is_merged = false WHERE development_plan_id = $1 RETURNING id',
          [sourceId],
        );
        updated.phases = Array.isArray(r6) ? r6.length : 0;
        this.logger.warn(`DEV RESET: updated phases: ${updated.phases} rows (is_merged reset)`);
      } else {
        const r4 = await queryRunner.query(
          'UPDATE revised_project_groups SET is_booked = false, booked_at = null, page_number = null WHERE development_plan_revision_id = $1 AND is_booked = true RETURNING id',
          [sourceId],
        );
        updated.revisedProjects = Array.isArray(r4) ? r4.length : 0;
        this.logger.warn(`DEV RESET: updated revised projects: ${updated.revisedProjects} rows (is_booked reset)`);

        await queryRunner.query(
          'UPDATE development_plan_revisions SET is_booked = false, is_open = true WHERE id = $1',
          [sourceId],
        );
        updated.revision = true;
        this.logger.warn('DEV RESET: updated revision: is_booked = false, is_open = true');
      }

      await queryRunner.commitTransaction();

      this.logger.warn(
        `DEV RESET: complete | sourceType=${sourceType} | sourceId=${sourceId}`,
      );
      return { deleted: { auditLogs, drafts, versions }, updated };
    } catch (error) {
      // Rollback on any error
      try {
        await queryRunner.rollbackTransaction();
      } catch {
        // Rollback failed — connection may be dead, nothing more we can do
      }
      throw error;
    } finally {
      // Re-enable triggers on THIS connection (always runs)
      try {
        await queryRunner.query('SET session_replication_role = DEFAULT');
        this.logger.warn('DEV RESET: triggers re-enabled (session_replication_role = DEFAULT)');
      } catch (restoreErr) {
        this.logger.warn(
          `DEV RESET: failed to restore session_replication_role (${restoreErr?.message})`,
        );
        try {
          await queryRunner.query(
            'ALTER TABLE deprecation_audit_logs ENABLE TRIGGER trg_deprecation_audit_no_delete',
          );
        } catch {
          // Best-effort
        }
      }
      // Release the connection back to the pool
      await queryRunner.release();
    }
  }

  /**
   * Resets ALL Book Assembly data across ALL contexts.
   * Dev-only utility. NUCLEAR — use with extreme caution.
   *
   * Uses a single QueryRunner to ensure trigger bypass and transaction share
   * the same database connection.
   */
  async resetAllForTesting(
    userId: string,
  ): Promise<{
    deleted: { auditLogs: number; drafts: number; versions: number };
    updated: Record<string, any>;
  }> {
    // Role guard
    const workHistory = await this.workHistoryRepo.findOne({
      where: { user: { id: userId }, isCurrent: true },
      relations: ['role'],
    });
    if (!workHistory) {
      throw new NotFoundException(`WorkHistory not found for user ${userId}`);
    }
    if (!RESET_ROLES.includes(workHistory.role?.name)) {
      throw new ForbiddenException(
        'เฉพาะ super-admin เท่านั้นที่สามารถดำเนินการ dev-reset ได้',
      );
    }

    this.logger.warn(`DEV RESET ALL: initiated | operator=${workHistory.id}`);

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      // Disable triggers on THIS connection
      try {
        await queryRunner.query('SET session_replication_role = replica');
        this.logger.warn('DEV RESET ALL: triggers disabled');
      } catch (triggerErr) {
        this.logger.warn(`DEV RESET ALL: SET session_replication_role failed (${triggerErr?.message}), attempting fallback`);
        try {
          await queryRunner.query(
            'ALTER TABLE deprecation_audit_logs DISABLE TRIGGER trg_deprecation_audit_no_delete',
          );
        } catch {
          this.logger.warn('DEV RESET ALL: fallback also failed, proceeding');
        }
      }

      await queryRunner.startTransaction();

      // Step 1: DELETE all audit logs
      const r1 = await queryRunner.query('DELETE FROM deprecation_audit_logs RETURNING id');
      const auditLogs = Array.isArray(r1) ? r1.length : 0;
      this.logger.warn(`DEV RESET ALL: deleted audit logs: ${auditLogs} rows`);

      // Step 2: DELETE all drafts
      const r2 = await queryRunner.query('DELETE FROM book_assembly_drafts RETURNING id');
      const drafts = Array.isArray(r2) ? r2.length : 0;
      this.logger.warn(`DEV RESET ALL: deleted drafts: ${drafts} rows`);

      // Step 3: DELETE all versions
      const r3 = await queryRunner.query('DELETE FROM book_assembly_versions RETURNING id');
      const versions = Array.isArray(r3) ? r3.length : 0;
      this.logger.warn(`DEV RESET ALL: deleted versions: ${versions} rows`);

      // Step 4: Reset project_groups
      const r4 = await queryRunner.query(
        'UPDATE project_groups SET is_booked = false, booked_at = null, page_number = null WHERE is_booked = true RETURNING id',
      );
      const projects = Array.isArray(r4) ? r4.length : 0;
      this.logger.warn(`DEV RESET ALL: updated projects: ${projects} rows`);

      // Step 5: Reset development_plans
      const r5 = await queryRunner.query(
        'UPDATE development_plans SET is_booked = false WHERE is_booked = true RETURNING id',
      );
      const plans = Array.isArray(r5) ? r5.length : 0;
      this.logger.warn(`DEV RESET ALL: updated plans: ${plans} rows`);

      // Step 6: Reset plan_phases
      const r6 = await queryRunner.query(
        'UPDATE plan_phases SET is_merged = false WHERE is_merged = true RETURNING id',
      );
      const phases = Array.isArray(r6) ? r6.length : 0;
      this.logger.warn(`DEV RESET ALL: updated phases: ${phases} rows`);

      // Step 7: Reset revised_project_groups
      const r7 = await queryRunner.query(
        'UPDATE revised_project_groups SET is_booked = false, booked_at = null, page_number = null WHERE is_booked = true RETURNING id',
      );
      const revisedProjects = Array.isArray(r7) ? r7.length : 0;
      this.logger.warn(`DEV RESET ALL: updated revised projects: ${revisedProjects} rows`);

      // Step 8: Reset development_plan_revisions
      const r8 = await queryRunner.query(
        'UPDATE development_plan_revisions SET is_booked = false, is_open = true WHERE is_booked = true RETURNING id',
      );
      const revisions = Array.isArray(r8) ? r8.length : 0;
      this.logger.warn(`DEV RESET ALL: updated revisions: ${revisions} rows`);

      await queryRunner.commitTransaction();

      this.logger.warn('DEV RESET ALL: complete');
      return {
        deleted: { auditLogs, drafts, versions },
        updated: { projects, revisedProjects, plans, revisions, phases },
      };
    } catch (error) {
      try {
        await queryRunner.rollbackTransaction();
      } catch {
        // Rollback failed — connection may be dead
      }
      throw error;
    } finally {
      try {
        await queryRunner.query('SET session_replication_role = DEFAULT');
        this.logger.warn('DEV RESET ALL: triggers re-enabled');
      } catch (restoreErr) {
        this.logger.warn(`DEV RESET ALL: failed to restore triggers (${restoreErr?.message})`);
        try {
          await queryRunner.query(
            'ALTER TABLE deprecation_audit_logs ENABLE TRIGGER trg_deprecation_audit_no_delete',
          );
        } catch {
          // Best-effort
        }
      }
      await queryRunner.release();
    }
  }
}
