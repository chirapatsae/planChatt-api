import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bull';
import { InjectQueue } from '@nestjs/bull';
import { Announcement, AnnouncementStatus, NotificationStatus } from './entities/announcement.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserNotificationsService } from '../user-notifications/user-notifications.service';
import { NotificationLogsService } from '../notification-logs/notification-logs.service';
import { WorkHistory } from '../work-history/entities/work-history.entity';


@Injectable()
export class AnnouncementSchedulerService {
  private readonly logger = new Logger(AnnouncementSchedulerService.name);

  constructor(
    @InjectQueue('announcements') private announcementQueue: Queue,
    @InjectRepository(Announcement)
    private announcementRepository: Repository<Announcement>,
    @InjectRepository(WorkHistory)
    private workHistoryRepository: Repository<WorkHistory>,
    private readonly userNotificationsService: UserNotificationsService,
    private readonly notificationLogsService: NotificationLogsService,
  ) {}

  async scheduleAnnouncement(announcement: Announcement): Promise<void> {
    if (announcement.status === AnnouncementStatus.SCHEDULED) {
      // Ensure publishDateTime is a valid Date object
      if (!announcement.publishDateTime || !(announcement.publishDateTime instanceof Date)) {
        this.logger.error(`Invalid publishDateTime for announcement ${announcement.id}: ${announcement.publishDateTime}`);
        throw new Error(`Invalid publishDateTime for announcement ${announcement.id}`);
      }
      
      const delay = announcement.publishDateTime.getTime() - Date.now();
      
      if (delay > 0) {
        // เพิ่ม task เข้า queue พร้อม delay
        await this.announcementQueue.add(
          'publish-announcement',
          { announcementId: announcement.id },
          { 
            delay, 
            jobId: `announcement-${announcement.id}`,
            removeOnComplete: true,
            removeOnFail: false
          }
        );
        
        this.logger.log(`📅 Scheduled announcement ${announcement.id} for ${new Date(announcement.publishDateTime).toISOString()}`);
      } else {
        // ถ้าเลยเวลาแล้ว ให้ publish ทันที
        this.logger.warn(`⚠️ Announcement ${announcement.id} is overdue, publishing immediately`);
        await this.publishAnnouncement(announcement.id);
      }
    }
  }

  async publishAnnouncement(announcementId: string): Promise<void> {
    try {
      this.logger.log(`🚀 Publishing announcement ${announcementId}`);
      
      // อัพเดท status เป็น PUBLISHED
      const announcement = await this.announcementRepository.findOne({
        where: { id: announcementId },
        relations: ['announcementRoles', 'announcementRoles.role'],
      });
      
      if (!announcement) {
        throw new Error(`Announcement ${announcementId} not found`);
      }
      
      announcement.status = AnnouncementStatus.PUBLISHED;
      announcement.publishDateTime = new Date();
      announcement.notificationStatus = NotificationStatus.PENDING;
      
      await this.announcementRepository.save(announcement);
      
      // ส่ง notifications ทันที + บันทึก user_notifications
      await this.sendNotificationsAndCreateUserNotifications(announcement);
      
      this.logger.log(`✅ Successfully published announcement ${announcementId}`);
    } catch (error) {
      this.logger.error(`❌ Failed to publish announcement ${announcementId}:`, error);
      throw error;
    }
  }

  // Cleanup เมื่อ server restart
  async rescheduleAllOnStartup(): Promise<void> {
    this.logger.log('🔄 Rescheduling all scheduled announcements on startup...');
    
    try {
      const scheduledAnnouncements = await this.announcementRepository.find({
        where: { status: AnnouncementStatus.SCHEDULED },
        relations: ['announcementRoles', 'announcementRoles.role'],
        order: { publishDateTime: 'ASC' },
      });
      
      this.logger.log(`Found ${scheduledAnnouncements.length} scheduled announcements`);
      
      for (const announcement of scheduledAnnouncements) {
        try {
          await this.scheduleAnnouncement(announcement);
        } catch (error) {
          this.logger.error(`Failed to schedule announcement ${announcement.id}:`, error);
          // Continue with other announcements instead of failing completely
        }
      }
      
      this.logger.log('✅ All scheduled announcements rescheduled successfully');
    } catch (error) {
      this.logger.error('❌ Failed to reschedule announcements on startup:', error);
    }
  }

  // ลบ scheduled job
  async removeScheduledAnnouncement(announcementId: string): Promise<void> {
    try {
      await this.announcementQueue.removeJobs(`announcement-${announcementId}`);
      this.logger.log(`🗑️ Removed scheduled announcement ${announcementId}`);
    } catch (error) {
      this.logger.error(`❌ Failed to remove scheduled announcement ${announcementId}:`, error);
    }
  }

  // ส่ง notifications และสร้าง user_notifications สำหรับ PUBLISHED announcements
  private async sendNotificationsAndCreateUserNotifications(announcement: Announcement): Promise<void> {
    if (!announcement.announcementRoles || announcement.announcementRoles.length === 0) {
      this.logger.warn(`No announcement roles assigned to announcement ${announcement.id}`);
      return;
    }

    try {
      this.logger.log(`📢 Sending notifications for announcement: ${announcement.title}`);
      
      const allWorkHistories: WorkHistory[] = [];
      
      // รวบรวม workHistories ของทุก roles
      for (const announcementRole of announcement.announcementRoles) {
        try {
          // หา users ที่มี role นี้
          const workHistories = await this.workHistoryRepository.find({
            where: { role: { id: announcementRole.role.id } },
            relations: ['user', 'role'],
          });
          
          this.logger.log(`Found ${workHistories.length} work histories for role ${announcementRole.role.name}`);
          allWorkHistories.push(...workHistories);
          
          // บันทึก notification logs สำหรับแต่ละ role
          await this.notificationLogsService.logSuccess(announcement.id, announcementRole.role.id);
          
        } catch (error) {
          this.logger.error(`Failed to process role ${announcementRole.role.id}:`, error);
        }
      }

      // สร้าง user_notifications สำหรับทุก users
      if (allWorkHistories.length > 0) {
        try {
          const result = await this.userNotificationsService.createBulk(announcement, allWorkHistories);
          this.logger.log(`✅ Successfully created ${result.length} user notifications for ${allWorkHistories.length} users`);
        } catch (error) {
          this.logger.error('❌ Error creating user notifications:', error);
          throw error;
        }
      } else {
        this.logger.warn(`⚠️ No work histories to create notifications for`);
      }
      
      // อัพเดท notification status เป็น SENT
      announcement.notificationStatus = NotificationStatus.SENT;
      await this.announcementRepository.save(announcement);
      
      this.logger.log(`✅ Successfully sent notifications for announcement: ${announcement.title}`);
    } catch (error) {
      this.logger.error(`❌ Failed to send notifications for announcement: ${announcement.title}:`, error);
      throw error;
    }
  }
} 