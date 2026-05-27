import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from 'src/users/entities/user.entity';

/**
 * backup_login_kill_switch_config — Wave wave-backup-login-thaid-fallback.
 *
 * Single-row config table holding the system-wide kill-switch for
 * the entire backup-login surface (SECURITY-01 §7.10). PK is the
 * literal string `BACKUP_LOGIN_ENABLED` — there is exactly ONE row
 * for the entire system.
 *
 * Why a dedicated entity (vs. a generic `system_settings` table):
 *   - Phase 1 needs only this one knob.
 *   - The behavior is security-critical and worth its own audit-able
 *     surface (`updated_by_user_id` is mandatory on every write,
 *     unlike a generic key/value where the audit is optional).
 *   - The task brief frames the entity as
 *     `BackupLoginKillSwitchConfig`, not a generic settings row.
 *
 * Source of Truth:
 *   - SECURITY-01 §7.10 — kill-switch contract
 *   - User decision 2026-05-27 — default `value = 'true'` (ON)
 *   - SECURITY-01 §7.14.1 — toggle MUST emit notification to ALL
 *     super-admins (handled by BE-01 in the toggle endpoint
 *     transaction)
 *
 * Seed (BE-01 ensures at boot, idempotent):
 *   INSERT INTO backup_login_kill_switch_config(key, value, description)
 *   VALUES ('BACKUP_LOGIN_ENABLED', 'true', '...')
 *   ON CONFLICT (key) DO NOTHING;
 */
@Entity('backup_login_kill_switch_config')
export class BackupLoginKillSwitchConfig {
  /**
   * Literal `BACKUP_LOGIN_ENABLED`. Phase 1 has exactly ONE row.
   */
  @PrimaryColumn({ name: 'key', type: 'varchar', length: 128 })
  key: string;

  /**
   * String over boolean for forward compatibility (e.g. `'incident'`
   * for a future tri-state). Service casts to boolean by
   * `value === 'true'`.
   */
  @Column({ name: 'value', type: 'varchar', length: 256 })
  value: string;

  @Column({
    name: 'description',
    type: 'varchar',
    length: 512,
    nullable: true,
  })
  description: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'updated_by_user_id' })
  updatedBy: User | null;

  @Column({ name: 'updated_by_user_id', type: 'uuid', nullable: true })
  updatedByUserId: string | null;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
