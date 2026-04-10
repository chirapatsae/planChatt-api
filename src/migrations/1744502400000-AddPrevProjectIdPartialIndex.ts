import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: AddPrevProjectIdPartialIndex
 *
 * Adds a partial index on revised_project_groups(prev_project_id)
 * WHERE deleted_at IS NULL.
 *
 * Business purpose:
 *   The staff-led rollback descendant guard fires a query on every rollback
 *   attempt:
 *
 *     SELECT 1 FROM revised_project_groups
 *     WHERE prev_project_id = $1
 *       AND deleted_at IS NULL
 *     LIMIT 1;
 *
 *   Without an index on prev_project_id, this becomes a full table scan as
 *   revised_project_groups grows. The partial predicate (deleted_at IS NULL)
 *   keeps the index small by excluding soft-deleted rows, which are never
 *   matched by the guard query.
 *
 * Design decisions:
 *   - Partial index (WHERE deleted_at IS NULL): aligns precisely with the
 *     query predicate; soft-deleted rows are irrelevant to the guard and are
 *     excluded to reduce index size and maintenance cost.
 *   - IF NOT EXISTS / IF EXISTS: ensures idempotency so re-running the
 *     migration on a database that already has the index does not error.
 *   - No entity changes: this is a pure database-level optimisation. The
 *     RevisedProjectGroup entity already declares prev_project_id and
 *     deleted_at correctly; no entity modification is required.
 */
export class AddPrevProjectIdPartialIndex1744502400000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_rpg_prev_project_id"
        ON "revised_project_groups" ("prev_project_id")
        WHERE "deleted_at" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_rpg_prev_project_id"`,
    );
  }
}
