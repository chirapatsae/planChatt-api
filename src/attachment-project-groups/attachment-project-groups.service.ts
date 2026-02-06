import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { mkdir, writeFile, access, unlink } from 'fs/promises';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { Response } from 'express';
import { createReadStream } from 'fs';
import { AttachmentProjectGroup } from './entities/attachment-project-group.entity';
import { CreateAttachmentProjectGroupDto } from './dto/create-attachment-project-group.dto';

@Injectable()
export class AttachmentProjectGroupsService {
  private readonly logger = new Logger(AttachmentProjectGroupsService.name);
  private readonly uploadDir = 'uploads/attachment-project-groups';

  constructor(
    @InjectRepository(AttachmentProjectGroup)
    private readonly attachmentRepo: Repository<AttachmentProjectGroup>,
  ) {}

  async create(
    dto: CreateAttachmentProjectGroupDto,
  ): Promise<AttachmentProjectGroup> {
    const attachment = this.attachmentRepo.create({
      filename: dto.filename,
      originalName: dto.originalName,
      mimetype: dto.mimetype,
      size: dto.size,
      path: dto.path,
      projectGroup: { id: dto.projectGroupId },
    });
    return this.attachmentRepo.save(attachment);
  }

  async uploadFile(
    file: Express.Multer.File,
    projectGroupId: string,
  ): Promise<AttachmentProjectGroup> {
    // สร้างโฟลเดอร์ย่อยตามวันที่: dd-mm-yyyy
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

    const createDto: CreateAttachmentProjectGroupDto = {
      filename,
      originalName: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
      path: filePath,
      projectGroupId,
    };

    const saved = await this.create(createDto);
    this.logger.log(
      `File uploaded for projectGroup ${projectGroupId}: ${filename}`,
    );
    return saved;
  }

  async uploadMultipleFiles(
    files: Express.Multer.File[],
    projectGroupId: string,
  ): Promise<AttachmentProjectGroup[]> {
    const tasks = files.map((file) => this.uploadFile(file, projectGroupId));
    return Promise.all(tasks);
  }

  async findByProjectGroupId(
    projectGroupId: string,
  ): Promise<AttachmentProjectGroup[]> {
    return this.attachmentRepo.find({ where: { projectGroup: { id: projectGroupId } } });
  }

  async findOne(id: string): Promise<AttachmentProjectGroup> {
    const attachment = await this.attachmentRepo.findOne({ where: { id }, relations: ['projectGroup'] });
    if (!attachment) {
      throw new NotFoundException(`Attachment with ID ${id} not found`);
    }
    return attachment;
  }

  async downloadFile(id: string, res: Response): Promise<void> {
    try {
      const attachment = await this.findOne(id);
      const filePath = attachment.path;
      
      // Check if file exists on disk
      try {
        await access(filePath);
      } catch {
        throw new NotFoundException(`File ${attachment.filename} not found on disk`);
      }

      // Encode filename properly for Content-Disposition header
      // Remove or replace invalid header characters
      const sanitizedFilename = attachment.originalName
        .replace(/[\r\n]/g, '') // Remove newlines and carriage returns
        .replace(/[^\x20-\x7E]/g, '_'); // Replace non-ASCII characters with underscore
      
      // Use RFC 5987 encoding for non-ASCII characters
      const encodedFilename = encodeURIComponent(attachment.originalName);
      const contentDisposition = `attachment; filename="${sanitizedFilename}"; filename*=UTF-8''${encodedFilename}`;

      // Set response headers
      res.setHeader('Content-Disposition', contentDisposition);
      res.setHeader('Content-Type', attachment.mimetype);

      // Create read stream and pipe to response
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
      
      // Check if file exists on disk
      try {
        await access(filePath);
      } catch {
        throw new NotFoundException(`File ${attachment.filename} not found on disk`);
      }

      // Set response headers for viewing (not downloading)
      res.setHeader('Content-Type', attachment.mimetype);
      res.setHeader('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour

      // Create read stream and pipe to response
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


