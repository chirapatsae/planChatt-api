import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AnnouncementsService } from 'src/announcements/announcements.service';
import { NotificationLogsService } from 'src/notification-logs/notification-logs.service';
import { AnnouncementStatus, NotificationStatus } from 'src/announcements/entities/announcement.entity';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly announcementsService: AnnouncementsService,
    private readonly notificationLogsService: NotificationLogsService,
  ) {}

  @Cron('0 */5 * * * *') // ทุก 5 นาที
  async handleScheduledAnnouncements() {
    this.logger.log('Checking for scheduled announcements...');
    
    try {
      // Step 1: Process SCHEDULED → PUBLISHED
      await this.processScheduledToPublished();
      
      // Step 2: Send notifications for PUBLISHED + pending
      await this.sendPendingNotifications();
    } catch (error) {
      this.logger.error('Error processing scheduled announcements:', error);
    }
  }

  private async processScheduledToPublished(): Promise<void> {
    this.logger.log('Processing scheduled to published announcements...');
    await this.announcementsService.processScheduledToPublished();
  }

  private async sendPendingNotifications(): Promise<void> {
    this.logger.log('Sending pending notifications...');
    
    try {
      const pendingAnnouncements = await this.announcementsService.getPendingNotifications();
      
      for (const announcement of pendingAnnouncements) {
        await this.sendNotificationsToAnnouncementRoles(announcement);
      }
    } catch (error) {
      this.logger.error('Error sending pending notifications:', error);
    }
  }

  private async sendNotificationsToAnnouncementRoles(announcement: any) {
    if (!announcement.announcementRoles || announcement.announcementRoles.length === 0) {
      this.logger.warn(`No announcement roles assigned to announcement ${announcement.id}`);
      return;
    }

    let allSuccess = true;
    let hasFailures = false;

    // Send notifications to each announcement-role (not directly to roles)
    for (const announcementRole of announcement.announcementRoles) {
      try {
        // Simulate sending push notification
        const success = await this.sendPushNotification(announcement, announcementRole.role);
        
        if (success) {
          await this.notificationLogsService.logSuccess(announcement.id, announcementRole.role.id);
        } else {
          allSuccess = false;
          hasFailures = true;
          await this.notificationLogsService.logFailure(
            announcement.id, 
            announcementRole.role.id, 
            'Failed to send push notification'
          );
        }
      } catch (error) {
        allSuccess = false;
        hasFailures = true;
        this.logger.error(`Error sending notification to announcement role ${announcementRole.id}:`, error);
        await this.notificationLogsService.logFailure(
          announcement.id, 
          announcementRole.role.id, 
          error.message
        );
      }
    }

    // Update announcement notification status based on results
    if (allSuccess) {
      await this.announcementsService.updateNotificationStatus(announcement.id, NotificationStatus.SENT);
    } else if (hasFailures) {
      await this.announcementsService.updateNotificationStatus(announcement.id, NotificationStatus.FAILED);
    }

    this.logger.log(`Completed processing notifications for announcement ${announcement.id}`);
  }

  private async sendPushNotification(announcement: any, role: any): Promise<boolean> {
    // This is a placeholder for actual push notification logic
    // In a real implementation, you would integrate with FCM, APNS, or other push services
    
    this.logger.log(`Sending push notification to role ${role.name} for announcement: ${announcement.title}`);
    
    // Simulate API call delay
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Simulate success (90% success rate)
    return Math.random() > 0.1;
  }

  async sendImmediateNotification(announcementId: string) {
    const announcement = await this.announcementsService.findOne(announcementId);
    
    if (announcement.status !== AnnouncementStatus.PUBLISHED) {
      throw new Error('Announcement must be published to send immediate notifications');
    }

    await this.sendNotificationsToAnnouncementRoles(announcement);
    return { message: 'Notifications sent successfully' };
  }
} 