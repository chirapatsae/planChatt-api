import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * FixDraftUniqueIndexExcludeCanceled
 *
 * Fixes defect D3: the partial unique index idx_single_active_draft_per_source
 * was originally created with:
 *   WHERE "assembly_status" != 'merged'
 *
 * When the CANCELED status was later added, this index was not updated.
 * CANCELED is a non-merged status, so a CANCELED draft and a new PREPARING
 * draft for the same (sourceType, sourceId) pair violated the unique constraint.
 *
 * The corrected invariant is: at most ONE active draft per (sourceType, sourceId)
 * where active means assemblyStatus IN ('preparing', 'ready').
 * Both MERGED (completed assemblies) and CANCELED (soft-deleted correction drafts)
 * must be excluded from the uniqueness constraint.
 *
 * This migration is idempotent:
 *   - If the old index exists: STEP 1 drops it, STEP 2 creates the correct version.
 *   - If no index exists (synchronize-only setup never ran the original migration):
 *     STEP 1 is a no-op, STEP 2 creates the correct index fresh.
 *
 * Note on rollback:
 *   down() reverts to the original index (WHERE != 'merged'), which does not
 *   exclude CANCELED. This is acceptable only in a dev rollback scenario.
 */
export class FixDraftUniqueIndexExcludeCanceled1744156800000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Step 1: Drop the existing index if it exists.
    // IF EXISTS makes this safe whether the original migration was run or not.
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_single_active_draft_per_source";`,
    );

    // Step 2: Recreate the index excluding both 'merged' and 'canceled'.
    // Only PREPARING and READY drafts participate in the uniqueness constraint.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "idx_single_active_draft_per_source"
      ON "book_assembly_drafts" ("source_type", "source_id")
      WHERE "assembly_status" NOT IN ('merged', 'canceled');
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Step 1: Drop the corrected index.
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_single_active_draft_per_source";`,
    );

    // Step 2: Recreate the original index (pre-CANCELED support).
    // WARNING: This reverts to the broken behavior where CANCELED drafts
    // prevent new PREPARING drafts. Only use in dev rollback scenarios.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "idx_single_active_draft_per_source"
      ON "book_assembly_drafts" ("source_type", "source_id")
      WHERE "assembly_status" != 'merged';
    `);
  }
}
