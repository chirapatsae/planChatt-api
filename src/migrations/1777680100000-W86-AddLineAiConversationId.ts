import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: W86AddLineAiConversationId — Wave 86 W86-BE-LINE-AI-BRIDGE.
 *
 * Adds `line_ai_conversation_id` (uuid, nullable) to `line_user_bindings`
 * so the LINE bridge can look up — in a single indexed read — the
 * persistent `ai_executive_conversations` row that LINE messages from a
 * bound user stream into.
 *
 * Rationale (deferred to entity JSDoc for the long-form):
 *   - `ai_executive_conversations` does NOT carry a `channel` discriminator
 *     column. Storing the LINE-channel mapping on the binding row avoids
 *     touching the FK-isolated `ai_*` boundary (§17.3 audit separation).
 *   - Lookup is `lineUserId → binding → conversationId` on one indexed
 *     read; no JOIN from the webhook hot path into the AI module.
 *
 * CLAUDE.md references:
 *   - §17.3 Audit separation. NO FK to `ai_executive_conversations` is
 *     added — the column is plain UUID metadata. The AI module's
 *     audit-isolation invariant (no FK from outside the `ai_*` boundary
 *     into AI tables, and no FK from AI tables into project tables)
 *     remains intact in BOTH directions.
 *   - §17.11 No role exemption. The column is integrity metadata, not a
 *     permission. No role can coerce a write that violates the
 *     conversation ownership scope (the LineAiBridgeService enforces
 *     `ownerWorkHistoryId === binding.user.currentWorkHistory.id` at
 *     create time).
 *   - §12 Audit Rule. No `tracking_status` writes — bindings are NOT a
 *     workflow status.
 *
 * Idempotency:
 *   - `ADD COLUMN IF NOT EXISTS` guards `up()` against partial-apply
 *     re-runs.
 *
 * Reversibility:
 *   - `down()` drops the column. Any LINE bridge state stored here is
 *     transient (a fresh conversation is created on next message), so
 *     dropping the column is safe — the worst-case effect is one
 *     duplicate empty conversation per active LINE user, which the AI
 *     PDPA cron will sweep on the standard retention schedule.
 */
export class W86AddLineAiConversationId1777680100000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "line_user_bindings"
      ADD COLUMN IF NOT EXISTS "line_ai_conversation_id" uuid NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "line_user_bindings"
      DROP COLUMN IF EXISTS "line_ai_conversation_id";
    `);
  }
}
