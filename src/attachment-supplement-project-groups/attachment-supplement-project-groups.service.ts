import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { mkdir, writeFile, access, unlink } from 'fs/promises';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { Response } from 'express';
import { createReadStream } from 'fs';
import { AttachmentSupplementProjectGroup } from './entities/attachment-supplement-project-group.entity';
import { SupplementProjectGroup } from 'src/supplement-project-group/entities/supplement-project-group.entity';
import { CreateAttachmentSupplementProjectGroupDto } from './dto/create-attachment-supplement-project-group.dto';
import { SupplementScopeService } from 'src/common/supplement-scope/supplement-scope.service';
import { WorkHistoryLookupService } from 'src/work-history/work-history-lookup.service';
// SUPP_AI_BE_06 hotfix (2026-05-15) — AI auto-analyze fire-and-forget
// hook for SPG attachments. `DocumentAnalysisService` was widened to
// accept `'supplement-project-group'` kind by SUPP_AI_BE_01, so the
// `TODO(SUPP-3-later)` deferred wiring can now land. Without this,
// `ai_status` stays at `'pending'` forever and the FE polls the
// `AttachmentAiAnalysisBlock` spinner indefinitely.
import { DocumentAnalysisService } from 'src/document-analysis/document-analysis.service';

/**
 * SUPP-3 / BE-07 — Attachment service for `SupplementProjectGroup`.
 *
 * Mirrors `AttachmentProjectGroupsService` /
 * `AttachmentRevisedProjectGroupsService` verbatim where possible. The
 * only divergence is the §1+§2 owner-scope gate via
 * `SupplementScopeService.assertSupplementOwnerScope` — supplement is
 * agency-only (workflow §4), so even file upload is restricted to
 * agency-classified callers with `workStatus = approved`.
 *
 * `DocumentAnalysisService` does NOT yet expose a `'supplement-project-group'`
 * attachment kind (verified 2026-05-12). Per the BE-07 task contract and
 * user-confirmed default this wave SHIPS CRUD only — the post-upload
 * AI-analysis fire-and-forget is deferred to a follow-up task once the
 * `AttachmentKind` union is widened. See `TODO(SUPP-3-later)` markers.
 */
@Injectable()
export class AttachmentSupplementProjectGroupsService {
  private readonly logger = new Logger(
    AttachmentSupplementProjectGroupsService.name,
  );
  private readonly uploadDir = 'uploads/attachment-supplement-project-groups';

  constructor(
    @InjectRepository(AttachmentSupplementProjectGroup)
    private readonly attachmentRepo: Repository<AttachmentSupplementProjectGroup>,
    private readonly dataSource: DataSource,
    private readonly supplementScopeService: SupplementScopeService,
    private readonly workHistoryLookup: WorkHistoryLookupService,
    // SUPP_AI_BE_06 hotfix — fire-and-forget AI analysis after upload.
    private readonly documentAnalysisService: DocumentAnalysisService,
  ) {}

  async create(
    dto: CreateAttachmentSupplementProjectGroupDto,
  ): Promise<AttachmentSupplementProjectGroup> {
    const attachment = this.attachmentRepo.create({
      filename: dto.filename,
      originalName: dto.originalName,
      mimetype: dto.mimetype,
      size: dto.size,
      path: dto.path,
      supplementProjectGroup: {
        id: dto.supplementProjectGroupId,
      } as SupplementProjectGroup,
    });
    return this.attachmentRepo.save(attachment);
  }

  /**
   * Upload a single file for an SPG. The owner-scope gate (§1 + §2) is
   * enforced via `SupplementScopeService.assertSupplementOwnerScope`,
   * which mirrors the BE-04 contract used by SPG create / pull-back.
   */
  async uploadFile(
    file: Express.Multer.File,
    supplementProjectGroupId: string,
    uploaderUserId: string,
  ): Promise<AttachmentSupplementProjectGroup> {
    await this.assertOwnerScope(uploaderUserId);

    const now = new Date();
    const day = String(now.getDate()).padStart(2, '0');
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const year = String(now.getFullYear());
    const dateSegment = `${day}-${month}-${year}`;

    const uploadDirForDate = join(this.uploadDir, dateSegment);
    await mkdir(uploadDirForDate, { recursive: true });

    const fileExtension = file.originalname.split('.').pop();
    const filename = `${uuidv4()}.${fileExtension}`;
    const filePath = join(uploadDirForDate, filename);

    await writeFile(filePath, file.buffer);

    const createDto: CreateAttachmentSupplementProjectGroupDto = {
      filename,
      originalName: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
      path: filePath,
      supplementProjectGroupId,
    };

    const saved = await this.create(createDto);
    this.logger.log(
      `File uploaded for supplementProjectGroup ${supplementProjectGroupId}: ${filename}`,
    );

    // SUPP_AI_BE_06 hotfix (2026-05-15) — fire-and-forget AI analysis,
    // identical pattern to PG / RPG attachment services. Failures land
    // in `ai_status` ('failed' | 'unsupported') without rolling back
    // the upload (the file is already on disk + row inserted). §17.2
    // advisory only — no workflow side effects.
    void this.documentAnalysisService
      .processAttachment('supplement-project-group', saved.id, uploaderUserId ?? null)
      .catch((e) =>
        this.logger.error(
          `Document analysis failed for ${saved.id}: ${(e as Error).message}`,
          (e as Error).stack,
        ),
      );

    return saved;
  }

