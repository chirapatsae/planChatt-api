import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: CreateChangeAssemblyTables — Wave A3 / DB-01.
 *
 * Standalone CHANGE_REVISION subsystem (near-twin of Wave A2's
 * EDIT_REVISION split, which itself mirrored Wave A1's MAIN_PLAN split
 * after the SUPP_STANDALONE pattern). Wave A3 is structurally
 * near-identical to Wave A2 because CHANGE_REVISION is also a
 * `DevelopmentPlanRevision` row — just discriminated by
 * `revisionType.id` instead. Creates:
 *
 *   - 5 Postgres enum types (Q3=B duplicate — separate from
 *     `book_assembly_*` AND `main_assembly_*` AND `edit_assembly_*`
 *     types so future drift is contained per-subsystem):
 *       change_assembly_part_upload_status
 *       change_assembly_draft_status
 *       change_assembly_version_status
 *       change_assembly_correction_mode
 *       change_assembly_part_source
 *
 *     Enum VALUES are identical to EDIT's (and MAIN's) so cast-by-text
 *     round-trips cleanly during backfill.
 *
 *   - 4 tables:
 *       change_assembly_drafts
 *       change_assembly_versions
 *       change_assembly_version_projects   (denormalized page_map)
 *       change_project_lineage             (segregated RPG lineage)
 *
 *   - indexes per task spec, including the partial unique indexes
 *     `idx_change_single_active_draft_per_revision`,
 *     `idx_change_single_completed_per_revision`, and
 *     `idx_change_spl_one_leaf_per_rpg` — none of which are expressible
 *     via TypeORM decorator.
 *
 * NEAR-TWIN OF Wave A2 (EDIT):
 *
 *   - Parent entity is `DevelopmentPlanRevision` (table:
 *     `development_plan_revision` — SINGULAR), same as EDIT. All `*_id`
 *     parent FKs target `development_plan_revision.id`.
 *
 *   - Lineage table FK target is `revised_project_groups.id` (same as
 *     EDIT). Lineage column name is `revised_project_group_id` —
 *     matches `RevisedProjectGroup` entity conventions elsewhere in
 *     the codebase.
 *
 *   - Source-data discriminator used during backfill — ONLY difference
 *     from EDIT:
 *       book_assembly_drafts.source_type = 'change_revision'
 *       book_assembly_versions.source_type = 'change_revision'
 *       book_project_lineage.project_type = 'revised_project_group'
 *         JOIN INTO book_assembly_versions WHERE source_type='change_revision'
 *
 *     EDIT and CHANGE share `project_type='revised_project_group'` in
 *     legacy `book_project_lineage`. The EDIT migration partitions by
 *     joining into `book_assembly_versions WHERE source_type='edit_revision'`.
 *     This migration uses the same pattern with `source_type='change_revision'`.
 *
 * After table creation, this migration ALSO copies existing CHANGE data
 * out of `book_assembly_*` / `book_project_lineage`:
 *
 *   1. `book_assembly_drafts WHERE source_type='change_revision'`
 *        → `change_assembly_drafts`
 *
 *   2. `book_assembly_versions WHERE source_type='change_revision'`
 *        → `change_assembly_versions` (excluding `part3_page_map`)
 *
 *   3. `book_assembly_versions.part3_page_map JSONB`
 *        → `change_assembly_version_projects` (one row per
 *           `(version_id, revised_project_group_id, page_number)`)
 *
 *   4. `book_project_lineage WHERE project_type='revised_project_group'`
 *        → `change_project_lineage` (only rows whose `book_version_id`
 *          maps to a `change_assembly_versions` row — i.e. lineage rows
 *          owned by CHANGE versions; EDIT-owned lineage rows already
 *          migrated to `edit_project_lineage` in Wave A2)
 *
 * All backfill inserts are idempotent (`NOT EXISTS` guards on PK / on
 * the natural-key tuple). Live data survey at migration authoring time
 * (2026-05-25, same scan as Wave A2 prep) showed:
 *   - book_assembly_versions WHERE source_type='change_revision' → 0 rows
 *   - book_assembly_drafts   WHERE source_type='change_revision' → 0 rows
 *
 * Backfill is a structural no-op for live data today but is included
 * for future-proofing if any CHANGE data lands before the CLEANUP wave.
 *
 * Old `book_assembly_*` rows are NOT touched — the legacy
 * `BookAssemblyService` continues to read/write them until CLEANUP-01
 * verifies zero traffic.
 *
 * `synchronize: true` interaction:
 *
 *   - On the next BE restart, TypeORM `synchronize` will see the four
 *     new entities (`ChangeAssemblyDraft`, `ChangeAssemblyVersion`,
 *     `ChangeAssemblyVersionProject`, `ChangeProjectLineage` — created
 *     by BE-01) and CREATE the tables + their decorator-declared
 *     indexes automatically.
 *
 *   - `synchronize` does NOT create:
 *       a) the PARTIAL UNIQUE indexes (none of:
 *          idx_change_single_active_draft_per_revision,
 *          idx_change_single_completed_per_revision,
 *          idx_change_spl_one_leaf_per_rpg are decorator-expressible)
 *       b) the data-copy INSERTs (Steps 6-9 below)
 *
 *   - WARNING: `synchronize: true` will DROP partial-unique indexes on
 *     every BE restart because TypeORM cannot represent them in the
 *     entity schema. Operator MUST re-apply the partial indexes via
 *     psql after any BE restart that follows index loss. See
 *     `memory/project_typeorm_synchronize.md`. Same caveat applied to
 *     Wave A1 and Wave A2 — operator re-applied via psql in the QA
 *     gate after BE restart.
 *
 *   - The recommended operator sequence is therefore EITHER:
 *       (a) run this migration explicitly (does all of the above
 *           atomically), OR
 *       (b) restart BE first (entity sync creates tables + regular
 *           indexes only) and then run this migration to add the
 *           partial-unique indexes + backfill.
 *
 * §15 / §17.2 / §18 / §20 — additive only, no invariant change. Wave
 * A3 introduces NO FK from change_assembly_* to book_assembly_* (Q3=B
 * standalone). The CHANGE subsystem is read/write-isolated until BE-01
 * lands.
 */
