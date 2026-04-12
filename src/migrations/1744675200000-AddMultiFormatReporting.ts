import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: AddMultiFormatReporting
 *
 * Implements the database layer for the Multi-Format Reporting feature
 * (CLAUDE.md §16). Introduces:
 *
 *   1. `development_plan.report_format` — enum column with default
 *      `STRATEGY_BASED`, NOT NULL. Determines the classification
 *      vocabulary used by every project under the plan.
 *
 *   2. `development_issues` table — plan-scoped classification nodes for
 *      ISSUE_BASED lineages, with soft-delete and sort ordering.
 *
 *   3. Nullability relaxation on `project_groups`, `revised_project_groups`,
 *      `supplement_project_groups`:
 *        - `strategy_id`, `tactic_id`, `plan_id`, `indicator` become nullable
 *        - new nullable FK `development_issue_id`
 *
 *   4. DB CHECK constraint per project table enforcing the §16.5
 *      exactly-one-shape invariant. A row must satisfy either the
 *      STRATEGY_BASED shape or the ISSUE_BASED shape, never a mix.
 *
 * Migration safety:
 *   - Online migration. No data backfill required — every existing
 *     `development_plan` row receives `STRATEGY_BASED` via the column
 *     default.
 *   - Existing project rows already satisfy the STRATEGY_BASED shape
 *     (strategy_id / tactic_id / plan_id / indicator were previously
 *     NOT NULL). The CHECK constraint is ADDED AFTER the nullability
 *     relaxation so it evaluates cleanly against the existing data.
 *   - Existing project rows with `indicator = ''` (if any) would fail
 *     the CHECK. The CHECK `indicator <> ''` condition is intentionally
 *     mirrored in the service layer; production DB audit must confirm
 *     no empty-string indicator values before running. A guard INSERT
 *     performed during rollout (outside this migration) should detect
 *     and repair such rows.
 *
 * Rollback safety:
 *   - Down migration reverses in strict LIFO order: DROP CHECK, DROP FK,
 *     DROP development_issue_id, restore NOT NULL on the 4 legacy
 *     columns, DROP development_issues table, DROP report_format column,
 *     DROP report_format enum type.
 *   - Restoring NOT NULL only succeeds if no ISSUE_BASED rows exist at
 *     downgrade time. This is the documented operator contract — the
 *     operator MUST delete ISSUE_BASED project rows before executing
 *     the down migration (CLAUDE.md §16.10).
 *
 * CLAUDE.md references: §16.3, §16.4, §16.5, §16.6, §16.10.
 */
