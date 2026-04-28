import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: AddPageNumberToSupplementProjectGroups — Wave 58 W58-DB-01.
 *
 * Adds a nullable `page_number` column on the `supplement_project_groups`
 * (SPG) table, bringing it into parity with the sibling tables
 * `project_groups` (PG) and `revised_project_groups` (RPG) which already
 * carry a `page_number` column.
 *
 * Business purpose:
 *   The Wave 58 Executive Chat dispatch found that supplement projects
 *   could not answer "อยู่หน้าไหน" because SPG had no `page_number`
 *   column. This migration adds the storage slot. W58-BE-AGG-03 will
 *   wire the chat envelope to read `spg.pageNumber` once this column
 *   exists.
 *
 * Design decisions:
 *   - Column is NULLABLE. `page_number` is populated when the book is
 *     compiled; legacy SPG rows MAY remain NULL until next book
 *     compilation. This matches PG/RPG semantics — no backfill.
 *   - Type is `int` matching the sibling tables' `pageNumber: number | null`
 *     property (TypeORM `@Column({ type: 'int', nullable: true })`).
 *   - No constraint linking `page_number` to `is_booked` — sibling
 *     tables don't enforce that either.
 *
 * Rollback safety:
 *   - Down migration drops the column. No data loss risk beyond the
 *     newly-added NULLs (column starts NULL on add).
 *
 * Idempotency:
 *   - `IF NOT EXISTS` on up, `IF EXISTS` on down so re-running is safe.
 *
 * Scope (§14, §15):
 *   DDL column-add is not a row mutation, so lineage and book lineage
 *   immutability locks do not apply.
 */
export class AddPageNumberToSupplementProjectGroups1748300000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "supplement_project_groups"
        ADD COLUMN IF NOT EXISTS "page_number" int DEFAULT NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "supplement_project_groups"
        DROP COLUMN IF EXISTS "page_number";
    `);
  }
}