export class CreateChangeAssemblyTables1781900000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Step 1: Enum types (idempotent via DO / pg_type lookup) ──────

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_type
           WHERE typname = 'change_assembly_part_upload_status'
        ) THEN
          CREATE TYPE "change_assembly_part_upload_status" AS ENUM (
            'pending', 'uploaded', 'generated', 'reused'
          );
        END IF;
      END$$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_type
           WHERE typname = 'change_assembly_draft_status'
        ) THEN
          CREATE TYPE "change_assembly_draft_status" AS ENUM (
            'preparing', 'ready', 'merged', 'canceled'
          );
        END IF;
      END$$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_type
           WHERE typname = 'change_assembly_version_status'
        ) THEN
          CREATE TYPE "change_assembly_version_status" AS ENUM (
            'completed', 'deprecated'
          );
        END IF;
      END$$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_type
           WHERE typname = 'change_assembly_correction_mode'
        ) THEN
          CREATE TYPE "change_assembly_correction_mode" AS ENUM (
            'cancellation',
            'correction_part1',
            'correction_part2',
            'correction_part3'
          );
        END IF;
      END$$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_type
           WHERE typname = 'change_assembly_part_source'
        ) THEN
          CREATE TYPE "change_assembly_part_source" AS ENUM (
            'uploaded', 'generated', 'reused'
          );
        END IF;
      END$$;
    `);

    // ── Step 2: change_assembly_versions table ────────────────────────
    // Created BEFORE change_assembly_drafts because the draft table has
    // an FK to it (`previous_version_id`).

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "change_assembly_versions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "development_plan_revision_id" uuid NOT NULL,
        "version_number" integer NOT NULL CHECK ("version_number" >= 1),
        "status" "change_assembly_version_status" NOT NULL DEFAULT 'completed',
        "correction_mode" "change_assembly_correction_mode",
        "correction_reason" text,
        "part1_file_path" character varying NOT NULL,
        "part1_source" "change_assembly_part_source" NOT NULL,
        "part1_original_file_name" character varying,
        "part2_file_path" character varying NOT NULL,
        "part2_source" "change_assembly_part_source" NOT NULL,
        "part2_original_file_name" character varying,
        "part3_file_path" character varying NOT NULL,
        "part3_source" "change_assembly_part_source" NOT NULL,
        "part3_project_snapshot" jsonb NOT NULL,
        "part3_project_count" integer NOT NULL,
        "merged_file_path" character varying NOT NULL,
        "merged_at" TIMESTAMP NOT NULL,
        "total_pages" integer,
        "created_by_id" uuid NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "deprecated_at" TIMESTAMP,
        "deprecated_by_id" uuid,
        "deprecation_reason" text,
        CONSTRAINT "PK_change_assembly_versions" PRIMARY KEY ("id"),
        CONSTRAINT "FK_cav_revision" FOREIGN KEY ("development_plan_revision_id")
          REFERENCES "development_plan_revision"("id")
          ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "FK_cav_created_by" FOREIGN KEY ("created_by_id")
          REFERENCES "work_history"("id")
          ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "FK_cav_deprecated_by" FOREIGN KEY ("deprecated_by_id")
          REFERENCES "work_history"("id")
          ON DELETE NO ACTION ON UPDATE NO ACTION
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_change_version_revision"
        ON "change_assembly_versions" ("development_plan_revision_id");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_change_version_status"
        ON "change_assembly_versions" ("status");
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_change_version_revision_number"
        ON "change_assembly_versions"
        ("development_plan_revision_id", "version_number");
    `);

    // Single Official Version Rule — mirror of EDIT's
    // `idx_edit_single_completed_per_revision` and MAIN's
    // `idx_main_single_completed_per_plan`. Enforces "at most one
    // COMPLETED version per development plan revision" at the DB layer.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_change_single_completed_per_revision"
        ON "change_assembly_versions" ("development_plan_revision_id")
        WHERE "status" = 'completed';
    `);

    // ── Step 3: change_assembly_drafts table ──────────────────────────

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "change_assembly_drafts" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "development_plan_revision_id" uuid NOT NULL,
        "target_version" integer NOT NULL,
        "previous_version_id" uuid,
        "correction_mode" "change_assembly_correction_mode",
        "correction_reason" text,
        "part1_status" "change_assembly_part_upload_status" NOT NULL DEFAULT 'pending',
        "part1_file_path" character varying,
        "part1_original_file_name" character varying,
        "part1_uploaded_at" TIMESTAMP,
        "part1_uploaded_by_id" uuid,
        "part2_status" "change_assembly_part_upload_status" NOT NULL DEFAULT 'pending',
        "part2_file_path" character varying,
        "part2_original_file_name" character varying,
        "part2_uploaded_at" TIMESTAMP,
        "part2_uploaded_by_id" uuid,
        "part3_status" "change_assembly_part_upload_status" NOT NULL DEFAULT 'pending',
        "part3_file_path" character varying,
        "part3_generated_at" TIMESTAMP,
        "part3_project_snapshot" jsonb,
        "part3_page_map" jsonb,
        "assembly_status" "change_assembly_draft_status" NOT NULL DEFAULT 'preparing',
        "canceled_at" TIMESTAMP,
        "canceled_by_id" uuid,
        "created_by_id" uuid NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_change_assembly_drafts" PRIMARY KEY ("id"),
        CONSTRAINT "FK_cad_revision" FOREIGN KEY ("development_plan_revision_id")
          REFERENCES "development_plan_revision"("id")
          ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "FK_cad_created_by" FOREIGN KEY ("created_by_id")
          REFERENCES "work_history"("id")
          ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "FK_cad_previous_version" FOREIGN KEY ("previous_version_id")
          REFERENCES "change_assembly_versions"("id")
          ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "FK_cad_part1_uploaded_by" FOREIGN KEY ("part1_uploaded_by_id")
          REFERENCES "work_history"("id")
          ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "FK_cad_part2_uploaded_by" FOREIGN KEY ("part2_uploaded_by_id")
          REFERENCES "work_history"("id")
          ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "FK_cad_canceled_by" FOREIGN KEY ("canceled_by_id")
          REFERENCES "work_history"("id")
          ON DELETE NO ACTION ON UPDATE NO ACTION
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_change_draft_revision"
        ON "change_assembly_drafts" ("development_plan_revision_id");
    `);

    // Partial UNIQUE — "at most one active draft per development plan
    // revision" (mirror of EDIT's `idx_edit_single_active_draft_per_revision`
    // and MAIN's `idx_main_single_active_draft_per_plan`). Not
    // expressible via TypeORM @Unique.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_change_single_active_draft_per_revision"
        ON "change_assembly_drafts" ("development_plan_revision_id")
        WHERE "assembly_status" != 'merged';
    `);

    // ── Step 4: change_assembly_version_projects table ────────────────
    // Join table FK target is `revised_project_groups` (CHANGE operates
    // on RPGs, not PGs — same as EDIT). Column name reflects the actual
    // entity type.

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "change_assembly_version_projects" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "version_id" uuid NOT NULL,
        "revised_project_group_id" uuid NOT NULL,
        "page_number" integer NOT NULL CHECK ("page_number" >= 1),
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_change_assembly_version_projects" PRIMARY KEY ("id"),
        CONSTRAINT "FK_cavp_version" FOREIGN KEY ("version_id")
          REFERENCES "change_assembly_versions"("id")
          ON DELETE CASCADE,
        CONSTRAINT "FK_cavp_rpg" FOREIGN KEY ("revised_project_group_id")
          REFERENCES "revised_project_groups"("id")
          ON DELETE RESTRICT
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_cavp_version"
        ON "change_assembly_version_projects" ("version_id");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_cavp_rpg"
        ON "change_assembly_version_projects" ("revised_project_group_id");
    `);

    // ── Step 5: change_project_lineage table ──────────────────────────
    // Segregated mirror of `book_project_lineage` for the CHANGE_REVISION
    // domain. FK target is `revised_project_groups` (NOT `project_groups`).
    // Column name `revised_project_group_id` reflects the actual entity
    // type; mirrors EDIT's `edit_project_lineage.revised_project_group_id`
    // and the supplement subsystem's
    // `supplement_project_lineage.supplement_project_group_id` naming
    // convention.

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "change_project_lineage" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "revised_project_group_id" uuid NOT NULL,
        "change_assembly_version_id" uuid NOT NULL,
        "parent_change_assembly_version_id" uuid,
        "is_current_leaf" boolean NOT NULL DEFAULT false,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_change_project_lineage" PRIMARY KEY ("id"),
        CONSTRAINT "FK_cpl_rpg" FOREIGN KEY ("revised_project_group_id")
          REFERENCES "revised_project_groups"("id")
          ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "FK_cpl_version" FOREIGN KEY ("change_assembly_version_id")
          REFERENCES "change_assembly_versions"("id")
          ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "FK_cpl_parent_version" FOREIGN KEY ("parent_change_assembly_version_id")
          REFERENCES "change_assembly_versions"("id")
          ON DELETE SET NULL ON UPDATE NO ACTION
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_change_spl_rpg"
        ON "change_project_lineage" ("revised_project_group_id");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_change_spl_version"
        ON "change_project_lineage" ("change_assembly_version_id");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_change_spl_parent_version"
        ON "change_project_lineage" ("parent_change_assembly_version_id");
    `);

    // Partial UNIQUE — "at most one leaf per RPG". Mirrors EDIT's
    // `idx_edit_spl_one_leaf_per_rpg` and MAIN's
    // `idx_main_spl_one_leaf_per_pg`.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_change_spl_one_leaf_per_rpg"
        ON "change_project_lineage" ("revised_project_group_id")
        WHERE "is_current_leaf" = true;
    `);

    // ── Step 6: Backfill change_assembly_versions from book_assembly_versions
    // Idempotent — re-runs are safe via WHERE NOT EXISTS on PK. Note we
    // copy `id` so descendant tables (draft.previous_version_id,
    // version_projects.version_id, lineage.*_version_id) can join on
    // identical UUIDs across the legacy and new tables.
    //
    // `part3_page_map` JSONB is INTENTIONALLY excluded — denormalized
    // into `change_assembly_version_projects` in Step 8 below.
    //
    // Live count at authoring time: 0 rows. Backfill is structural
    // future-proofing.

    await queryRunner.query(`
      INSERT INTO "change_assembly_versions" (
        "id",
        "development_plan_revision_id",
        "version_number",
        "status",
        "correction_mode",
        "correction_reason",
        "part1_file_path",
        "part1_source",
        "part1_original_file_name",
        "part2_file_path",
        "part2_source",
        "part2_original_file_name",
        "part3_file_path",
        "part3_source",
        "part3_project_snapshot",
        "part3_project_count",
        "merged_file_path",
        "merged_at",
        "total_pages",
        "created_by_id",
        "created_at",
        "deprecated_at",
        "deprecated_by_id",
        "deprecation_reason"
      )
      SELECT
        bav."id",
        bav."source_id" AS development_plan_revision_id,
        bav."version_number",
        bav."status"::text::"change_assembly_version_status",
        bav."correction_mode"::text::"change_assembly_correction_mode",
        bav."correction_reason",
        bav."part1_file_path",
        bav."part1_source"::text::"change_assembly_part_source",
        bav."part1_original_file_name",
        bav."part2_file_path",
        bav."part2_source"::text::"change_assembly_part_source",
        bav."part2_original_file_name",
        bav."part3_file_path",
        bav."part3_source"::text::"change_assembly_part_source",
        bav."part3_project_snapshot",
        bav."part3_project_count",
        bav."merged_file_path",
        bav."merged_at",
        bav."total_pages",
        bav."created_by_id",
        bav."created_at",
        bav."deprecated_at",
        bav."deprecated_by_id",
        bav."deprecation_reason"
      FROM "book_assembly_versions" bav
      WHERE bav."source_type" = 'change_revision'
        AND NOT EXISTS (
          SELECT 1 FROM "change_assembly_versions" cav
          WHERE cav."id" = bav."id"
        );
    `);

    // ── Step 7: Backfill change_assembly_drafts from book_assembly_drafts
    // Idempotent — guarded by NOT EXISTS on PK.
    // Live count at authoring time: 0 rows.

    await queryRunner.query(`
      INSERT INTO "change_assembly_drafts" (
        "id",
        "development_plan_revision_id",
        "target_version",
        "previous_version_id",
        "correction_mode",
        "correction_reason",
        "part1_status",
        "part1_file_path",
        "part1_original_file_name",
        "part1_uploaded_at",
        "part1_uploaded_by_id",
        "part2_status",
        "part2_file_path",
        "part2_original_file_name",
        "part2_uploaded_at",
        "part2_uploaded_by_id",
        "part3_status",
        "part3_file_path",
        "part3_generated_at",
        "part3_project_snapshot",
        "part3_page_map",
        "assembly_status",
        "canceled_at",
        "canceled_by_id",
        "created_by_id",
        "created_at"
      )
      SELECT
        bad."id",
        bad."source_id" AS development_plan_revision_id,
        bad."target_version",
        bad."previous_version_id",
        bad."correction_mode"::text::"change_assembly_correction_mode",
        bad."correction_reason",
        bad."part1_status"::text::"change_assembly_part_upload_status",
        bad."part1_file_path",
        bad."part1_original_file_name",
        bad."part1_uploaded_at",
        bad."part1_uploaded_by_id",
        bad."part2_status"::text::"change_assembly_part_upload_status",
        bad."part2_file_path",
        bad."part2_original_file_name",
        bad."part2_uploaded_at",
        bad."part2_uploaded_by_id",
        bad."part3_status"::text::"change_assembly_part_upload_status",
        bad."part3_file_path",
        bad."part3_generated_at",
        bad."part3_project_snapshot",
        bad."part3_page_map",
        bad."assembly_status"::text::"change_assembly_draft_status",
        NULL::timestamp AS canceled_at,
        NULL::uuid AS canceled_by_id,
        bad."created_by_id",
        bad."created_at"
      FROM "book_assembly_drafts" bad
      WHERE bad."source_type" = 'change_revision'
        AND NOT EXISTS (
          SELECT 1 FROM "change_assembly_drafts" cad
          WHERE cad."id" = bad."id"
        );
    `);

    // ── Step 8: Denormalize part3_page_map → change_assembly_version_projects
    // Idempotent — guarded by NOT EXISTS on (version_id,
    // revised_project_group_id).
    //
    // Legacy shape: book_assembly_versions.part3_page_map is JSONB of
    //   { "<revisedProjectGroupUuid>": <pageNumber>, ... }
    //
    // We expand each entry into its own row. Cast the JSONB key to UUID
    // and the value text → int. Filter to source_type='change_revision'
    // and to RPG ids that actually exist in revised_project_groups
    // (defensive — drops orphan map entries to avoid FK_cavp_rpg
    // violations).

    await queryRunner.query(`
      INSERT INTO "change_assembly_version_projects" (
        "version_id",
        "revised_project_group_id",
        "page_number"
      )
      SELECT
        bav."id" AS version_id,
        (page_map.key)::uuid AS revised_project_group_id,
        (page_map.value)::int AS page_number
      FROM "book_assembly_versions" bav,
           LATERAL jsonb_each_text(bav."part3_page_map") AS page_map
      WHERE bav."source_type" = 'change_revision'
        AND bav."part3_page_map" IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM "revised_project_groups" rpg
          WHERE rpg."id" = (page_map.key)::uuid
        )
        AND NOT EXISTS (
          SELECT 1 FROM "change_assembly_version_projects" cavp
          WHERE cavp."version_id" = bav."id"
            AND cavp."revised_project_group_id" = (page_map.key)::uuid
        );
    `);

    // ── Step 9: Backfill change_project_lineage from book_project_lineage
    // Idempotent — guarded by NOT EXISTS on (revised_project_group_id,
    // change_assembly_version_id).
    //
    // CRITICAL — backfill predicate disambiguation: EDIT and CHANGE
    // share `project_type='revised_project_group'` in legacy
    // `book_project_lineage`. Wave A2 partitioned by joining into
    // `book_assembly_versions WHERE source_type='edit_revision'`. This
    // migration uses the SAME pattern with `source_type='change_revision'`
    // via the EXISTS guard on `change_assembly_versions` below (which
    // was just backfilled in Step 6 with exactly those rows).
    //
    // Only rows whose `book_version_id` resolves to a CHANGE
    // `change_assembly_versions` row are copied. EDIT-owned lineage
    // rows (same `project_type='revised_project_group'`) already
    // migrated to `edit_project_lineage` in Wave A2.

    await queryRunner.query(`
      INSERT INTO "change_project_lineage" (
        "revised_project_group_id",
        "change_assembly_version_id",
        "parent_change_assembly_version_id",
        "is_current_leaf",
        "created_at"
      )
      SELECT
        bpl."project_id" AS revised_project_group_id,
        bpl."book_version_id" AS change_assembly_version_id,
        bpl."parent_book_version_id" AS parent_change_assembly_version_id,
        bpl."is_current_leaf",
        bpl."created_at"
      FROM "book_project_lineage" bpl
      WHERE bpl."project_type" = 'revised_project_group'
        AND EXISTS (
          SELECT 1 FROM "change_assembly_versions" cav
          WHERE cav."id" = bpl."book_version_id"
        )
        AND NOT EXISTS (
          SELECT 1 FROM "change_project_lineage" cpl
          WHERE cpl."revised_project_group_id" = bpl."project_id"
            AND cpl."change_assembly_version_id" = bpl."book_version_id"
        );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop tables in reverse dependency order; legacy book_assembly_*
    // / book_project_lineage rows are untouched and remain the live
    // source until CLEANUP-01 runs.

    await queryRunner.query(`
      DROP TABLE IF EXISTS "change_project_lineage" CASCADE;
    `);
    await queryRunner.query(`
      DROP TABLE IF EXISTS "change_assembly_version_projects" CASCADE;
    `);
    await queryRunner.query(`
      DROP TABLE IF EXISTS "change_assembly_drafts" CASCADE;
    `);
    await queryRunner.query(`
      DROP TABLE IF EXISTS "change_assembly_versions" CASCADE;
    `);

    await queryRunner.query(`
      DROP TYPE IF EXISTS "change_assembly_part_source";
    `);
    await queryRunner.query(`
      DROP TYPE IF EXISTS "change_assembly_correction_mode";
    `);
    await queryRunner.query(`
      DROP TYPE IF EXISTS "change_assembly_version_status";
    `);
    await queryRunner.query(`
      DROP TYPE IF EXISTS "change_assembly_draft_status";
    `);
    await queryRunner.query(`
      DROP TYPE IF EXISTS "change_assembly_part_upload_status";
    `);
  }
}