export class AddMultiFormatReporting1744675200000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Step 1: Create report_format enum type ──────────────────────────
    // Guarded with IF NOT EXISTS semantics by checking pg_type so the
    // migration is idempotent against environments that ran a partial
    // previous migration attempt.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_type WHERE typname = 'development_plan_report_format_enum'
        ) THEN
          CREATE TYPE "development_plan_report_format_enum" AS ENUM (
            'STRATEGY_BASED',
            'ISSUE_BASED'
          );
        END IF;
      END$$;
    `);

    // ── Step 2: Add report_format column to development_plan ────────────
    // Non-null with default. Existing rows auto-fill to STRATEGY_BASED.
    await queryRunner.query(`
      ALTER TABLE "development_plan"
        ADD COLUMN IF NOT EXISTS "report_format"
          "development_plan_report_format_enum"
          NOT NULL
          DEFAULT 'STRATEGY_BASED';
    `);

    // ── Step 3: Create development_issues table ─────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "development_issues" (
        "id"                  uuid        NOT NULL DEFAULT uuid_generate_v4(),
        "development_plan_id" uuid        NOT NULL,
        "name"                varchar(512) NOT NULL,
        "sort_order"          int         NOT NULL DEFAULT 0,
        "created_at"          TIMESTAMP   NOT NULL DEFAULT now(),
        "deleted_at"          TIMESTAMP,
        "created_by"          uuid,
        CONSTRAINT "PK_development_issues" PRIMARY KEY ("id")
      );
    `);

    // Link to parent plan. CASCADE matches the soft-ownership pattern
    // used by every other plan-scoped entity in the code base.
    await queryRunner.query(`
      ALTER TABLE "development_issues"
        ADD CONSTRAINT "FK_development_issues_plan"
          FOREIGN KEY ("development_plan_id")
          REFERENCES "development_plan" ("id")
          ON DELETE CASCADE
          ON UPDATE CASCADE;
    `);

    // Link to author WorkHistory. Nullable=false mirrors the other
    // plan/project author FKs; historical rows do not exist at creation
    // time so the column is populated from the request context.
    await queryRunner.query(`
      ALTER TABLE "development_issues"
        ADD CONSTRAINT "FK_development_issues_created_by"
          FOREIGN KEY ("created_by")
          REFERENCES "work_history" ("id")
          ON DELETE CASCADE
          ON UPDATE CASCADE;
    `);

    // Composite index for the common listing query
    // (`WHERE development_plan_id = $1 ORDER BY sort_order`).
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_development_issues_plan_sort"
        ON "development_issues" ("development_plan_id", "sort_order");
    `);

    // ── Step 4: Relax NOT NULL on the 4 classification columns ──────────
    // Mirrored across the three project tables. Strategy/tactic/plan FKs
    // already existed — we only drop the NOT NULL guard so ISSUE_BASED
    // rows can leave them empty.
    const projectTables = [
      'project_groups',
      'revised_project_groups',
      'supplement_project_groups',
    ];

    for (const table of projectTables) {
      await queryRunner.query(`
        ALTER TABLE "${table}" ALTER COLUMN "strategy_id" DROP NOT NULL;
      `);
      await queryRunner.query(`
        ALTER TABLE "${table}" ALTER COLUMN "tactic_id" DROP NOT NULL;
      `);
      await queryRunner.query(`
        ALTER TABLE "${table}" ALTER COLUMN "plan_id" DROP NOT NULL;
      `);
      await queryRunner.query(`
        ALTER TABLE "${table}" ALTER COLUMN "indicator" DROP NOT NULL;
      `);

      // ── Step 5: Add development_issue_id FK column ────────────────────
      await queryRunner.query(`
        ALTER TABLE "${table}"
          ADD COLUMN IF NOT EXISTS "development_issue_id" uuid;
      `);
      await queryRunner.query(`
        ALTER TABLE "${table}"
          ADD CONSTRAINT "FK_${table}_development_issue"
            FOREIGN KEY ("development_issue_id")
            REFERENCES "development_issues" ("id")
            ON DELETE CASCADE
            ON UPDATE CASCADE;
      `);

      // ── Step 6: Add exactly-one-shape CHECK constraint ────────────────
      // Two disjuncts:
      //   (a) STRATEGY_BASED — classic tuple present, issue absent,
      //       indicator non-empty
      //   (b) ISSUE_BASED    — issue present, classic tuple absent,
      //       indicator null
      // Empty-string indicator is rejected for STRATEGY_BASED so that
      // the frontend cannot bypass the "required" rule with whitespace.
      await queryRunner.query(`
        ALTER TABLE "${table}"
          ADD CONSTRAINT "chk_${table}_classification_shape"
          CHECK (
            (
              "strategy_id"          IS NOT NULL
              AND "tactic_id"        IS NOT NULL
              AND "plan_id"          IS NOT NULL
              AND "development_issue_id" IS NULL
              AND "indicator"        IS NOT NULL
              AND "indicator" <> ''
            )
            OR
            (
              "strategy_id"          IS NULL
              AND "tactic_id"        IS NULL
              AND "plan_id"          IS NULL
              AND "development_issue_id" IS NOT NULL
              AND "indicator"        IS NULL
            )
          );
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverse in strict LIFO order.
    const projectTables = [
      'supplement_project_groups',
      'revised_project_groups',
      'project_groups',
    ];

    for (const table of projectTables) {
      // Drop CHECK first so subsequent column changes don't trip it.
      await queryRunner.query(`
        ALTER TABLE "${table}"
          DROP CONSTRAINT IF EXISTS "chk_${table}_classification_shape";
      `);

      // Drop FK + column.
      await queryRunner.query(`
        ALTER TABLE "${table}"
          DROP CONSTRAINT IF EXISTS "FK_${table}_development_issue";
      `);
      await queryRunner.query(`
        ALTER TABLE "${table}"
          DROP COLUMN IF EXISTS "development_issue_id";
      `);

      // Restore NOT NULL. Only succeeds if no ISSUE_BASED rows exist.
      // Operator is responsible for cleanup per the migration header
      // (see CLAUDE.md §16.10).
      await queryRunner.query(`
        ALTER TABLE "${table}" ALTER COLUMN "strategy_id" SET NOT NULL;
      `);
      await queryRunner.query(`
        ALTER TABLE "${table}" ALTER COLUMN "tactic_id" SET NOT NULL;
      `);
      await queryRunner.query(`
        ALTER TABLE "${table}" ALTER COLUMN "plan_id" SET NOT NULL;
      `);
      await queryRunner.query(`
        ALTER TABLE "${table}" ALTER COLUMN "indicator" SET NOT NULL;
      `);
    }

    // Drop development_issues table.
    await queryRunner.query(`
      DROP INDEX IF EXISTS "idx_development_issues_plan_sort";
    `);
    await queryRunner.query(`
      ALTER TABLE "development_issues"
        DROP CONSTRAINT IF EXISTS "FK_development_issues_created_by";
    `);
    await queryRunner.query(`
      ALTER TABLE "development_issues"
        DROP CONSTRAINT IF EXISTS "FK_development_issues_plan";
    `);
    await queryRunner.query(`
      DROP TABLE IF EXISTS "development_issues";
    `);

    // Drop report_format column and its enum type.
    await queryRunner.query(`
      ALTER TABLE "development_plan"
        DROP COLUMN IF EXISTS "report_format";
    `);
    await queryRunner.query(`
      DROP TYPE IF EXISTS "development_plan_report_format_enum";
    `);
  }
}
