import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AnnouncementSchedulerService } from './announcement-scheduler.service';
import { AnnouncementQueueProcessor } from './announcement-queue.processor';
import { Announcement } from './entities/announcement.entity';
import { WorkHistory } from '../work-history/entities/work-history.entity';
import { UserNotificationsModule } from '../user-notifications/user-notifications.module';
import { NotificationLogsModule } from '../notification-logs/notification-logs.module';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'announcements',
    }),
    TypeOrmModule.forFeature([Announcement, WorkHistory]),
    UserNotificationsModule,
    NotificationLogsModule,
  ],
  providers: [AnnouncementSchedulerService, AnnouncementQueueProcessor],
  exports: [AnnouncementSchedulerService],
})
export class AnnouncementSchedulerModule {} 