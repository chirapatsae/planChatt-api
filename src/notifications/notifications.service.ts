import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AnnouncementsService } from 'src/announcements/announcements.service';
import { NotificationLogsService } from 'src/notification-logs/notification-logs.service';
import { UserNotificationsService } from 'src/user-notifications/user-notifications.service';
import { AnnouncementStatus, NotificationStatus } from 'src/announcements/entities/announcement.entity';
import { WebsocketService } from 'src/websocket/websocket/websocket.service';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly announcementsService: AnnouncementsService,
    private readonly notificationLogsService: NotificationLogsService,
    private readonly userNotificationsService: UserNotificationsService,
    private readonly webSocketService: WebsocketService,
  ) {}

  @Cron('0 */1 * * * *') // ทุก 1 นาที
  async handleScheduledAnnouncements() {
    this.logger.log('🕐 === CRON JOB STARTED ===');
    this.logger.log(`Timestamp: ${new Date().toISOString()}`);
    
    try {
      // Step 1: Process SCHEDULED → PUBLISHED
      this.logger.log('📅 Step 1: Processing SCHEDULED → PUBLISHED');
      await this.processScheduledToPublished();
      
      // Step 2: Send notifications for PUBLISHED + pending
      this.logger.log('📢 Step 2: Sending pending notifications');
      await this.sendPendingNotifications();
      
      this.logger.log('✅ === CRON JOB COMPLETED ===');
    } catch (error) {
      this.logger.error('❌ === CRON JOB ERROR ===');
      this.logger.error('Error processing scheduled announcements:', error);
    }
  }

  private async processScheduledToPublished(): Promise<void> {
    this.logger.log('Processing scheduled to published announcements...');
    await this.announcementsService.processScheduledToPublished();
  }

  private async sendPendingNotifications(): Promise<void> {
    this.logger.log('📢 === SENDING PENDING NOTIFICATIONS ===');
    
    try {
      const pendingAnnouncements = await this.announcementsService.getPendingNotifications();
      this.logger.log(`Found ${pendingAnnouncements.length} pending announcements`);
      
      if (pendingAnnouncements.length === 0) {
        this.logger.log('ℹ️ No pending announcements to process');
        return;
      }
      
      for (const announcement of pendingAnnouncements) {
        this.logger.log(`📋 Processing announcement: ${announcement.id} - "${announcement.title}"`);
        try {
          await this.sendNotificationsToAnnouncementRoles(announcement);
        } catch (error) {
          this.logger.error(`❌ Error processing announcement ${announcement.id}:`, error);
        }
      }
      
      this.logger.log(`✅ Completed processing ${pendingAnnouncements.length} announcements`);
    } catch (error) {
      this.logger.error('❌ Error sending pending notifications:', error);
    }
  }

  private async sendNotificationsToAnnouncementRoles(announcement: any) {
    this.logger.log(`=== START PROCESSING ANNOUNCEMENT: ${announcement.id} ===`);
    this.logger.log(`Announcement Title: ${announcement.title}`);
    this.logger.log(`Current Status: ${announcement.notificationStatus}`);
    
    if (!announcement.announcementRoles || announcement.announcementRoles.length === 0) {
      this.logger.warn(`No announcement roles assigned to announcement ${announcement.id}`);
      return;
    }

    this.logger.log(`Found ${announcement.announcementRoles.length} announcement roles`);

    // ตรวจสอบ status จาก database อีกครั้งเพื่อป้องกัน race condition
    const currentAnnouncement = await this.announcementsService.findOne(announcement.id);
    this.logger.log(`Database Status Check: ${currentAnnouncement.notificationStatus}`);
    
    if (currentAnnouncement.notificationStatus !== NotificationStatus.PENDING) {
      this.logger.log(`Announcement ${announcement.id} already processed with status: ${currentAnnouncement.notificationStatus}`);
      return;
    }

    let allSuccess = true;
    let hasFailures = false;

    // Collect all workHistories for the roles
    const allWorkHistories: any[] = [];
    
    for (const announcementRole of announcement.announcementRoles) {
      try {
        this.logger.log(`--- Processing Role: ${announcementRole.role.name} (${announcementRole.role.id}) ---`);
        
        // Get all workHistories for this role
        const workHistories = await this.announcementsService.getWorkHistoriesByRole(announcementRole.role.id);
        this.logger.log(`Found ${workHistories.length} work histories for role ${announcementRole.role.name}`);
        
        // Log work history details
        workHistories.forEach((wh, index) => {
          this.logger.log(`  WorkHistory ${index + 1}: ${wh.id} - User: ${wh.user?.firstname} ${wh.user?.lastname}`);
        });
        
        allWorkHistories.push(...workHistories);
        
        // Simulate sending push notification
        const success = await this.sendPushNotification(announcement, announcementRole.role);
        
        // Send WebSocket notification to all users with this role
        try {
          for (const workHistory of workHistories) {
            if (workHistory.user?.id) {
              await this.webSocketService.notifyUser({
                userId: workHistory.user.id,
                event: 'announcement-received',
                data: {
                  announcementId: announcement.id,
                  announcementTitle: announcement.title,
                  roleName: announcementRole.role.name,
                  message: `New announcement: ${announcement.title}`,
                },
              });
            }
          }
        } catch (wsError) {
          this.logger.error('Failed to send WebSocket notification:', wsError);
          // Don't fail the main operation if WebSocket fails
        }
        
        if (success) {
          await this.notificationLogsService.logSuccess(announcement.id, announcementRole.role.id);
          this.logger.log(`✅ Push notification sent successfully to role ${announcementRole.role.name}`);
        } else {
          allSuccess = false;
          hasFailures = true;
          await this.notificationLogsService.logFailure(
            announcement.id, 
            announcementRole.role.id, 
            'Failed to send push notification'
          );
          this.logger.log(`❌ Push notification failed for role ${announcementRole.role.name}`);
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

    // Create user notifications for all workHistories
    this.logger.log(`=== CREATING USER NOTIFICATIONS ===`);
    this.logger.log(`Total WorkHistories to process: ${allWorkHistories.length}`);
    
    if (allWorkHistories.length > 0) {
      try {
        this.logger.log(`WorkHistory Details:`);
        allWorkHistories.forEach((wh, index) => {
          this.logger.log(`  ${index + 1}. ID: ${wh.id}, User: ${wh.user?.firstname} ${wh.user?.lastname}, Role: ${wh.role?.name}`);
        });
        
        console.log('=== DEBUG: allWorkHistories ===');
        console.log(allWorkHistories);
        console.log('=== END DEBUG ===');
        
        const result = await this.userNotificationsService.createBulk(announcement, allWorkHistories);
        this.logger.log(`✅ Successfully created ${result.length} user notifications`);
        this.logger.log(`Created user notifications for ${allWorkHistories.length} work histories`);
      } catch (error) {
        this.logger.error('❌ Error creating user notifications:', error);
        allSuccess = false;
        hasFailures = true;
      }
    } else {
      this.logger.log(`⚠️ No work histories to create notifications for`);
    }

    // Update announcement notification status based on results
    this.logger.log(`=== UPDATING ANNOUNCEMENT STATUS ===`);
    this.logger.log(`All Success: ${allSuccess}, Has Failures: ${hasFailures}`);
    
    if (allSuccess) {
      await this.announcementsService.updateNotificationStatus(announcement.id, NotificationStatus.SENT);
      this.logger.log(`✅ Updated announcement status to SENT`);
    } else if (hasFailures) {
      await this.announcementsService.updateNotificationStatus(announcement.id, NotificationStatus.FAILED);
      this.logger.log(`❌ Updated announcement status to FAILED`);
    }

    this.logger.log(`=== COMPLETED PROCESSING ANNOUNCEMENT: ${announcement.id} ===`);
    this.logger.log(`Final Status: ${allSuccess ? 'SUCCESS' : 'FAILED'}`);
    this.logger.log(`Total WorkHistories Processed: ${allWorkHistories.length}`);
    this.logger.log(`===============================================`);
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

    // ตรวจสอบว่า announcement นี้ถูกประมวลผลไปแล้วหรือยัง
    if (announcement.notificationStatus !== NotificationStatus.PENDING) {
      throw new Error(`Announcement already processed with status: ${announcement.notificationStatus}`);
    }

    try {
      await this.sendNotificationsToAnnouncementRoles(announcement);
      return { message: 'Notifications sent successfully' };
    } catch (error) {
      throw error;
    }
  }
} 