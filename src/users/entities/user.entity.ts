import { Exclude } from 'class-transformer';
import { AiUsageQuota } from 'src/ai-usage-quotas/entities/ai-usage-quota.entity';
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

  @Column({ name: 'is_first_login', default: true })
  isFirstLogin: boolean;

  @DeleteDateColumn({ nullable: true, name: 'delete_at' })
  @Exclude()
  deletedAt?: Date;

  @Column({ default: () => 'CURRENT_TIMESTAMP', name: 'create_at' })
  createAt: Date;

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
  @JoinColumn({ name: 'ai_usage_quota_id' })
  aiUsageQuota?: AiUsageQuota;

  @OneToMany(() => UserNotification, (userNotification) => userNotification.user, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  userNotifications: UserNotification[];
}
