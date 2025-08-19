import { UserNotificationStatus } from '../entities/user-notification.entity';

export class UserNotificationResponseDto {
  id: string;
  status: UserNotificationStatus;
  readAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  
  // Relations
  announcement?: {
    id: string;
    title: string;
    description?: string;
    status: string;
  };
  
  workHistory?: {
    id: string;
    user?: {
      id: string;
      firstname: string;
      lastname: string;
    };
    role?: {
      id: string;
      name: string;
    };
  };
} 