import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from 'src/users/entities/user.entity';

/**
 * Wave 97 — Quota Alert configuration row.
 *
 * Source of truth:
 *   - docs/tasks/wave97/W97-MIGRATION.md (table contract)
 *   - docs/tasks/wave97/W97-API-QUOTA.md  (W97-amendment / OpenAI-inspired)
 *   - CLAUDE.md §17.3 (audit isolation — NO FK to project tables)
 *   - CLAUDE.md §12   (alert worker MUST NOT write tracking_status)
 *   - W83 — recipient_email is operator metadata (super-admin); MUST be
 *     masked in any log line via `maskEmail`.
 *
 * Invariants:
 *   - `channel` ∈ { 'email', 'line' } (DB CHECK + DTO validation).
 *   - `thresholdPercent` 1..200 inclusive (overage configurations allowed).
 *   - `recipientEmail` MUST validate as `@IsEmail`.
 *   - `createdByUserId` FK → `users.id` ON DELETE SET NULL — nullable so
 *     hard-delete of an admin user does not destroy alert config history.
 *   - `lastFiredAt` and `lastFiredWindowKey` are owned by the worker; the
 *     CRUD endpoints MUST NOT mutate them.
 *
 * The table itself is created by the W97-MIGRATION task (already shipped).
 * This entity merely binds the existing table for repository injection.
 */
@Entity('notification_quota_alerts')
@Index('ix_nqa_channel_enabled', ['channel', 'enabled'])
@Index('ix_nqa_created_by', ['createdByUserId'])
export class NotificationQuotaAlert {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 'email' | 'line' — DB-enforced via CHECK. */
  @Column({ name: 'channel', type: 'varchar', length: 8 })
  channel: 'email' | 'line';

  /** 1..200 — DB-enforced via CHECK. */
  @Column({ name: 'threshold_percent', type: 'int' })
  thresholdPercent: number;

  /** Destination address (super-admin's mailbox). NOT a FK. */
  @Column({ name: 'recipient_email', type: 'varchar', length: 255 })
  recipientEmail: string;

  @Column({ name: 'enabled', type: 'boolean', default: true })
  enabled: boolean;

  /** Set by worker when an alert fires for the current window. */
  @Column({ name: 'last_fired_at', type: 'timestamptz', nullable: true })
  lastFiredAt: Date | null;

  /**
   * Per-window dedupe key. Email = `YYYY-MM-DD` (UTC). LINE = `YYYY-MM`
   * (UTC). Worker resets `lastFiredAt` to NULL when the current window
   * key differs from this stored value (rollover).
   */
  @Column({
    name: 'last_fired_window_key',
    type: 'varchar',
    length: 16,
    nullable: true,
  })
  lastFiredWindowKey: string | null;

  /**
   * FK → users(id) ON DELETE SET NULL. NULLABLE per migration (the
   * task spec corrected the earlier "NOT NULL + SET NULL" mutual
   * exclusion). API DTO enforces presence at insert time via the
   * controller capturing `req.user.userId`.
   */
  @Column({ name: 'created_by_user_id', type: 'uuid', nullable: true })
  createdByUserId: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'created_by_user_id' })
  createdByUser?: User | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
