import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Wave Equipment Revision Management — DB-01 (Phase 3).
 *
 * Creates the `revised_equipment_project_groups` table (RELPG) — the
 * equipment (ผ.03) analog of `revised_project_groups`, a full lineage
 * fork from an approved `equipment_project_groups` row into a
 * `development_plan_revision` context. Also:
 *
 *   - Adds the 5th nullable FK `revised_equipment_project_group_id` to
 *     `tracking_status` (§12 audit hook for RELPG rows).
 *   - Extends the polymorphic `budget` table with a 5th nullable FK
 *     (`revised_equipment_project_group_id`).
 *
 * # Locked decisions
 *
 * - **Dual-shape CHECK (§16.5 + Q5=B).** `ck_revised_equipment_project_group_shape`
 *   mirrors EPG exactly: `equipment_category_id IS NOT NULL` in BOTH
 *   shapes, exactly-one-of STRATEGY_BASED / ISSUE_BASED. `indicator` is
 *   intentionally OMITTED from the CHECK (equipment relaxes PG's
 *   `indicator NOT NULL` clause in BOTH shapes per §16.5).
 *
 * - **Lineage (§14).** `prev_project_id` uuid + `prev_project_type`
 *   varchar (NOT a shared Postgres enum — §7.2 decision). Valid values:
 *   `'equipment'` (parent EPG) / `'revised_equipment'` (chained RELPG).
 *
 * - **Agency-only authoring** = BE-enforced (creator WorkHistory
 *   classification per §1). NOT a DB constraint.
 *
 * # FK column-type alignment
 *
 * The FK column types MUST match the referenced PK types (Postgres
 * rejects mismatched FK types), mirroring the EPG Phase 2 migration:
 *   - `strategy_id` / `tactic_id` / `plan_id` → varchar
 *     (Strategy/Tactic/Plan use `@PrimaryColumn()`).
 *   - `amphoe_id` / `local_administrative_organization_id` /
 *     `origin_agency_id` → text (Amphoe/LAO use `@PrimaryColumn()`).
 *   - `responsible_agency_id` → int (GovernmentAgency uses
 *     `@PrimaryGeneratedColumn()` serial).
 *   - `development_issue_id` / `equipment_category_id` /
 *     `development_plan_id` / `development_plan_revision_id` /
 *     `equipment_project_group_id` / `create_by` → uuid.
 *
 * # Idempotency
 *
 * - `CREATE TABLE IF NOT EXISTS` tolerates a `synchronize:true`
 *   pre-creation of the empty table on boot (which does NOT add the
 *   CHECK constraint — see MEMORY: typeorm synchronize). The @Check
 *   decorator on the entity is what guarantees the constraint survives
 *   reboot; this migration is for production safety + documentation.
 * - All `ALTER TABLE … ADD` / `CREATE INDEX` / `ADD CONSTRAINT` are
 *   guarded by DO-blocks or `IF NOT EXISTS`. Re-runs are no-ops.
 *
 * # Source of truth
 *
 * - docs/tasks/wave-equipment-revision-management/DB-01-revised-equipment-entity-and-migration.md
 * - CLAUDE.md §4 / §5.3 / §11 / §12 / §14 / §14.7 / §16.5 / §18 / §20.3
 * - Sibling pattern: `1782200000000-EquipmentProjectGroupPhase2.ts`
 */
