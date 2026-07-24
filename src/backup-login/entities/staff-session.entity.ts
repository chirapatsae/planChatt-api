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
 * staff_session — per-session (per-device) registry row for the STAFF cohort.
 * The primary key IS the session id (`sid`) embedded in the staff JWT, so a
 * single indexed PK lookup authorizes (or per-session revokes) a token.
 * Complements the global `users.session_version` master (kept as the
 * revoke-everything switch): revoking ONE row fails ONLY that device's token.
 *
 * Staff boundary (NOT §17.3-citizen-isolated): `user_id` MAY FK into `users`
 * with `SET NULL` on delete — mirroring `backup_login_audit_logs`. IP is stored
 * in the CLEAR (`ip_address`, varchar for simplicity/consistency — same posture
 * as the backup-login audit `inet` column, staff are not PDPA data subjects the
 * way citizens are). Geo is stored plain for the device-manager display.
 *
 * `expires_at` is set by the mint caller (created + 8h — the staff session
 * window). `synchronize: true` auto-creates the table in dev; prod parity is
 * via migration `1799500000001-CreateStaffSession` + the
 * BootstrapMigrationsService allow-list (idempotent CREATE ... IF NOT EXISTS).
 */
@Entity('staff_session')
// "active sessions for this user" + revoke-others scans.
@Index('ix_staff_session_user_revoked', ['userId', 'revokedAt'])
// New-device match-key lookups.
@Index('ix_staff_session_device_hash', ['deviceHash'])
// Retention sweep — purge expired rows.
@Index('ix_staff_session_expires_at', ['expiresAt'])
export class StaffSession {
  /** The session id (`sid`) carried in the staff JWT. */
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * NULL after user hard/soft-delete (SET NULL preserves the pseudonymized
   * session row until the retention sweep). Staff boundary — FK allowed.
   */
  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'user_id' })
  user: User | null;

  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId: string | null;

  /** Snapshot of the user's session_version at mint (audit / drift check). */
  @Column({ name: 'session_version', type: 'int' })
  sessionVersion: number;

  /** `password` | `thaid` | `backup` — the login path that minted this. */
  @Column({ name: 'login_method', type: 'varchar', length: 16 })
  loginMethod: string;

  /** HMAC-SHA256 hex of `browser|os|subnet24` (new-device match key). */
  @Column({ name: 'device_hash', type: 'varchar', length: 64 })
  deviceHash: string;

  /** Coarse browser label (e.g. `Chrome`) for the device-manager display. */
  @Column({ name: 'browser_label', type: 'varchar', length: 48, nullable: true })
  browserLabel: string | null;

  /** Coarse OS label (e.g. `Windows`) for the device-manager display. */
  @Column({ name: 'os_label', type: 'varchar', length: 48, nullable: true })
  osLabel: string | null;

  /** Client IP — plain (staff boundary; parity with backup_login_audit_logs). */
  @Column({ name: 'ip_address', type: 'varchar', length: 64, nullable: true })
  ipAddress: string | null;

  /** IP masked to /24 (IPv4) or /64 (IPv6) — device match component. */
  @Column({ name: 'subnet24', type: 'varchar', length: 64, nullable: true })
  subnet24: string | null;

  /** ISO 3166-1 alpha-2 (or `LAN` sentinel) resolved via geoip at mint. */
  @Column({ name: 'geo_country', type: 'varchar', length: 8, nullable: true })
  geoCountry: string | null;

  /** City name resolved via geoip at mint (device-manager display). */
  @Column({ name: 'geo_city', type: 'varchar', length: 64, nullable: true })
  geoCity: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  /** Throttled (>5min) last-activity marker (see touchLastSeen). */
  @Column({ name: 'last_seen_at', type: 'timestamptz', default: () => 'now()' })
  lastSeenAt: Date;

  /** Session expiry — mint sets created + 8h (staff session window). */
  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  /** Per-session revocation marker. NULL = active. */
  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  /** Why the session was revoked (e.g. `user_revoke`, `revoke_others`). */
  @Column({ name: 'revoked_reason', type: 'varchar', length: 32, nullable: true })
  revokedReason: string | null;
}
