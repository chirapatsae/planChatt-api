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
 * password_history — Wave wave-backup-login-thaid-fallback.
 *
 * Stores the last 5 Argon2id `passwordHash` values per user for the
 * no-reuse rule (SECURITY-01 §7.4).
 *
 * Source of Truth:
 *   - SECURITY-01 §7.4 — history depth = 5, newest first; verify
 *     candidate against EACH entry via Argon2 verify and reject on
 *     any match.
 *   - Task brief (DB-01 deliverables) — `PasswordHistory` as a
 *     standalone entity (more normalized than the DB-01.md spec's
 *     JSONB column on `backup_credentials`). Lets the service paginate
 *     / index history independently and avoids JSONB writes on every
 *     change-password.
 *
 * Trim policy (service-side):
 *   - Insert new row with `createdAt = NOW()`.
 *   - After insert, DELETE rows beyond the 5 newest for that
 *     `user_id` (ordered by `created_at DESC`).
 *
 * Cascade contract:
 *   - User hard-delete → CASCADE (PDPA erasure).
 *   - User soft-delete → leave rows in place; they become orphan
 *     under the soft-deleted user but are still tied to the user_id
 *     for audit purposes.
 */
@Entity('password_history')
@Index('idx_password_history_user_id_created_at', ['userId', 'createdAt'])
export class PasswordHistory {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  /**
   * Argon2id encoded PHC string. Same shape as
   * `backup_credentials.password_hash`.
   */
  @Column({ name: 'password_hash', type: 'varchar', length: 256 })
  passwordHash: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
