import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: DropDevelopmentPlanIsFrozen
 *
 * Removes the dead `development_plan.is_frozen` column that was introduced by
 * `1744416000000-AddBookProjectLineageAndPlanFrozen` as a denormalized cache.
 *
 * Context (see docs/tasks/IS_FROZEN_DEAD_STATE_CLEANUP.md):
 * - The column was intended as a fast UI-filter cache, set to true when the
 *   first DevelopmentPlanRevision is created for a plan.
 * - In practice the write-side was never wired. Nothing in the codebase ever
 *   sets `is_frozen = true`. The single helper that writes to this column
 *   (`syncPlanFrozenCache`) only ever sets it to `false` and is never called.
 * - The authoritative freeze check (`assertMainBookNotFrozen`) uses a live
 *   COUNT(*) query against `development_plan_revision` and bypasses this
 *   cache entirely.
 * - The column is therefore dead state and a drift risk. Per the audit
 *   decision (Option B) it is removed from the schema and the application
 *   layer (entity, DTO, service, frontend) in the same change set.
 *
 * The authoritative live-query freeze path is untouched.
 *
 * Rollback safety:
 * The `down()` method restores the column with exactly the same shape as the
 * original migration (`BOOLEAN NOT NULL DEFAULT false`). No backfill is
 * performed because the column was never authoritative and was never written
 * to a non-default value in production.
 */
export class DropDevelopmentPlanIsFrozen1744588800000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Drop the dead cache column. IF EXISTS mirrors the guard style used in
    // the original migration's down() path and keeps this migration idempotent
    // against environments where the column may already have been removed
    // manually.
    await queryRunner.query(`
      ALTER TABLE "development_plan"
        DROP COLUMN IF EXISTS "is_frozen";
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Re-create the column with the exact original shape:
    //   BOOLEAN NOT NULL DEFAULT false
    // This matches 1744416000000-AddBookProjectLineageAndPlanFrozen Step 7 so
    // a rollback produces a schema identical to the pre-drop state.
    await queryRunner.query(`
      ALTER TABLE "development_plan"
        ADD COLUMN IF NOT EXISTS "is_frozen" BOOLEAN NOT NULL DEFAULT false;
    `);
  }
}
