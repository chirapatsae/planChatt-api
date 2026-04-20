import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from 'src/users/entities/user.entity';

/**
 * NotificationSettingsAudit — Wave 22 B2 append-only kill-switch trail.
 *
 * Source of truth:
 *   - docs/tasks/IMPLEMENT_EMAIL_KILL_SWITCH.md §8
 *   - Migration: backend/src/migrations/1746000000000-AddActorAndKillSwitchToNotifications.ts
 *   - CLAUDE.md §12 (audit-preservation principle by analogy — this
 *     table is append-only)
 *   - CLAUDE.md §14.6 (`changedBy` uses ON DELETE SET NULL so audit
 *     rows survive user hard-delete during rollback)
 *
 * Invariants:
 *   - Every toggle of `notification_settings.email_enabled` writes
 *     exactly one row here.
 *   - Rows MUST NOT be updated or deleted in normal flow (append-only).
 *   - `settingId` is NOT an FK — future-proofing to allow renaming or
 *     splitting settings without cascade pain.
 *   - This row does NOT participate in any workflow / §12 TrackingStatus
 *     chain. It is an independent operational audit stream.
 *
 * NOTE: This entity is intentionally NOT registered in any module in
 * this wave. B2 (backend kill-switch) will wire it in.
 */
@Entity('notification_settings_audit')
@Index('ix_notification_settings_audit_changed_at', ['changedAt'])
export class NotificationSettingsAudit {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Logical key of the setting row this audit references.
   * Currently always 'global'. No FK declared (see class-level note).
   */
  @Column({ name: 'setting_id', type: 'varchar', length: 32 })
  settingId: string;

  @Column({ name: 'prev_enabled', type: 'boolean' })
  prevEnabled: boolean;

  @Column({ name: 'next_enabled', type: 'boolean' })
  nextEnabled: boolean;

  @Column({ name: 'changed_by', type: 'uuid', nullable: true })
  changedById: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'changed_by' })
  changedBy?: User | null;

  @Column({
    name: 'changed_at',
    type: 'timestamptz',
    default: () => 'now()',
  })
  changedAt: Date;

  /**
   * Optional operator note (e.g. "enabling after maintenance window").
   */
  @Column({ name: 'reason', type: 'text', nullable: true })
  reason?: string | null;
}
