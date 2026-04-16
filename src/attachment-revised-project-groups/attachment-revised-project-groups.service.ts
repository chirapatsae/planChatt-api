import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { mkdir, writeFile, access, unlink } from 'fs/promises';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { Response } from 'express';
import { createReadStream } from 'fs';
import { AttachmentRevisedProjectGroup } from './entities/attachment-revised-project-group.entity';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';
import { CreateAttachmentRevisedProjectGroupDto } from './dto/create-attachment-revised-project-group.dto';
import { DocumentAnalysisService } from 'src/document-analysis/document-analysis.service';

@Injectable()
export class AttachmentRevisedProjectGroupsService {
  private readonly logger = new Logger(AttachmentRevisedProjectGroupsService.name);
  private readonly uploadDir = 'uploads/attachment-revised-project-groups';

  constructor(
    @InjectRepository(AttachmentRevisedProjectGroup)
    private readonly attachmentRepo: Repository<AttachmentRevisedProjectGroup>,
    private readonly documentAnalysisService: DocumentAnalysisService,
  ) {}

  async create(
    dto: CreateAttachmentRevisedProjectGroupDto,
  ): Promise<AttachmentRevisedProjectGroup> {
    const attachment = this.attachmentRepo.create({
      filename: dto.filename,
      originalName: dto.originalName,
      mimetype: dto.mimetype,
      size: dto.size,
      path: dto.path,
      revisedProjectGroup: { id: dto.revisedProjectGroupId } as RevisedProjectGroup,
    });
    return this.attachmentRepo.save(attachment);
  }

  async uploadFile(
    file: Express.Multer.File,
    revisedProjectGroupId: string,
    uploaderUserId?: string | null,
  ): Promise<AttachmentRevisedProjectGroup> {
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

    const createDto: CreateAttachmentRevisedProjectGroupDto = {
      filename,
      originalName: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
      path: filePath,
      revisedProjectGroupId,
    };

    const saved = await this.create(createDto);
    this.logger.log(
      `File uploaded for revisedProjectGroup ${revisedProjectGroupId}: ${filename}`,
    );

    // Fire-and-forget AI analysis — non-blocking.
    void this.documentAnalysisService
      .processAttachment(
        'revised-project-group',
        saved.id,
        uploaderUserId ?? null,
      )
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
    revisedProjectGroupId: string,
    uploaderUserId?: string | null,
  ): Promise<AttachmentRevisedProjectGroup[]> {
    const tasks = files.map((file) =>
      this.uploadFile(file, revisedProjectGroupId, uploaderUserId),
    );
    return Promise.all(tasks);
  }

  async findByRevisedProjectGroupId(
    revisedProjectGroupId: string,
  ): Promise<AttachmentRevisedProjectGroup[]> {
    return this.attachmentRepo.find({
      where: { revisedProjectGroup: { id: revisedProjectGroupId } },
    });
  }

  async findOne(id: string): Promise<AttachmentRevisedProjectGroup> {
    const attachment = await this.attachmentRepo.findOne({
      where: { id },
      relations: ['revisedProjectGroup'],
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
        throw new NotFoundException(`File ${attachment.filename} not found on disk`);
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

      this.logger.log(`File downloaded successfully: ${attachment.filename}`);
    } catch (error) {
      this.logger.error(`Error downloading file: ${error.message}`, error.stack);
      if (error instanceof NotFoundException) {
        throw error;
      }
      throw new NotFoundException(`Error downloading file`);
    }
  }

  async remove(id: string): Promise<void> {
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
        throw new NotFoundException(`File ${attachment.filename} not found on disk`);
      }

      res.setHeader('Content-Type', attachment.mimetype);
      res.setHeader('Cache-Control', 'public, max-age=3600');

      const fileStream = createReadStream(filePath);
      fileStream.pipe(res);

      this.logger.log(`File viewed successfully: ${attachment.filename}`);
    } catch (error) {
      this.logger.error(`Error viewing file: ${error.message}`, error.stack);
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
}


