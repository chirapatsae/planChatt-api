import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from 'src/users/entities/user.entity';

/**
 * backup_credentials — Wave wave-backup-login-thaid-fallback.
 *
 * 1-to-1 with `users`. Stores the Argon2id `passwordHash` and the
 * lockout / freeze / revoke fields that drive the SECURITY-01 §7.3
 * escalation ladder (3 fails → 30-min lock, 5 → 24h, 10 → freeze).
 *
 * `usernameEmailHash` is a deterministic HMAC-SHA256 of the user's
 * normalized (trim + lower) email — populated from
 * `users.email_hash` at issuance time so the login flow can lookup
 * the credential WITHOUT decrypting `users.email` ciphertext.
 * Phase 1 limitation: users without a registered email cannot
 * receive a backup credential (documented in DOCS-01).
 *
 * Source of Truth:
 *   - SECURITY-01 §7.1 Argon2id params (encoded format header)
 *   - SECURITY-01 §7.3 lockout escalation
 *   - SECURITY-01 §7.4 password history (separate `PasswordHistory`
 *     entity per task brief — NOT a JSONB column here)
 *   - SECURITY-01 §7.11 forced password change
 *   - CLAUDE.md §17.3 — no FK into project / plan / tracking tables
 *
 * Cascade contract (DB-01 §3):
 *   - `users.delete_at` soft-delete does NOT cascade — TypeORM
 *     soft-delete leaves the user row in place. The hard-delete
 *     CASCADE on the FK fires only if the user row is hard-deleted
 *     (PDPA erasure path), in which case the credential disappears
 *     with it.
 */
@Entity('backup_credentials')
@Index('idx_backup_credentials_locked_until', ['lockedUntil'], {
  where: '"locked_until" IS NOT NULL',
})
@Index('idx_backup_credentials_frozen_at', ['frozenAt'], {
  where: '"frozen_at" IS NOT NULL',
})
@Index('idx_backup_credentials_active', ['revokedAt'], {
  where: '"revoked_at" IS NULL',
})
export class BackupCredential {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * 1-to-1 with User. Hard-delete CASCADE per DB-01 §3.
   */
  @OneToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ name: 'user_id', type: 'uuid', unique: true })
  userId: string;

  /**
   * Deterministic HMAC-SHA256 of normalized email (mirrors the
   * `users.email_hash` column produced by `hashEmail()`). 64 hex
   * chars. UNIQUE — one credential per email globally.
   */
  @Index('uq_backup_credentials_username_email_hash', { unique: true })
  @Column({
    name: 'username_email_hash',
    type: 'varchar',
    length: 64,
  })
  usernameEmailHash: string;

  /**
   * Argon2id encoded PHC string:
   *   `$argon2id$v=19$m=131072,t=4,p=1$<salt>$<hash>`
   * Sized 256 chars to accommodate the 128 MiB memoryCost header per
   * SECURITY-01 §7.1.
   */
  @Column({ name: 'password_hash', type: 'varchar', length: 256 })
  passwordHash: string;

  @Column({
    name: 'password_set_at',
    type: 'timestamptz',
    default: () => 'CURRENT_TIMESTAMP',
  })
  passwordSetAt: Date;

  /**
   * Accountability column — who issued / reset / last-changed the
   * password. RESTRICT on delete to preserve audit (SECURITY-01 §9
   * insider-with-super-admin actor profile).
   */
  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'password_set_by_user_id' })
  passwordSetBy: User;

  @Column({ name: 'password_set_by_user_id', type: 'uuid' })
  passwordSetByUserId: string;

  /**
   * SECURITY-01 §7.11 forced-password-change gate. Set true on
   * super-admin issue / reset; cleared by user change-password.
   */
  @Column({
    name: 'must_change_on_next_login',
    type: 'boolean',
    default: false,
  })
  mustChangeOnNextLogin: boolean;

  /**
   * Per-user failure counter — incremented on every wrong credential
   * OR wrong TOTP attempt; reset to 0 on successful TOTP completion
   * (SECURITY-01 §7.3.2 counter semantics).
   */
  @Column({ name: 'failed_attempts', type: 'int', default: 0 })
  failedAttempts: number;

  /**
   * When set AND in the future, login is rejected with `locked` or
   * `locked_24h` outcome. Auto-clears at expiry.
   */
  @Column({ name: 'locked_until', type: 'timestamptz', nullable: true })
  lockedUntil: Date | null;

  /**
   * Indefinite freeze — requires super-admin `unfreeze` to clear
   * (SECURITY-01 §7.3.2). Auto-set when 10 failures occur in any
   * rolling 24h window.
   */
  @Column({ name: 'frozen_at', type: 'timestamptz', nullable: true })
  frozenAt: Date | null;

  @Column({
    name: 'frozen_reason',
    type: 'varchar',
    length: 256,
    nullable: true,
  })
  frozenReason: string | null;

  /**
   * When set, the credential is dead — login rejected with
   * `not_eligible` outcome. Super-admin can issue a fresh credential
   * to revive (which generates a new row with `revoked_at = NULL`).
   */
  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'revoked_by_user_id' })
  revokedBy: User | null;

  @Column({ name: 'revoked_by_user_id', type: 'uuid', nullable: true })
  revokedByUserId: string | null;

  @Column({
    name: 'revoked_reason',
    type: 'varchar',
    length: 256,
    nullable: true,
  })
  revokedReason: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
