import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: DecoupleAiExecutiveMessages — Wave 52 DB-W52-01.
 *
 * Thin decouple ("Option B") of `ai_executive_messages` from the shared
 * `AbstractAiResult` shape. This migration drops the six columns that are
 * documented as dead weight by the Wave 52 architecture RCA, plus the
 * score-range CHECK constraint that depends on `score_0_100`. The table
 * name, historical row contents, all chat-owned columns, all Wave 45/50/51
 * additions, the sole FK (`conversation_id` → `ai_executive_conversations`,
 * intra-AI only), and every existing index are preserved.
 *
 * Dropped (in UP order, CHECK first):
 *   - CHECK constraint `chk_ai_executive_messages_score_range`
 *   - Column  `score_0_100`             (int NULL)
 *   - Column  `band`                    (ai_score_band NULL)
 *   - Column  `result_json`             (jsonb NOT NULL DEFAULT '{}')
 *   - Column  `computed_by_work_history_id` (uuid NULL)
 *   - Column  `updated_at`              (timestamptz NULL)
 *   - Column  `staleness_policy`        (ai_staleness_policy NOT NULL
 *                                         DEFAULT 'snapshot-only')
 *
 * Preserved (NOT touched by this migration):
 *   - id, conversation_id, turn_index (Wave 50), role, content_text,
 *     tool_calls_json, tool_name, tool_result_json, tokens_in, tokens_out,
 *     target_id, target_kind (Wave 44 HOTFIX + Wave 45 backfill),
 *     content_hash, model, endpoint, computed_at, created_at, deleted_at.
 *   - Indexes: ix_ai_executive_messages_conversation_created,
 *     ix_ai_executive_messages_conversation_hash,
 *     ix_ai_executive_messages_conversation_turn.
 *   - FK fk_ai_executive_messages_conversation (§17.3 intra-AI only).
 *
 * Post-up shape: 18 columns.
 *
 * Rationale & full column inventory:
 *   docs/reports/wave52/WAVE52_CHAT_AI_DECOUPLING_RCA.md §1, §5, §8
 *   docs/tasks/wave52/DB-W52-01.md §3, §8
 *
 * Enum preservation
 * -----------------
 * The enum types `ai_score_band` and `ai_staleness_policy` are OWNED by
 * the N1 foundation migration `1745366400000-CreateAiResultFoundation.ts`
 * and are ALSO in use by `ai_pre_submit_snapshots` (RF5) and
 * `ai_staff_review_runs` (RF2). This migration MUST NOT drop either enum
 * type — doing so would take down unrelated AI result tables. Only the
 * columns on `ai_executive_messages` are dropped; the enum types remain.
 *
 * Reversibility
 * -------------
 * `down()` re-creates the six columns with their Wave 44 original
 * defaults + the score-range CHECK. Historical data for the dropped
 * columns is NOT restored — per RCA §1 the payloads were never
 * meaningful (`result_json` was always `{}`, `score_0_100` / `band` /
 * `computed_by_work_history_id` were always NULL, `updated_at` was never
 * written because the table is append-only, `staleness_policy` was
 * always the default `'snapshot-only'`). The shape is restored; the
 * non-information those columns carried is not.
 *
 * Idempotency
 * -----------
 * Every statement uses `DROP ... IF EXISTS` / `ADD COLUMN IF NOT EXISTS`
 * / `DROP CONSTRAINT IF EXISTS`. `up()` is safe to run against:
 *   - a fresh DB bootstrapped through Wave 44-51 (columns present → dropped)
 *   - a DB already at Wave 52 shape (columns absent → no-op)
 *   - a partially-applied Wave 52 state (mixed → converges)
 * `down()` is similarly safe against any state between the two shapes.
 *
 * CLAUDE.md compliance
 * --------------------
 *   - §12 Audit separation — no `tracking_status` mutation; chat never
 *     wrote to that table and this migration does not change that.
 *   - §17.3 Audit separation / FK isolation — NO new foreign key is
 *     introduced. The sole FK on this table
 *     (`fk_ai_executive_messages_conversation`, intra-AI) is untouched.
 *     `target_id` remains a plain-uuid analytics metadata column with
 *     NO FK — §17.3 explicitly forbids referential integrity into
 *     project/plan tables and that invariant is preserved.
 *   - §17.4 Staleness — dropping the per-row `staleness_policy` column
 *     converts §17.4 enforcement from per-row to MODULE-LEVEL. The
 *     read-side hard-codes `isStale: false` on every served row in
 *     `toMessageDto`, and BE-W52-03 will add an explicit module-level
 *     invariant constant. Per-row expression of the policy is now
 *     IMPOSSIBLE (the column does not exist), which is strictly tighter
 *     enforcement than a column that always carried the same default.
 *     Wave 46 HOTFIX `target_id` / `target_kind` nullability is preserved
 *     — neither column is touched by this migration.
 *   - §17.11 No role exemption — schema integrity; no role (including
 *     super-admin) can restore the dropped columns at runtime. A restore
 *     requires running `down()`.
 */
