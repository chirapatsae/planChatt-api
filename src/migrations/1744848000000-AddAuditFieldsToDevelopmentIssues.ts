import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: AddAuditFieldsToDevelopmentIssues
 *
 * Adds three audit columns to the `development_issues` table:
 *
 *   1. `updated_at`  TIMESTAMP, nullable  -- tracks last edit time
 *   2. `updated_by`  UUID FK -> work_history(id), nullable, ON DELETE SET NULL
 *   3. `deleted_by`  UUID FK -> work_history(id), nullable, ON DELETE SET NULL
 *
 * Business purpose:
 *   `development_issues` currently tracks creation context (`created_at`,
 *   `created_by`) and soft-delete time (`deleted_at`), but does not record
 *   WHO last edited or WHO soft-deleted a row. CLAUDE.md S12 (Audit Rule)
 *   requires all mutations to be traceable. These columns close the audit
 *   gap for update and soft-delete operations on DevelopmentIssue.
 *
 * Design decisions:
 *   - All three columns are NULLABLE so existing rows require no backfill.
 *   - ON DELETE SET NULL for both FKs: if a WorkHistory row is removed, the
 *     audit reference is cleared rather than cascade-deleting the issue.
 *     This matches the `canceled_by_id` FK pattern in `book_assembly_drafts`.
 *   - No index added for `updated_by` / `deleted_by` -- these columns are
 *     used for audit display, not for query filtering in hot paths.
 *
 * Rollback safety:
 *   - Down migration drops FKs first, then columns, in strict LIFO order.
 *   - No data loss risk -- columns start NULL and contain only supplementary
 *     audit metadata.
 */
export class AddAuditFieldsToDevelopmentIssues1744848000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Step 1: Add updated_at nullable timestamp column.
    await queryRunner.query(`
      ALTER TABLE "development_issues"
        ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMP DEFAULT NULL;
    `);

    // Step 2: Add updated_by nullable UUID column.
    await queryRunner.query(`
      ALTER TABLE "development_issues"
        ADD COLUMN IF NOT EXISTS "updated_by" uuid DEFAULT NULL;
    `);

    // Step 3: Add deleted_by nullable UUID column.
    await queryRunner.query(`
      ALTER TABLE "development_issues"
        ADD COLUMN IF NOT EXISTS "deleted_by" uuid DEFAULT NULL;
    `);

    // Step 4: Add FK for updated_by -> work_history(id) ON DELETE SET NULL.
    await queryRunner.query(`
      ALTER TABLE "development_issues"
        ADD CONSTRAINT "FK_development_issues_updated_by"
        FOREIGN KEY ("updated_by") REFERENCES "work_history"("id")
        ON DELETE SET NULL;
    `);

    // Step 5: Add FK for deleted_by -> work_history(id) ON DELETE SET NULL.
    await queryRunner.query(`
      ALTER TABLE "development_issues"
        ADD CONSTRAINT "FK_development_issues_deleted_by"
        FOREIGN KEY ("deleted_by") REFERENCES "work_history"("id")
        ON DELETE SET NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop FKs first, then columns (strict LIFO order).

    await queryRunner.query(`
      ALTER TABLE "development_issues"
        DROP CONSTRAINT IF EXISTS "FK_development_issues_deleted_by";
    `);

    await queryRunner.query(`
      ALTER TABLE "development_issues"
        DROP CONSTRAINT IF EXISTS "FK_development_issues_updated_by";
    `);

    await queryRunner.query(`
      ALTER TABLE "development_issues"
        DROP COLUMN IF EXISTS "deleted_by";
    `);

    await queryRunner.query(`
      ALTER TABLE "development_issues"
        DROP COLUMN IF EXISTS "updated_by";
    `);

    await queryRunner.query(`
      ALTER TABLE "development_issues"
        DROP COLUMN IF EXISTS "updated_at";
    `);
  }
}
