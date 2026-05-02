import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserNotificationsService } from './user-notifications.service';
import { UserNotificationsController } from './user-notifications.controller';
import { UserNotification } from './entities/user-notification.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { UsersModule } from 'src/users/users.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([UserNotification, WorkHistory]),
    // W89B — UsersService.decryptUserPii used in findByUserId to keep
    // ciphertext from leaking via /my-notifications.
    UsersModule,
  ],
  controllers: [UserNotificationsController],
  providers: [UserNotificationsService],
  exports: [UserNotificationsService],
})
export class UserNotificationsModule {} 