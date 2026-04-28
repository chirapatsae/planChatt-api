import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: AddAmphoeIdToSupplementProjectGroups — Wave 55 W55-DB-01.
 *
 * Adds a nullable `amphoe_id` column + FK to `amphoes(id)` ON DELETE SET NULL
 * on the `supplement_project_groups` (SPG) table, bringing it into parity
 * with the sibling tables `project_groups` (PG) and `revised_project_groups`
 * (RPG) which already carry an `amphoe_id` FK.
 *
 * Business purpose:
 *   The CTO audit GAP-8 found that SPG rows could not participate in
 *   province-level amphoe aggregation inside the Executive Chat, because
 *   `geo-enrichment.service.ts` had no amphoe column to read on SPG. This
 *   migration adds the storage slot. W55-BE-04 will re-wire the
 *   geo-enrichment read path to consume this column once the migration
 *   lands. This migration is the prerequisite.
 *
 * Design decisions:
 *   - Column is NULLABLE. Historical rows are intentionally NOT backfilled
 *     — there is no authoritative way to infer amphoe retroactively, and
 *     geo-enrichment already tolerates NULL by skipping the row. Backfill
 *     is out of scope for this task.
 *   - FK uses ON DELETE SET NULL, explicitly per W55-DB-01. If an Amphoe
 *     row were ever removed, the SPG audit row must survive with NULL
 *     rather than cascade-delete (SPG is §15 book lineage history and
 *     MUST NOT be silently destroyed). Note: PG and RPG currently use
 *     ON DELETE CASCADE for their amphoe FK — SPG deliberately diverges
 *     here because PG/RPG were authored before this policy was clarified,
 *     and the task spec pins SET NULL as the correct lifecycle for
 *     audit-preserving tables.
 *   - Column type is `text` to match `amphoes.id` (varchar PK declared via
 *     `@PrimaryColumn()` without an explicit length). PG and RPG currently
 *     use matching varchar columns on `amphoe_id` — `text` and `varchar`
 *     interoperate freely in PostgreSQL for FK purposes.
 *
 * Rollback safety:
 *   - Down migration drops the FK first, then the column, in strict LIFO
 *     order. No data loss risk — the column starts NULL.
 *
 * Scope (§14, §15):
 *   DDL column-add is not a row mutation, so lineage and book lineage
 *   immutability locks do not apply.
 */
export class AddAmphoeIdToSupplementProjectGroups1748100000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Step 1: Add nullable amphoe_id column matching amphoes.id type.
    await queryRunner.query(`
      ALTER TABLE "supplement_project_groups"
        ADD COLUMN IF NOT EXISTS "amphoe_id" text DEFAULT NULL;
    `);

    // Step 2: Add FK amphoe_id -> amphoes(id) ON DELETE SET NULL.
    await queryRunner.query(`
      ALTER TABLE "supplement_project_groups"
        ADD CONSTRAINT "FK_supplement_project_groups_amphoe_id"
        FOREIGN KEY ("amphoe_id") REFERENCES "amphoes"("id")
        ON DELETE SET NULL
        ON UPDATE CASCADE;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop FK first, then column (strict LIFO order).
    await queryRunner.query(`
      ALTER TABLE "supplement_project_groups"
        DROP CONSTRAINT IF EXISTS "FK_supplement_project_groups_amphoe_id";
    `);

    await queryRunner.query(`
      ALTER TABLE "supplement_project_groups"
        DROP COLUMN IF EXISTS "amphoe_id";
    `);
  }
}
