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
  type: string;
  title: string;
  description?: string;
  status: AnnouncementStatus;
  publishDateTime?: Date;
  notificationStatus: NotificationStatus;
  createdAt: Date;
  updatedAt: Date;
  creator?: WorkHistoryDto;
  announcementRoles: AnnouncementRoleDto[];
} 