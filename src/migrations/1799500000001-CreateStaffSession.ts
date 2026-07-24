import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CreateStaffSession — per-session (per-device) registry for the STAFF cohort
 * (login-alerts / device-session-management, Batch 1 / DB-1). The PK is the
 * session id (`sid`) embedded in the staff JWT.
 *
 * `synchronize: true` creates the `staff_session` table + columns + indexes
 * from the entity decorators on dev boxes. This migration is the prod-parity
 * path (and dev boxes that run the migration runner without synchronize): every
 * statement is idempotent (`CREATE TABLE / INDEX IF NOT EXISTS`). The FK to
 * `users(id)` is `ON DELETE SET NULL` — mirrors backup_login_audit_logs; the
 * `ADD CONSTRAINT` is wrapped in a guard so a re-run is a no-op.
 *
 * Staff boundary (NOT §17.3-citizen-isolated): `user_id` MAY FK into `users`.
 * IP is stored in the CLEAR (`ip_address`) — same posture as the backup-login
 * audit trail.
 */
export class CreateStaffSession1799500000001 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "staff_session" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NULL,
        "session_version" int NOT NULL,
        "login_method" varchar(16) NOT NULL,
        "device_hash" varchar(64) NOT NULL,
        "browser_label" varchar(48) NULL,
        "os_label" varchar(48) NULL,
        "ip_address" varchar(64) NULL,
        "subnet24" varchar(64) NULL,
        "geo_country" varchar(8) NULL,
        "geo_city" varchar(64) NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "last_seen_at" timestamptz NOT NULL DEFAULT now(),
        "expires_at" timestamptz NOT NULL,
        "revoked_at" timestamptz NULL,
        "revoked_reason" varchar(32) NULL,
        CONSTRAINT "pk_staff_session" PRIMARY KEY ("id")
      );
    `);

    // FK user_id -> users(id) ON DELETE SET NULL (staff boundary). Guarded so
    // a re-run against an already-constrained table is a no-op.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'fk_staff_session_user'
        ) THEN
          ALTER TABLE "staff_session"
          ADD CONSTRAINT "fk_staff_session_user"
          FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE SET NULL;
        END IF;
      END $$;
    `);

    // "active sessions for this user" + revoke-others scans.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_staff_session_user_revoked"
      ON "staff_session" ("user_id", "revoked_at");
    `);

    // New-device match-key lookups.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_staff_session_device_hash"
      ON "staff_session" ("device_hash");
    `);

    // Retention sweep — purge expired rows.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_staff_session_expires_at"
      ON "staff_session" ("expires_at");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "staff_session";`);
  }
}
