import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: CreateAiPreSubmitSnapshots
 *
 * Implements RF5 persistence layer per CLAUDE.md §17 (AI-Assist Rule).
 *
 * Depends on the N1 foundation migration
 * `1745366400000-CreateAiResultFoundation.ts` for the shared enum types
 * `ai_target_kind`, `ai_score_band`, `ai_staleness_policy`.
 *
 * Key design points enforced by this migration:
 *
 *   1. §17.3 Audit separation — the table has NO FOREIGN KEY to the project
 *      tables (`project_groups`, `revised_project_groups`,
 *      `supplement_project_groups`). `target_id` is a plain UUID column and
 *      `target_kind` is the discriminator. This guarantees that §14.6
 *      staff-led rollback hard-deletes of a `RevisedProjectGroup` row DO NOT
 *      cascade into this AI audit history.
 *
 *   2. §17.4 `snapshot-only` staleness policy — rows are canonical
 *      photographs at submit time. The column `staleness_policy` defaults
 *      to `'snapshot-only'`. The read API always returns `isStale: false`
 *      regardless of the column (the service forces the policy when
 *      building the envelope).
 *
 *   3. Partial unique index on `(target_kind, target_id) WHERE deleted_at
 *      IS NULL` — exactly one active snapshot per target. Resubmit flow
 *      soft-deletes the prior active row (sets `deleted_at = now()`) then
 *      INSERTs a new row; prior rows stay in the table as history.
 *
 *   4. §12 / §17.5 Audit preservation — no hard delete ever. All updates
 *      are soft-delete-previous + INSERT new.
 *
 * Rollback safety:
 *   - Down migration drops the partial unique index first, then the audit
 *     index, then the table. The foundation enum types are OWNED by the
 *     N1 foundation migration and MUST NOT be dropped here.
 */
export class CreateAiPreSubmitSnapshots1745452800000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Workflow-specific enum (local to this table) ─────────────────────
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_type
          WHERE typname = 'ai_pre_submit_workflow'
        ) THEN
          CREATE TYPE "ai_pre_submit_workflow" AS ENUM (
            'add',
            'revision',
            'change'
          );
        END IF;
      END$$;
    `);

    // ── Create table ────────────────────────────────────────────────────
    // NOTE (§17.3): `target_id` is a plain uuid column — NO FK. Verified by
    // the absence of any REFERENCES clause below.
    //
    // NOTE: re-uses N1 foundation enums `ai_target_kind`, `ai_score_band`,
    // `ai_staleness_policy` so that RF2 and RF5 share the same enum types
    // across tables.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "ai_pre_submit_snapshots" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "target_kind" "ai_target_kind" NOT NULL,
        "target_id" uuid NOT NULL,
        "workflow" "ai_pre_submit_workflow" NOT NULL,
        "submitted_by_work_history_id" uuid NOT NULL,
        "computed_by_work_history_id" uuid NULL,
        "score_0_100" integer NULL,
        "band" "ai_score_band" NULL,
        "summary_text" text NULL,
        "suggestions_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "categories_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "result_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "content_hash" varchar(64) NOT NULL,
        "model" varchar(128) NOT NULL DEFAULT 'unknown',
        "endpoint" varchar(256) NOT NULL DEFAULT 'pre-submit-review',
        "staleness_policy" "ai_staleness_policy"
          NOT NULL DEFAULT 'snapshot-only',
        "computed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NULL,
        "deleted_at" TIMESTAMP WITH TIME ZONE NULL,
        CONSTRAINT "pk_ai_pre_submit_snapshots" PRIMARY KEY ("id"),
        CONSTRAINT "chk_ai_pre_submit_snapshots_score_range"
          CHECK ("score_0_100" IS NULL
                 OR ("score_0_100" >= 0 AND "score_0_100" <= 100))
      );
    `);

    // ── Partial unique index — exactly one active snapshot per target ──
    // CRITICAL: WHERE deleted_at IS NULL so resubmit (soft-delete old +
    // insert new) works without violating uniqueness.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS
        "uq_ai_pre_submit_snapshots_active_target"
      ON "ai_pre_submit_snapshots" ("target_kind", "target_id")
      WHERE "deleted_at" IS NULL;
    `);

    // Audit / history queries.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS
        "ix_ai_pre_submit_snapshots_target_computed_at"
      ON "ai_pre_submit_snapshots" ("target_id", "computed_at" DESC);
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS
        "ix_ai_pre_submit_snapshots_submitted_by"
      ON "ai_pre_submit_snapshots" ("submitted_by_work_history_id");
    `);

    // Composite hash lookup index per §17.3 task file §8.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS
        "ix_ai_pre_submit_snapshots_target_kind_hash"
      ON "ai_pre_submit_snapshots" ("target_id", "target_kind", "content_hash");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // LIFO — drop indexes, then table, then the local workflow enum.
    // Foundation enums are intentionally NOT dropped here (owned by N1).
    await queryRunner.query(`
      DROP INDEX IF EXISTS "ix_ai_pre_submit_snapshots_target_kind_hash";
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "ix_ai_pre_submit_snapshots_submitted_by";
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "ix_ai_pre_submit_snapshots_target_computed_at";
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "uq_ai_pre_submit_snapshots_active_target";
    `);
    await queryRunner.query(`
      DROP TABLE IF EXISTS "ai_pre_submit_snapshots";
    `);
    await queryRunner.query(`
      DROP TYPE IF EXISTS "ai_pre_submit_workflow";
    `);
  }
}
