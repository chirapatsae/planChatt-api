import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: CreateMainAssemblyTables — Wave A1 / DB-01.
 *
 * Standalone MAIN subsystem (mirror of SUPP_STANDALONE pattern). Creates:
 *
 *   - 5 Postgres enum types (Q3=B duplicate — separate from
 *     `book_assembly_*` types so future drift is contained):
 *       main_assembly_part_upload_status
 *       main_assembly_draft_status
 *       main_assembly_version_status
 *       main_assembly_correction_mode
 *       main_assembly_part_source
 *
 *   - 4 tables:
 *       main_assembly_drafts
 *       main_assembly_versions
 *       main_assembly_version_projects   (NEW shape — page_map
 *                                          denormalization)
 *       main_project_lineage             (segregated PG lineage)
 *
 *   - indexes per task spec §1, including the partial unique indexes
 *     `idx_main_single_active_draft_per_plan`,
 *     `idx_main_single_completed_per_plan`, and
 *     `idx_main_spl_one_leaf_per_pg` — none of which are expressible
 *     via TypeORM decorator.
 *
 * After table creation, this migration ALSO copies existing main-plan
 * data out of `book_assembly_*` / `book_project_lineage`:
 *
 *   1. `book_assembly_drafts WHERE source_type='main_plan'`
 *        → `main_assembly_drafts`
 *
 *   2. `book_assembly_versions WHERE source_type='main_plan'`
 *        → `main_assembly_versions` (excluding `part3_page_map`)
 *
 *   3. `book_assembly_versions.part3_page_map JSONB`
 *        → `main_assembly_version_projects` (one row per
 *           `(version_id, project_group_id, page_number)` triple)
 *
 *   4. `book_project_lineage WHERE project_type='project_group'`
 *        → `main_project_lineage`
 *
 * All backfill inserts are idempotent (`NOT EXISTS` guards on PK / on
 * the natural-key tuple). Old `book_assembly_*` rows are NOT touched —
 * the legacy `BookAssemblyService` continues to read/write them until
 * Wave A3 + CLEANUP-01 verify zero traffic.
 *
 * `synchronize: true` interaction:
 *
 *   - On the next BE restart, TypeORM `synchronize` will see the four
 *     new entities (`MainAssemblyDraft`, `MainAssemblyVersion`,
 *     `MainAssemblyVersionProject`, `MainProjectLineage`) and CREATE
 *     the tables + their decorator-declared indexes automatically.
 *
 *   - `synchronize` does NOT create:
 *       a) the PARTIAL UNIQUE indexes (none of:
 *          idx_main_single_active_draft_per_plan,
 *          idx_main_single_completed_per_plan,
 *          idx_main_spl_one_leaf_per_pg are decorator-expressible)
 *       b) the data-copy INSERTs (Steps 5-8 below)
 *
 *   - The recommended operator sequence is therefore EITHER:
 *       (a) run this migration explicitly (does all of the above
 *           atomically), OR
 *       (b) restart BE first (entity sync creates tables + regular
 *           indexes only) and then run this migration to add the
 *           partial-unique indexes + backfill.
 *
 * §15 / §17.2 / §18 — additive only, no invariant change in M1.
 * Wave A1 introduces NO FK from main_assembly_* to book_assembly_*
 * (Q3=B standalone). The MAIN subsystem is read/write-isolated until
 * BE-01 lands.
 */