  async uploadMultipleFiles(
    files: Express.Multer.File[],
    supplementProjectGroupId: string,
    uploaderUserId: string,
  ): Promise<AttachmentSupplementProjectGroup[]> {
    // Single scope check up-front — fan-out only after the gate clears.
    await this.assertOwnerScope(uploaderUserId);

    const tasks = files.map((file) =>
      this.uploadFile(file, supplementProjectGroupId, uploaderUserId),
    );
    return Promise.all(tasks);
  }

  async findBySupplementProjectGroupId(
    supplementProjectGroupId: string,
  ): Promise<AttachmentSupplementProjectGroup[]> {
    return this.attachmentRepo.find({
      where: {
        supplementProjectGroup: { id: supplementProjectGroupId },
      },
    });
  }

  async findOne(id: string): Promise<AttachmentSupplementProjectGroup> {
    const attachment = await this.attachmentRepo.findOne({
      where: { id },
      relations: ['supplementProjectGroup'],
    });
    if (!attachment) {
      throw new NotFoundException(`Attachment with ID ${id} not found`);
    }
    return attachment;
  }

  async downloadFile(id: string, res: Response): Promise<void> {
    try {
      const attachment = await this.findOne(id);
      const filePath = attachment.path;

      try {
        await access(filePath);
      } catch {
        throw new NotFoundException(
          `File ${attachment.filename} not found on disk`,
        );
      }

      const sanitizedFilename = attachment.originalName
        .replace(/[\r\n]/g, '')
        .replace(/[^\x20-\x7E]/g, '_');

      const encodedFilename = encodeURIComponent(attachment.originalName);
      const contentDisposition = `attachment; filename="${sanitizedFilename}"; filename*=UTF-8''${encodedFilename}`;

      res.setHeader('Content-Disposition', contentDisposition);
      res.setHeader('Content-Type', attachment.mimetype);

      const fileStream = createReadStream(filePath);
      fileStream.pipe(res);

      this.logger.log(
        `File downloaded successfully: ${attachment.filename}`,
      );
    } catch (error) {
      this.logger.error(
        `Error downloading file: ${(error as Error).message}`,
        (error as Error).stack,
      );
      if (error instanceof NotFoundException) {
        throw error;
      }
      throw new NotFoundException(`Error downloading file`);
    }
  }

  /**
   * Owner-scoped soft delete. The §1+§2 gate is enforced for the
   * caller; SPG-row ownership (createdBy match) is intentionally NOT
   * checked here to mirror the PG / RPG attachment pattern verbatim.
   */
  async remove(id: string, callerUserId: string): Promise<void> {
    await this.assertOwnerScope(callerUserId);

    const attachment = await this.findOne(id);
    try {
      await unlink(attachment.path);
    } catch (e) {
      this.logger.error(
        `Failed to delete file from disk: ${attachment.path}`,
        (e as Error).stack,
      );
    }
    await this.attachmentRepo.softDelete(id);
  }

  async viewFile(id: string, res: Response): Promise<void> {
    try {
      const attachment = await this.findOne(id);
      const filePath = attachment.path;

      try {
        await access(filePath);
      } catch {
        throw new NotFoundException(
          `File ${attachment.filename} not found on disk`,
        );
      }

      res.setHeader('Content-Type', attachment.mimetype);
      res.setHeader('Cache-Control', 'public, max-age=3600');

      const fileStream = createReadStream(filePath);
      fileStream.pipe(res);

      this.logger.log(`File viewed successfully: ${attachment.filename}`);
    } catch (error) {
      this.logger.error(
        `Error viewing file: ${(error as Error).message}`,
        (error as Error).stack,
      );
      if (error instanceof NotFoundException) {
        throw error;
      }
      throw new NotFoundException(`Error viewing file`);
    }
  }

  async fileExists(id: string): Promise<boolean> {
    try {
      const attachment = await this.findOne(id);
      const filePath = attachment.path;
      try {
        await access(filePath);
        return true;
      } catch {
        return false;
      }
    } catch {
      return false;
    }
  }

  /**
   * Resolves the caller's current `WorkHistory` and enforces the §1+§2
   * owner-scope gate. Throws the same 403 codes BE-04 documents
   * (`LAO_NOT_ALLOWED_ON_SUPPLEMENT`,
   * `SUPPLEMENT_REQUIRES_AGENCY_CLASSIFICATION`) plus the standard
   * `workStatus.approved` 401.
   */
  private async assertOwnerScope(userId: string): Promise<void> {
    const workHistory = await this.workHistoryLookup.getCurrent(
      this.dataSource.manager,
      userId,
    );
    this.supplementScopeService.assertSupplementOwnerScope(workHistory);
  }
}
