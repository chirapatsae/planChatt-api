import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: DropLegacyBookAssemblyTables — Wave OPTION-A-FULL-SPLIT / CLEANUP / DB-01.
 *
 * Final DB step of the four-wave OPTION-A-FULL-SPLIT initiative
 * (CLAUDE.md §20.10). Waves A1 / A2 / A3 introduced standalone
 * subsystems for MAIN / EDIT / CHANGE; SUPP_STANDALONE introduced
 * the standalone SUPPLEMENT subsystem earlier. CLEANUP / BE-02
 * deleted every TypeScript reference to the legacy
 * `BookAssemblyService`, controller, entities, DTOs, enums, and
 * the W4 storage-migration CLI. This DB-01 migration drops the
 * three legacy tables and their orphaned enum types, completing
 * the storage split.
 *
 * Per CLAUDE.md §20.10.1 + §20.10.2:
 *   - all FE traffic for MAIN_PLAN / EDIT_REVISION / CHANGE_REVISION
 *     was cut over to the new standalone services in their
 *     respective A-waves
 *   - data was duplicated (not migrated) to the new
 *     `{main,edit,change}_assembly_*` + `{main,edit,change}_project_lineage`
 *     tables during each A-wave; the legacy rows were retained
 *     as a safety net until BE-02 verified zero live traffic
 *   - CLEANUP / BE-02 confirmed BE imports are gone
 *   - this DB-01 wave is the last reversal point — after merge,
 *     restoring legacy storage requires a backup restore
 *
 * ── Tables dropped ──────────────────────────────────────────────────
 *
 *   1. book_project_lineage
 *      - FK book_version_id → book_assembly_versions (ON DELETE RESTRICT)
 *      - FK parent_book_version_id → book_assembly_versions (ON DELETE SET NULL)
 *      - dropped FIRST so the FK constraints into
 *        `book_assembly_versions` are removed before the version
 *        table is itself dropped
 *
 *   2. book_assembly_drafts
 *      - FK previous_version_id → book_assembly_versions (ON DELETE NO ACTION)
 *      - FK created_by_id / part1_uploaded_by_id / part2_uploaded_by_id /
 *        canceled_by_id → work_history (unaffected by this drop —
 *        the FK direction is FROM drafts TO work_history, so
 *        dropping the drafts table removes the constraint cleanly)
 *      - dropped SECOND so the inbound FK on
 *        `book_assembly_versions.id` is released
 *
 *   3. book_assembly_versions
 *      - FK created_by_id / deprecated_by_id → work_history
 *      - dropped LAST after both child tables release their FKs
 *
 * ── Enum types dropped ──────────────────────────────────────────────
 *
 *   - part_upload_status_enum                       (was used by drafts.part{n}_status)
 *   - assembly_draft_status_enum                    (was used by drafts.assembly_status)
 *   - book_assembly_version_status_enum             (was used by versions.status)
 *   - correction_mode_enum                          (was used by versions.correction_mode, drafts.correction_mode)
 *   - part_source_enum                              (was used by versions.part{n}_source)
 *   - book_project_lineage_project_type_enum        (was used by book_project_lineage.project_type)
 *
 * ── Enum types PRESERVED (still in active use) ──────────────────────
 *
 *   - book_assembly_source_type_enum
 *       still referenced by `deprecation_audit_logs.source_type`.
 *       The surviving `DeprecationAuditLog` entity pins
 *       `enumName: 'book_assembly_source_type_enum'` (see
 *       `backend/src/book-assembly/entities/deprecation-audit-log.entity.ts`)
 *       to prevent `synchronize: true` from ALTER'ing the column
 *       away from the existing Postgres type.
 *
 *   - deprecation_audit_action_enum
 *       still referenced by `deprecation_audit_logs.action`. The
 *       entity pins the enum name identically. Migration
 *       `1744070400000-FixAuditLogNullableAndRestoredEnum.ts`
 *       extended the enum with `restored` — that value MUST be
 *       preserved.
 *
 * Renaming `book_assembly_source_type_enum` to a neutral name
 * (e.g. `deprecation_audit_source_type_enum`) is OUT OF SCOPE
 * for this wave and would require a separate enum-rename wave
 * involving ALTER TYPE RENAME + entity `enumName` flip.
 *
 * ── deprecation_audit_logs preservation ─────────────────────────────
 *
 *   The `deprecation_audit_logs` TABLE is NOT dropped. It survives
 *   with its row data, its two FKs (`FK_dal_version` → versions,
 *   `FK_dal_operator` → work_history), its triggers
 *   (trg_deprecation_audit_no_update, trg_deprecation_audit_no_delete),
 *   and its immutability function (`deprecation_audit_immutable`).
 *
 *   HOWEVER, the `FK_dal_version` constraint on
 *   `deprecation_audit_logs.version_id` references
 *   `book_assembly_versions(id)`. Dropping `book_assembly_versions`
 *   without first dropping this FK would fail with a Postgres
 *   dependency error. So Step 0 of this migration is to drop
 *   `FK_dal_version`. After the drop, `version_id` becomes a
 *   raw UUID column with no referential integrity — this is
 *   acceptable because:
 *     a) the BE-02 entity rewrite already removed the
 *        `@ManyToOne(() => BookAssemblyVersion)` relation
 *     b) historical audit rows resolve via direct UUID lookup
 *     c) supplement-side audit writes use UUIDs without FK
 *        (CLAUDE.md §20.10.3 Q3=B file-service exemption pattern)
 *
 * ── Reversibility ───────────────────────────────────────────────────
 *
 *   `down()` re-creates the three tables, six enums, and the
 *   `FK_dal_version` FK constraint on `deprecation_audit_logs`.
 *   It does NOT restore row data — restoring legacy data requires
 *   a backup restore. The down() is provided strictly for
 *   schema-shape reversibility (e.g. migration-runner rollback
 *   in dev environments). Production rollback is "restore from
 *   backup before CLEANUP merge".
 *
 * ── Idempotency ─────────────────────────────────────────────────────
 *
 *   Every `DROP TABLE` and `DROP TYPE` uses `IF EXISTS`. Re-running
 *   after a successful apply is a no-op (all targets already gone).
 *   The `FK_dal_version` drop uses `IF EXISTS` as well.
 *
 *   Notably we do NOT use `DROP TABLE ... CASCADE` — the explicit
 *   FK-drop sequence above is enough, and CASCADE would mask any
 *   unexpected dependency (e.g. a view added by a later wave).
 *   If apply fails mid-way, the operator can re-run safely.
 */
