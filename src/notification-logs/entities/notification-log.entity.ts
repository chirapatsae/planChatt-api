import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Announcement } from 'src/announcements/entities/announcement.entity';
import { Role } from 'src/roles/entities/role.entity';

export enum NotificationLogStatus {
  SUCCESS = 'success',
  FAILED = 'failed',
}

@Entity('notification_logs')
export class NotificationLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  announcementId: string;

  @Column({ type: 'uuid' })
  roleId: string;

  @Column({ type: 'timestamp' })
  sentAt: Date;

  @Column({
    type: 'enum',
    enum: NotificationLogStatus,
  })
  status: NotificationLogStatus;

  @Column({ type: 'text', nullable: true })
  errorMessage: string;

  @ManyToOne(() => Announcement, (announcement) => announcement.notificationLogs, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'announcement_id' })
  announcement: Announcement;

  @ManyToOne(() => Role, (role) => role.notificationLogs, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'role_id' })
  role: Role;
}
