import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: CreateAiSmartApproveRevisedResults (RF2 / Wave 2).
 *
 * Implements the RF2 diff-aware smart-approve persistence table per
 * CLAUDE.md §17 (AI-Assist Rule — §17.3 audit separation, §17.4 `strict`
 * staleness policy, §17.5 recompute discipline).
 *
 * Depends on `1745366400000-CreateAiResultFoundation.ts` (N1) for the
 * shared enum types:
 *   - `ai_target_kind`
 *   - `ai_score_band`
 *   - `ai_staleness_policy`
 *
 * This migration MUST NOT recreate those enums. Two table-local enums
 * (`ai_smart_approve_revised_workflow`, `ai_smart_approve_parent_kind`)
 * are created here and dropped in the `down` branch.
 *
 * Key design points enforced by this migration (match the RF5 shape):
 *
 *   1. §17.3 Audit separation — NO foreign key to any project-owning
 *      table. `target_id` is a plain uuid; `target_kind` is the
 *      discriminator. §14.6 rollback hard-deletes DO NOT cascade here.
 *
 *   2. §17.4 `strict` policy — `staleness_policy` defaults to `'strict'`.
 *      The read side computes `isStale` by comparing stored
 *      `content_hash` against the currently-computed hash.
 *
 *   3. Partial unique index on `(target_kind, target_id, endpoint)
 *      WHERE deleted_at IS NULL` — exactly one active row per
 *      (revised project, endpoint). Recompute soft-deletes the prior
 *      active row and inserts a new one (§17.5 audit preservation).
 *
 *   4. §12 / §17.5 Audit preservation — no hard delete. All updates are
 *      soft-delete previous + INSERT new.
 *
 *   5. Check constraint on `score_0_100` mirrors the RF5 table (0..100
 *      or NULL).
 *
 * Rollback safety:
 *   - `down` drops indexes, table, then workflow/parent-kind enums. It
 *     does NOT drop N1 foundation enums.
 *   - `up` is idempotent via `IF NOT EXISTS` guards.
 */
export class CreateAiSmartApproveRevisedResults1745539200000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
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

    // ── Create table ────────────────────────────────────────────────────
    // NOTE (§17.3): `target_id` / `parent_project_id` are plain uuid
    // columns — NO FK. Verified by the absence of any REFERENCES clause.
    //
    // NOTE: re-uses N1 foundation enums `ai_target_kind`, `ai_score_band`,
    // `ai_staleness_policy` — these MUST NOT be recreated here.
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

    // Composite hash lookup index per task file §8 (dedup probes).
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

  public async down(queryRunner: QueryRunner): Promise<void> {
    // LIFO — drop indexes, then table, then the local enums. Foundation
    // enums are intentionally NOT dropped here (owned by N1).
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
    await queryRunner.query(`
      DROP TABLE IF EXISTS "ai_smart_approve_revised_results";
    `);
    await queryRunner.query(`
      DROP TYPE IF EXISTS "ai_smart_approve_parent_kind";
    `);
    await queryRunner.query(`
      DROP TYPE IF EXISTS "ai_smart_approve_revised_workflow";
    `);
  }
}
