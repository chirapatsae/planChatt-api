import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CreateCitizenPasswordResetTokens — single-use password-reset tokens for the
 * email/password CITIZEN login (AUTH-REDESIGN §3.2 follow-up).
 *
 * `synchronize: true` creates the `citizen_password_reset_tokens` table +
 * columns + the plain indexes from the entity decorators on dev boxes. This
 * migration is the prod-parity path (and dev boxes that run the migration
 * runner without synchronize): every statement is idempotent
 * (`CREATE TABLE / INDEX IF NOT EXISTS`).
 *
 * §17.3 isolation: every object lives in the `citizen_*` namespace. `identity_id`
 * is a PLAIN uuid with NO FK into `citizen_identities` (mirrors
 * `citizen_audit_logs`), so a PDPA erase never cascades and the retention sweep
 * purges by expiry independently. There is NO FK into any project table /
 * users / work_history / tracking_status.
 *
 * SECURITY: only `token_hash` (HMAC-SHA256 hex of the raw token) is stored —
 * the plaintext token is emailed and never persisted.
 */
export class CreateCitizenPasswordResetTokens1799000000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "citizen_password_reset_tokens" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "identity_id" uuid NOT NULL,
        "token_hash" varchar(64) NOT NULL,
        "expires_at" timestamptz NOT NULL,
        "used_at" timestamptz NULL,
        "request_ip" varchar(45) NULL,
        "request_user_agent" varchar(256) NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_citizen_password_reset_tokens" PRIMARY KEY ("id"),
        CONSTRAINT "uq_citizen_prt_token_hash" UNIQUE ("token_hash")
      );
    `);

    // "active tokens for this identity" scans (invalidate prior unused tokens).
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_citizen_prt_identity_used"
      ON "citizen_password_reset_tokens" ("identity_id", "used_at");
    `);

    // Retention sweep — purge expired rows.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_citizen_prt_expires_at"
      ON "citizen_password_reset_tokens" ("expires_at");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "citizen_password_reset_tokens";`,
    );
  }
}
