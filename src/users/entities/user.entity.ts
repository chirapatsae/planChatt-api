import { Exclude, Transform } from 'class-transformer';
import { AiUsageQuota } from 'src/ai-usage-quotas/entities/ai-usage-quota.entity';
import { Favorite } from 'src/favorite/entities/favorite.entity';
import { Position } from 'src/positions/entities/position.entity';
import { UserActivityLog } from 'src/user-activity-logs/entities/user-activity-log.entity';
import { UserNotification } from 'src/user-notifications/entities/user-notification.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import {
  Column,
  DeleteDateColumn,
  Entity,
  JoinColumn,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'citizen_id', unique: true })
  citizenId: string;

  @Column({ name: 'citizen_id_hash', unique: true })
  @Exclude()
  citizenIdHash: string;

  @Column()
  prefix: string;

  @Column()
  firstname: string;

  @Column()
  lastname: string;

  @Column({ nullable: true, unique: true })
  email?: string;

  @Column({ nullable: true, unique: true })
  phone?: string;

  @Column({ name: 'profile_image_url', nullable: true })
  @Transform(({ value }) => {
    if (!value) return null;

    const appUrl = process.env.APP_URL;

    // ถ้า value เป็นแค่ชื่อไฟล์ เช่น profile-123.jpg
    return `${appUrl}${value}`;
  })
  profileImageUrl?: string;

  @Column({ name: 'is_first_login', default: true })
  isFirstLogin: boolean;

  @DeleteDateColumn({ nullable: true, name: 'delete_at' })
  @Exclude()
  deletedAt?: Date;

  @Column({ default: () => 'CURRENT_TIMESTAMP', name: 'create_at' })
  createAt: Date;

  @Column({ name: 'allow_email_notification', default: true })
  allowEmailNotification: boolean;

  @Column({ name: 'allow_line_notification', default: true })
  allowLineNotification: boolean;

  @Column({ name: 'line_id', nullable: true })
  lineId?: string;

  @OneToMany(() => WorkHistory, (workHistory) => workHistory.user, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  workHistory: WorkHistory[];

  @OneToMany(() => WorkHistory, (workHistory) => workHistory.createdBy, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  createdWorkHistory: WorkHistory[];

  @OneToMany(() => WorkHistory, (workHistory) => workHistory.updatedBy, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  updatedWorkHistory: WorkHistory[];

  @OneToMany(() => Position, (position) => position.user, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  position: Position[];

  @OneToMany(() => UserActivityLog, (userActivityLog) => userActivityLog.createdBy, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  userActivityLogs: UserActivityLog[];

  @OneToOne(() => AiUsageQuota, (aiUsageQuota) => aiUsageQuota.user)
  aiUsageQuota?: AiUsageQuota;

  @OneToMany(() => UserNotification, (userNotification) => userNotification.user, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  userNotifications: UserNotification[];

  @OneToMany(() => Favorite, (favorite) => favorite.userId, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  favorites: Favorite[];
}
