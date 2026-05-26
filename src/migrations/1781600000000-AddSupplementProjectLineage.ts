import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: AddSupplementProjectLineage
 *
 * Wave wave-supplement-convergence-milestone-5 / DB-01 (2026-05-25).
 *
 * Implements the M4 CTO decision — Option B "dual segregated DAG" — by
 * creating `supplement_project_lineage`, the per-type segregated mirror
 * of `book_project_lineage` for the supplement-book domain.
 *
 * Why segregated instead of merged:
 *
 *   M4 validated three hypotheses and concluded that mixing supplement
 *   lineage into `book_project_lineage` would require either (a)
 *   extending the `book_project_lineage_project_type_enum` to include
 *   `supplement_project_group` and adding cross-table FK polymorphism, or
 *   (b) repointing supplement rows to a future shared `*_assembly_version`
 *   table. Both options break the Q3=B SUPP_STANDALONE boundary that the
 *   supplement subsystem was built to preserve, and both introduce a
 *   schema migration risk that the segregated table avoids entirely.
 *
 *   The segregated table mirrors `book_project_lineage` byte-for-shape
 *   where reasonable but intentionally omits the `project_type` column —
 *   table membership is the type discriminator for supplement rows.
 *
 * Schema delta:
 *
 *   + supplement_project_lineage (new table)
 *       columns:
 *         id                                       uuid PK
 *         supplement_project_group_id              uuid NOT NULL FK
 *         supplement_assembly_version_id           uuid NOT NULL FK
 *         parent_supplement_assembly_version_id    uuid NULL FK
 *         is_current_leaf                          boolean NOT NULL DEFAULT false
 *         created_at                               timestamptz NOT NULL DEFAULT now()
 *
 *       FKs:
 *         FK_spl_spg            → supplement_project_groups(id) ON DELETE RESTRICT
 *         FK_spl_version        → supplement_assembly_versions(id) ON DELETE RESTRICT
 *         FK_spl_parent_version → supplement_assembly_versions(id) ON DELETE SET NULL
 *
 *       indexes:
 *         idx_spl_spg                  (supplement_project_group_id)
 *         idx_spl_version              (supplement_assembly_version_id)
 *         idx_spl_parent_version       (parent_supplement_assembly_version_id)
 *         idx_spl_one_leaf_per_spg     PARTIAL UNIQUE on (supplement_project_group_id)
 *                                      WHERE is_current_leaf = true
 *
 * Backfill (idempotent — re-run safe):
 *
 *   Live state at migration authoring time: 1 booked DevelopmentPlanSupplement
 *   with 1 SupplementAssemblyVersion (v1), 2 SPGs in the v1 snapshot.
 *
 *   For each row in `supplement_assembly_version_projects` whose
 *   referenced version has `status = 'completed'`, insert a lineage row
 *   with parent_supplement_assembly_version_id = NULL (first appearance)
 *   and is_current_leaf = true (v1 is the only/latest version per SPG).
 *
 *   `WHERE NOT EXISTS` guard makes the backfill idempotent: re-running
 *   the migration after BE-01 starts populating fresh lineage rows will
 *   skip everything that already has a row, regardless of whether the
 *   existing row is a backfill or a live BE-01 write.
 *
 *   Expected post-backfill row count: 2 (matching the 2 SPGs in the v1
 *   snapshot). Verify in psql via:
 *     SELECT COUNT(*) FROM supplement_project_lineage;
 *
 * Critical invariants preserved:
 *
 *   - CLAUDE.md §15 — additive table only; no book-lineage invariant
 *     changes. The new table sits orthogonally beside
 *     `book_project_lineage` and is not referenced by any §15 predicate.
 *
 *   - CLAUDE.md §17.2 — advisory-only AI is unaffected. No `ai_*` table
 *     references lineage by FK; AI snapshot reads continue to use UUID
 *     pointers (§17.3).
 *
 *   - CLAUDE.md §18 — orphan cleanup is unaffected. The §18.4.2 SPG
 *     soft-delete path does NOT touch lineage rows (lineage is preserved
 *     for audit even when the SPG is tombstoned). The §18.8 lineage-lock
 *     check operates on the §14 `prev_project_id` graph, NOT on this
 *     table — the two graphs are distinct.
 *
 *   - CLAUDE.md §20 parity — supplement now has the same lineage-tracking
 *     surface that main-plan has had since W76. DOCS-01 (downstream of
 *     this migration in the M5 DAG) flips §20.6 M4 → LIVE and Invariant 3
 *     → closed.
 *
 *   - Q3=B (SUPP_STANDALONE) — table is owned by the supplement-assembly
 *     module. No import path from supplement → book-assembly. The FKs
 *     reference supplement-owned tables only.
 *
 * Idempotency:
 *
 *   - `CREATE TABLE IF NOT EXISTS` keeps the table creation re-run safe.
 *   - `CREATE INDEX IF NOT EXISTS` (regular + partial unique) re-run safe.
 *   - `INSERT ... WHERE NOT EXISTS (...)` keeps the backfill re-run safe.
 *   - `DROP TABLE IF EXISTS ... CASCADE` keeps the down re-run safe.
 *
 * Backend interaction:
 *
 *   - `synchronize: true` will auto-CREATE the table from the entity
 *     metadata (`SupplementProjectLineage`) once it is registered at
 *     the root DataSource in `app.module.ts` and via `forFeature` in
 *     `SupplementAssemblyModule`. HOWEVER, `synchronize` does NOT
 *     create the PARTIAL UNIQUE index (`idx_spl_one_leaf_per_spg`) —
 *     TypeORM has no decorator for partial unique indexes. The partial
 *     index MUST be created by this migration (or by manual psql) for
 *     the "at most one leaf per SPG" invariant to hold.
 *
 *   - The backfill INSERT MUST be run AFTER the table exists (either
 *     via this migration or via `synchronize`) and BEFORE BE-01 wires
 *     `populateLineageForMerge()` for supplements, so that BE-01 sees
 *     a coherent starting state for the existing v1 snapshot.
 *
 *   - Recommended operator sequence:
 *       1. BE restart → entity sync creates the table (regular indexes only)
 *       2. psql → CREATE UNIQUE INDEX ... (partial unique)
 *       3. psql → INSERT ... SELECT ... (backfill, idempotent)
 *     OR — equivalently — run this migration explicitly, which performs
 *     all three steps atomically.
 */
