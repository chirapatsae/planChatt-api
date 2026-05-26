import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: AddBookedAtToBookEntities
 *
 * Wave wave-lineage-linear-chain-by-bookedAt / DB-01.
 *
 * Adds a nullable `booked_at TIMESTAMPTZ` column to the three book
 * entities so CLAUDE.md §15 Book Lineage Immutability can order the
 * cross-category linear chain by FINALIZE moment (Model A) rather than
 * by `createdAt` (the pre-Wave-116 model that Wave 116's parallel-siblings
 * rewrite replaced). The user-directed revert is:
 *
 *   "เก่ากว่าไม่ได้ดูที่ create ให้ดูที่ bookedAt"
 *
 * Affected tables:
 *
 *   - development_plan
 *   - development_plan_revision
 *   - development_plan_supplement
 *
 * Column shape on all three tables:
 *
 *   booked_at TIMESTAMPTZ NULL
 *
 *   - NULLABLE on purpose: draft rows (`is_booked = false`) MUST keep
 *     `booked_at IS NULL`; pre-migration rows with no recoverable
 *     finalize timestamp also stay NULL (edge case — backfill falls
 *     back to `createdAt` so this should be zero in practice).
 *   - No CHECK constraint and no DEFAULT — the column is purely a
 *     finalize-moment timestamp, not a workflow flag. BE-01 owns the
 *     write paths.
 *   - TIMESTAMPTZ chosen to match the most-recent precedent
 *     (`supplement_assembly_versions.merged_at`) and so that the
 *     cross-category sort in §15.2 / §15.3 is TZ-safe; the older
 *     `create_at` / `created_at` columns are `timestamp without time
 *     zone`, but for a brand-new column we prefer TZ-aware.
 *
 * Backfill source (per row, idempotent — only touches rows where
 * `booked_at IS NULL`):
 *
 *   1. development_plan (is_booked = true):
 *        MAX(merged_at) FROM book_assembly_versions
 *          WHERE source_id = development_plan.id
 *            AND source_type = 'main_plan'
 *        Fallback: development_plan.create_at
 *
 *   2. development_plan_revision (is_booked = true):
 *        MAX(merged_at) FROM book_assembly_versions
 *          WHERE source_id = development_plan_revision.id
 *            AND source_type IN ('edit_revision', 'change_revision')
 *        Fallback: development_plan_revision.created_at
 *
 *   3. development_plan_supplement (is_booked = true):
 *        MAX(merged_at) FROM supplement_assembly_versions
 *          WHERE development_plan_supplement_id = development_plan_supplement.id
 *        Fallback: development_plan_supplement.created_at
 *
 * NOTE on `BookAssemblySourceType` enum literals — verified against
 * `backend/src/book-assembly/enums/book-assembly.enums.ts`:
 *
 *   MAIN_PLAN        = 'main_plan'
 *   EDIT_REVISION    = 'edit_revision'
 *   CHANGE_REVISION  = 'change_revision'
 *
 * (Lowercase snake_case — DIFFERENT from the placeholder names in the
 * task brief which used SCREAMING_SNAKE_CASE.)
 *
 * NOTE on supplement assembly — the supplement subsystem has a dedicated
 * `supplement_assembly_versions` table joined on
 * `development_plan_supplement_id` (NOT `source_id`/`source_type`).
 * Verified against
 * `backend/src/supplement-assembly/entities/supplement-assembly-version.entity.ts`.
 *
 * Partial indices (for §15.3 sibling-scan path: "any sibling under the
 * same plan with strictly-newer booked_at"):
 *
 *   idx_dpr_plan_booked_at
 *     ON development_plan_revision (development_plan_id, booked_at DESC)
 *     WHERE booked_at IS NOT NULL AND deleted_at IS NULL;
 *
 *   idx_dps_plan_booked_at
 *     ON development_plan_supplement (development_plan_id, booked_at DESC)
 *     WHERE booked_at IS NOT NULL AND deleted_at IS NULL;
 *
 * Index notes:
 *
 *   - `DESC` ordering matches the §15.2 "newer-than-me" probe shape
 *     (`booked_at > $1 LIMIT 1`).
 *   - Partial predicate excludes drafts (booked_at NULL) and tombstones
 *     (deleted_at NOT NULL) so the index stays compact.
 *   - No index on `development_plan` itself — §15 plan-level lock is
 *     a simple "any non-deleted child exists" check that does not
 *     scan booked_at.
 *
 * Critical invariants preserved:
 *
 *   - CLAUDE.md §15.7 Unlock Semantics — soft-deleted descendants MUST
 *     NOT contribute to lock. The partial index `deleted_at IS NULL`
 *     filter mirrors that invariant.
 *
 *   - CLAUDE.md §15.11 — guard runs BEFORE write. The index supports
 *     the predicate; it does not enforce it.
 *
 *   - CLAUDE.md §18 Orphan Cleanup — cascade transitions do not touch
 *     `booked_at`; this column is book-level metadata, not project-level.
 *
 *   - CLAUDE.md §12 — no `tracking_status` interaction; book finalize
 *     events are already audited via `book_assembly_versions` /
 *     `supplement_assembly_versions` rows.
 *
 *   - Idempotent — `ADD COLUMN IF NOT EXISTS` + UPDATE guarded by
 *     `WHERE booked_at IS NULL` means re-run is a no-op.
 *
 *   - Reversibility — `down()` drops indices then columns in reverse
 *     order. All `IF EXISTS`.
 */
export class AddBookedAtToBookEntities1781200000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Step 1: Add booked_at column to all three book tables ────────────

    await queryRunner.query(`
      ALTER TABLE "development_plan"
        ADD COLUMN IF NOT EXISTS "booked_at" TIMESTAMPTZ NULL;
    `);

    await queryRunner.query(`
      ALTER TABLE "development_plan_revision"
        ADD COLUMN IF NOT EXISTS "booked_at" TIMESTAMPTZ NULL;
    `);

    await queryRunner.query(`
      ALTER TABLE "development_plan_supplement"
        ADD COLUMN IF NOT EXISTS "booked_at" TIMESTAMPTZ NULL;
    `);

    // ── Step 2: Backfill development_plan from book_assembly_versions ────
    //
    // Source: book_assembly_versions where source_type='main_plan'.
    // Use MAX(merged_at) so plans with multiple sibling versions
    // (re-merge corrections) get the LATEST finalize moment, which is
    // semantically the current booked moment.

    await queryRunner.query(`
      UPDATE "development_plan" AS p
         SET "booked_at" = sub.merged_at
        FROM (
          SELECT bav."source_id"::uuid AS plan_id,
                 MAX(bav."merged_at")  AS merged_at
            FROM "book_assembly_versions" bav
           WHERE bav."source_type" = 'main_plan'
             AND bav."merged_at" IS NOT NULL
           GROUP BY bav."source_id"
        ) AS sub
       WHERE p."id" = sub.plan_id
         AND p."is_booked" = true
         AND p."booked_at" IS NULL;
    `);

    // Fallback: booked plans with no book_assembly_versions row use
    // their own create_at. Idempotent — guarded by booked_at IS NULL.
    await queryRunner.query(`
      UPDATE "development_plan"
         SET "booked_at" = "create_at"
       WHERE "is_booked" = true
         AND "booked_at" IS NULL;
    `);

    // ── Step 3: Backfill development_plan_revision ───────────────────────

    await queryRunner.query(`
      UPDATE "development_plan_revision" AS r
         SET "booked_at" = sub.merged_at
        FROM (
          SELECT bav."source_id"::uuid AS revision_id,
                 MAX(bav."merged_at")  AS merged_at
            FROM "book_assembly_versions" bav
           WHERE bav."source_type" IN ('edit_revision', 'change_revision')
             AND bav."merged_at" IS NOT NULL
           GROUP BY bav."source_id"
        ) AS sub
       WHERE r."id" = sub.revision_id
         AND r."is_booked" = true
         AND r."booked_at" IS NULL;
    `);

    await queryRunner.query(`
      UPDATE "development_plan_revision"
         SET "booked_at" = "created_at"
       WHERE "is_booked" = true
         AND "booked_at" IS NULL;
    `);

    // ── Step 4: Backfill development_plan_supplement ─────────────────────
    //
    // Different join shape: supplement_assembly_versions joins on
    // development_plan_supplement_id (its own FK column), NOT on
    // source_id/source_type. Supplement assembly is a dedicated
    // standalone subsystem (SUPP_STANDALONE).

    await queryRunner.query(`
      UPDATE "development_plan_supplement" AS s
         SET "booked_at" = sub.merged_at
        FROM (
          SELECT sav."development_plan_supplement_id" AS supplement_id,
                 MAX(sav."merged_at")                 AS merged_at
            FROM "supplement_assembly_versions" sav
           WHERE sav."merged_at" IS NOT NULL
           GROUP BY sav."development_plan_supplement_id"
        ) AS sub
       WHERE s."id" = sub.supplement_id
         AND s."is_booked" = true
         AND s."booked_at" IS NULL;
    `);

    await queryRunner.query(`
      UPDATE "development_plan_supplement"
         SET "booked_at" = "created_at"
       WHERE "is_booked" = true
         AND "booked_at" IS NULL;
    `);

    // ── Step 5: Partial indices for §15 sibling scan ─────────────────────

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_dpr_plan_booked_at"
        ON "development_plan_revision" ("development_plan_id", "booked_at" DESC)
        WHERE "booked_at" IS NOT NULL AND "deleted_at" IS NULL;
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_dps_plan_booked_at"
        ON "development_plan_supplement" ("development_plan_id", "booked_at" DESC)
        WHERE "booked_at" IS NOT NULL AND "deleted_at" IS NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverse order — drop indices first, then columns. All IF EXISTS so
    // partial-state databases are safe.

    await queryRunner.query(`
      DROP INDEX IF EXISTS "idx_dps_plan_booked_at";
    `);

    await queryRunner.query(`
      DROP INDEX IF EXISTS "idx_dpr_plan_booked_at";
    `);

    await queryRunner.query(`
      ALTER TABLE "development_plan_supplement"
        DROP COLUMN IF EXISTS "booked_at";
    `);

    await queryRunner.query(`
      ALTER TABLE "development_plan_revision"
        DROP COLUMN IF EXISTS "booked_at";
    `);

    await queryRunner.query(`
      ALTER TABLE "development_plan"
        DROP COLUMN IF EXISTS "booked_at";
    `);
  }
}
