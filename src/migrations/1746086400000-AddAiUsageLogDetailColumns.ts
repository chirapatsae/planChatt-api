import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: AddAiUsageLogDetailColumns (Wave 36 / N1).
 *
 * Extends `ai_usage_logs` with nine NULLABLE detail-log columns so every
 * LLM-backed AI call can persist a rich record (endpoint discriminator,
 * Thai summary, sanitized request / response payloads, soft target
 * reference, actor context, duration, error). These feed the Profile
 * "what the AI did" detail drawer introduced in later waves.
 *
 * Source of truth:
 *   - docs/tasks/WAVE36_N1_DB_SCHEMA_MIGRATION.md
 *   - CLAUDE.md §17.3 (AI audit separation — no FK to project tables)
 *   - CLAUDE.md §17.4 (event-log vs snapshot — this table is event-log)
 *   - CLAUDE.md §17.9 (payloads must be sanitized BEFORE persist;
 *     enforced at service layer in N2, schema only provides storage)
 *   - CLAUDE.md §17.11 (no role exemption)
 *
 * Columns added (all NULLABLE, backward compatible):
 *   1. endpoint              VARCHAR(64)  — endpoint discriminator
 *   2. summary_th            TEXT         — short Thai list-view label
 *   3. request_payload       JSONB        — sanitized request bag
 *   4. response_payload      JSONB        — sanitized response bag
 *   5. target_id             UUID         — soft ref to project-like row
 *   6. target_kind           VARCHAR(64)  — discriminator for target_id
 *   7. actor_work_history_id UUID         — soft ref to WorkHistory
 *   8. duration_ms           INTEGER      — LLM call duration
 *   9. error                 TEXT         — error message on failure
 *
 * Guardrails (§17.3 + task file "CRITICAL — what NOT to do"):
 *   - NO foreign key constraints on `target_id` (bare UUID)
 *   - NO foreign key constraints on `actor_work_history_id` (bare UUID)
 *   - NO indexes (deferred — revisit if query perf demands it)
 *   - All columns NULLABLE (pre-Wave-36 rows must survive unchanged)
 *   - Existing columns (id, usage_type, model_name, input_tokens,
 *     output_tokens, input_text_length, output_text_length, cost_bath,
 *     used_at, ai_usage_quota_id) are UNTOUCHED
 *   - `ai_usage_quota_id` FK remains as-is (Wave 18 quota ownership)
 *
 * Idempotency / reversibility:
 *   - `up()` uses `ADD COLUMN IF NOT EXISTS` (re-runnable)
 *   - `down()` uses `DROP COLUMN IF EXISTS` in reverse order (LIFO)
 *   - No data loss risk on down — new columns only ever hold
 *     AI-derived metadata; the existing metric columns are preserved.
 *
 * Related tables NOT touched (separate contracts):
 *   - `ai_pre_submit_snapshots` — §17.4 snapshot-only staleness policy
 *     lives here; that table has its own `content_hash` / endpoint
 *     semantics and is out of scope for Wave 36.
 */
export class AddAiUsageLogDetailColumns1746086400000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "ai_usage_logs"
        ADD COLUMN IF NOT EXISTS "endpoint"              VARCHAR(64) DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS "summary_th"            TEXT        DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS "request_payload"       JSONB       DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS "response_payload"      JSONB       DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS "target_id"             UUID        DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS "target_kind"           VARCHAR(64) DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS "actor_work_history_id" UUID        DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS "duration_ms"           INTEGER     DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS "error"                 TEXT        DEFAULT NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverse order (LIFO). No indexes or FKs to drop first.
    await queryRunner.query(`
      ALTER TABLE "ai_usage_logs"
        DROP COLUMN IF EXISTS "error",
        DROP COLUMN IF EXISTS "duration_ms",
        DROP COLUMN IF EXISTS "actor_work_history_id",
        DROP COLUMN IF EXISTS "target_kind",
        DROP COLUMN IF EXISTS "target_id",
        DROP COLUMN IF EXISTS "response_payload",
        DROP COLUMN IF EXISTS "request_payload",
        DROP COLUMN IF EXISTS "summary_th",
        DROP COLUMN IF EXISTS "endpoint";
    `);
  }
}
