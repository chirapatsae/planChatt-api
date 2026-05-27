import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from 'src/users/entities/user.entity';

/**
 * totp_enrollments — Wave wave-backup-login-thaid-fallback.
 *
 * 1-to-1 with `users`. Stores the AES-GCM-encrypted TOTP secret +
 * enrollment lifecycle (pending → confirmed). Mandatory second
 * factor per SECURITY-01 §2.2 / §7.5.
 *
 * Source of Truth:
 *   - SECURITY-01 §7.5 TOTP params (RFC 6238: HMAC-SHA1, 6 digits,
 *     30s step, ±1 step grace, 160-bit secret)
 *   - SECURITY-01 §7.6 encryption at rest (AES-GCM via existing
 *     `backend/src/util/encryption.util.ts` helper)
 *   - SECURITY-01 §11 bootstrap edge case — first super-admin gets a
 *     credential row BEFORE this row exists; service-side checks
 *     existence, schema is permissive (no FK from
 *     BackupCredential).
 *
 * State machine:
 *   - pending: `pending_until` set, `confirmed_at` NULL.
 *     `pending_until` expires 10 minutes after enroll-init; sweep
 *     cron deletes expired rows.
 *   - confirmed: `pending_until` NULL, `confirmed_at` set.
 *     TOTP becomes mandatory for `/v1/auth/backup-login/complete`
 *     for this user.
 *   Service enforces the "exactly one of pending_until / confirmed_at
 *   is set" invariant — TypeORM cannot express XOR under
 *   `synchronize:true`.
 *
 * Replay defense (SECURITY-01 §7.5 application-side):
 *   `replay_window` is a JSONB array of
 *   `{timeStep: number, acceptedAt: timestamptz}` entries; service
 *   rejects any (userId, code, timeStep) seen within the last 120s
 *   and trims older entries on every write.
 */
@Entity('totp_enrollments')
@Index('idx_totp_enrollments_pending_until', ['pendingUntil'], {
  where: '"pending_until" IS NOT NULL',
})
@Index('idx_totp_enrollments_confirmed_at', ['confirmedAt'], {
  where: '"confirmed_at" IS NOT NULL',
})
export class TotpEnrollment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * 1-to-1 with User. Hard-delete CASCADE per DB-01 §3
   * (PDPA erasure).
   */
  @OneToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ name: 'user_id', type: 'uuid', unique: true })
  userId: string;

  /**
   * AES-GCM ciphertext (format `<iv-hex>:<ciphertext-hex>`) of the
   * 160-bit raw TOTP secret. Produced by `encryption()` from
   * `backend/src/util/encryption.util.ts`. Decrypted ONLY inside
   * `TotpService.verifyCode()` — never returned in any response
   * after the initial enrollment, never logged.
   *
   * Stored as `text` because the ciphertext length varies and is
   * not large enough to warrant LOB storage. The IV is randomly
   * generated per encrypt — same plaintext yields different
   * ciphertext, so this column is NOT searchable.
   */
  @Column({ name: 'secret_encrypted', type: 'text' })
  secretEncrypted: string;

  /**
   * Pending-state marker. NULL once the user confirms via
   * `enroll-complete`. Sweep cron deletes the row when
   * `pending_until < NOW()`.
   */
  @Column({ name: 'pending_until', type: 'timestamptz', nullable: true })
  pendingUntil: Date | null;

  /**
   * Confirmed-state marker. Once set, TOTP becomes mandatory for
   * subsequent `/v1/auth/backup-login/complete` calls for this user.
   */
  @Column({ name: 'confirmed_at', type: 'timestamptz', nullable: true })
  confirmedAt: Date | null;

  /**
   * Last successful TOTP verify — for audit / "last used" display.
   */
  @Column({ name: 'last_verified_at', type: 'timestamptz', nullable: true })
  lastVerifiedAt: Date | null;

  /**
   * Replay-defense ring (SECURITY-01 §7.5). Service trims entries
   * older than 120s on every write. Shape:
   *   Array of { timeStep: number, acceptedAt: string (ISO 8601) }
   */
  @Column({
    name: 'replay_window',
    type: 'jsonb',
    default: () => "'[]'::jsonb",
  })
  replayWindow: Array<{ timeStep: number; acceptedAt: string }>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
