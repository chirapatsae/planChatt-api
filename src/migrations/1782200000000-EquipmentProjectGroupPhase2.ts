import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Wave Equipment ผ.03, Phase 2 — DB-02 (2026-05-28).
 *
 * Creates the `equipment_project_groups` table — a sibling of
 * `project_groups` / `revised_project_groups` / `supplement_project_groups`
 * — wires the §12 audit hook (`equipment_project_group_id` FK on
 * `tracking_status`), and extends the polymorphic `budget` table with
 * a fourth nullable FK (`equipment_project_group_id`).
 *
 * # Locked decisions (2026-05-28)
 *
 * - **Q5 = B (dual format).** The CHECK constraint
 *   `ck_equipment_project_group_shape` enforces exactly-one-of:
 *     STRATEGY_BASED: (strategy_id, tactic_id, plan_id) NOT NULL +
 *                     development_issue_id NULL
 *     ISSUE_BASED   : (strategy_id, tactic_id, plan_id) NULL +
 *                     development_issue_id NOT NULL
 *   `equipment_category_id IS NOT NULL` in BOTH shapes.
 *
 * - **§16.5 indicator-relaxation.** Unlike PG's CHECK, `indicator`
 *   is intentionally NOT part of this CHECK — equipment relaxes the
 *   KPI-required clause in BOTH shapes (user spec: no KPI for
 *   equipment items).
 *
 * - **Agency-only authoring** = BE-04 enforcement (classification gate
 *   on the request's WorkHistory per §1). NOT a DB constraint.
 *
 * - **R3 = NO** — no `prev_project_id` / `prev_project_type` columns.
 *
 * # Idempotency
 *
 * - `CREATE TABLE IF NOT EXISTS` tolerates a `synchronize:true`
 *   pre-creation of the empty table on boot (which does NOT add the
 *   CHECK constraint — see MEMORY: typeorm synchronize).
 * - All `ALTER TABLE … ADD` / `CREATE INDEX` / `ADD CONSTRAINT` are
 *   guarded by DO-blocks or `IF NOT EXISTS`.
 * - Re-runs are no-ops.
 *
 * # Source of truth
 *
 * - docs/tasks/wave-equipment-pro3/DB-02-equipment-project-entity.md
 * - CLAUDE.md §4 / §5 / §7 / §10 / §12 / §14 / §16.5
 * - Sibling pattern: `1744675200000-AddMultiFormatReporting.ts`
 *   (CHECK shape), `1779000000000-SUPP3-CreateAttachmentSupplementProjectGroups.ts`
 *   (table-creation pattern), `1781400000000-AddBookedFieldsToSupplementProjectGroups.ts`
 */
export class EquipmentProjectGroupPhase21782200000000
  implements MigrationInterface
{
  name = 'EquipmentProjectGroupPhase21782200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ──────────────────────────────────────────────────────────────────
    // Step 1: Create equipment_project_groups (idempotent).
    // `synchronize:true` may have already created this from entity
    // metadata; `IF NOT EXISTS` tolerates that prior state but DOES
    // NOT add the CHECK constraint (synchronize does not emit CHECKs).
    // ──────────────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "equipment_project_groups" (
        "id"                                      uuid        NOT NULL DEFAULT gen_random_uuid(),

        -- Equipment content (user spec — five fields)
        "equipment_name"                          text        NOT NULL,
        "target_output"                           text        NOT NULL,
        "expected_results"                        text        NOT NULL,
        "indicator"                               text                                 ,

        -- Engagement counters (mirror PG)
        "like_count"                              int         NOT NULL DEFAULT 0,
        "view_count"                              int         NOT NULL DEFAULT 0,

        -- Classification (dual shape per §16.5 + Q5=B)
        "strategy_id"                             varchar                              ,
        "tactic_id"                               varchar                              ,
        "plan_id"                                 varchar                              ,
        "development_issue_id"                    uuid                                 ,
        "equipment_category_id"                   uuid        NOT NULL,

        -- Book parent (§8, §10)
        "development_plan_id"                     uuid        NOT NULL,

        -- Ownership (§4 — WorkHistory)
        "create_by"                               uuid                                 ,

        -- Origin context (§5)
        "amphoe_id"                               text                                 ,
        "local_administrative_organization_id"    text                                 ,
        "origin_agency_id"                        text                                 ,

        -- ResponsibleAgency (§5 / §7) — nullable at DB; auto-assigned
        -- at BE for agency-origin equipment per §5.1
        "responsible_agency_id"                   int                                  ,

        "created_at"                              timestamptz NOT NULL DEFAULT now(),
        "deleted_at"                              timestamptz                          ,

        CONSTRAINT "PK_equipment_project_groups" PRIMARY KEY ("id")
      );
    `);

    // ──────────────────────────────────────────────────────────────────
    // Step 2: Foreign keys (idempotent via pg_constraint guard).
    // ──────────────────────────────────────────────────────────────────
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_eqg_strategy') THEN
          ALTER TABLE "equipment_project_groups"
            ADD CONSTRAINT "FK_eqg_strategy"
              FOREIGN KEY ("strategy_id") REFERENCES "strategies"("id")
              ON DELETE CASCADE ON UPDATE CASCADE;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_eqg_tactic') THEN
          ALTER TABLE "equipment_project_groups"
            ADD CONSTRAINT "FK_eqg_tactic"
              FOREIGN KEY ("tactic_id") REFERENCES "tactics"("id")
              ON DELETE CASCADE ON UPDATE CASCADE;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_eqg_plan') THEN
          ALTER TABLE "equipment_project_groups"
            ADD CONSTRAINT "FK_eqg_plan"
              FOREIGN KEY ("plan_id") REFERENCES "plans"("id")
              ON DELETE CASCADE ON UPDATE CASCADE;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_eqg_development_issue') THEN
          ALTER TABLE "equipment_project_groups"
            ADD CONSTRAINT "FK_eqg_development_issue"
              FOREIGN KEY ("development_issue_id") REFERENCES "development_issues"("id")
              ON DELETE CASCADE ON UPDATE CASCADE;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_eqg_equipment_category') THEN
          ALTER TABLE "equipment_project_groups"
            ADD CONSTRAINT "FK_eqg_equipment_category"
              FOREIGN KEY ("equipment_category_id") REFERENCES "equipment_categories"("id")
              ON DELETE RESTRICT ON UPDATE CASCADE;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_eqg_development_plan') THEN
          ALTER TABLE "equipment_project_groups"
            ADD CONSTRAINT "FK_eqg_development_plan"
              FOREIGN KEY ("development_plan_id") REFERENCES "development_plan"("id")
              ON DELETE CASCADE ON UPDATE CASCADE;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_eqg_create_by') THEN
          ALTER TABLE "equipment_project_groups"
            ADD CONSTRAINT "FK_eqg_create_by"
              FOREIGN KEY ("create_by") REFERENCES "work_history"("id")
              ON DELETE CASCADE ON UPDATE CASCADE;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_eqg_amphoe') THEN
          ALTER TABLE "equipment_project_groups"
            ADD CONSTRAINT "FK_eqg_amphoe"
              FOREIGN KEY ("amphoe_id") REFERENCES "amphoes"("id")
              ON DELETE CASCADE ON UPDATE CASCADE;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_eqg_lao') THEN
          ALTER TABLE "equipment_project_groups"
            ADD CONSTRAINT "FK_eqg_lao"
              FOREIGN KEY ("local_administrative_organization_id")
              REFERENCES "local_administrative_organizations"("id")
              ON DELETE CASCADE ON UPDATE CASCADE;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_eqg_origin_agency') THEN
          ALTER TABLE "equipment_project_groups"
            ADD CONSTRAINT "FK_eqg_origin_agency"
              FOREIGN KEY ("origin_agency_id")
              REFERENCES "local_administrative_organizations"("id")
              ON DELETE CASCADE ON UPDATE CASCADE;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_eqg_responsible_agency') THEN
          ALTER TABLE "equipment_project_groups"
            ADD CONSTRAINT "FK_eqg_responsible_agency"
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
      CREATE INDEX IF NOT EXISTS "idx_eqg_development_plan"
        ON "equipment_project_groups" ("development_plan_id");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_eqg_create_by"
        ON "equipment_project_groups" ("create_by");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_eqg_equipment_category"
        ON "equipment_project_groups" ("equipment_category_id");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_eqg_responsible_agency"
        ON "equipment_project_groups" ("responsible_agency_id");
    `);
    // Partial — ISSUE_BASED rows only (per task spec §3 indexes).
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_eqg_development_issue"
        ON "equipment_project_groups" ("development_issue_id")
        WHERE "development_issue_id" IS NOT NULL;
    `);
    // Composite — STRATEGY_BASED filtering.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_eqg_strategy_tactic_plan"
        ON "equipment_project_groups" ("strategy_id", "tactic_id", "plan_id");
    `);
    // Soft-delete filter.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_eqg_deleted_at"
        ON "equipment_project_groups" ("deleted_at");
    `);

    // ──────────────────────────────────────────────────────────────────
    // Step 4: Dual-shape CHECK constraint (§16.5 + Q5=B).
    // Indicator is intentionally OMITTED from the CHECK — equipment
    // relaxes PG's `indicator NOT NULL` clause in BOTH shapes.
    // ──────────────────────────────────────────────────────────────────
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'ck_equipment_project_group_shape'
        ) THEN
          ALTER TABLE "equipment_project_groups"
            ADD CONSTRAINT "ck_equipment_project_group_shape"
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
    // Step 5: tracking_status — add equipment_project_group_id FK + index.
    // §12 audit hook: equipment items record TrackingStatus rows the
    // same way PG / RPG / SPG do.
    // ──────────────────────────────────────────────────────────────────
    await queryRunner.query(`
      ALTER TABLE "tracking_status"
        ADD COLUMN IF NOT EXISTS "equipment_project_group_id" uuid;
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_tracking_status_equipment_project_group'
        ) THEN
          ALTER TABLE "tracking_status"
            ADD CONSTRAINT "FK_tracking_status_equipment_project_group"
              FOREIGN KEY ("equipment_project_group_id")
              REFERENCES "equipment_project_groups"("id")
              ON DELETE CASCADE ON UPDATE CASCADE;
        END IF;
      END$$;
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_tracking_status_equipment_project_group"
        ON "tracking_status" ("equipment_project_group_id")
        WHERE "equipment_project_group_id" IS NOT NULL;
    `);

    // ──────────────────────────────────────────────────────────────────
    // Step 6: budget — extend the polymorphic FK pattern with a fourth
    // nullable FK column (`equipment_project_group_id`). The existing
    // pattern already carries three nullable FKs (PG / RPG / SPG); this
    // adds the equipment sibling. Exactly one of the four FKs is
    // expected per row at the BE layer (not DB-enforced — same
    // convention as the existing three).
    // ──────────────────────────────────────────────────────────────────
    await queryRunner.query(`
      ALTER TABLE "budget"
        ADD COLUMN IF NOT EXISTS "equipment_project_group_id" uuid;
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_budget_equipment_project_group'
        ) THEN
          ALTER TABLE "budget"
            ADD CONSTRAINT "FK_budget_equipment_project_group"
              FOREIGN KEY ("equipment_project_group_id")
              REFERENCES "equipment_project_groups"("id")
              ON DELETE CASCADE ON UPDATE CASCADE;
        END IF;
      END$$;
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_budget_equipment_project_group"
        ON "budget" ("equipment_project_group_id")
        WHERE "equipment_project_group_id" IS NOT NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverse in strict LIFO order.

    // Step 6 rollback — budget polymorphic FK.
    await queryRunner.query(`
      DROP INDEX IF EXISTS "idx_budget_equipment_project_group";
    `);
    await queryRunner.query(`
      ALTER TABLE "budget"
        DROP CONSTRAINT IF EXISTS "FK_budget_equipment_project_group";
    `);
    await queryRunner.query(`
      ALTER TABLE "budget"
        DROP COLUMN IF EXISTS "equipment_project_group_id";
    `);

    // Step 5 rollback — tracking_status FK + index.
    await queryRunner.query(`
      DROP INDEX IF EXISTS "idx_tracking_status_equipment_project_group";
    `);
    await queryRunner.query(`
      ALTER TABLE "tracking_status"
        DROP CONSTRAINT IF EXISTS "FK_tracking_status_equipment_project_group";
    `);
    await queryRunner.query(`
      ALTER TABLE "tracking_status"
        DROP COLUMN IF EXISTS "equipment_project_group_id";
    `);

    // Step 4 rollback — CHECK constraint.
    await queryRunner.query(`
      ALTER TABLE "equipment_project_groups"
        DROP CONSTRAINT IF EXISTS "ck_equipment_project_group_shape";
    `);

    // Steps 1-3 rollback — CASCADE on DROP TABLE removes FKs + indexes.
    await queryRunner.query(`
      DROP TABLE IF EXISTS "equipment_project_groups" CASCADE;
    `);
  }
}
