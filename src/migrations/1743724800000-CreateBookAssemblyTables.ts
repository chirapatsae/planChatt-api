import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateBookAssemblyTables1743724800000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Enum types ──────────────────────────────────────────

    await queryRunner.query(`
      CREATE TYPE "book_assembly_source_type_enum" AS ENUM (
        'main_plan',
        'edit_revision',
        'change_revision'
      );
    `);

    await queryRunner.query(`
      CREATE TYPE "part_upload_status_enum" AS ENUM (
        'pending',
        'uploaded',
        'generated',
        'reused'
      );
    `);

    await queryRunner.query(`
      CREATE TYPE "assembly_draft_status_enum" AS ENUM (
        'preparing',
        'ready',
        'merged'
      );
    `);

    await queryRunner.query(`
      CREATE TYPE "book_assembly_version_status_enum" AS ENUM (
        'completed',
        'deprecated'
      );
    `);

    await queryRunner.query(`
      CREATE TYPE "correction_mode_enum" AS ENUM (
        'cancellation',
        'correction_part1',
        'correction_part2',
        'correction_part3'
      );
    `);

    await queryRunner.query(`
      CREATE TYPE "part_source_enum" AS ENUM (
        'uploaded',
        'generated',
        'reused'
      );
    `);

    await queryRunner.query(`
      CREATE TYPE "deprecation_audit_action_enum" AS ENUM (
        'success',
        'failed'
      );
    `);

    // ── Table: book_assembly_versions ────────────────────────

    await queryRunner.query(`
      CREATE TABLE "book_assembly_versions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "source_type" "book_assembly_source_type_enum" NOT NULL,
        "source_id" uuid NOT NULL,
        "version_number" integer NOT NULL,
        "status" "book_assembly_version_status_enum" NOT NULL DEFAULT 'completed',
        "correction_mode" "correction_mode_enum",
        "correction_reason" text,
        "part1_file_path" character varying NOT NULL,
        "part1_source" "part_source_enum" NOT NULL,
        "part1_original_file_name" character varying,
        "part2_file_path" character varying NOT NULL,
        "part2_source" "part_source_enum" NOT NULL,
        "part2_original_file_name" character varying,
        "part3_file_path" character varying NOT NULL,
        "part3_source" "part_source_enum" NOT NULL,
        "part3_project_snapshot" jsonb NOT NULL,
        "part3_project_count" integer NOT NULL,
        "part3_page_map" jsonb,
        "merged_file_path" character varying NOT NULL,
        "merged_at" TIMESTAMP NOT NULL,
        "total_pages" integer,
        "created_by_id" uuid NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "deprecated_at" TIMESTAMP,
        "deprecated_by_id" uuid,
        "deprecation_reason" text,
        CONSTRAINT "PK_book_assembly_versions" PRIMARY KEY ("id"),
        CONSTRAINT "FK_bav_created_by" FOREIGN KEY ("created_by_id")
          REFERENCES "work_history"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "FK_bav_deprecated_by" FOREIGN KEY ("deprecated_by_id")
          REFERENCES "work_history"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
      );
    `);

    // version indexes
    await queryRunner.query(`
      CREATE UNIQUE INDEX "idx_version_source_number"
      ON "book_assembly_versions" ("source_type", "source_id", "version_number");
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_version_source"
      ON "book_assembly_versions" ("source_type", "source_id");
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_version_status"
      ON "book_assembly_versions" ("status");
    `);

    // Single Official Version Rule (Spec Section 6.2)
    await queryRunner.query(`
      CREATE UNIQUE INDEX "idx_single_completed_per_source"
      ON "book_assembly_versions" ("source_type", "source_id")
      WHERE "status" = 'completed';
    `);

    // ── Table: book_assembly_drafts ──────────────────────────

    await queryRunner.query(`
      CREATE TABLE "book_assembly_drafts" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "source_type" "book_assembly_source_type_enum" NOT NULL,
        "source_id" uuid NOT NULL,
        "target_version" integer NOT NULL,
        "previous_version_id" uuid,
        "correction_mode" "correction_mode_enum",
        "correction_reason" text,
        "part1_status" "part_upload_status_enum" NOT NULL DEFAULT 'pending',
        "part1_file_path" character varying,
        "part1_original_file_name" character varying,
        "part1_uploaded_at" TIMESTAMP,
        "part1_uploaded_by_id" uuid,
        "part2_status" "part_upload_status_enum" NOT NULL DEFAULT 'pending',
        "part2_file_path" character varying,
        "part2_original_file_name" character varying,
        "part2_uploaded_at" TIMESTAMP,
        "part2_uploaded_by_id" uuid,
        "part3_status" "part_upload_status_enum" NOT NULL DEFAULT 'pending',
        "part3_file_path" character varying,
        "part3_generated_at" TIMESTAMP,
        "part3_project_snapshot" jsonb,
        "part3_page_map" jsonb,
        "assembly_status" "assembly_draft_status_enum" NOT NULL DEFAULT 'preparing',
        "created_by_id" uuid NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_book_assembly_drafts" PRIMARY KEY ("id"),
        CONSTRAINT "FK_bad_created_by" FOREIGN KEY ("created_by_id")
          REFERENCES "work_history"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "FK_bad_previous_version" FOREIGN KEY ("previous_version_id")
          REFERENCES "book_assembly_versions"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "FK_bad_part1_uploaded_by" FOREIGN KEY ("part1_uploaded_by_id")
          REFERENCES "work_history"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "FK_bad_part2_uploaded_by" FOREIGN KEY ("part2_uploaded_by_id")
          REFERENCES "work_history"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
      );
    `);

    // draft indexes
    await queryRunner.query(`
      CREATE INDEX "idx_draft_source"
      ON "book_assembly_drafts" ("source_type", "source_id");
    `);

    // One active draft per source context (Edge Case #2)
    await queryRunner.query(`
      CREATE UNIQUE INDEX "idx_single_active_draft_per_source"
      ON "book_assembly_drafts" ("source_type", "source_id")
      WHERE "assembly_status" != 'merged';
    `);

    // ── Table: deprecation_audit_logs ─────────────────────────

    await queryRunner.query(`
      CREATE TABLE "deprecation_audit_logs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "action" "deprecation_audit_action_enum" NOT NULL,
        "version_id" uuid NOT NULL,
        "source_type" "book_assembly_source_type_enum" NOT NULL,
        "source_id" uuid NOT NULL,
        "operator_work_history_id" uuid NOT NULL,
        "operator_role" character varying NOT NULL,
        "identity_verified" boolean NOT NULL,
        "identity_masked" character varying,
        "reason" text,
        "failure_reason" text,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_deprecation_audit_logs" PRIMARY KEY ("id"),
        CONSTRAINT "FK_dal_version" FOREIGN KEY ("version_id")
          REFERENCES "book_assembly_versions"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "FK_dal_operator" FOREIGN KEY ("operator_work_history_id")
          REFERENCES "work_history"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
      );
    `);

    // audit indexes
    await queryRunner.query(`
      CREATE INDEX "idx_deprecation_audit_version_id"
      ON "deprecation_audit_logs" ("version_id");
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_deprecation_audit_operator"
      ON "deprecation_audit_logs" ("operator_work_history_id");
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_deprecation_audit_created_at"
      ON "deprecation_audit_logs" ("created_at");
    `);

    // ── Database-level immutability for audit logs ────────────
    // Trigger function raises exception on UPDATE or DELETE (fails loudly)

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION deprecation_audit_immutable()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'deprecation_audit_logs is immutable: % not allowed', TG_OP;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await queryRunner.query(`
      CREATE TRIGGER trg_deprecation_audit_no_update
      BEFORE UPDATE ON "deprecation_audit_logs"
      FOR EACH ROW EXECUTE FUNCTION deprecation_audit_immutable();
    `);

    await queryRunner.query(`
      CREATE TRIGGER trg_deprecation_audit_no_delete
      BEFORE DELETE ON "deprecation_audit_logs"
      FOR EACH ROW EXECUTE FUNCTION deprecation_audit_immutable();
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // ── Drop triggers and function first ─────────────────────
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_deprecation_audit_no_delete" ON "deprecation_audit_logs";`,
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_deprecation_audit_no_update" ON "deprecation_audit_logs";`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS "deprecation_audit_immutable";`,
    );

    // ── Drop audit indexes ────────────────────────────────────
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_deprecation_audit_created_at";`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_deprecation_audit_operator";`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_deprecation_audit_version_id";`,
    );

    // ── Drop draft indexes ────────────────────────────────────
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_single_active_draft_per_source";`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_draft_source";`);

    // ── Drop version indexes ──────────────────────────────────
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_single_completed_per_source";`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_version_status";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_version_source";`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_version_source_number";`,
    );

    // ── Drop tables (order matters for FK dependencies) ───────
    await queryRunner.query(`DROP TABLE IF EXISTS "deprecation_audit_logs";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "book_assembly_drafts";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "book_assembly_versions";`);

    // ── Drop enum types ───────────────────────────────────────
    await queryRunner.query(
      `DROP TYPE IF EXISTS "deprecation_audit_action_enum";`,
    );
    await queryRunner.query(`DROP TYPE IF EXISTS "part_source_enum";`);
    await queryRunner.query(`DROP TYPE IF EXISTS "correction_mode_enum";`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "book_assembly_version_status_enum";`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "assembly_draft_status_enum";`,
    );
    await queryRunner.query(`DROP TYPE IF EXISTS "part_upload_status_enum";`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "book_assembly_source_type_enum";`,
    );
  }
}