export class DecoupleAiExecutiveMessages1748000000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1) CHECK constraint first — it references `score_0_100`, so it
    //    MUST be dropped before the column underneath it.
    await queryRunner.query(`
      ALTER TABLE "ai_executive_messages"
      DROP CONSTRAINT IF EXISTS "chk_ai_executive_messages_score_range";
    `);

    // 2) Dead column: score_0_100 (int NULL). Never written by chat.
    await queryRunner.query(`
      ALTER TABLE "ai_executive_messages"
      DROP COLUMN IF EXISTS "score_0_100";
    `);

    // 3) Dead column: band (ai_score_band NULL). Never written by chat.
    //    Enum TYPE is NOT dropped — still in use by ai_pre_submit_snapshots
    //    and ai_staff_review_runs.
    await queryRunner.query(`
      ALTER TABLE "ai_executive_messages"
      DROP COLUMN IF EXISTS "band";
    `);

    // 4) Dead column: result_json (jsonb NOT NULL DEFAULT '{}').
    //    Always written as `{}`; no reader projects it.
    await queryRunner.query(`
      ALTER TABLE "ai_executive_messages"
      DROP COLUMN IF EXISTS "result_json";
    `);

    // 5) Dead column: computed_by_work_history_id (uuid NULL). Always NULL.
    //    §17.3-friendly: had no FK anyway.
    await queryRunner.query(`
      ALTER TABLE "ai_executive_messages"
      DROP COLUMN IF EXISTS "computed_by_work_history_id";
    `);

    // 6) Dead column: updated_at (timestamptz NULL). Chat is append-only;
    //    soft-delete goes through deleted_at, not updated_at.
    await queryRunner.query(`
      ALTER TABLE "ai_executive_messages"
      DROP COLUMN IF EXISTS "updated_at";
    `);

    // 7) Dead column: staleness_policy (ai_staleness_policy NOT NULL
    //    DEFAULT 'snapshot-only'). §17.4 enforcement migrates to
    //    module-level (BE-W52-03). Enum TYPE is NOT dropped — still in
    //    use by ai_pre_submit_snapshots and ai_staff_review_runs.
    await queryRunner.query(`
      ALTER TABLE "ai_executive_messages"
      DROP COLUMN IF EXISTS "staleness_policy";
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // LIFO — re-add columns in the reverse of the UP drop order, then
    // restore the CHECK constraint last (it depends on `score_0_100`).
    // Defaults match the Wave 44 base migration byte-for-byte.

    // 7') Restore staleness_policy. Enum type pre-exists (owned by the
    //     foundation migration); no CREATE TYPE needed here.
    await queryRunner.query(`
      ALTER TABLE "ai_executive_messages"
      ADD COLUMN IF NOT EXISTS "staleness_policy" "ai_staleness_policy"
        NOT NULL DEFAULT 'snapshot-only';
    `);

    // 6') Restore updated_at. Nullable, no default (matches Wave 44).
    await queryRunner.query(`
      ALTER TABLE "ai_executive_messages"
      ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMP WITH TIME ZONE NULL;
    `);

    // 5') Restore computed_by_work_history_id. uuid NULL, no FK (§17.3).
    await queryRunner.query(`
      ALTER TABLE "ai_executive_messages"
      ADD COLUMN IF NOT EXISTS "computed_by_work_history_id" uuid NULL;
    `);

    // 4') Restore result_json. NOT NULL DEFAULT '{}'::jsonb.
    await queryRunner.query(`
      ALTER TABLE "ai_executive_messages"
      ADD COLUMN IF NOT EXISTS "result_json" jsonb
        NOT NULL DEFAULT '{}'::jsonb;
    `);

    // 3') Restore band (ai_score_band NULL). Enum type pre-exists.
    await queryRunner.query(`
      ALTER TABLE "ai_executive_messages"
      ADD COLUMN IF NOT EXISTS "band" "ai_score_band" NULL;
    `);

    // 2') Restore score_0_100 (int NULL).
    await queryRunner.query(`
      ALTER TABLE "ai_executive_messages"
      ADD COLUMN IF NOT EXISTS "score_0_100" integer NULL;
    `);

    // 1') Restore CHECK constraint last. Guarded against accidental
    //     re-adds via DROP + ADD pattern so the re-creation is idempotent.
    await queryRunner.query(`
      ALTER TABLE "ai_executive_messages"
      DROP CONSTRAINT IF EXISTS "chk_ai_executive_messages_score_range";
    `);
    await queryRunner.query(`
      ALTER TABLE "ai_executive_messages"
      ADD CONSTRAINT "chk_ai_executive_messages_score_range"
        CHECK ("score_0_100" IS NULL
               OR ("score_0_100" >= 0 AND "score_0_100" <= 100));
    `);
  }
}
