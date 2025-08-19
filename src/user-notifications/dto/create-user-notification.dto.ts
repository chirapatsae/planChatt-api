import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { UserNotificationStatus } from '../entities/user-notification.entity';

export class CreateUserNotificationDto {
  @IsUUID()
  announcementId: string;

  @IsUUID()
  workHistoryId: string;

  @IsOptional()
  @IsEnum(UserNotificationStatus)
  status?: UserNotificationStatus;
} 