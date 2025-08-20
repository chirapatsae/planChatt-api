import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { CreateUserNotificationDto } from './dto/create-user-notification.dto';
import { UpdateUserNotificationDto } from './dto/update-user-notification.dto';
import { UserNotification, UserNotificationStatus } from './entities/user-notification.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { handleException } from 'src/util/handleException';

@Injectable()
export class UserNotificationsService {
  private readonly logger = new Logger(UserNotificationsService.name);

  constructor(
    @InjectRepository(UserNotification)
    private userNotificationRepository: Repository<UserNotification>,
    @InjectRepository(WorkHistory)
    private workHistoryRepository: Repository<WorkHistory>,
  ) {}

  /**
   * Create a new user notification
   */
  async create(createUserNotificationDto: CreateUserNotificationDto): Promise<UserNotification> {
    try {
      const userNotification = this.userNotificationRepository.create(createUserNotificationDto);
      return await this.userNotificationRepository.save(userNotification);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * Get all user notifications
   */
  async findAll(): Promise<UserNotification[]> {
    try {
      return await this.userNotificationRepository.find({
        relations: ['announcement', 'workHistory', 'workHistory.user', 'workHistory.role'],
        order: { createdAt: 'DESC' },
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * Get user notifications by user ID (from JWT)
   */
  async findByUserId(userId: string): Promise<UserNotification[]> {
    try {
      // Find workHistory from userId
      const workHistory = await this.workHistoryRepository.findOne({
        where: { user: { id: userId }, isCurrent: true },
        relations: ['user', 'role'],
      });

      if (!workHistory) {
        this.logger.warn(`No current workHistory found for user ${userId}`);
        return [];
      }

      // Use workHistory.id to find user notifications
      return await this.userNotificationRepository.find({
        where: { workHistory: { id: workHistory.id } },
        relations: ['announcement'],
        order: { createdAt: 'DESC' },
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * Get unread count for a user
   */
  async getUnreadCount(userId: string): Promise<number> {
    try {
      const workHistory = await this.workHistoryRepository.findOne({
        where: { user: { id: userId }, isCurrent: true },
        relations: ['user', 'role'],
      });

      if (!workHistory) {
        return 0;
      }

      return await this.userNotificationRepository.count({
        where: {
          workHistory: { id: workHistory.id },
          status: UserNotificationStatus.UNREAD
        },
      });
    } catch (error) {
      handleException(this.logger, error);
      return 0;
    }
  }

  /**
   * Get user notifications by work history ID
   */
  async findByWorkHistory(workHistoryId: string): Promise<UserNotification[]> {
    try {
      return await this.userNotificationRepository.find({
        where: { workHistory: { id: workHistoryId } },
        relations: ['announcement'],
        order: { createdAt: 'DESC' },
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * Get a single user notification by ID
   */
  async findOne(id: string): Promise<UserNotification> {
    try {
      const userNotification = await this.userNotificationRepository.findOne({
        where: { id },
        relations: ['announcement', 'workHistory', 'workHistory.user', 'workHistory.role'],
      });

      if (!userNotification) {
        throw new NotFoundException(`UserNotification with ID ${id} not found`);
      }

      return userNotification;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * Mark a notification as read
   */
  async markAsRead(id: string): Promise<UserNotification> {
    try {
      const userNotification = await this.findOne(id);

      if (userNotification.status === UserNotificationStatus.UNREAD) {
        userNotification.status = UserNotificationStatus.READ;
        userNotification.readAt = new Date();
        return await this.userNotificationRepository.save(userNotification);
      }

      return userNotification;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * Mark multiple notifications as read
   */
  async markAsReadBulk(ids: string[]): Promise<UserNotification[]> {
    try {
      const userNotifications = await this.userNotificationRepository.findBy({ id: In(ids) });

      const updatedNotifications = userNotifications.map(notification => {
        if (notification.status === UserNotificationStatus.UNREAD) {
          notification.status = UserNotificationStatus.READ;
          notification.readAt = new Date();
        }
        return notification;
      });

      return await this.userNotificationRepository.save(updatedNotifications);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * Mark all notifications as read for a work history
   */
  async markAllAsRead(workHistoryId: string): Promise<void> {
    try {
      await this.userNotificationRepository.update(
        {
          workHistory: { id: workHistoryId },
          status: UserNotificationStatus.UNREAD
        },
        {
          status: UserNotificationStatus.READ,
          readAt: new Date()
        }
      );
      
      this.logger.log(`Marked all notifications as read for workHistory ${workHistoryId}`);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * Delete a user notification
   */
  async remove(id: string): Promise<void> {
    try {
      const userNotification = await this.findOne(id);
      await this.userNotificationRepository.remove(userNotification);
      this.logger.log(`Deleted user notification ${id}`);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * Create bulk notifications for an announcement
   */
  async createBulk(announcement: any, workHistories: any[]): Promise<UserNotification[]> {
    try {
      // Check existing notifications by announcement_id and work_history_id
      const existingNotifications = await this.userNotificationRepository.find({
        where: {
          announcement: { id: announcement.id },
          workHistory: { id: In(workHistories.map(wh => wh.id)) }
        },
        select: ['workHistory']
      });

      const existingWorkHistoryIds = existingNotifications.map(n => n.workHistory.id);

      // Create only for workHistories that don't have notifications yet
      const newWorkHistories = workHistories.filter(wh =>
        !existingWorkHistoryIds.includes(wh.id)
      );

      if (newWorkHistories.length === 0) {
        this.logger.log(`All user notifications already exist for announcement ${announcement.id}`);
        return [];
      }

      const userNotifications = newWorkHistories.map(workHistory =>
        this.userNotificationRepository.create({
          announcement,
          workHistory,
          status: UserNotificationStatus.UNREAD,
        })
      );

      const savedNotifications = await this.userNotificationRepository.save(userNotifications);
      this.logger.log(`Created ${savedNotifications.length} new user notifications for announcement ${announcement.id}`);

      return savedNotifications;
    } catch (error) {
      handleException(this.logger, error);
    }
  }
} 