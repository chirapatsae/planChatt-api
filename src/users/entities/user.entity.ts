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
  Index,
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

  /**
   * W89: AES-encrypted at rest (`iv:ciphertext`). UNIQUE constraint moved
   * to `emailHash` (deterministic HMAC over normalized form). Widened to
   * 512 chars to fit the ciphertext blob comfortably.
   */
  @Column({ nullable: true, length: 512 })
  email?: string;

  /**
   * W89: AES-encrypted at rest. UNIQUE moved to `phoneHash`.
   */
  @Column({ nullable: true, length: 512 })
  phone?: string;

  /**
   * W89: HMAC-SHA256(LOWER(TRIM(email))) — deterministic lookup + uniqueness
   * surrogate. Owned by `hashEmail` in `src/util/encryption.util.ts`.
   * Partial-unique index (`uq_users_email_hash WHERE email_hash IS NOT NULL`)
   * is created by the W89 migration; the entity-side index is a plain
   * b-tree alias for query planning.
   */
  @Index('idx_users_email_hash')
  @Column({ name: 'email_hash', nullable: true, length: 64 })
  @Exclude()
  emailHash?: string;

  /**
   * W89: HMAC-SHA256(digit-only phone). See `emailHash` notes.
   */
  @Index('idx_users_phone_hash')
  @Column({ name: 'phone_hash', nullable: true, length: 64 })
  @Exclude()
  phoneHash?: string;

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

  /**
   * W95: Timestamp at which the user's current email was verified via the
   * link-based verification flow. NULL means "not yet verified" — the
   * frontend uses this to render the verification banner / gate features
   * defined in W95-GATE.
   *
   * Reset to NULL automatically by `UsersService.update` whenever the
   * email column changes (compared via `email_hash`, never decrypted).
   * Set to NOW() by `UsersService.markEmailVerified` after the verify
   * endpoint validates the HMAC token.
   *
   * §17.3 — this column lives on the User entity, NOT on a project table;
   * the verification gate is integrity, not workflow authority (§4.1).
   */
  @Column({ name: 'email_verified_at', type: 'timestamptz', nullable: true })
  emailVerifiedAt: Date | null;

  /**
   * W106 (DB-PR1): Durable presence anchor. Updated by BE-PR1's debounced
   * heartbeat path (≤1 write per 30s per user). The live presence state
   * lives in Redis (`presence:user:<id>` with EXPIRE); this column is the
   * fall-back used to render "ออฟไลน์ — ใช้งานล่าสุด N นาทีที่แล้ว"
   * when the WS signal is unavailable (server restart, browser closed,
   * WS blocked).
   *
   * Nullable by design: a user who has never logged in (or who has not
   * logged in since the feature shipped) stays NULL. We deliberately do
   * NOT default to CURRENT_TIMESTAMP — that would imply every existing
   * user is currently online.
   *
   * §17.3 — this is metadata on the User entity, NOT a workflow audit
   * column. It MUST NOT be confused with TrackingStatus (§12). It does
   * not gate any workflow transition (§17.2 advisory framing applies by
   * analogy: presence is non-authoritative).
   *
   * Index `idx_users_last_seen_at` (plain b-tree) supports future
   * "recently seen" / stale-cleanup sweep queries from BE-PR1.
   */
  @Index('idx_users_last_seen_at')
  @Column({ name: 'last_seen_at', type: 'timestamptz', nullable: true })
  lastSeenAt: Date | null;

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
