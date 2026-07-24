import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * citizen_login_otp — short-lived, single-use email-OTP challenges gating every
 * CITIZEN login (mandatory 2FA). One row is minted per login attempt
 * (password / google / register) and burned on verify (or after MAX_ATTEMPTS
 * failures / expiry). The retention cron hard-deletes spent/expired rows.
 *
 * §17.3 isolation: this table lives entirely in the `citizen_*` namespace. Like
 * `citizen_password_reset_tokens` / `citizen_audit_logs`, `identity_id` is a
 * PLAIN uuid with NO foreign key / relation into `citizen_identities` — a PDPA
 * erase (status='deleted') NEVER cascades here, and the retention sweep purges
 * rows by expiry/consumption independently.
 *
 * SECURITY: only the HMAC-SHA256 hex of the 6-digit code is stored
 * (`code_hash`). The plaintext code is emailed to the citizen and NEVER
 * persisted / logged, so a DB read cannot reconstruct a usable code.
 * `consumed_at` is the single-use marker (NULL = unconsumed); `expires_at`
 * bounds the 5-minute validity window; `attempt_count` / `resend_count` cap
 * guessing / mailbombing.
 *
 * `synchronize: true` auto-creates this table + columns + indexes in dev; prod
 * parity is via a real migration + the BootstrapMigrationsService allow-list
 * (idempotent CREATE TABLE/INDEX IF NOT EXISTS).
 */
@Entity('citizen_login_otp')
// "active challenges for this identity" scans.
@Index('ix_citizen_login_otp_identity_consumed', ['identityId', 'consumedAt'])
// Retention sweep — purge expired rows.
@Index('ix_citizen_login_otp_expires_at', ['expiresAt'])
export class CitizenLoginOtp {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** citizen_identities.id — PLAIN uuid, NO FK (mirrors citizen_audit_logs). */
  @Column({ name: 'identity_id', type: 'uuid' })
  identityId: string;

  /**
   * Opaque public handle for this challenge (carried in the signed
   * otpChallengeToken `cid` claim, looked up on verify/resend). UNIQUE — the
   * code itself is never exposed, only this random id.
   */
  @Column({ name: 'challenge_id', type: 'varchar', length: 64, unique: true })
  challengeId: string;

  /** HMAC-SHA256 hex of the 6-digit code. Plaintext code is never stored. */
  @Column({ name: 'code_hash', type: 'varchar', length: 64 })
  codeHash: string;

  /** `password` | `google` | `register` — the login path that opened this challenge. */
  @Column({ name: 'login_method', type: 'varchar', length: 16 })
  loginMethod: string;

  /** Validity window end (issue + 5 minutes; reset on each resend). */
  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  /** Single-use marker. NULL = unconsumed; set on verify OR on attempt-cap burn. */
  @Column({ name: 'consumed_at', type: 'timestamptz', nullable: true })
  consumedAt: Date | null;

  /** Failed-verify counter. Burned (consumed) once it reaches MAX_ATTEMPTS. */
  @Column({ name: 'attempt_count', type: 'int', default: 0 })
  attemptCount: number;

  /** Resend counter (anti-mailbomb). Capped at MAX_RESENDS. */
  @Column({ name: 'resend_count', type: 'int', default: 0 })
  resendCount: number;

  /** Requesting client IP (audit / abuse). IPv6-safe width. */
  @Column({ name: 'request_ip', type: 'varchar', length: 45, nullable: true })
  requestIp: string | null;

  /** Requesting client User-Agent (audit / abuse). Truncated to 256. */
  @Column({ name: 'request_user_agent', type: 'varchar', length: 256, nullable: true })
  requestUserAgent: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