export class DropLegacyBookAssemblyTables1782000000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Step 0: Release FK from deprecation_audit_logs → book_assembly_versions
    //
    // `deprecation_audit_logs.version_id` was originally an FK into
    // `book_assembly_versions.id` (ON DELETE NO ACTION). The
    // `DeprecationAuditLog` entity no longer carries the
    // `@ManyToOne(() => BookAssemblyVersion)` relation (CLEANUP BE-02),
    // so the constraint must be released before the version table is
    // dropped. After this drop, `version_id` is a raw UUID column with
    // no referential integrity (intentional — see header).

    await queryRunner.query(
      `ALTER TABLE "deprecation_audit_logs" DROP CONSTRAINT IF EXISTS "FK_dal_version";`,
    );

    // ── Step 1: Drop book_project_lineage
    //
    // This table has two outbound FKs into `book_assembly_versions`
    // (`FK_bpl_book_version` ON DELETE RESTRICT, `FK_bpl_parent_book_version`
    // ON DELETE SET NULL). Dropping the table removes both constraints.

    await queryRunner.query(`DROP TABLE IF EXISTS "book_project_lineage";`);

    // ── Step 2: Drop book_assembly_drafts
    //
    // Outbound FKs (all dropped when the table is dropped):
    //   FK_bad_created_by         → work_history
    //   FK_bad_previous_version   → book_assembly_versions
    //   FK_bad_part1_uploaded_by  → work_history
    //   FK_bad_part2_uploaded_by  → work_history
    //   FK_draft_canceled_by      → work_history

    await queryRunner.query(`DROP TABLE IF EXISTS "book_assembly_drafts";`);

    // ── Step 3: Drop book_assembly_versions
    //
    // Outbound FKs (all dropped when the table is dropped):
    //   FK_bav_created_by        → work_history
    //   FK_bav_deprecated_by     → work_history
    //
    // No remaining inbound FKs at this point (Steps 0-2 released them).

    await queryRunner.query(`DROP TABLE IF EXISTS "book_assembly_versions";`);

    // ── Step 4: Drop orphaned enum types
    //
    // The two enums that are STILL IN USE (book_assembly_source_type_enum
    // and deprecation_audit_action_enum) are EXCLUDED from this list
    // because the surviving `deprecation_audit_logs.source_type` /
    // `.action` columns continue to reference them and the
    // `DeprecationAuditLog` entity pins them by `enumName`.

    const orphanedEnums = [
      'book_project_lineage_project_type_enum',
      'part_source_enum',
      'correction_mode_enum',
      'book_assembly_version_status_enum',
      'assembly_draft_status_enum',
      'part_upload_status_enum',
    ];

    for (const enumName of orphanedEnums) {
      await queryRunner.query(`DROP TYPE IF EXISTS "${enumName}";`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Re-create schema-shape ONLY. Row data is NOT restored — this
    // down() exists for migration-runner reversibility in dev.
    // Production rollback is "restore from backup".

    // ── Step 1: Re-create the six orphaned enum types ───────────────

    await queryRunner.query(`
      CREATE TYPE "part_upload_status_enum" AS ENUM (
        'pending', 'uploaded', 'generated', 'reused'
      );
    `);

    await queryRunner.query(`
      CREATE TYPE "assembly_draft_status_enum" AS ENUM (
        'preparing', 'ready', 'merged', 'canceled'
      );
    `);

    await queryRunner.query(`
      CREATE TYPE "book_assembly_version_status_enum" AS ENUM (
        'completed', 'deprecated'
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
        'uploaded', 'generated', 'reused'
      );
    `);

    await queryRunner.query(`
      CREATE TYPE "book_project_lineage_project_type_enum" AS ENUM (
        'project_group', 'revised_project_group'
      );
    `);

    // ── Step 2: Re-create book_assembly_versions ────────────────────

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
    await queryRunner.query(`
      CREATE UNIQUE INDEX "idx_single_completed_per_source"
        ON "book_assembly_versions" ("source_type", "source_id")
        WHERE "status" = 'completed';
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_version_source_status"
        ON "book_assembly_versions" ("source_type", "source_id", "status");
    `);

    // ── Step 3: Re-create book_assembly_drafts ──────────────────────

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
        "canceled_at" TIMESTAMP,
        "canceled_by_id" uuid,
        CONSTRAINT "PK_book_assembly_drafts" PRIMARY KEY ("id"),
        CONSTRAINT "FK_bad_created_by" FOREIGN KEY ("created_by_id")
          REFERENCES "work_history"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "FK_bad_previous_version" FOREIGN KEY ("previous_version_id")
          REFERENCES "book_assembly_versions"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "FK_bad_part1_uploaded_by" FOREIGN KEY ("part1_uploaded_by_id")
          REFERENCES "work_history"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "FK_bad_part2_uploaded_by" FOREIGN KEY ("part2_uploaded_by_id")
          REFERENCES "work_history"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "FK_draft_canceled_by" FOREIGN KEY ("canceled_by_id")
          REFERENCES "work_history"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      );
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_draft_source"
        ON "book_assembly_drafts" ("source_type", "source_id");
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "idx_single_active_draft_per_source"
        ON "book_assembly_drafts" ("source_type", "source_id")
        WHERE "assembly_status" NOT IN ('merged', 'canceled');
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_draft_canceled"
        ON "book_assembly_drafts" ("source_type", "source_id")
        WHERE "assembly_status" = 'canceled';
    `);

    // ── Step 4: Re-create book_project_lineage ──────────────────────

    await queryRunner.query(`
      CREATE TABLE "book_project_lineage" (
        "id"                     uuid        NOT NULL DEFAULT uuid_generate_v4(),
        "project_id"             uuid        NOT NULL,
        "project_type"           "book_project_lineage_project_type_enum" NOT NULL,
        "book_version_id"        uuid        NOT NULL,
        "parent_book_version_id" uuid,
        "is_current_leaf"        boolean     NOT NULL DEFAULT false,
        "created_at"             TIMESTAMP   NOT NULL DEFAULT now(),
        CONSTRAINT "PK_book_project_lineage" PRIMARY KEY ("id"),
        CONSTRAINT "FK_bpl_book_version" FOREIGN KEY ("book_version_id")
          REFERENCES "book_assembly_versions"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "FK_bpl_parent_book_version" FOREIGN KEY ("parent_book_version_id")
          REFERENCES "book_assembly_versions"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      );
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_bpl_project"
        ON "book_project_lineage" ("project_id", "project_type");
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_bpl_version"
        ON "book_project_lineage" ("book_version_id");
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_bpl_parent_version"
        ON "book_project_lineage" ("parent_book_version_id");
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "idx_bpl_one_leaf_per_project"
        ON "book_project_lineage" ("project_id", "project_type")
        WHERE "is_current_leaf" = true;
    `);

    // ── Step 5: Restore FK from deprecation_audit_logs → versions ───
    //
    // Best-effort: only re-add the FK if no rows currently violate it
    // (i.e. version_id refers to a now-restored version row, OR
    // version_id IS NULL). If violating rows exist (likely, since up()
    // dropped the data), the operator must either delete them or
    // accept the FK-less state. We attempt the constraint but tolerate
    // failure to keep the down() runnable in dev.

    await queryRunner.query(`
      DO $$
      BEGIN
        BEGIN
          ALTER TABLE "deprecation_audit_logs"
            ADD CONSTRAINT "FK_dal_version"
              FOREIGN KEY ("version_id")
              REFERENCES "book_assembly_versions"("id")
              ON DELETE NO ACTION ON UPDATE NO ACTION;
        EXCEPTION WHEN others THEN
          RAISE NOTICE 'FK_dal_version not restored (likely dangling version_id values): %', SQLERRM;
        END;
      END$$;
    `);
  }
}
