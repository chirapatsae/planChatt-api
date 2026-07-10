import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * citizen_identities — the ThaID-authenticated CITIZEN identity.
 *
 * This is a SEPARATE identity from the internal `users` table (CLAUDE.md
 * production plan D1/D2): a citizen who posts on the public board is NEVER
 * granted an internal `User`/`WorkHistory`. ThaID OIDC issues a distinct
 * `aud:'citizen'` JWT whose `sub` is THIS row's `id` (never the national ID).
 *
 * §17.3 isolation: this table lives in the `citizen_*` namespace and has ZERO
 * FK into project_groups / any project table / users / work_history /
 * tracking_status. It is the ONLY home of citizen PII.
 *
 * PII handling (PDPA): `national_id` is minimized — `national_id_hash`
 * (HMAC, for dedup/erasure lookup) is sufficient; `national_id_enc` /
 * `full_name_enc` exist nullable for optional DSAR identity-matching but the
 * default service path leaves them NULL (plan D4). `display_alias` is the ONLY
 * publicly displayed name. The `*_enc` / `*_hash` columns MUST be excluded
 * from every public DTO.
 */
@Entity('citizen_identities')
export class CitizenIdentity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * HMAC of the ThaID OIDC `sub`. Lookup key. Partial-unique (migration).
   * AUTH-REDESIGN (2026-07-08): now NULLABLE — ThaID is removed, so
   * email/password + Google identities carry no `thaid_sub_hash`. Existing
   * ThaID rows keep their value.
   */
  @Column({ name: 'thaid_sub_hash', type: 'varchar', length: 64, nullable: true })
  thaidSubHash: string | null;

  /** HMAC of the 13-digit national ID. Dedup / erasure lookup. Partial-unique (migration). */
  @Column({ name: 'national_id_hash', type: 'varchar', length: 64, nullable: true })
  nationalIdHash: string | null;

  /** AES `iv:ciphertext`. DEFAULT NULL (plan D4) — only populated if DSAR demands it. */
  @Column({ name: 'national_id_enc', type: 'varchar', length: 512, nullable: true })
  nationalIdEnc: string | null;

  /** AES `iv:ciphertext` of the full name. DEFAULT NULL — never displayed publicly. */
  @Column({ name: 'full_name_enc', type: 'varchar', length: 512, nullable: true })
  fullNameEnc: string | null;

  // -------------------------------------------------------------------
  // AUTH-REDESIGN (2026-07-08) — email/password + Google registration.
  // Replaces the ThaID-only citizen login. See docs/AUTH-REDESIGN.md §3.2.
  // `synchronize:true` auto-adds these in dev; prod parity via
  // BootstrapMigrationsService allow-list.
  // -------------------------------------------------------------------

  /** AES `iv:ciphertext` of the login email (PDPA — encrypted at rest). */
  @Column({ name: 'email_enc', type: 'varchar', length: 512, nullable: true })
  emailEnc: string | null;

  /** HMAC-SHA256(LOWER(TRIM(email))) — deterministic lookup + uniqueness. Partial-unique (migration). */
  @Column({ name: 'email_hash', type: 'varchar', length: 64, nullable: true })
  emailHash: string | null;

  /** Argon2id PHC string. NULL = registered via Google only (no password). */
  @Column({ name: 'password_hash', type: 'varchar', length: 512, nullable: true })
  passwordHash: string | null;

  /** HMAC of the Google OIDC `sub`. NULL = not linked to Google. Partial-unique (migration). */
  @Column({ name: 'google_sub_hash', type: 'varchar', length: 64, nullable: true })
  googleSubHash: string | null;

  /** Timestamp email was verified via link flow. NULL = unverified (Google logins are pre-verified). */
  @Column({ name: 'email_verified_at', type: 'timestamptz', nullable: true })
  emailVerifiedAt: Date | null;

  /** `password` | `google` | `both` — how this citizen authenticates. */
  @Column({ name: 'auth_provider', type: 'varchar', length: 16, default: 'password' })
  authProvider: string;

  /** The ONLY public name. */
  @Column({ name: 'display_alias', type: 'varchar', length: 64 })
  displayAlias: string;

  /**
   * Optional public bio / "แนะนำตัว" (2026-07-03). Alias-only-safe free text
   * (§17.3 — NOT PII; the citizen types it themselves). Shown on the public
   * profile header. `null` / empty = no bio. `synchronize:true` auto-adds this
   * column in dev; prod needs a migration to add `bio varchar(300) NULL`.
   */
  @Column({ name: 'bio', type: 'varchar', length: 300, nullable: true })
  bio: string | null;

  /**
   * Opaque storage key of the citizen's profile photo (community avatars,
   * 2026-07), or null for the gradient+initial fallback. The bytes are
   * EXIF-stripped on upload (PDPA — no embedded GPS/device metadata) and held by
   * CitizenStorageService, NEVER a raw disk path leaked to clients. Public read
   * via `GET citizens/:id/avatar`. `synchronize:true` auto-adds this column in
   * dev; prod needs a migration (`avatar_path varchar(512) NULL`).
   */
  @Column({ name: 'avatar_path', type: 'varchar', length: 512, nullable: true })
  avatarPath: string | null;

  /**
   * Presence privacy (community presence, 2026-07): when false the citizen is
   * reported OFFLINE to others (they still see everyone) — Facebook "invisible"
   * mode. The citizen's own PDPA control over presence metadata (§17.3).
   * `synchronize:true` auto-adds this column in dev; prod needs a migration
   * (`show_online_status boolean NOT NULL DEFAULT true`).
   */
  @Column({ name: 'show_online_status', type: 'boolean', default: true })
  showOnlineStatus: boolean;

  /**
   * `active` | `blocked` | `deleted` (W-G1 DSAR erase) | `suspended` (W-T3
   * offender-ladder auto-suspend). CHECK enforced in the migration and widened
   * idempotently in `bootstrap-migrations.service.ts` for prod parity.
   */
  @Column({ name: 'status', type: 'varchar', length: 16, default: 'active' })
  status: string;

  /** Session revocation — bumped to invalidate issued citizen tokens. */
  @Column({ name: 'session_version', type: 'int', default: 0 })
  sessionVersion: number;

  @Column({ name: 'consent_version', type: 'varchar', length: 32, nullable: true })
  consentVersion: string | null;

  @Column({ name: 'consent_at', type: 'timestamptz', nullable: true })
  consentAt: Date | null;

  @Column({ name: 'last_login_at', type: 'timestamptz', nullable: true })
  lastLoginAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt: Date | null;
}
