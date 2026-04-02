import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { AnnouncementRole } from 'src/announcement-roles/entities/announcement-role.entity';
import { NotificationLog } from 'src/notification-logs/entities/notification-log.entity';
import { UserNotification } from 'src/user-notifications/entities/user-notification.entity';

export enum AnnouncementStatus {
  DRAFT = 'draft',
  SCHEDULED = 'scheduled',
  PUBLISHED = 'published',
}

export enum NotificationStatus {
  PENDING = 'pending',
  SENT = 'sent',
  FAILED = 'failed',
}

export enum NotificationType {
  ANNOUNCEMENT = 'announcement',
  SYSTEM = 'system',
  ALERT = 'alert',
  GENERAL = 'general',
  EVENT = 'event',
  USER = 'user',
  PROJECT = 'project',
}

@Entity('announcements')
export class Announcement {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column({
    type: 'enum',
    enum: NotificationType,
    default: NotificationType.ANNOUNCEMENT,
  })
  type: NotificationType;

  @Column({
    type: 'enum',
    enum: AnnouncementStatus,
    default: AnnouncementStatus.DRAFT,
  })
  status: AnnouncementStatus;

  @Column({ type: 'timestamp', nullable: true })
  publishDateTime: Date;

  @Column({
    type: 'enum',
    enum: NotificationStatus,
    default: NotificationStatus.PENDING,
  })
  notificationStatus: NotificationStatus;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @ManyToOne(() => WorkHistory, (workHistory) => workHistory.creatorAnnoucements, { nullable: true })
  @JoinColumn({ name: 'created_by' })
  createdBy: WorkHistory;

  @DeleteDateColumn({ name: 'deleted_at', nullable: true })
  deletedAt?: Date;

  @OneToMany(() => AnnouncementRole, (announcementRole) => announcementRole.announcement, {
    cascade: true,
    onDelete: 'CASCADE',
  })
  announcementRoles: AnnouncementRole[];

  @OneToMany(() => NotificationLog, (notificationLog) => notificationLog.announcement, {
    cascade: true,
    onDelete: 'CASCADE',
  })
  notificationLogs: NotificationLog[];

  @OneToMany(() => UserNotification, (userNotification) => userNotification.announcement, {
    cascade: true,
    onDelete: 'CASCADE',
  })
  userNotifications: UserNotification[];


}