export class CreateMainAssemblyTables1781700000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Step 1: Enum types (idempotent via DO / pg_type lookup) ──────

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_type
           WHERE typname = 'main_assembly_part_upload_status'
        ) THEN
          CREATE TYPE "main_assembly_part_upload_status" AS ENUM (
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
           WHERE typname = 'main_assembly_draft_status'
        ) THEN
          CREATE TYPE "main_assembly_draft_status" AS ENUM (
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
           WHERE typname = 'main_assembly_version_status'
        ) THEN
          CREATE TYPE "main_assembly_version_status" AS ENUM (
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
           WHERE typname = 'main_assembly_correction_mode'
        ) THEN
          CREATE TYPE "main_assembly_correction_mode" AS ENUM (
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
           WHERE typname = 'main_assembly_part_source'
        ) THEN
          CREATE TYPE "main_assembly_part_source" AS ENUM (
            'uploaded', 'generated', 'reused'
          );
        END IF;
      END$$;
    `);

    // ── Step 2: main_assembly_versions table ──────────────────────────
    // Created BEFORE main_assembly_drafts because the draft table has
    // an FK to it (`previous_version_id`).

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "main_assembly_versions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "development_plan_id" uuid NOT NULL,
        "version_number" integer NOT NULL CHECK ("version_number" >= 1),
        "status" "main_assembly_version_status" NOT NULL DEFAULT 'completed',
        "correction_mode" "main_assembly_correction_mode",
        "correction_reason" text,
        "part1_file_path" character varying NOT NULL,
        "part1_source" "main_assembly_part_source" NOT NULL,
        "part1_original_file_name" character varying,
        "part2_file_path" character varying NOT NULL,
        "part2_source" "main_assembly_part_source" NOT NULL,
        "part2_original_file_name" character varying,
        "part3_file_path" character varying NOT NULL,
        "part3_source" "main_assembly_part_source" NOT NULL,
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
        CONSTRAINT "PK_main_assembly_versions" PRIMARY KEY ("id"),
        CONSTRAINT "FK_mav_plan" FOREIGN KEY ("development_plan_id")
          REFERENCES "development_plan"("id")
          ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "FK_mav_created_by" FOREIGN KEY ("created_by_id")
          REFERENCES "work_history"("id")
          ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "FK_mav_deprecated_by" FOREIGN KEY ("deprecated_by_id")
          REFERENCES "work_history"("id")
          ON DELETE NO ACTION ON UPDATE NO ACTION
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_main_version_plan"
        ON "main_assembly_versions" ("development_plan_id");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_main_version_status"
        ON "main_assembly_versions" ("status");
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_main_version_plan_number"
        ON "main_assembly_versions"
        ("development_plan_id", "version_number");
    `);

    // Single Official Version Rule — mirror of
    // `idx_single_completed_per_source`. Enforces "at most one COMPLETED
    // version per development plan" at the DB layer.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_main_single_completed_per_plan"
        ON "main_assembly_versions" ("development_plan_id")
        WHERE "status" = 'completed';
    `);

    // ── Step 3: main_assembly_drafts table ────────────────────────────

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "main_assembly_drafts" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "development_plan_id" uuid NOT NULL,
        "target_version" integer NOT NULL,
        "previous_version_id" uuid,
        "correction_mode" "main_assembly_correction_mode",
        "correction_reason" text,
        "part1_status" "main_assembly_part_upload_status" NOT NULL DEFAULT 'pending',
        "part1_file_path" character varying,
        "part1_original_file_name" character varying,
        "part1_uploaded_at" TIMESTAMP,
        "part1_uploaded_by_id" uuid,
        "part2_status" "main_assembly_part_upload_status" NOT NULL DEFAULT 'pending',
        "part2_file_path" character varying,
        "part2_original_file_name" character varying,
        "part2_uploaded_at" TIMESTAMP,
        "part2_uploaded_by_id" uuid,
        "part3_status" "main_assembly_part_upload_status" NOT NULL DEFAULT 'pending',
        "part3_file_path" character varying,
        "part3_generated_at" TIMESTAMP,
        "part3_project_snapshot" jsonb,
        "part3_page_map" jsonb,
        "assembly_status" "main_assembly_draft_status" NOT NULL DEFAULT 'preparing',
        "canceled_at" TIMESTAMP,
        "canceled_by_id" uuid,
        "created_by_id" uuid NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_main_assembly_drafts" PRIMARY KEY ("id"),
        CONSTRAINT "FK_mad_plan" FOREIGN KEY ("development_plan_id")
          REFERENCES "development_plan"("id")
          ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "FK_mad_created_by" FOREIGN KEY ("created_by_id")
          REFERENCES "work_history"("id")
          ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "FK_mad_previous_version" FOREIGN KEY ("previous_version_id")
          REFERENCES "main_assembly_versions"("id")
          ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "FK_mad_part1_uploaded_by" FOREIGN KEY ("part1_uploaded_by_id")
          REFERENCES "work_history"("id")
          ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "FK_mad_part2_uploaded_by" FOREIGN KEY ("part2_uploaded_by_id")
          REFERENCES "work_history"("id")
          ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "FK_mad_canceled_by" FOREIGN KEY ("canceled_by_id")
          REFERENCES "work_history"("id")
          ON DELETE NO ACTION ON UPDATE NO ACTION
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_main_draft_plan"
        ON "main_assembly_drafts" ("development_plan_id");
    `);

    // Partial UNIQUE — "at most one active draft per development plan"
    // (mirror of `idx_single_active_draft_per_source`). Not expressible
    // via TypeORM @Unique.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_main_single_active_draft_per_plan"
        ON "main_assembly_drafts" ("development_plan_id")
        WHERE "assembly_status" != 'merged';
    `);

    // ── Step 4: main_assembly_version_projects table ──────────────────

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "main_assembly_version_projects" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "version_id" uuid NOT NULL,
        "project_group_id" uuid NOT NULL,
        "page_number" integer NOT NULL CHECK ("page_number" >= 1),
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_main_assembly_version_projects" PRIMARY KEY ("id"),
        CONSTRAINT "FK_mavp_version" FOREIGN KEY ("version_id")
          REFERENCES "main_assembly_versions"("id")
          ON DELETE CASCADE,
        CONSTRAINT "FK_mavp_pg" FOREIGN KEY ("project_group_id")
          REFERENCES "project_groups"("id")
          ON DELETE RESTRICT
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_mavp_version"
        ON "main_assembly_version_projects" ("version_id");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_mavp_pg"
        ON "main_assembly_version_projects" ("project_group_id");
    `);

    // ── Step 5: main_project_lineage table ────────────────────────────

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "main_project_lineage" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_group_id" uuid NOT NULL,
        "main_assembly_version_id" uuid NOT NULL,
        "parent_main_assembly_version_id" uuid,
        "is_current_leaf" boolean NOT NULL DEFAULT false,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_main_project_lineage" PRIMARY KEY ("id"),
        CONSTRAINT "FK_mpl_pg" FOREIGN KEY ("project_group_id")
          REFERENCES "project_groups"("id")
          ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "FK_mpl_version" FOREIGN KEY ("main_assembly_version_id")
          REFERENCES "main_assembly_versions"("id")
          ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "FK_mpl_parent_version" FOREIGN KEY ("parent_main_assembly_version_id")
          REFERENCES "main_assembly_versions"("id")
          ON DELETE SET NULL ON UPDATE NO ACTION
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_main_spl_pg"
        ON "main_project_lineage" ("project_group_id");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_main_spl_version"
        ON "main_project_lineage" ("main_assembly_version_id");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_main_spl_parent_version"
        ON "main_project_lineage" ("parent_main_assembly_version_id");
    `);

    // Partial UNIQUE — "at most one leaf per PG". Mirrors
    // `idx_bpl_one_leaf_per_project` minus the project_type column.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_main_spl_one_leaf_per_pg"
        ON "main_project_lineage" ("project_group_id")
        WHERE "is_current_leaf" = true;
    `);

    // ── Step 6: Backfill main_assembly_versions from book_assembly_versions
    // Idempotent — re-runs are safe via WHERE NOT EXISTS on PK. Note we
    // copy `id` so descendant tables (draft.previous_version_id,
    // version_projects.version_id, lineage.*_version_id) can join on
    // identical UUIDs across the legacy and new tables.
    //
    // `part3_page_map` JSONB is INTENTIONALLY excluded — denormalized
    // into `main_assembly_version_projects` in Step 8 below.

    await queryRunner.query(`
      INSERT INTO "main_assembly_versions" (
        "id",
        "development_plan_id",
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
        bav."source_id" AS development_plan_id,
        bav."version_number",
        bav."status"::text::"main_assembly_version_status",
        bav."correction_mode"::text::"main_assembly_correction_mode",
        bav."correction_reason",
        bav."part1_file_path",
        bav."part1_source"::text::"main_assembly_part_source",
        bav."part1_original_file_name",
        bav."part2_file_path",
        bav."part2_source"::text::"main_assembly_part_source",
        bav."part2_original_file_name",
        bav."part3_file_path",
        bav."part3_source"::text::"main_assembly_part_source",
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
      WHERE bav."source_type" = 'main_plan'
        AND NOT EXISTS (
          SELECT 1 FROM "main_assembly_versions" mav
          WHERE mav."id" = bav."id"
        );
    `);

    // ── Step 7: Backfill main_assembly_drafts from book_assembly_drafts
    // Idempotent — guarded by NOT EXISTS on PK.

    await queryRunner.query(`
      INSERT INTO "main_assembly_drafts" (
        "id",
        "development_plan_id",
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
        bad."source_id" AS development_plan_id,
        bad."target_version",
        bad."previous_version_id",
        bad."correction_mode"::text::"main_assembly_correction_mode",
        bad."correction_reason",
        bad."part1_status"::text::"main_assembly_part_upload_status",
        bad."part1_file_path",
        bad."part1_original_file_name",
        bad."part1_uploaded_at",
        bad."part1_uploaded_by_id",
        bad."part2_status"::text::"main_assembly_part_upload_status",
        bad."part2_file_path",
        bad."part2_original_file_name",
        bad."part2_uploaded_at",
        bad."part2_uploaded_by_id",
        bad."part3_status"::text::"main_assembly_part_upload_status",
        bad."part3_file_path",
        bad."part3_generated_at",
        bad."part3_project_snapshot",
        bad."part3_page_map",
        bad."assembly_status"::text::"main_assembly_draft_status",
        NULL::timestamp AS canceled_at,
        NULL::uuid AS canceled_by_id,
        bad."created_by_id",
        bad."created_at"
      FROM "book_assembly_drafts" bad
      WHERE bad."source_type" = 'main_plan'
        AND NOT EXISTS (
          SELECT 1 FROM "main_assembly_drafts" mad
          WHERE mad."id" = bad."id"
        );
    `);

    // ── Step 8: Denormalize part3_page_map → main_assembly_version_projects
    // Idempotent — guarded by NOT EXISTS on (version_id, project_group_id).
    //
    // Legacy shape: book_assembly_versions.part3_page_map is JSONB of
    //   { "<projectGroupUuid>": <pageNumber>, ... }
    //
    // We expand each entry into its own row in the new join table. Cast
    // the JSONB key to UUID and the value text → int. Filter to
    // source_type='main_plan' and to PG ids that actually exist in
    // project_groups (defensive — drops orphan map entries to avoid
    // FK_mavp_pg violations).

    await queryRunner.query(`
      INSERT INTO "main_assembly_version_projects" (
        "version_id",
        "project_group_id",
        "page_number"
      )
      SELECT
        bav."id" AS version_id,
        (page_map.key)::uuid AS project_group_id,
        (page_map.value)::int AS page_number
      FROM "book_assembly_versions" bav,
           LATERAL jsonb_each_text(bav."part3_page_map") AS page_map
      WHERE bav."source_type" = 'main_plan'
        AND bav."part3_page_map" IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM "project_groups" pg
          WHERE pg."id" = (page_map.key)::uuid
        )
        AND NOT EXISTS (
          SELECT 1 FROM "main_assembly_version_projects" mavp
          WHERE mavp."version_id" = bav."id"
            AND mavp."project_group_id" = (page_map.key)::uuid
        );
    `);

    // ── Step 9: Backfill main_project_lineage from book_project_lineage
    // Idempotent — guarded by NOT EXISTS on (project_group_id,
    // main_assembly_version_id). Only `project_type='project_group'`
    // rows are copied; revised_project_group rows stay in the legacy
    // table until Waves A2/A3 ship.

    await queryRunner.query(`
      INSERT INTO "main_project_lineage" (
        "project_group_id",
        "main_assembly_version_id",
        "parent_main_assembly_version_id",
        "is_current_leaf",
        "created_at"
      )
      SELECT
        bpl."project_id" AS project_group_id,
        bpl."book_version_id" AS main_assembly_version_id,
        bpl."parent_book_version_id" AS parent_main_assembly_version_id,
        bpl."is_current_leaf",
        bpl."created_at"
      FROM "book_project_lineage" bpl
      WHERE bpl."project_type" = 'project_group'
        AND EXISTS (
          SELECT 1 FROM "main_assembly_versions" mav
          WHERE mav."id" = bpl."book_version_id"
        )
        AND NOT EXISTS (
          SELECT 1 FROM "main_project_lineage" mpl
          WHERE mpl."project_group_id" = bpl."project_id"
            AND mpl."main_assembly_version_id" = bpl."book_version_id"
        );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop tables in reverse dependency order; legacy book_assembly_*
    // / book_project_lineage rows are untouched and remain the live
    // source until CLEANUP-01 runs.

    await queryRunner.query(`
      DROP TABLE IF EXISTS "main_project_lineage" CASCADE;
    `);
    await queryRunner.query(`
      DROP TABLE IF EXISTS "main_assembly_version_projects" CASCADE;
    `);
    await queryRunner.query(`
      DROP TABLE IF EXISTS "main_assembly_drafts" CASCADE;
    `);
    await queryRunner.query(`
      DROP TABLE IF EXISTS "main_assembly_versions" CASCADE;
    `);

    await queryRunner.query(`
      DROP TYPE IF EXISTS "main_assembly_part_source";
    `);
    await queryRunner.query(`
      DROP TYPE IF EXISTS "main_assembly_correction_mode";
    `);
    await queryRunner.query(`
      DROP TYPE IF EXISTS "main_assembly_version_status";
    `);
    await queryRunner.query(`
      DROP TYPE IF EXISTS "main_assembly_draft_status";
    `);
    await queryRunner.query(`
      DROP TYPE IF EXISTS "main_assembly_part_upload_status";
    `);
  }
}
