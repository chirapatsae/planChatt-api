import { AnnouncementStatus, NotificationStatus } from '../entities/announcement.entity';

export class RoleDto {
  id: string;
  name: string;
}

export class AnnouncementRoleDto {
  id: string;
  role: RoleDto;
}

export class WorkHistoryDto {
  id: string;
  user: {
    id: string;
    firstname: string;
    lastname: string;
    email?: string;
  };
}

export class AnnouncementResponseDto {
  id: string;
  title: string;
  description?: string;
  status: AnnouncementStatus;
  startDate?: Date;
  endDate?: Date;
  location?: string;
  publishDateTime?: Date;
  notificationStatus: NotificationStatus;
  createdAt: Date;
  updatedAt: Date;
  creator?: WorkHistoryDto;
  announcementRoles: AnnouncementRoleDto[];
} 