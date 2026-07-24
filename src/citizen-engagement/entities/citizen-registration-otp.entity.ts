import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * citizen_registration_otp — short-lived, single-use email-OTP challenges that
 * gate the "verify-email-first" CITIZEN registration flow (AUTH-REDESIGN
 * follow-up). One row is minted per `register/request-otp` call and burned on
 * `register/complete` (or after MAX_ATTEMPTS failures / expiry). NO identity
 * exists yet — the `citizen_identities` row is created ONLY at complete, so
 * there is intentionally NO `identity_id` column here.
 *
 * §17.3 isolation: this table lives entirely in the `citizen_*` namespace and
 * holds ZERO foreign key / relation — it carries the (encrypted + hashed) email
 * of a prospective citizen who does NOT yet have an identity, mirroring the
 * hash-only posture of `citizen_login_otp` / `citizen_password_reset_tokens`.
 * The retention sweep purges spent/expired rows independently.
 *
 * SECURITY: only the HMAC-SHA256 hex of the 6-digit code is stored
 * (`code_hash`). The plaintext code is emailed to the prospective citizen and
 * NEVER persisted / logged, so a DB read cannot reconstruct a usable code. The
 * "already-registered" anti-enumeration branch stores a random DECOY hash that
 * is never emailed (so an existing email produces an indistinguishable row that
 * can never be verified). `email_enc` is AES `iv:ciphertext` (PDPA — encrypted
 * at rest); `email_hash` is the HMAC lookup key. `verified_at` marks that email
 * ownership was proven (step 2); `consumed_at` is the single-use marker set at
 * complete; `expires_at` bounds the 5-minute validity window; `attempt_count` /
 * `resend_count` cap guessing / mailbombing.
 *
 * `synchronize: true` auto-creates this table + columns + indexes in dev; prod
 * parity is via a real migration + the BootstrapMigrationsService allow-list
 * (idempotent CREATE TABLE/INDEX IF NOT EXISTS).
 */
@Entity('citizen_registration_otp')
// Anti-enum lookup of the active challenge for an email (rotate-on-cooldown).
@Index('ix_citizen_registration_otp_email_hash', ['emailHash'])
// Retention sweep — purge expired rows.
@Index('ix_citizen_registration_otp_expires_at', ['expiresAt'])
export class CitizenRegistrationOtp {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Opaque public handle for this challenge (carried as the `sub` claim of the
   * signed challengeToken, looked up on verify/resend/complete). UNIQUE — the
   * code itself is never exposed, only this random id.
   */
  @Column({ name: 'challenge_id', type: 'varchar', length: 64, unique: true })
  challengeId: string;

  /** HMAC-SHA256(LOWER(TRIM(email))) — deterministic lookup, NO uniqueness. */
  @Column({ name: 'email_hash', type: 'varchar', length: 64 })
  emailHash: string;

  /** AES `iv:ciphertext` of the prospective login email (PDPA — encrypted at rest). */
  @Column({ name: 'email_enc', type: 'varchar', length: 512 })
  emailEnc: string;

  /** HMAC-SHA256 hex of the 6-digit code (or a random DECOY for existing-email). */
  @Column({ name: 'code_hash', type: 'varchar', length: 64 })
  codeHash: string;

  /** Validity window end (issue + 5 minutes; reset on each resend). */
  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  /** Set when email ownership is proven (step 2 verify). NULL = not yet verified. */
  @Column({ name: 'verified_at', type: 'timestamptz', nullable: true })
  verifiedAt: Date | null;

  /** Single-use marker. NULL = unconsumed; set at complete (identity created). */
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
