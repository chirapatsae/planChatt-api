import { IsArray, IsDateString, IsEnum, IsOptional, IsString, IsUUID, ValidateIf } from 'class-validator';
import { AnnouncementStatus, NotificationType } from '../entities/announcement.entity';

export class CreateAnnouncementDto {
  @IsOptional()
  @IsEnum(NotificationType)
  type?: NotificationType;

  @IsString()
  title: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsEnum(AnnouncementStatus)
  status?: AnnouncementStatus;

  @ValidateIf((o) => o.status === AnnouncementStatus.SCHEDULED)
  @IsDateString()
  publishDateTime?: string;

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  roleIds?: string[];
}
