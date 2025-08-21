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

  async create(createUserNotificationDto: CreateUserNotificationDto): Promise<UserNotification> {
    try {
      const userNotification = this.userNotificationRepository.create(createUserNotificationDto);
      return await this.userNotificationRepository.save(userNotification);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

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

      // Use user.id to find user notifications
      return await this.userNotificationRepository.find({
        where: { user: { id: workHistory.user.id } },
        relations: ['announcement', 'announcement.createdBy', 'announcement.createdBy.user'],
        order: { createdAt: 'DESC' },
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

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
          user: { id: workHistory.user.id },
          status: UserNotificationStatus.UNREAD
        },
      });
    } catch (error) {
      handleException(this.logger, error);
      return 0;
    }
  }

  async markAsRead(id: string): Promise<UserNotification> {
    try {
      const userNotification = await this.userNotificationRepository.findOne({ where: { id } });
      if (!userNotification) {
        throw new NotFoundException(`User notification with ID ${id} not found`);
      }

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

  async createBulk(announcement: any, workHistories: any[]): Promise<UserNotification[]> {
    try {
      // Check existing notifications by announcement_id and user_id
      const existingNotifications = await this.userNotificationRepository.find({
        where: {
          announcement: { id: announcement.id },
          user: { id: In(workHistories.map(wh => wh.user.id)) }
        },
        select: ['user']
      });

      const existingUserIds = existingNotifications.map(n => n.user.id);

      // Create only for users that don't have notifications yet
      const newWorkHistories = workHistories.filter(wh =>
        !existingUserIds.includes(wh.user.id)
      );

      if (newWorkHistories.length === 0) {
        this.logger.log(`All user notifications already exist for announcement ${announcement.id}`);
        return [];
      }

      const userNotifications = newWorkHistories.map(workHistory =>
        this.userNotificationRepository.create({
          announcement,
          user: workHistory.user,
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