export class AddSupplementProjectLineage1781600000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Step 1: Create supplement_project_lineage table ──────────────────────
    // NO project_type enum — single-type table (SPG only). Membership is
    // the type discriminator. See entity docstring for rationale.

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "supplement_project_lineage" (
        "id"                                       uuid        NOT NULL DEFAULT uuid_generate_v4(),
        "supplement_project_group_id"              uuid        NOT NULL,
        "supplement_assembly_version_id"           uuid        NOT NULL,
        "parent_supplement_assembly_version_id"    uuid,
        "is_current_leaf"                          boolean     NOT NULL DEFAULT false,
        "created_at"                               TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_supplement_project_lineage" PRIMARY KEY ("id")
      );
    `);

    // ── Step 2: FK — supplement_project_group_id → supplement_project_groups.id
    // ON DELETE RESTRICT: an SPG with lineage rows must not be hard-
    // deleted; lineage is the source of truth for leaf state. SPG
    // tombstones (`deleted_at`) per §18.4.2 do NOT trigger FK action
    // because soft-delete leaves the row in place.

    await queryRunner.query(`
      ALTER TABLE "supplement_project_lineage"
        ADD CONSTRAINT "FK_spl_spg"
          FOREIGN KEY ("supplement_project_group_id")
          REFERENCES "supplement_project_groups" ("id")
          ON DELETE RESTRICT
          ON UPDATE NO ACTION;
    `);

    // ── Step 3: FK — supplement_assembly_version_id → supplement_assembly_versions.id
    // ON DELETE RESTRICT: a version with lineage rows must not be
    // deleted. Mirrors `FK_bpl_book_version` semantics.

    await queryRunner.query(`
      ALTER TABLE "supplement_project_lineage"
        ADD CONSTRAINT "FK_spl_version"
          FOREIGN KEY ("supplement_assembly_version_id")
          REFERENCES "supplement_assembly_versions" ("id")
          ON DELETE RESTRICT
          ON UPDATE NO ACTION;
    `);

    // ── Step 4: FK — parent_supplement_assembly_version_id (nullable) ─────────
    // ON DELETE SET NULL: matches `FK_bpl_parent_book_version`. If the
    // parent version is removed (rare — typically rollback/correction
    // flows), preserve the child lineage row for audit but clear the
    // dangling pointer.

    await queryRunner.query(`
      ALTER TABLE "supplement_project_lineage"
        ADD CONSTRAINT "FK_spl_parent_version"
          FOREIGN KEY ("parent_supplement_assembly_version_id")
          REFERENCES "supplement_assembly_versions" ("id")
          ON DELETE SET NULL
          ON UPDATE NO ACTION;
    `);

    // ── Step 5: Regular indexes ───────────────────────────────────────────────

    // Lookup by SPG — used by lineage read paths (Rule-4-equivalent
    // rollback guard, Rule-5-equivalent correction guard).
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_spl_spg"
        ON "supplement_project_lineage" ("supplement_project_group_id");
    `);

    // Lookup by version — used when deprecating/rolling back a version
    // to find all SPGs whose leaf flag must be cleared.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_spl_version"
        ON "supplement_project_lineage" ("supplement_assembly_version_id");
    `);

    // Lookup by parent version — used for descendant queries to
    // determine whether a given version has any child lineage entries
    // depending on it.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_spl_parent_version"
        ON "supplement_project_lineage" ("parent_supplement_assembly_version_id");
    `);

    // ── Step 6: Partial UNIQUE — one leaf per SPG ─────────────────────────────
    // Enforces the business invariant: at most one supplement_project_lineage
    // row per supplement_project_group_id may have is_current_leaf = true at
    // any time. TypeORM cannot express partial unique via decorator, so the
    // index lives here. NOTE: this single-column partial-unique is sufficient
    // (no project_type column on this table — membership is the discriminator).

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_spl_one_leaf_per_spg"
        ON "supplement_project_lineage" ("supplement_project_group_id")
        WHERE "is_current_leaf" = true;
    `);

    // ── Step 7: Backfill from existing supplement_assembly_version_projects ──
    // Idempotent — re-run safe via WHERE NOT EXISTS guard.
    //
    // All currently-completed versions are treated as first-appearance
    // (parent NULL, is_current_leaf=true) because the live state is a
    // single v1 per supplement. If a future operator runs this migration
    // AFTER v2/v3 exist (theoretical — BE-01 will be live before that),
    // the WHERE NOT EXISTS guard avoids duplicating rows; manual triage
    // would be required to flip the correct leaf flag, which is exactly
    // the safer failure mode.

    await queryRunner.query(`
      INSERT INTO "supplement_project_lineage" (
        "supplement_project_group_id",
        "supplement_assembly_version_id",
        "parent_supplement_assembly_version_id",
        "is_current_leaf"
      )
      SELECT
        savp."supplement_project_group_id",
        savp."version_id",
        NULL AS parent_supplement_assembly_version_id,
        true AS is_current_leaf
      FROM "supplement_assembly_version_projects" savp
      JOIN "supplement_assembly_versions" v
        ON v."id" = savp."version_id"
      WHERE v."status" = 'completed'
        AND NOT EXISTS (
          SELECT 1
          FROM "supplement_project_lineage" spl
          WHERE spl."supplement_project_group_id" = savp."supplement_project_group_id"
            AND spl."supplement_assembly_version_id" = savp."version_id"
        );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // DROP TABLE CASCADE removes the table together with all of its own
    // indexes (regular + partial unique) and FK constraints. There are
    // no incoming FKs from other tables (nothing references
    // supplement_project_lineage), so CASCADE here is conservative —
    // included for symmetry with the main-plan precedent at
    // `1744416000000-AddBookProjectLineageAndPlanFrozen.ts:152-154`.

    await queryRunner.query(`
      DROP TABLE IF EXISTS "supplement_project_lineage" CASCADE;
    `);
  }
}
