import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CreateCitizenSession — per-session (per-device) registry for the CITIZEN
 * cohort (login-alerts / device-session-management, Batch 1 / DB-1). The PK is
 * the session id (`sid`) embedded in the citizen JWT.
 *
 * `synchronize: true` creates the `citizen_session` table + columns + indexes
 * from the entity decorators on dev boxes. This migration is the prod-parity
 * path (and dev boxes that run the migration runner without synchronize): every
 * statement is idempotent (`CREATE TABLE / INDEX IF NOT EXISTS`).
 *
 * §17.3 isolation: `identity_id` is a PLAIN uuid with NO FK into
 * `citizen_identities` (mirrors citizen_login_otp / citizen_audit_logs), so a
 * PDPA erase never cascades and the retention sweep purges by expiry
 * independently. NO FK into any project / users / work_history / tracking table.
 *
 * PDPA: the client IP is stored AES-encrypted (`ip_enc`); only the coarse
 * `subnet24` + geo (country/city) are clear-text.
 */
export class CreateCitizenSession1799500000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "citizen_session" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "identity_id" uuid NOT NULL,
        "session_version" int NOT NULL,
        "login_method" varchar(16) NOT NULL,
        "device_hash" varchar(64) NOT NULL,
        "browser_label" varchar(48) NULL,
        "os_label" varchar(48) NULL,
        "ip_enc" varchar(512) NULL,
        "subnet24" varchar(64) NULL,
        "geo_country" varchar(8) NULL,
        "geo_city" varchar(64) NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "last_seen_at" timestamptz NOT NULL DEFAULT now(),
        "expires_at" timestamptz NOT NULL,
        "revoked_at" timestamptz NULL,
        "revoked_reason" varchar(32) NULL,
        CONSTRAINT "pk_citizen_session" PRIMARY KEY ("id")
      );
    `);

    // "active sessions for this identity" + revoke-others scans.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_citizen_session_identity_revoked"
      ON "citizen_session" ("identity_id", "revoked_at");
    `);

    // New-device match-key lookups.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_citizen_session_device_hash"
      ON "citizen_session" ("device_hash");
    `);

    // Retention sweep — purge expired rows.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_citizen_session_expires_at"
      ON "citizen_session" ("expires_at");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "citizen_session";`);
  }
}
