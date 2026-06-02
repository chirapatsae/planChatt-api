import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { mkdir, writeFile, access, unlink } from 'fs/promises';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { Response } from 'express';
import { createReadStream } from 'fs';
import { AttachmentRevisedEquipmentProjectGroup } from './entities/attachment-revised-equipment-project-group.entity';
import { RevisedEquipmentProjectGroup } from 'src/revised-equipment-project-group/entities/revised-equipment-project-group.entity';
import { CreateAttachmentRevisedEquipmentProjectGroupDto } from './dto/create-attachment-revised-equipment-project-group.dto';

/**
 * Wave Equipment Revision Management — attachment support for RELPG.
 *
 * Behavioural clone of `AttachmentRevisedProjectGroupsService`. Same on-disk
 * storage layout convention (dated subfolders under an `uploads/...` root,
 * uuid filenames, soft-delete on remove) so ops / backup behave identically.
 *
 * # Deliberate divergence
 * The RPG attachment service fires a fire-and-forget `DocumentAnalysisService`
 * run after each upload. That pipeline's `AttachmentKind` union does NOT
 * include an equipment kind, so this service OMITS the analysis trigger.
 * Equipment AI document-analysis is out of scope for this wave (§5.3 Phase 3
 * deferred AI for equipment). Everything else — path resolution, multipart
 * handling, save / read / remove — is identical.
 */
@Injectable()
export class AttachmentRevisedEquipmentProjectGroupsService {
  private readonly logger = new Logger(
    AttachmentRevisedEquipmentProjectGroupsService.name,
  );
  private readonly uploadDir =
    'uploads/attachment-revised-equipment-project-groups';

  constructor(
    @InjectRepository(AttachmentRevisedEquipmentProjectGroup)
    private readonly attachmentRepo: Repository<AttachmentRevisedEquipmentProjectGroup>,
  ) {}

  async create(
    dto: CreateAttachmentRevisedEquipmentProjectGroupDto,
  ): Promise<AttachmentRevisedEquipmentProjectGroup> {
    const attachment = this.attachmentRepo.create({
      filename: dto.filename,
      originalName: dto.originalName,
      mimetype: dto.mimetype,
      size: dto.size,
      path: dto.path,
      revisedEquipmentProjectGroup: {
        id: dto.revisedEquipmentProjectGroupId,
      } as RevisedEquipmentProjectGroup,
    });
    return this.attachmentRepo.save(attachment);
  }

  async uploadFile(
    file: Express.Multer.File,
    revisedEquipmentProjectGroupId: string,
  ): Promise<AttachmentRevisedEquipmentProjectGroup> {
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

    const createDto: CreateAttachmentRevisedEquipmentProjectGroupDto = {
      filename,
      originalName: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
      path: filePath,
      revisedEquipmentProjectGroupId,
    };

    const saved = await this.create(createDto);
    this.logger.log(
      `File uploaded for revisedEquipmentProjectGroup ${revisedEquipmentProjectGroupId}: ${filename}`,
    );

    return saved;
  }

  async uploadMultipleFiles(
    files: Express.Multer.File[],
    revisedEquipmentProjectGroupId: string,
  ): Promise<AttachmentRevisedEquipmentProjectGroup[]> {
    const tasks = files.map((file) =>
      this.uploadFile(file, revisedEquipmentProjectGroupId),
    );
    return Promise.all(tasks);
  }

  async findByRevisedEquipmentProjectGroupId(
    revisedEquipmentProjectGroupId: string,
  ): Promise<AttachmentRevisedEquipmentProjectGroup[]> {
    return this.attachmentRepo.find({
      where: {
        revisedEquipmentProjectGroup: { id: revisedEquipmentProjectGroupId },
      },
    });
  }

  async findOne(id: string): Promise<AttachmentRevisedEquipmentProjectGroup> {
    const attachment = await this.attachmentRepo.findOne({
      where: { id },
      relations: ['revisedEquipmentProjectGroup'],
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
