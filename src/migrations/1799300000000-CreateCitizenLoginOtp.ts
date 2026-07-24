import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CreateCitizenLoginOtp — short-lived, single-use email-OTP challenges gating
 * every CITIZEN login (mandatory 2FA).
 *
 * `synchronize: true` creates the `citizen_login_otp` table + columns + the
 * indexes from the entity decorators on dev boxes. This migration is the
 * prod-parity path (and dev boxes that run the migration runner without
 * synchronize): every statement is idempotent (`CREATE TABLE / INDEX IF NOT
 * EXISTS`).
 *
 * §17.3 isolation: every object lives in the `citizen_*` namespace.
 * `identity_id` is a PLAIN uuid with NO FK into `citizen_identities` (mirrors
 * `citizen_password_reset_tokens` / `citizen_audit_logs`), so a PDPA erase
 * never cascades and the retention sweep purges by expiry/consumption
 * independently. There is NO FK into any project table / users / work_history /
 * tracking_status.
 *
 * SECURITY: only `code_hash` (HMAC-SHA256 hex of the 6-digit code) is stored —
 * the plaintext code is emailed and never persisted.
 */
export class CreateCitizenLoginOtp1799300000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "citizen_login_otp" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "identity_id" uuid NOT NULL,
        "challenge_id" varchar(64) NOT NULL,
        "code_hash" varchar(64) NOT NULL,
        "login_method" varchar(16) NOT NULL,
        "expires_at" timestamptz NOT NULL,
        "consumed_at" timestamptz NULL,
        "attempt_count" int NOT NULL DEFAULT 0,
        "resend_count" int NOT NULL DEFAULT 0,
        "request_ip" varchar(45) NULL,
        "request_user_agent" varchar(256) NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_citizen_login_otp" PRIMARY KEY ("id"),
        CONSTRAINT "uq_citizen_login_otp_challenge_id" UNIQUE ("challenge_id")
      );
    `);

    // "active challenges for this identity" scans.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_citizen_login_otp_identity_consumed"
      ON "citizen_login_otp" ("identity_id", "consumed_at");
    `);

    // Retention sweep — purge expired rows.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_citizen_login_otp_expires_at"
      ON "citizen_login_otp" ("expires_at");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "citizen_login_otp";`);
  }
}