export class CreateRevisedEquipmentProjectGroup1782300000000
  implements MigrationInterface
{
  name = 'CreateRevisedEquipmentProjectGroup1782300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ──────────────────────────────────────────────────────────────────
    // Step 1: Create revised_equipment_project_groups (idempotent).
    // `synchronize:true` may have already created this from entity
    // metadata; `IF NOT EXISTS` tolerates that prior state but DOES NOT
    // add the CHECK constraint (synchronize does not emit CHECKs).
    // ──────────────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "revised_equipment_project_groups" (
        "id"                                      uuid        NOT NULL DEFAULT gen_random_uuid(),

        -- Identity and parent book (§8, §10)
        "development_plan_revision_id"            uuid        NOT NULL,
        "development_plan_id"                     uuid                                 ,

        -- Source EPG reference (lineage root)
        "equipment_project_group_id"              uuid                                 ,

        -- Lineage columns (§14) — varchar prev_project_type per §7.2
        "prev_project_id"                         uuid                                 ,
        "prev_project_type"                       varchar                              ,

        -- Equipment content (copied from EPG — five fields)
        "equipment_name"                          text        NOT NULL,
        "target_output"                           text        NOT NULL,
        "expected_results"                        text        NOT NULL,
        "indicator"                               text                                 ,
        "equipment_category_id"                   uuid        NOT NULL,

        -- Classification (dual shape per §16.5 + Q5=B)
        "strategy_id"                             varchar                              ,
        "tactic_id"                               varchar                              ,
        "plan_id"                                 varchar                              ,
        "development_issue_id"                    uuid                                 ,

        -- Ownership (§4 — WorkHistory)
        "create_by"                               uuid                                 ,

        -- Origin context (§5)
        "amphoe_id"                               text                                 ,
        "local_administrative_organization_id"    text                                 ,
        "origin_agency_id"                        text                                 ,

        -- ResponsibleAgency (§5 / §7) — nullable at DB; auto-assigned at
        -- BE for agency-origin equipment per §5.1
        "responsible_agency_id"                   int                                  ,

        -- Booked-state (§20.3 Invariant 1)
        "is_booked"                               boolean     NOT NULL DEFAULT false,
        "booked_at"                               timestamptz                          ,
        "page_number"                             int                                  ,

        -- Engagement counters (§17.3 — mirror EPG)
        "like_count"                              int         NOT NULL DEFAULT 0,
        "view_count"                              int         NOT NULL DEFAULT 0,

        "created_at"                              timestamptz NOT NULL DEFAULT now(),
        "deleted_at"                              timestamptz                          ,

        CONSTRAINT "PK_revised_equipment_project_groups" PRIMARY KEY ("id")
      );
    `);

    // ──────────────────────────────────────────────────────────────────
    // Step 2: Foreign keys (idempotent via pg_constraint guard).
    // ──────────────────────────────────────────────────────────────────
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_relpg_development_plan_revision') THEN
          ALTER TABLE "revised_equipment_project_groups"
            ADD CONSTRAINT "FK_relpg_development_plan_revision"
              FOREIGN KEY ("development_plan_revision_id") REFERENCES "development_plan_revision"("id")
              ON DELETE CASCADE ON UPDATE CASCADE;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_relpg_development_plan') THEN
          ALTER TABLE "revised_equipment_project_groups"
            ADD CONSTRAINT "FK_relpg_development_plan"
              FOREIGN KEY ("development_plan_id") REFERENCES "development_plan"("id")
              ON DELETE CASCADE ON UPDATE CASCADE;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_relpg_equipment_project_group') THEN
          ALTER TABLE "revised_equipment_project_groups"
            ADD CONSTRAINT "FK_relpg_equipment_project_group"
              FOREIGN KEY ("equipment_project_group_id") REFERENCES "equipment_project_groups"("id")
              ON DELETE CASCADE ON UPDATE CASCADE;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_relpg_strategy') THEN
          ALTER TABLE "revised_equipment_project_groups"
            ADD CONSTRAINT "FK_relpg_strategy"
              FOREIGN KEY ("strategy_id") REFERENCES "strategies"("id")
              ON DELETE CASCADE ON UPDATE CASCADE;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_relpg_tactic') THEN
          ALTER TABLE "revised_equipment_project_groups"
            ADD CONSTRAINT "FK_relpg_tactic"
              FOREIGN KEY ("tactic_id") REFERENCES "tactics"("id")
              ON DELETE CASCADE ON UPDATE CASCADE;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_relpg_plan') THEN
          ALTER TABLE "revised_equipment_project_groups"
            ADD CONSTRAINT "FK_relpg_plan"
              FOREIGN KEY ("plan_id") REFERENCES "plans"("id")
              ON DELETE CASCADE ON UPDATE CASCADE;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_relpg_development_issue') THEN
          ALTER TABLE "revised_equipment_project_groups"
            ADD CONSTRAINT "FK_relpg_development_issue"
              FOREIGN KEY ("development_issue_id") REFERENCES "development_issues"("id")
              ON DELETE CASCADE ON UPDATE CASCADE;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_relpg_equipment_category') THEN
          ALTER TABLE "revised_equipment_project_groups"
            ADD CONSTRAINT "FK_relpg_equipment_category"
              FOREIGN KEY ("equipment_category_id") REFERENCES "equipment_categories"("id")
              ON DELETE RESTRICT ON UPDATE CASCADE;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_relpg_create_by') THEN
          ALTER TABLE "revised_equipment_project_groups"
            ADD CONSTRAINT "FK_relpg_create_by"
              FOREIGN KEY ("create_by") REFERENCES "work_history"("id")
              ON DELETE CASCADE ON UPDATE CASCADE;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_relpg_amphoe') THEN
          ALTER TABLE "revised_equipment_project_groups"
            ADD CONSTRAINT "FK_relpg_amphoe"
              FOREIGN KEY ("amphoe_id") REFERENCES "amphoes"("id")
              ON DELETE CASCADE ON UPDATE CASCADE;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_relpg_lao') THEN
          ALTER TABLE "revised_equipment_project_groups"
            ADD CONSTRAINT "FK_relpg_lao"
              FOREIGN KEY ("local_administrative_organization_id")
              REFERENCES "local_administrative_organizations"("id")
              ON DELETE CASCADE ON UPDATE CASCADE;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_relpg_origin_agency') THEN
          ALTER TABLE "revised_equipment_project_groups"
            ADD CONSTRAINT "FK_relpg_origin_agency"
              FOREIGN KEY ("origin_agency_id")
              REFERENCES "local_administrative_organizations"("id")
              ON DELETE CASCADE ON UPDATE CASCADE;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_relpg_responsible_agency') THEN
          ALTER TABLE "revised_equipment_project_groups"
            ADD CONSTRAINT "FK_relpg_responsible_agency"
              FOREIGN KEY ("responsible_agency_id")
              REFERENCES "government_agencies"("id")
              ON DELETE CASCADE ON UPDATE CASCADE;
        END IF;
      END$$;
    `);

    // ──────────────────────────────────────────────────────────────────
    // Step 3: Indexes (idempotent via IF NOT EXISTS).
    // ──────────────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_relpg_development_plan_revision"
        ON "revised_equipment_project_groups" ("development_plan_revision_id");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_relpg_development_plan"
        ON "revised_equipment_project_groups" ("development_plan_id");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_relpg_equipment_project_group"
        ON "revised_equipment_project_groups" ("equipment_project_group_id");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_relpg_create_by"
        ON "revised_equipment_project_groups" ("create_by");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_relpg_equipment_category"
        ON "revised_equipment_project_groups" ("equipment_category_id");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_relpg_responsible_agency"
        ON "revised_equipment_project_groups" ("responsible_agency_id");
    `);
    // Partial — ISSUE_BASED rows only.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_relpg_development_issue"
        ON "revised_equipment_project_groups" ("development_issue_id")
        WHERE "development_issue_id" IS NOT NULL;
    `);
    // Composite — STRATEGY_BASED filtering.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_relpg_strategy_tactic_plan"
        ON "revised_equipment_project_groups" ("strategy_id", "tactic_id", "plan_id");
    `);
    // Lineage detection (§14.7) — partial index on the descendant edge,
    // matching the `idx_rpg_prev_project_id` pattern on RPG. Soft-deleted
    // descendants are excluded so they do NOT lock their ancestor (§14.2).
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_relpg_prev_project_id"
        ON "revised_equipment_project_groups" ("prev_project_id")
        WHERE "deleted_at" IS NULL;
    `);
    // Soft-delete filter.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_relpg_deleted_at"
        ON "revised_equipment_project_groups" ("deleted_at");
    `);

    // ──────────────────────────────────────────────────────────────────
    // Step 4: Dual-shape CHECK constraint (§16.5 + Q5=B).
    // Indicator is intentionally OMITTED — equipment relaxes PG's
    // `indicator NOT NULL` clause in BOTH shapes.
    // ──────────────────────────────────────────────────────────────────
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'ck_revised_equipment_project_group_shape'
        ) THEN
          ALTER TABLE "revised_equipment_project_groups"
            ADD CONSTRAINT "ck_revised_equipment_project_group_shape"
            CHECK (
              "equipment_category_id" IS NOT NULL
              AND (
                (
                  "strategy_id"          IS NOT NULL
                  AND "tactic_id"        IS NOT NULL
                  AND "plan_id"          IS NOT NULL
                  AND "development_issue_id" IS NULL
                )
                OR
                (
                  "strategy_id"          IS NULL
                  AND "tactic_id"        IS NULL
                  AND "plan_id"          IS NULL
                  AND "development_issue_id" IS NOT NULL
                )
              )
            );
        END IF;
      END$$;
    `);

    // ──────────────────────────────────────────────────────────────────
    // Step 5: tracking_status — add revised_equipment_project_group_id FK
    // (5th nullable FK). §12 audit hook for RELPG rows.
    // ──────────────────────────────────────────────────────────────────
    await queryRunner.query(`
      ALTER TABLE "tracking_status"
        ADD COLUMN IF NOT EXISTS "revised_equipment_project_group_id" uuid;
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_tracking_status_revised_equipment_project_group'
        ) THEN
          ALTER TABLE "tracking_status"
            ADD CONSTRAINT "FK_tracking_status_revised_equipment_project_group"
              FOREIGN KEY ("revised_equipment_project_group_id")
              REFERENCES "revised_equipment_project_groups"("id")
              ON DELETE CASCADE ON UPDATE CASCADE;
        END IF;
      END$$;
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_tracking_status_revised_equipment_project_group"
        ON "tracking_status" ("revised_equipment_project_group_id")
        WHERE "revised_equipment_project_group_id" IS NOT NULL;
    `);

    // ──────────────────────────────────────────────────────────────────
    // Step 6: budget — extend the polymorphic FK pattern with a 5th
    // nullable FK column (`revised_equipment_project_group_id`). Exactly
    // one of the five FKs is expected per row at the BE layer (not
    // DB-enforced — same convention as the existing four).
    // ──────────────────────────────────────────────────────────────────
    await queryRunner.query(`
      ALTER TABLE "budget"
        ADD COLUMN IF NOT EXISTS "revised_equipment_project_group_id" uuid;
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_budget_revised_equipment_project_group'
        ) THEN
          ALTER TABLE "budget"
            ADD CONSTRAINT "FK_budget_revised_equipment_project_group"
              FOREIGN KEY ("revised_equipment_project_group_id")
              REFERENCES "revised_equipment_project_groups"("id")
              ON DELETE CASCADE ON UPDATE CASCADE;
        END IF;
      END$$;
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_budget_revised_equipment_project_group"
        ON "budget" ("revised_equipment_project_group_id")
        WHERE "revised_equipment_project_group_id" IS NOT NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverse in strict LIFO order.

    // Step 6 rollback — budget polymorphic FK.
    await queryRunner.query(`
      DROP INDEX IF EXISTS "idx_budget_revised_equipment_project_group";
    `);
    await queryRunner.query(`
      ALTER TABLE "budget"
        DROP CONSTRAINT IF EXISTS "FK_budget_revised_equipment_project_group";
    `);
    await queryRunner.query(`
      ALTER TABLE "budget"
        DROP COLUMN IF EXISTS "revised_equipment_project_group_id";
    `);

    // Step 5 rollback — tracking_status FK + index.
    await queryRunner.query(`
      DROP INDEX IF EXISTS "idx_tracking_status_revised_equipment_project_group";
    `);
    await queryRunner.query(`
      ALTER TABLE "tracking_status"
        DROP CONSTRAINT IF EXISTS "FK_tracking_status_revised_equipment_project_group";
    `);
    await queryRunner.query(`
      ALTER TABLE "tracking_status"
        DROP COLUMN IF EXISTS "revised_equipment_project_group_id";
    `);

    // Step 4 rollback — CHECK constraint.
    await queryRunner.query(`
      ALTER TABLE "revised_equipment_project_groups"
        DROP CONSTRAINT IF EXISTS "ck_revised_equipment_project_group_shape";
    `);

    // Steps 1-3 rollback — CASCADE on DROP TABLE removes FKs + indexes.
    await queryRunner.query(`
      DROP TABLE IF EXISTS "revised_equipment_project_groups" CASCADE;
    `);
  }
}
