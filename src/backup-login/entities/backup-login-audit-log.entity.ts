import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from 'src/users/entities/user.entity';

/**
 * backup_login_audit_logs — Wave wave-backup-login-thaid-fallback.
 *
 * Immutable audit trail of EVERY backup-login attempt (success +
 * failure) per SECURITY-01 §7.12.
 *
 * APPEND-ONLY at the DB layer:
 *   - BEFORE UPDATE trigger rejects with EXCEPTION.
 *   - BEFORE DELETE trigger rejects with EXCEPTION.
 *   - Escape hatch: the retention-sweep transaction sets
 *     `SET LOCAL app.retention_sweep_in_progress = 'true'` which the
 *     trigger function checks via `current_setting(...)`. ONLY the
 *     dedicated sweep cron may DELETE rows (2-year rolling per
 *     SECURITY-01 §7.12.2).
 *   - `synchronize:true` does NOT create triggers. The trigger SQL
 *     is shipped alongside this file at
 *     `backend/src/backup-login/sql/backup-login-audit-log.triggers.sql`
 *     and applied via psql after BE restart (see DB-01 task brief).
 *
 * Source of Truth:
 *   - SECURITY-01 §7.12.1 outcome enum (15 values)
 *   - SECURITY-01 §7.12.2 retention (2 years rolling, daily 03:00
 *     cron)
 *   - SECURITY-01 §7.12.3 append-only trigger SQL
 *   - SECURITY-01 §7.14 LINE per-attempt notification (separate code
 *     path; does NOT write here)
 *   - CLAUDE.md §17.3 — no FK into project / plan / tracking tables
 *     (this audit lives in its own boundary; user_id is the only
 *     cross-boundary reference and uses SET NULL on cascade)
 *
 * Cascade contract (DB-01 §3):
 *   - User soft-delete → row preserved with `user_id` SET NULL
 *     (pseudonymized; IP + UA + outcome retained for the security
 *     audit window per PDPA §24(2) legitimate interest).
 *   - User hard-delete → SET NULL on user_id (rows retained until
 *     the 2-year sweep).
 */
@Entity('backup_login_audit_logs')
@Index('idx_backup_login_audit_logs_user_attempted', [
  'userId',
  'attemptedAt',
])
@Index('idx_backup_login_audit_logs_attempted_at', ['attemptedAt'])
@Index('idx_backup_login_audit_logs_outcome_attempted', [
  'outcome',
  'attemptedAt',
])
@Index('idx_backup_login_audit_logs_subnet_attempted', [
  'subnet24',
  'attemptedAt',
])
export class BackupLoginAuditLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * NULL when the username does not resolve OR after User
   * soft/hard-delete (SET NULL preserves pseudonymized audit).
   */
  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'user_id' })
  user: User | null;

  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId: string | null;

  /**
   * Lowercased email (the canonical backup-login username). Capped
   * 256.
   */
  @Column({
    name: 'username_attempted',
    type: 'varchar',
    length: 256,
  })
  usernameAttempted: string;

  /**
   * `init` (credential stage), `complete` (TOTP stage), or
   * `bootstrap` (one-shot CLI). String column over PG enum to keep
   * `synchronize:true` migrations friction-free.
   */
  @Column({ name: 'stage', type: 'varchar', length: 16 })
  stage: 'init' | 'complete' | 'bootstrap';

  /**
   * `req.ip` — backend MUST honor `trust proxy` so the recorded IP
   * is the client's, not the proxy's. PostgreSQL `inet` type covers
   * IPv4 and IPv6 uniformly.
   */
  @Column({ name: 'ip_address', type: 'inet' })
  ipAddress: string;

  /**
   * `req.ip` masked to /24 (IPv4) or /64 (IPv6). Used by rate-limit
   * + analytics + LINE user-facing message (which never shows the
   * full IP — masked-/24 only per SECURITY-01 §7.14.2 PII safety).
   */
  @Column({ name: 'subnet_24', type: 'inet' })
  subnet24: string;

  @Column({
    name: 'user_agent',
    type: 'varchar',
    length: 512,
    nullable: true,
  })
  userAgent: string | null;

  /**
   * SECURITY-01 §7.12.1 outcome enum (one of):
   *   `success`, `invalid_credentials`, `invalid_totp`,
   *   `mfa_required`, `must_change_password`, `locked`, `locked_24h`,
   *   `frozen`, `killswitch_off`, `not_eligible`, `rate_limited`,
   *   `bootstrap`, `challenge_expired`.
   * String column over PG enum to keep `synchronize:true`
   * migrations friction-free.
   */
  @Column({ name: 'outcome', type: 'varchar', length: 64 })
  outcome: string;

  @CreateDateColumn({ name: 'attempted_at', type: 'timestamptz' })
  attemptedAt: Date;
}
