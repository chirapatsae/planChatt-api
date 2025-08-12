import { IsDateString, IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
import { NotificationLogStatus } from '../entities/notification-log.entity';

export class CreateNotificationLogDto {
  @IsUUID()
  announcementId: string;

  @IsUUID()
  roleId: string;

  @IsDateString()
  sentAt: string;

  @IsEnum(NotificationLogStatus)
  status: NotificationLogStatus;

  @IsOptional()
  @IsString()
  errorMessage?: string;
}
