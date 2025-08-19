import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { AnnouncementsModule } from 'src/announcements/announcements.module';
import { NotificationLogsModule } from 'src/notification-logs/notification-logs.module';
import { UserNotificationsModule } from 'src/user-notifications/user-notifications.module';
import { WebsocketModule } from 'src/websocket/websocket.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    AnnouncementsModule,
    NotificationLogsModule,
    UserNotificationsModule,
    WebsocketModule,
  ],
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {} 