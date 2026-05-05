import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { CreateUserNotificationDto } from './dto/create-user-notification.dto';
import { UpdateUserNotificationDto } from './dto/update-user-notification.dto';
import { UserNotification, UserNotificationStatus } from './entities/user-notification.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { handleException } from 'src/util/handleException';
import { UsersService } from 'src/users/users.service';

@Injectable()
export class UserNotificationsService {
  private readonly logger = new Logger(UserNotificationsService.name);

  constructor(
    @InjectRepository(UserNotification)
    private userNotificationRepository: Repository<UserNotification>,
    @InjectRepository(WorkHistory)
    private workHistoryRepository: Repository<WorkHistory>,
    // W89B — used to decrypt the embedded `announcement.createdBy.user`
    // before returning UserNotification rows. The `findByUserId` path is
    // hit by GET /v1/user-notifications/my-notifications and would
    // otherwise leak `iv:ciphertext` to the FE.
    private readonly usersService: UsersService,
  ) { }

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
      const notifications = await this.userNotificationRepository.find({
        where: { user: { id: workHistory.user.id } },
        relations: ['announcement', 'announcement.createdBy', 'announcement.createdBy.user'],
        order: { createdAt: 'DESC' },
      });

      // W89B — decrypt the embedded creator User on every row before the
      // payload leaves the service. Without this, `announcement.createdBy
      // .user.email/.phone` would be `iv:ciphertext` strings on the wire.
      // `decryptUserPii` is idempotent so a repeat call on a cached entity
      // is safe.
      for (const n of notifications) {
        if (n.announcement?.createdBy?.user) {
          await this.usersService.decryptUserPii(n.announcement.createdBy.user);
        }
      }
      return notifications;
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

  /**
   * Mark every unread `UserNotification` for the given user as read.
   * Returns how many rows were affected (0 when there is nothing to flip).
   *
   * Owner-scoped via `user_id`; no privilege escalation. Idempotent —
   * already-read rows are skipped by the WHERE clause.
   */
  async markAllAsRead(userId: string): Promise<{ markedCount: number }> {
    try {
      const result = await this.userNotificationRepository
        .createQueryBuilder()
        .update(UserNotification)
        .set({
          status: UserNotificationStatus.READ,
          readAt: () => 'NOW()',
        })
        .where('user_id = :userId', { userId })
        .andWhere('status = :unread', { unread: UserNotificationStatus.UNREAD })
        .execute();
      return { markedCount: result.affected ?? 0 };
    } catch (error) {
      handleException(this.logger, error);
      return { markedCount: 0 };
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