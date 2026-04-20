import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { User } from 'src/users/entities/user.entity';

/**
 * NotificationSetting — Wave 22 B2 global kill-switch config row.
 *
 * Source of truth:
 *   - docs/tasks/IMPLEMENT_EMAIL_KILL_SWITCH.md §8
 *   - Migration: backend/src/migrations/1746000000000-AddActorAndKillSwitchToNotifications.ts
 *   - CLAUDE.md §14.6 (user hard-delete MUST NOT destroy audit fields —
 *     `lastChangedBy` uses ON DELETE SET NULL)
 *
 * Invariants:
 *   - Singleton: only the 'global' row exists today. `id` is a short
 *     string to leave room for future per-scope settings without a
 *     schema change.
 *   - `emailEnabled` ships FALSE by default per user directive
 *     ("ปิดไว้ก่อน"). The toggle endpoint flips it and writes a row to
 *     `notification_settings_audit`.
 *   - This row does NOT gate any workflow transition. Its only effect
 *     is to short-circuit the email-dispatch path in
 *     `NotificationsService`.
 *
 * NOTE: This entity is intentionally NOT registered in any module in
 * this wave. B2 (backend kill-switch) will wire it into the wave-21
 * `NotificationsModule` via `TypeOrmModule.forFeature([...])`.
 */
@Entity('notification_settings')
export class NotificationSetting {
  /**
   * Singleton key. Currently always 'global'.
   */
  @PrimaryColumn({ name: 'id', type: 'varchar', length: 32 })
  id: string;

  @Column({ name: 'email_enabled', type: 'boolean', default: false })
  emailEnabled: boolean;

  @Column({
    name: 'last_changed_at',
    type: 'timestamptz',
    default: () => 'now()',
  })
  lastChangedAt: Date;

  @Column({ name: 'last_changed_by', type: 'uuid', nullable: true })
  lastChangedById: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'last_changed_by' })
  lastChangedBy?: User | null;

  @Column({
    name: 'created_at',
    type: 'timestamptz',
    default: () => 'now()',
  })
  createdAt: Date;

  @Column({
    name: 'updated_at',
    type: 'timestamptz',
    default: () => 'now()',
  })
  updatedAt: Date;
}
