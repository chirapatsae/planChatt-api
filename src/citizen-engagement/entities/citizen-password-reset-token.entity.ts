import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * citizen_password_reset_tokens — single-use password-reset tokens for the
 * email/password CITIZEN login (AUTH-REDESIGN §3.2 follow-up).
 *
 * §17.3 isolation: this table lives entirely in the `citizen_*` namespace. Like
 * `citizen_audit_logs`, `identity_id` is a PLAIN uuid with NO foreign key /
 * relation into `citizen_identities` — a PDPA erase (status='deleted') NEVER
 * cascades here, and the retention sweep purges tokens by expiry independently.
 *
 * SECURITY: only the HMAC-SHA256 hex of the raw token is stored (`token_hash`).
 * The plaintext token is emailed to the citizen and NEVER persisted, so a DB
 * read cannot reconstruct a usable reset link. `used_at` is the single-use
 * marker (NULL = unconsumed); `expires_at` bounds the validity window.
 *
 * `synchronize: true` auto-creates this table + columns + the plain indexes in
 * dev; prod parity is via a real migration + the BootstrapMigrationsService
 * allow-list (idempotent CREATE TABLE/INDEX IF NOT EXISTS).
 */
@Entity('citizen_password_reset_tokens')
// "active tokens for this identity" scans (invalidate prior unused tokens).
@Index('ix_citizen_prt_identity_used', ['identityId', 'usedAt'])
// Retention sweep — purge expired rows.
@Index('ix_citizen_prt_expires_at', ['expiresAt'])
export class CitizenPasswordResetToken {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** citizen_identities.id — PLAIN uuid, NO FK (mirrors citizen_audit_logs). */
  @Column({ name: 'identity_id', type: 'uuid' })
  identityId: string;

  /** HMAC-SHA256 hex of the raw token. UNIQUE — plaintext is never stored. */
  @Column({ name: 'token_hash', type: 'varchar', length: 64, unique: true })
  tokenHash: string;

  /** Validity window end. */
  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  /** Single-use marker. NULL = unconsumed; set when the token is redeemed. */
  @Column({ name: 'used_at', type: 'timestamptz', nullable: true })
  usedAt: Date | null;

  /** Requesting client IP (audit / abuse). IPv6-safe width. */
  @Column({ name: 'request_ip', type: 'varchar', length: 45, nullable: true })
  requestIp: string | null;

  /** Requesting client User-Agent (audit / abuse). Truncated to 256. */
  @Column({ name: 'request_user_agent', type: 'varchar', length: 256, nullable: true })
  requestUserAgent: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
