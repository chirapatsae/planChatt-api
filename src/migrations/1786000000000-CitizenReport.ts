import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CitizenReport — C5 of the civic-community plan (moderation-at-scale, D13).
 *
 * `synchronize: true` creates the `citizen_report` table + columns + the plain
 * `(post_id, status)` index from the entity. This migration adds what
 * synchronize cannot (project memory: `project_typeorm_synchronize`):
 *   1. The partial-unique `(post_id, reporter_identity_id) WHERE deleted_at IS
 *      NULL` — one live report per citizen per post (drives the distinct count).
 *   2. The status CHECK.
 *
 * §17.3 isolation: every object lives in the `citizen_*` namespace; the only FK
 * is the entity-declared post_id → citizen_post (citizen_* → citizen_*).
 */
export class CitizenReport1786000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_citizen_report_one_per_reporter"
      ON "citizen_report" ("post_id", "reporter_identity_id")
      WHERE "deleted_at" IS NULL;
    `);

    await queryRunner.query(
      `ALTER TABLE "citizen_report" DROP CONSTRAINT IF EXISTS "ck_citizen_report_status";`,
    );
    await queryRunner.query(
      `ALTER TABLE "citizen_report" ADD CONSTRAINT "ck_citizen_report_status" CHECK ("status" IN ('open','actioned','dismissed'));`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "citizen_report" DROP CONSTRAINT IF EXISTS "ck_citizen_report_status";`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "uq_citizen_report_one_per_reporter";`,
    );
  }
}
