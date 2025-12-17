import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { writeFile, mkdir, unlink, access } from 'fs/promises';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { Response } from 'express';
import { createReadStream } from 'fs';
import { AttachmentEvent } from './entities/attachment-event.entity';
import { CreateAttachmentEventDto } from './dto/create-attachment-event.dto';
import { UpdateAttachmentEventDto } from './dto/update-attachment-event.dto';

@Injectable()
export class AttachmentEventService {
  private readonly logger = new Logger(AttachmentEventService.name);
  private readonly uploadDir = 'uploads/events';

  constructor(
    @InjectRepository(AttachmentEvent)
    private readonly attachmentEventRepository: Repository<AttachmentEvent>,
  ) {}

  async create(createAttachmentEventDto: CreateAttachmentEventDto): Promise<AttachmentEvent> {
    try {
      const attachment = this.attachmentEventRepository.create(createAttachmentEventDto);
      const savedAttachment = await this.attachmentEventRepository.save(attachment);
      
      this.logger.log(`Attachment created successfully: ${savedAttachment.filename}`);
      return savedAttachment;
    } catch (error) {
      this.logger.error(`Error creating attachment: ${error.message}`, error.stack);
      throw error;
    }
  }

  async findAll(): Promise<AttachmentEvent[]> {
    try {
      return await this.attachmentEventRepository.find({
        relations: ['event'],
      });
    } catch (error) {
      this.logger.error(`Error fetching attachments: ${error.message}`, error.stack);
      throw error;
    }
  }

  async findByEventId(eventId: string): Promise<AttachmentEvent[]> {
    try {
      return await this.attachmentEventRepository.find({
        where: { eventId },
        relations: ['event'],
      });
    } catch (error) {
      this.logger.error(`Error fetching attachments for event ${eventId}: ${error.message}`, error.stack);
      throw error;
    }
  }

  async findOne(id: string): Promise<AttachmentEvent> {
    try {
      const attachment = await this.attachmentEventRepository.findOne({
        where: { id },
        relations: ['event'],
      });

      if (!attachment) {
        throw new NotFoundException(`Attachment with ID ${id} not found`);
      }

      return attachment;
    } catch (error) {
      this.logger.error(`Error fetching attachment ${id}: ${error.message}`, error.stack);
      throw error;
    }
  }

  async update(id: string, updateAttachmentEventDto: UpdateAttachmentEventDto): Promise<AttachmentEvent> {
    try {
      const attachment = await this.findOne(id);
      
      // อัปเดตข้อมูล
      Object.assign(attachment, updateAttachmentEventDto);
      
      const updatedAttachment = await this.attachmentEventRepository.save(attachment);
      
      this.logger.log(`Attachment updated successfully: ${updatedAttachment.filename}`);
      return updatedAttachment;
    } catch (error) {
      this.logger.error(`Error updating attachment ${id}: ${error.message}`, error.stack);
      throw error;
    }
  }


  async remove(id: string): Promise<void> {
    try {
      const attachment = await this.findOne(id);
      
      // ลบไฟล์จาก disk
      await this.deleteFileFromDisk(attachment.path);
      
      // ลบข้อมูลจาก database
      await this.attachmentEventRepository.softDelete(id);
      
      this.logger.log(`Attachment deleted successfully: ${attachment.filename}`);
    } catch (error) {
      this.logger.error(`Error deleting attachment ${id}: ${error.message}`, error.stack);
      throw error;
    }
  }

  async uploadFile(file: Express.Multer.File, eventId: string): Promise<AttachmentEvent> {
    try {
      // Ensure upload directory exists
      await mkdir(this.uploadDir, { recursive: true });

      // Generate unique filename
      const fileExtension = file.originalname.split('.').pop();
      const filename = `${uuidv4()}.${fileExtension}`;
      const filePath = join(this.uploadDir, filename);

      // Write file to disk
      await writeFile(filePath, file.buffer);

      // Create attachment record
      const createDto: CreateAttachmentEventDto = {
        filename,
        originalName: file.originalname,
        mimetype: file.mimetype,
        size: file.size,
        path: filePath,
        eventId,
      };

      const attachment = await this.create(createDto);
      
      this.logger.log(`File uploaded successfully: ${filename}`);
      return attachment;
    } catch (error) {
      this.logger.error(`Error uploading file: ${error.message}`, error.stack);
      throw error;
    }
  }

  async uploadMultipleFiles(files: Express.Multer.File[], eventId: string): Promise<AttachmentEvent[]> {
    const uploadPromises = files.map(file => this.uploadFile(file, eventId));
    return Promise.all(uploadPromises);
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

  private async deleteFileFromDisk(filePath: string): Promise<void> {
    try {
      await unlink(filePath);
      this.logger.log(`File deleted from disk: ${filePath}`);
    } catch (error) {
      this.logger.error(`Error deleting file from disk: ${error.message}`, error.stack);
      // Don't throw error for file deletion failures
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
