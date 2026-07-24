import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CreateCitizenRegistrationOtp — short-lived, single-use email-OTP challenges
 * gating the "verify-email-first" CITIZEN registration flow (AUTH-REDESIGN
 * follow-up).
 *
 * `synchronize: true` creates the `citizen_registration_otp` table + columns +
 * the indexes from the entity decorators on dev boxes. This migration is the
 * prod-parity path (and dev boxes that run the migration runner without
 * synchronize): every statement is idempotent (`CREATE TABLE / INDEX IF NOT
 * EXISTS`).
 *
 * §17.3 isolation: every object lives in the `citizen_*` namespace. There is
 * NO `identity_id` column and NO foreign key at all — the identity does not
 * exist until `register/complete` creates it. NO FK into any project table /
 * users / work_history / tracking_status.
 *
 * SECURITY: only `code_hash` (HMAC-SHA256 hex of the 6-digit code, or a random
 * DECOY for the existing-email anti-enumeration branch) is stored — the
 * plaintext code is emailed and never persisted. `email_enc` is AES-encrypted.
 */
export class CreateCitizenRegistrationOtp1799400000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "citizen_registration_otp" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "challenge_id" varchar(64) NOT NULL,
        "email_hash" varchar(64) NOT NULL,
        "email_enc" varchar(512) NOT NULL,
        "code_hash" varchar(64) NOT NULL,
        "expires_at" timestamptz NOT NULL,
        "verified_at" timestamptz NULL,
        "consumed_at" timestamptz NULL,
        "attempt_count" int NOT NULL DEFAULT 0,
        "resend_count" int NOT NULL DEFAULT 0,
        "request_ip" varchar(45) NULL,
        "request_user_agent" varchar(256) NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_citizen_registration_otp" PRIMARY KEY ("id"),
        CONSTRAINT "uq_citizen_registration_otp_challenge_id" UNIQUE ("challenge_id")
      );
    `);

    // Anti-enum lookup of the active challenge for an email (rotate-on-cooldown).
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_citizen_registration_otp_email_hash"
      ON "citizen_registration_otp" ("email_hash");
    `);

    // Retention sweep — purge expired rows.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_citizen_registration_otp_expires_at"
      ON "citizen_registration_otp" ("expires_at");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "citizen_registration_otp";`,
    );
  }
}
