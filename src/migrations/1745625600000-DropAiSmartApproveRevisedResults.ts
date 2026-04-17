import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: DropAiSmartApproveRevisedResults (RF2 removal / Wave 6).
 *
 * Reverses `1745539200000-CreateAiSmartApproveRevisedResults.ts` (RF2 /
 * Wave 2) as part of the coordinated feature removal described in
 * `docs/tasks/REMOVE_RF2_DIFF_AWARE_SMART_APPROVE.md`.
 *
 * Per CLAUDE.md §17.2 (advisory-only): rows in
 * `ai_smart_approve_revised_results` never gated workflow state and never
 * joined `tracking_status`. Destroying them when the table is dropped is
 * acceptable under §17.2, and §12 audit integrity is preserved by
 * construction because RF2 never participated in the canonical audit
 * trail (see also §17.3 audit separation — RF2 rows carried NO FK into
 * any project-owning table, so §14.6 rollback cascade is irrelevant).
 *
 * Enum ownership (CRITICAL):
 *   - LOCAL enums (dropped here, recreated on down):
 *       · `ai_smart_approve_revised_workflow`
 *       · `ai_smart_approve_parent_kind`
 *   - SHARED foundation enums (OWNED BY `1745366400000-CreateAiResultFoundation.ts`,
 *     still consumed by RF5's `ai_pre_submit_snapshots`). MUST NOT be dropped:
 *       · `ai_target_kind`
 *       · `ai_score_band`
 *       · `ai_staleness_policy`
 *
 * Idempotency: every statement uses `IF EXISTS` / `IF NOT EXISTS` guards
 * so `up()` and `down()` are safe to re-run.
 *
 * Reversibility: `down()` copies the CREATE DDL verbatim from the
 * original migration so the table and its LOCAL enums can be fully
 * reconstructed for emergency rollback.
 */
export class DropAiSmartApproveRevisedResults1745625600000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Drop indexes (LIFO relative to original CREATE) ──────────────────
    await queryRunner.query(`
      DROP INDEX IF EXISTS "ix_ai_smart_approve_revised_workflow";
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "ix_ai_smart_approve_revised_target_kind_hash";
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "ix_ai_smart_approve_revised_target_computed_at";
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "uq_ai_smart_approve_revised_active";
    `);

    // ── Drop the RF2 table ───────────────────────────────────────────────
    // CASCADE is defensive: no FK points here and no FK points out, so in
    // practice this is equivalent to a plain DROP. Rows are destroyed;
    // §17.2 advisory-only clearance applies.
    await queryRunner.query(`
      DROP TABLE IF EXISTS "ai_smart_approve_revised_results" CASCADE;
    `);

    // ── Drop LOCAL enums only ────────────────────────────────────────────
    // These two enums were created by the CREATE migration exclusively
    // for this table. Safe to drop now that the table is gone.
    await queryRunner.query(`
      DROP TYPE IF EXISTS "ai_smart_approve_parent_kind" CASCADE;
    `);
    await queryRunner.query(`
      DROP TYPE IF EXISTS "ai_smart_approve_revised_workflow" CASCADE;
    `);

    // NOTE: `ai_target_kind`, `ai_score_band`, `ai_staleness_policy` are
    // intentionally NOT dropped — they are owned by
    // `1745366400000-CreateAiResultFoundation.ts` and are still consumed
    // by RF5's `ai_pre_submit_snapshots` table.
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Mirror of `1745539200000-CreateAiSmartApproveRevisedResults.ts` up()
    // copied verbatim so the reversal is byte-equivalent to the original
    // CREATE. This preserves emergency-rollback fidelity.

    // ── Table-local enums ────────────────────────────────────────────────
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_type
          WHERE typname = 'ai_smart_approve_revised_workflow'
        ) THEN
          CREATE TYPE "ai_smart_approve_revised_workflow" AS ENUM (
            'revision',
            'change'
          );
        END IF;
      END$$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_type
          WHERE typname = 'ai_smart_approve_parent_kind'
        ) THEN
          CREATE TYPE "ai_smart_approve_parent_kind" AS ENUM (
            'original',
            'revised'
          );
        END IF;
      END$$;
    `);

    // ── Recreate table (mirror of original CREATE) ───────────────────────
    // NO FK — §17.3 audit separation preserved.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "ai_smart_approve_revised_results" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "target_kind" "ai_target_kind" NOT NULL,
        "target_id" uuid NOT NULL,
        "workflow" "ai_smart_approve_revised_workflow" NOT NULL,
        "parent_project_id" uuid NULL,
        "parent_kind" "ai_smart_approve_parent_kind" NULL,
        "parent_content_hash" varchar(64) NULL,
        "computed_by_work_history_id" uuid NULL,
        "score_0_100" integer NULL,
        "band" "ai_score_band" NULL,
        "category_scores_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "result_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "content_hash" varchar(64) NOT NULL,
        "additional_context_length" integer NOT NULL DEFAULT 0,
        "model" varchar(128) NOT NULL DEFAULT 'gpt-4o',
        "endpoint" varchar(256) NOT NULL DEFAULT 'smart-approve/analyze/revised',
        "staleness_policy" "ai_staleness_policy"
          NOT NULL DEFAULT 'strict',
        "computed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NULL,
        "deleted_at" TIMESTAMP WITH TIME ZONE NULL,
        CONSTRAINT "pk_ai_smart_approve_revised_results" PRIMARY KEY ("id"),
        CONSTRAINT "chk_ai_smart_approve_revised_score_range"
          CHECK ("score_0_100" IS NULL
                 OR ("score_0_100" >= 0 AND "score_0_100" <= 100))
      );
    `);

    // ── Partial unique index — exactly one active row per (target, endpoint) ──
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS
        "uq_ai_smart_approve_revised_active"
      ON "ai_smart_approve_revised_results"
        ("target_kind", "target_id", "endpoint")
      WHERE "deleted_at" IS NULL;
    `);

    // Audit / history query index (mirrors RF5 naming).
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS
        "ix_ai_smart_approve_revised_target_computed_at"
      ON "ai_smart_approve_revised_results"
        ("target_id", "computed_at" DESC);
    `);

    // Composite hash lookup index (dedup probes).
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS
        "ix_ai_smart_approve_revised_target_kind_hash"
      ON "ai_smart_approve_revised_results"
        ("target_id", "target_kind", "content_hash");
    `);

    // Workflow-scoped lookups (UI may render all history for one workflow).
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS
        "ix_ai_smart_approve_revised_workflow"
      ON "ai_smart_approve_revised_results" ("workflow");
    `);
  }
}
