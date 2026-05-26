import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: SupplementAssemblyVersionMetadataParity
 *
 * Wave wave-supplement-assembly-metadata-parity DB-01.
 *
 * Adds three nullable read-side display columns to
 * `supplement_assembly_versions` so the FE version card on
 * `/local-plan-book/assembly/supplement` can render the same chips that
 * `book_assembly_versions` (main-plan) already supports:
 *
 *   - `part3_project_count`     INTEGER NULL
 *   - `part3_project_snapshot`  JSONB   NULL  (Thai title string array)
 *   - `total_pages`             INTEGER NULL
 *
 * Shape matches the main-plan precedent at
 * `backend/src/book-assembly/entities/book-assembly-version.entity.ts`
 * lines 109-130 (same TypeORM types, no CHECK, no default). The only
 * intentional divergence is nullability: the supplement table carries
 * pre-existing Wave-A rows that have no snapshot data captured at merge
 * time, so the columns MUST be NULL-tolerant. BE-01 will populate them
 * going forward for new merges; FE-01 already renders `null` as "—".
 *
 * Critical invariants preserved:
 *
 *   - CLAUDE.md §15 — additive-only schema change; nullable columns mean
 *     pre-existing rows are not rewritten and a future `softRemove` /
 *     restore on a finalized supplement does not corrupt audit.
 *
 *   - CLAUDE.md §18 / §18.2.1 SUPPLEMENT finalize trigger — the orphan
 *     cleanup cascade contract is untouched. The new columns are
 *     read-only metadata; they do not feed the cascade.
 *
 *   - CLAUDE.md §12 — no `tracking_status` interaction; this is a
 *     book-version metadata add, not a workflow transition.
 *
 *   - Idempotent backfill — the UPDATE block targets only rows whose
 *     new columns are still NULL (`WHERE part3_project_count IS NULL`,
 *     etc.). Safe to re-run after a `down()` → `up()` cycle and safe
 *     against races with any concurrent BE-01 writer (a writer that
 *     fills the columns explicitly is not overwritten).
 *
 *   - Reversibility — `down()` drops the three columns in reverse
 *     order. Drops are guarded with `IF EXISTS` so partial-state
 *     databases are safe.
 *
 * Backfill source: `metadata_json.approvedSpgIds` (existing audit JSON
 * payload on every Wave-A version row) + the
 * `supplement_assembly_version_projects` join table for the snapshot
 * titles in `page_number` order. `total_pages` is intentionally NOT
 * backfilled — recovering it would require re-parsing every merged
 * PDF, which is out of scope; legacy rows stay NULL and FE renders "—".
 */
export class SupplementAssemblyVersionMetadataParity1781100000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Additive column add. `ADD COLUMN IF NOT EXISTS` keeps the up
    //    idempotent against partial-failure rerun. All three NULL.
    await queryRunner.query(`
      ALTER TABLE "supplement_assembly_versions"
        ADD COLUMN IF NOT EXISTS "part3_project_count" integer NULL,
        ADD COLUMN IF NOT EXISTS "part3_project_snapshot" jsonb NULL,
        ADD COLUMN IF NOT EXISTS "total_pages" integer NULL;
    `);

    // 2. Idempotent backfill — count from metadata_json.approvedSpgIds.
    //    Only touches rows where `part3_project_count IS NULL` so a
    //    re-run (or a row already populated by BE-01) is a no-op.
    //    Skips rows whose metadata_json is null or lacks the key.
    await queryRunner.query(`
      UPDATE "supplement_assembly_versions" AS v
         SET "part3_project_count" =
               jsonb_array_length(v."metadata_json" -> 'approvedSpgIds')
       WHERE v."part3_project_count" IS NULL
         AND v."metadata_json" IS NOT NULL
         AND v."metadata_json" ? 'approvedSpgIds'
         AND jsonb_typeof(v."metadata_json" -> 'approvedSpgIds') = 'array';
    `);

    // 3. Idempotent backfill — snapshot titles from the join table,
    //    ordered by page_number to match main-plan shape (string[]).
    //    Versions with zero join rows get `[]` (matches main-plan
    //    "no projects" rendering rather than NULL).
    await queryRunner.query(`
      UPDATE "supplement_assembly_versions" AS v
         SET "part3_project_snapshot" = COALESCE(sub.titles, '[]'::jsonb)
        FROM (
          SELECT savp."version_id" AS version_id,
                 jsonb_agg(spg."title" ORDER BY savp."page_number") AS titles
            FROM "supplement_assembly_version_projects" savp
            JOIN "supplement_project_groups" spg
              ON spg."id" = savp."supplement_project_group_id"
           GROUP BY savp."version_id"
        ) AS sub
       WHERE v."id" = sub.version_id
         AND v."part3_project_snapshot" IS NULL;
    `);

    // Note: `total_pages` deliberately left NULL for legacy rows.
    //       Recovering it would require re-parsing every merged PDF
    //       which is out of scope. BE-01 populates it on new merges.
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverse order. `DROP COLUMN IF EXISTS` keeps `down()` idempotent.
    await queryRunner.query(`
      ALTER TABLE "supplement_assembly_versions"
        DROP COLUMN IF EXISTS "total_pages",
        DROP COLUMN IF EXISTS "part3_project_snapshot",
        DROP COLUMN IF EXISTS "part3_project_count";
    `);
  }
}
