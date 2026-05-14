import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: SuppStandaloneInit — SUPP_STANDALONE_DB_01.
 *
 * Wave A of the standalone Supplement Assembly subsystem. Creates:
 *   - 4 Postgres enum types (Q3=B duplicate — separate from
 *     `book_assembly_*` types so future drift is contained):
 *       supplement_assembly_part_upload_status
 *       supplement_assembly_draft_status
 *       supplement_assembly_version_status
 *       supplement_assembly_part_source
 *   - 3 tables:
 *       supplement_assembly_drafts
 *       supplement_assembly_versions
 *       supplement_assembly_version_projects
 *   - indexes per task spec §3.2, including the PG-specific partial
 *     UNIQUE index `uniq_sad_active_draft` which enforces "at most one
 *     active draft per supplement". This is not expressible via TypeORM
 *     decorator and lives only here in the migration.
 *
 * Up + down are designed to be idempotent against partial-failure
 * rerun (CREATE TABLE IF NOT EXISTS + DO blocks for enum types +
 * DROP ... IF EXISTS).
 *
 * Q4=C — schema deliberately leaves room for Wave B:
 *   - `supplement_assembly_versions.status` enum carries `completed`
 *     ONLY (no `deprecated`).
 *   - `supplement_assembly_version_projects` has NO
 *     UNIQUE(version_id, supplement_project_group_id) — leaves room
 *     for future correction / deprecation joins.
 * Q8=A — multi-version supported: UNIQUE only on
 *   (development_plan_supplement_id, version_number); NO unique on
 *   development_plan_supplement_id alone.
 * Q9=A — version numbers reset per-supplement.
 *
 * FK target tables verified at write time:
 *   - `development_plan_supplement` (SINGULAR — see entity file)
 *   - `supplement_project_groups` (plural)
 *   - `supplement_assembly_versions` (this migration)
 *
 * No FK is declared on `created_by_id` columns — bare UUID matches
 * BookAssembly precedent for migration-safety.
 */
export class SuppStandaloneInit1779019200000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Enum types (idempotent via DO / pg_type lookup).

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_type
           WHERE typname = 'supplement_assembly_part_upload_status'
        ) THEN
          CREATE TYPE "supplement_assembly_part_upload_status" AS ENUM (
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
           WHERE typname = 'supplement_assembly_draft_status'
        ) THEN
          CREATE TYPE "supplement_assembly_draft_status" AS ENUM (
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
           WHERE typname = 'supplement_assembly_version_status'
        ) THEN
          CREATE TYPE "supplement_assembly_version_status" AS ENUM (
            'completed'
          );
        END IF;
      END$$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_type
           WHERE typname = 'supplement_assembly_part_source'
        ) THEN
          CREATE TYPE "supplement_assembly_part_source" AS ENUM (
            'uploaded', 'generated', 'reused'
          );
        END IF;
      END$$;
    `);

    // 2. supplement_assembly_drafts

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "supplement_assembly_drafts" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "development_plan_supplement_id" UUID NOT NULL,
        "assembly_status" "supplement_assembly_draft_status" NOT NULL
          DEFAULT 'preparing',
        "part1_status" "supplement_assembly_part_upload_status"
          NOT NULL DEFAULT 'pending',
        "part1_source" "supplement_assembly_part_source" NULL,
        "part1_original_file_name" TEXT NULL,
        "part1_uploaded_at" TIMESTAMPTZ NULL,
        "part2_status" "supplement_assembly_part_upload_status"
          NOT NULL DEFAULT 'pending',
        "part2_source" "supplement_assembly_part_source" NULL,
        "part2_original_file_name" TEXT NULL,
        "part2_uploaded_at" TIMESTAMPTZ NULL,
        "part3_status" "supplement_assembly_part_upload_status"
          NOT NULL DEFAULT 'pending',
        "part3_source" "supplement_assembly_part_source" NULL,
        "part3_original_file_name" TEXT NULL,
        "part3_generated_at" TIMESTAMPTZ NULL,
        "created_by_id" UUID NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT "fk_sad_supplement"
          FOREIGN KEY ("development_plan_supplement_id")
          REFERENCES "development_plan_supplement" ("id")
          ON DELETE RESTRICT
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_sad_supplement"
        ON "supplement_assembly_drafts" ("development_plan_supplement_id");
    `);

    // Partial UNIQUE — enforces "at most one active draft per
    // supplement". Not expressible as a TypeORM @Unique decorator.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uniq_sad_active_draft"
        ON "supplement_assembly_drafts" ("development_plan_supplement_id")
        WHERE "assembly_status" IN ('preparing', 'ready');
    `);

    // 3. supplement_assembly_versions

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "supplement_assembly_versions" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "development_plan_supplement_id" UUID NOT NULL,
        "version_number" INTEGER NOT NULL CHECK ("version_number" >= 1),
        "status" "supplement_assembly_version_status" NOT NULL
          DEFAULT 'completed',
        "merged_file_path" TEXT NOT NULL,
        "merged_file_sha256" TEXT NOT NULL,
        "merged_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "created_by_id" UUID NOT NULL,
        "metadata_json" JSONB NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT "fk_sav_supplement"
          FOREIGN KEY ("development_plan_supplement_id")
          REFERENCES "development_plan_supplement" ("id")
          ON DELETE RESTRICT
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_sav_supplement"
        ON "supplement_assembly_versions" ("development_plan_supplement_id");
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uniq_sav_supplement_version"
        ON "supplement_assembly_versions"
        ("development_plan_supplement_id", "version_number");
    `);

    // 4. supplement_assembly_version_projects

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "supplement_assembly_version_projects" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "version_id" UUID NOT NULL,
        "supplement_project_group_id" UUID NOT NULL,
        "page_number" INTEGER NOT NULL CHECK ("page_number" >= 1),
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT "fk_savp_version"
          FOREIGN KEY ("version_id")
          REFERENCES "supplement_assembly_versions" ("id")
          ON DELETE CASCADE,
        CONSTRAINT "fk_savp_spg"
          FOREIGN KEY ("supplement_project_group_id")
          REFERENCES "supplement_project_groups" ("id")
          ON DELETE RESTRICT
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_savp_version"
        ON "supplement_assembly_version_projects" ("version_id");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_savp_spg"
        ON "supplement_assembly_version_projects"
        ("supplement_project_group_id");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverse order: tables first (deepest dependency last), then
    // enum types. DROP ... IF EXISTS keeps the down idempotent.

    await queryRunner.query(`
      DROP TABLE IF EXISTS "supplement_assembly_version_projects";
    `);
    await queryRunner.query(`
      DROP TABLE IF EXISTS "supplement_assembly_versions";
    `);
    await queryRunner.query(`
      DROP TABLE IF EXISTS "supplement_assembly_drafts";
    `);

    await queryRunner.query(`
      DROP TYPE IF EXISTS "supplement_assembly_part_source";
    `);
    await queryRunner.query(`
      DROP TYPE IF EXISTS "supplement_assembly_version_status";
    `);
    await queryRunner.query(`
      DROP TYPE IF EXISTS "supplement_assembly_draft_status";
    `);
    await queryRunner.query(`
      DROP TYPE IF EXISTS "supplement_assembly_part_upload_status";
    `);
  }
}
