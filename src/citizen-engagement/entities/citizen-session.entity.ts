import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * citizen_session — per-session (per-device) registry row for the CITIZEN
 * cohort. The primary key IS the session id (`sid`) embedded in the citizen
 * JWT, so a single indexed PK lookup authorizes (or per-session revokes) a
 * token. Complements the global `session_version` master (kept as the
 * revoke-everything switch): revoking ONE row fails ONLY that device's token.
 *
 * §17.3 isolation: this table lives entirely in the `citizen_*` namespace.
 * Like `citizen_login_otp` / `citizen_password_reset_tokens` /
 * `citizen_audit_logs`, `identity_id` is a PLAIN uuid with NO foreign key into
 * `citizen_identities` — a PDPA erase (`status='deleted'`) NEVER cascades here,
 * and the retention sweep purges by `expires_at` independently.
 *
 * PDPA: the client IP is stored AES-encrypted (`ip_enc`, `iv:ct` via
 * `encryption()`), NOT in plaintext. Only the coarse `subnet24` + geo
 * (country/city) are kept in the clear for the device-manager display + the
 * new-device match key. `device_hash` is an HMAC over `browser|os|subnet24`.
 *
 * `synchronize: true` auto-creates this table + columns + indexes in dev; prod
 * parity is via migration `1799500000000-CreateCitizenSession` + the
 * BootstrapMigrationsService allow-list (idempotent CREATE ... IF NOT EXISTS).
 */
@Entity('citizen_session')
// "active sessions for this identity" + revoke-others scans.
@Index('ix_citizen_session_identity_revoked', ['identityId', 'revokedAt'])
// New-device match-key lookups.
@Index('ix_citizen_session_device_hash', ['deviceHash'])
// Retention sweep — purge expired rows.
@Index('ix_citizen_session_expires_at', ['expiresAt'])
export class CitizenSession {
  /** The session id (`sid`) carried in the citizen JWT. */
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** citizen_identities.id — PLAIN uuid, NO FK (mirrors citizen_login_otp). */
  @Column({ name: 'identity_id', type: 'uuid' })
  identityId: string;

  /** Snapshot of the identity's session_version at mint (audit / drift check). */
  @Column({ name: 'session_version', type: 'int' })
  sessionVersion: number;

  /** `password` | `google` | `register` — the login path that minted this. */
  @Column({ name: 'login_method', type: 'varchar', length: 16 })
  loginMethod: string;

  /** HMAC-SHA256 hex of `browser|os|subnet24` (new-device match key). */
  @Column({ name: 'device_hash', type: 'varchar', length: 64 })
  deviceHash: string;

  /** Coarse browser label (e.g. `Chrome`) for the device-manager display. */
  @Column({ name: 'browser_label', type: 'varchar', length: 48, nullable: true })
  browserLabel: string | null;

  /** Coarse OS label (e.g. `iOS`) for the device-manager display. */
  @Column({ name: 'os_label', type: 'varchar', length: 48, nullable: true })
  osLabel: string | null;

  /** AES-encrypted client IP (`iv:ct` via encryption()). PDPA — never plain. */
  @Column({ name: 'ip_enc', type: 'varchar', length: 512, nullable: true })
  ipEnc: string | null;

  /** IP masked to /24 (IPv4) or /64 (IPv6) — clear-text device match component. */
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

  /** Session expiry (mint sets this — citizen token lifetime). */
  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  /** Per-session revocation marker. NULL = active. */
  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  /** Why the session was revoked (e.g. `user_revoke`, `revoke_others`). */
  @Column({ name: 'revoked_reason', type: 'varchar', length: 32, nullable: true })
  revokedReason: string | null;
}
