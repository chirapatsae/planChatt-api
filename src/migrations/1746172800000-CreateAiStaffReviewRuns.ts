import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: CreateAiStaffReviewRuns
 *
 * Wave 40 N4 — schema-only foundation for persisting staff smart-approve
 * runs. Wave 41 will wire the write path; this migration creates the
 * table + indexes ONLY. No controller, no service, no write code.
 *
 * Depends on the N1 foundation migration
 * `1745366400000-CreateAiResultFoundation.ts` for the shared enum types
 * `ai_target_kind`, `ai_score_band`, `ai_staleness_policy`.
 *
 * CLAUDE.md references:
 *   - §17.3 Audit separation. The table has NO FOREIGN KEY to
 *     `project_groups`, `revised_project_groups`, or
 *     `supplement_project_groups`. `target_id` is a plain uuid column
 *     and `target_kind` is the discriminator. This guarantees that
 *     §14.6 staff-led rollback hard-deletes of a `RevisedProjectGroup`
 *     row DO NOT cascade into this AI audit history. The reviewer
 *     reference (`reviewer_work_history_id`) is likewise a plain uuid
 *     with no FK to `work_histories`, mirroring the precedent set by
 *     `ai_pre_submit_snapshots.submitted_by_work_history_id` and
 *     `ai_usage_logs.actor_work_history_id`.
 *
 *   - §17.4 `strict` staleness policy — staff-side reviewer runs are
 *     live (NOT snapshot-only). The column defaults to `'strict'` so
 *     that Wave 41 read paths correctly surface a stale warning when
 *     the underlying content hash drifts.
 *
 *   - §17.11 No role exemption — nothing in this schema permits any
 *     role to override or coerce an AI result; the schema is
 *     integrity-bound.
 *
 * Table design notes:
 *   - Mirrors the `AbstractAiResult` base used by
 *     `ai_pre_submit_snapshots` (shared columns: target_id,
 *     target_kind, content_hash, computed_at, score_0_100, band,
 *     result_json, staleness_policy, endpoint, model, timestamps).
 *   - Adds `reviewer_work_history_id` as the reviewer audit stamp
 *     captured at compute time (§4 ownership semantics — WorkHistory
 *     is the source of truth for organizational context).
 *   - Default `endpoint` is `'smart-approve/analyze'` so bare INSERTs
 *     from Wave 41 default to the canonical reviewer endpoint.
 *
 * Rollback safety:
 *   - Down migration drops indexes first (LIFO), then the table.
 *   - Foundation enum types are OWNED by the N1 foundation migration
 *     and MUST NOT be dropped here.
 */
export class CreateAiStaffReviewRuns1746172800000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Create table ────────────────────────────────────────────────────
    // NOTE (§17.3): `target_id` AND `reviewer_work_history_id` are plain
    // uuid columns — NO FK. Verified by the absence of any REFERENCES
    // clause below. `pgcrypto` is already present project-wide for
    // gen_random_uuid(); we continue to use uuid_generate_v4() for
    // consistency with the precedent table `ai_pre_submit_snapshots`.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "ai_staff_review_runs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "target_kind" "ai_target_kind" NOT NULL,
        "target_id" uuid NOT NULL,
        "reviewer_work_history_id" uuid NOT NULL,
        "content_hash" varchar(64) NOT NULL,
        "endpoint" varchar(256) NOT NULL DEFAULT 'smart-approve/analyze',
        "result_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "score_0_100" integer NULL,
        "band" "ai_score_band" NULL,
        "model" varchar(128) NOT NULL DEFAULT 'unknown',
        "staleness_policy" "ai_staleness_policy"
          NOT NULL DEFAULT 'strict',
        "computed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NULL,
        "deleted_at" TIMESTAMP WITH TIME ZONE NULL,
        CONSTRAINT "pk_ai_staff_review_runs" PRIMARY KEY ("id"),
        CONSTRAINT "chk_ai_staff_review_runs_score_range"
          CHECK ("score_0_100" IS NULL
                 OR ("score_0_100" >= 0 AND "score_0_100" <= 100))
      );
    `);

    // ── Indexes ─────────────────────────────────────────────────────────
    // Latest-lookup index: Wave 41 read path will ORDER BY computed_at
    // DESC scoped to (target_kind, target_id).
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS
        "ix_ai_staff_review_runs_target_computed_at"
      ON "ai_staff_review_runs"
        ("target_kind", "target_id", "computed_at" DESC);
    `);

    // Reviewer analytics / quota join index.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS
        "ix_ai_staff_review_runs_reviewer_computed_at"
      ON "ai_staff_review_runs"
        ("reviewer_work_history_id", "computed_at" DESC);
    `);

    // Idempotency candidate — Wave 41 MAY use content_hash for
    // deduplication before writing a new run.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS
        "ix_ai_staff_review_runs_content_hash"
      ON "ai_staff_review_runs" ("content_hash");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // LIFO — drop indexes, then the table. Foundation enums are
    // intentionally NOT dropped here (owned by the N1 foundation
    // migration).
    await queryRunner.query(`
      DROP INDEX IF EXISTS "ix_ai_staff_review_runs_content_hash";
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "ix_ai_staff_review_runs_reviewer_computed_at";
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "ix_ai_staff_review_runs_target_computed_at";
    `);
    await queryRunner.query(`
      DROP TABLE IF EXISTS "ai_staff_review_runs";
    `);
  }
}
