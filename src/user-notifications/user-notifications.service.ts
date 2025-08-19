import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { CreateUserNotificationDto } from './dto/create-user-notification.dto';
import { UpdateUserNotificationDto } from './dto/update-user-notification.dto';
import { UserNotification, UserNotificationStatus } from './entities/user-notification.entity';
import { handleException } from 'src/util/handleException';

@Injectable()

export class UserNotificationsService {
  private readonly logger = new Logger(UserNotificationsService.name);

  constructor(
    @InjectRepository(UserNotification)
    private userNotificationRepository: Repository<UserNotification>,
    @InjectRepository(WorkHistory)
    private workHistoryRepository: Repository<WorkHistory>,

  ) { }

  async create(createUserNotificationDto: CreateUserNotificationDto): Promise<UserNotification> {
    const userNotification = this.userNotificationRepository.create(createUserNotificationDto);
    return this.userNotificationRepository.save(userNotification);
  }

  async createBulk(announcement: any, workHistories: any[]): Promise<UserNotification[]> {
    // ตรวจสอบจาก announcement_id และ work_history_id โดยตรง
    const existingNotifications = await this.userNotificationRepository.find({
      where: {
        announcement: { id: announcement.id },
        workHistory: { id: In(workHistories.map(wh => wh.id)) }
      },
      select: ['workHistory']
    });

    const existingWorkHistoryIds = existingNotifications.map(n => n.workHistory.id);

    // สร้างเฉพาะ workHistories ที่ยังไม่มี notification
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
  }

  async findAll(): Promise<UserNotification[]> {
    return this.userNotificationRepository.find({
      relations: ['announcement', 'workHistory', 'workHistory.user', 'workHistory.role'],
      order: { createdAt: 'DESC' },
    });
  }

  async findOne(id: string): Promise<UserNotification> {
    const userNotification = await this.userNotificationRepository.findOne({
      where: { id },
      relations: ['announcement', 'workHistory', 'workHistory.user', 'workHistory.role'],
    });

    if (!userNotification) {
      throw new NotFoundException(`UserNotification with ID ${id} not found`);
    }

    return userNotification;
  }

  async findByUserId(userId: string): Promise<UserNotification[]> {
    // หา workHistory จาก userId
    const workHistory = await this.workHistoryRepository.findOne({
      where: { user: { id: userId } },
      relations: ['user', 'role'],
    });

    if (!workHistory) {
      throw new NotFoundException(`WorkHistory with user ID ${userId} not found`);
    }

    // ใช้ workHistory.id ไปหา user notifications
    return this.userNotificationRepository.find({
      where: { workHistory: { id: workHistory.id } },
      relations: ['announcement'],
      order: { createdAt: 'DESC' },
    });
  }

  async findByWorkHistory(workHistoryId: string): Promise<UserNotification[]> {
    return this.userNotificationRepository.find({
      where: { workHistory: { id: workHistoryId } },
      relations: ['announcement'],
      order: { createdAt: 'DESC' },
    });
  }

  async findByAnnouncement(announcementId: string): Promise<UserNotification[]> {
    return this.userNotificationRepository.find({
      where: { announcement: { id: announcementId } },
      relations: ['workHistory', 'workHistory.user', 'workHistory.role'],
      order: { createdAt: 'DESC' },
    });
  }

  async findByStatus(workHistoryId: string, status: UserNotificationStatus): Promise<UserNotification[]> {
    return this.userNotificationRepository.find({
      where: { workHistory: { id: workHistoryId }, status },
      relations: ['announcement'],
      order: { createdAt: 'DESC' },
    });
  }

  async getUnreadCount(userId: string): Promise<number> {
    try {
      const workHistory = await this.workHistoryRepository.findOne({
        where: { user: { id: userId } },
        relations: ['user', 'role'],
      });

      if (!workHistory) {
        return 0;
      }

      return this.userNotificationRepository.count({
        where: {
          workHistory: { id: workHistory?.id },
          status: UserNotificationStatus.UNREAD
        },
      });
    } catch (error) {
      handleException(this.logger, error)
    }

  }

  async markAsRead(id: string): Promise<UserNotification> {
    const userNotification = await this.findOne(id);

    if (userNotification.status === UserNotificationStatus.UNREAD) {
      userNotification.status = UserNotificationStatus.READ;
      userNotification.readAt = new Date();
      return this.userNotificationRepository.save(userNotification);
    }

    return userNotification;
  }

  async markAsReadBulk(ids: string[]): Promise<UserNotification[]> {
    const userNotifications = await this.userNotificationRepository.findByIds(ids);

    const updatedNotifications = userNotifications.map(notification => {
      if (notification.status === UserNotificationStatus.UNREAD) {
        notification.status = UserNotificationStatus.READ;
        notification.readAt = new Date();
      }
      return notification;
    });

    return this.userNotificationRepository.save(updatedNotifications);
  }

  async markAllAsRead(workHistoryId: string): Promise<void> {
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
  }



  async update(id: string, updateUserNotificationDto: UpdateUserNotificationDto): Promise<UserNotification> {
    const userNotification = await this.findOne(id);
    Object.assign(userNotification, updateUserNotificationDto);
    return this.userNotificationRepository.save(userNotification);
  }

  async remove(id: string): Promise<void> {
    const userNotification = await this.findOne(id);
    await this.userNotificationRepository.remove(userNotification);
  }

  async removeByAnnouncement(announcementId: string): Promise<void> {
    await this.userNotificationRepository.delete({ announcement: { id: announcementId } });
  }
} 