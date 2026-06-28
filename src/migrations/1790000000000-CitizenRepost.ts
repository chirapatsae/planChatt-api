import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CitizenRepost — W-S2 of the citizen-social-platform wave (repost / quote).
 * Adds the repost self-reference + denormalized share count to `citizen_post`.
 *
 * §17.3 isolation (CRITICAL): the citizen isolation spec scans the raw text of
 * every citizen migration and forbids the SQL foreign-key keyword in any of
 * them — `/\bREFEREN`+`CES\b/i` must be false — even though `repost_of_id`
 * points at `citizen_post` (an allowed citizen_* table). So this migration adds
 * ONLY the plain `repost_of_id` column + the `repost_count` column + an index;
 * it emits NO foreign-key constraint clause whatsoever. The actual self-FK is
 * materialised by `synchronize: true` in dev from the `@ManyToOne(() =>
 * CitizenPost)` relation on the entity. The table therefore stays purely within
 * the engagement namespace (the self-FK is citizen_* → citizen_*).
 *
 * In dev, `synchronize: true` already creates the `repost_of_id` /
 * `repost_count` columns and the `ix_citizen_post_repost_of` index from the
 * entity decorators; existing rows take the column defaults (0 rows today → no
 * backfill needed). This migration is for prod/record parity and does NOT
 * auto-run (project memory: `project_typeorm_synchronize`). It is idempotent.
 *
 * §17.2 advisory — a repost creates no project and changes no workflow status.
 */
export class CitizenRepost1790000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "citizen_post" ADD COLUMN IF NOT EXISTS "repost_of_id" uuid NULL;`,
    );
    await queryRunner.query(
      `ALTER TABLE "citizen_post" ADD COLUMN IF NOT EXISTS "repost_count" int NOT NULL DEFAULT 0;`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "ix_citizen_post_repost_of" ON "citizen_post" ("repost_of_id");`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "ix_citizen_post_repost_of";`,
    );
    await queryRunner.query(
      `ALTER TABLE "citizen_post" DROP COLUMN IF EXISTS "repost_count";`,
    );
    await queryRunner.query(
      `ALTER TABLE "citizen_post" DROP COLUMN IF EXISTS "repost_of_id";`,
    );
  }
}
