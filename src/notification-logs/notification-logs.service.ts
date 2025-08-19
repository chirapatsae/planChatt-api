import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateNotificationLogDto } from './dto/create-notification-log.dto';
import { UpdateNotificationLogDto } from './dto/update-notification-log.dto';
import { NotificationLog, NotificationLogStatus } from './entities/notification-log.entity';

@Injectable()
export class NotificationLogsService {
  constructor(
    @InjectRepository(NotificationLog)
    private notificationLogRepository: Repository<NotificationLog>,
  ) {}

  async create(createNotificationLogDto: CreateNotificationLogDto): Promise<NotificationLog> {
    const notificationLog = this.notificationLogRepository.create(createNotificationLogDto);
    return this.notificationLogRepository.save(notificationLog);
  }

  async findAll(): Promise<NotificationLog[]> {
    return this.notificationLogRepository.find({
      relations: ['announcement', 'role'],
      order: { sentAt: 'DESC' },
    });
  }

  async findOne(id: string): Promise<NotificationLog> {
    const notificationLog = await this.notificationLogRepository.findOne({
      where: { id },
      relations: ['announcement', 'role'],
    });

    if (!notificationLog) {
      throw new NotFoundException(`NotificationLog with ID ${id} not found`);
    }

    return notificationLog;
  }

  async update(id: string, updateNotificationLogDto: UpdateNotificationLogDto): Promise<NotificationLog> {
    const notificationLog = await this.findOne(id);
    Object.assign(notificationLog, updateNotificationLogDto);
    return this.notificationLogRepository.save(notificationLog);
  }

  async remove(id: string): Promise<void> {
    const notificationLog = await this.findOne(id);
    await this.notificationLogRepository.remove(notificationLog);
  }

  async findByAnnouncement(announcementId: string): Promise<NotificationLog[]> {
    return this.notificationLogRepository.find({
      where: { announcementId },
      relations: ['role'],
      order: { sentAt: 'DESC' },
    });
  }

  async findByRole(roleId: string): Promise<NotificationLog[]> {
    return this.notificationLogRepository.find({
      where: { roleId },
      relations: ['announcement'],
      order: { sentAt: 'DESC' },
    });
  }

  async findByStatus(status: NotificationLogStatus): Promise<NotificationLog[]> {
    return this.notificationLogRepository.find({
      where: { status },
      relations: ['announcement', 'role'],
      order: { sentAt: 'DESC' },
    });
  }

  async logSuccess(announcementId: string, roleId: string): Promise<NotificationLog> {
    // ตรวจสอบจาก announcement_id และ role_id โดยตรง
    const existingLog = await this.notificationLogRepository.findOne({
      where: { 
        announcementId, 
        roleId
      }
    });

    if (existingLog) {
      // อัปเดต status เป็น SUCCESS ถ้ายังไม่ใช่
      if (existingLog.status !== NotificationLogStatus.SUCCESS) {
        existingLog.status = NotificationLogStatus.SUCCESS;
        existingLog.sentAt = new Date();
        return this.notificationLogRepository.save(existingLog);
      }
      return existingLog; // ไม่สร้างซ้ำ
    }

    return this.create({
      announcementId,
      roleId,
      sentAt: new Date().toISOString(),
      status: NotificationLogStatus.SUCCESS,
    });
  }

  async logFailure(announcementId: string, roleId: string, errorMessage: string): Promise<NotificationLog> {
    // ตรวจสอบจาก announcement_id และ role_id โดยตรง
    const existingLog = await this.notificationLogRepository.findOne({
      where: { 
        announcementId, 
        roleId
      }
    });

    if (existingLog) {
      // อัปเดต status และ errorMessage ถ้ายังไม่ใช่ FAILED
      if (existingLog.status !== NotificationLogStatus.FAILED) {
        existingLog.status = NotificationLogStatus.FAILED;
        existingLog.errorMessage = errorMessage;
        existingLog.sentAt = new Date();
        return this.notificationLogRepository.save(existingLog);
      }
      return existingLog; // ไม่สร้างซ้ำ
    }

    return this.create({
      announcementId,
      roleId,
      sentAt: new Date().toISOString(),
      status: NotificationLogStatus.FAILED,
      errorMessage,
    });
  }
}
