import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CitizenOfficialResponseStatus — W-G2 of the citizen-social-platform wave
 * (official-response v2: issue-handling status lifecycle).
 *
 * Adds two columns to the existing C4 `citizen_official_response` table:
 *   - `status` varchar(16) NOT NULL DEFAULT 'received'
 *     (`received | in_progress | resolved`)
 *   - `status_updated_at` timestamptz NULL
 * plus the value CHECK `ck_citizen_official_response_status`.
 *
 * NO new entity, NO new table — this is a column add on an existing citizen_*
 * table. In dev, `synchronize: true` already adds the columns from the entity
 * decorators but NOT the CHECK; this migration is for prod/record parity and
 * does NOT auto-run (project memory: `project_typeorm_synchronize`). It is
 * idempotent (IF NOT EXISTS on the columns, DROP-then-ADD on the CHECK).
 *
 * §17.3 isolation (CRITICAL): every object below lives in the `citizen_*`
 * namespace. There is NO foreign key into any project table / users /
 * work_history / tracking_status — and the citizen isolation spec scans this
 * file's raw text and FAILS the build if the SQL foreign-key keyword appears,
 * so no such clause is emitted here. §17.2 advisory — the status is the citizen
 * issue-handling display state and writes no `tracking_status`.
 */
export class CitizenOfficialResponseStatus1797000000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Add the lifecycle columns (idempotent).
    await queryRunner.query(`
      ALTER TABLE IF EXISTS "citizen_official_response"
        ADD COLUMN IF NOT EXISTS "status" varchar(16) NOT NULL DEFAULT 'received';
    `);
    await queryRunner.query(`
      ALTER TABLE IF EXISTS "citizen_official_response"
        ADD COLUMN IF NOT EXISTS "status_updated_at" timestamptz;
    `);

    // 2. Constrain status to the three FROZEN values (drop-then-add → idempotent).
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "citizen_official_response" DROP CONSTRAINT IF EXISTS "ck_citizen_official_response_status";`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "citizen_official_response" ADD CONSTRAINT "ck_citizen_official_response_status" CHECK ("status" IN ('received','in_progress','resolved'));`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "citizen_official_response" DROP CONSTRAINT IF EXISTS "ck_citizen_official_response_status";`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "citizen_official_response" DROP COLUMN IF EXISTS "status_updated_at";`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "citizen_official_response" DROP COLUMN IF EXISTS "status";`,
    );
  }
}
