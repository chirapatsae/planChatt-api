import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AnnouncementsService } from './announcements.service';
import { AnnouncementsController } from './announcements.controller';
import { Announcement } from './entities/announcement.entity';
import { AnnouncementRole } from 'src/announcement-roles/entities/announcement-role.entity';
import { Role } from 'src/roles/entities/role.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { UserNotificationsModule } from '../user-notifications/user-notifications.module';
import { NotificationLogsModule } from '../notification-logs/notification-logs.module';
import { AnnouncementSchedulerModule } from './announcement-scheduler.module';
import { WebsocketModule } from '../websocket/websocket.module';
import { UsersModule } from 'src/users/users.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Announcement, AnnouncementRole, Role, WorkHistory]),
    UserNotificationsModule,
    NotificationLogsModule,
    AnnouncementSchedulerModule,
    WebsocketModule,
    // W89B — UsersService.decryptUserPii used in findAll/findOne to keep
    // ciphertext from leaking into the response payload.
    UsersModule,
  ],
  controllers: [AnnouncementsController],
  providers: [AnnouncementsService],
  exports: [AnnouncementsService],
})
export class AnnouncementsModule {}
