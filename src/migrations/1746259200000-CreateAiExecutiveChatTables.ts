import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: CreateAiExecutiveChatTables
 *
 * Wave 44 DB-W44-01 — schema foundation for the Executive AI Chat
 * Assistant. Creates the two new tables plus one new enum:
 *
 *   1. `ai_chat_role` enum       (user | assistant | tool | system)
 *   2. `ai_executive_conversations` table
 *   3. `ai_executive_messages` table (extends `AbstractAiResult` shape)
 *
 * Depends on the N1 foundation migration
 * `1745366400000-CreateAiResultFoundation.ts` for the shared enum types
 * `ai_target_kind`, `ai_score_band`, `ai_staleness_policy`.
 *
 * CLAUDE.md references:
 *
 *   - §17.3 Audit separation (CRITICAL). Neither new table carries a
 *     foreign key to `project_groups`, `revised_project_groups`,
 *     `supplement_project_groups`, `development_plans`,
 *     `development_plan_revisions`, `development_plan_supplements`,
 *     `tracking_status`, or `work_histories`. The only FK in this
 *     migration is intra-AI: `ai_executive_messages.conversation_id`
 *     REFERENCES `ai_executive_conversations(id) ON DELETE CASCADE`.
 *     This guarantees that §14.6 rollback hard-deletes and §15 book
 *     unlock events NEVER cascade into chat history.
 *
 *   - §17.4 Staleness model. Chat messages are point-in-time
 *     photographs — `staleness_policy` defaults to `'snapshot-only'`.
 *     The read-side envelope MUST force `isStale: false` per §17.4
 *     `snapshot-only` semantics.
 *
 *   - §17.11 No role exemption. The schema is an integrity guarantee;
 *     no role (including super-admin) may bypass it.
 *
 *   - §4 Ownership. `owner_work_history_id` is a plain uuid without FK
 *     so audit rows survive hypothetical WorkHistory mutations. Service
 *     layer (BE-W44-02) enforces per-query owner scoping.
 *
 * Rollback safety:
 *   - Down migration drops indexes + tables in strict LIFO order, then
 *     the local `ai_chat_role` enum.
 *   - Foundation enums (`ai_target_kind`, `ai_score_band`,
 *     `ai_staleness_policy`) are OWNED by the N1 foundation migration
 *     and MUST NOT be dropped here.
 */
export class CreateAiExecutiveChatTables1746259200000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Local enum: ai_chat_role (CLAUDE.md §17 DB-W44-01 scope) ────────
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_type WHERE typname = 'ai_chat_role'
        ) THEN
          CREATE TYPE "ai_chat_role" AS ENUM (
            'user',
            'assistant',
            'tool',
            'system'
          );
        END IF;
      END$$;
    `);

    // ── Table: ai_executive_conversations ───────────────────────────────
    // NOTE (§17.3): `owner_work_history_id` is a plain uuid — NO FK.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "ai_executive_conversations" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "owner_work_history_id" uuid NOT NULL,
        "title" varchar(200) NOT NULL DEFAULT 'บทสนทนาใหม่',
        "model" varchar(64) NOT NULL DEFAULT 'gpt-4o',
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NULL,
        "deleted_at" TIMESTAMP WITH TIME ZONE NULL,
        CONSTRAINT "pk_ai_executive_conversations" PRIMARY KEY ("id")
      );
    `);

    // Partial index — owner's active conversation list ordered by recency.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS
        "ix_ai_executive_conversations_owner_updated"
      ON "ai_executive_conversations"
        ("owner_work_history_id", "updated_at" DESC)
      WHERE "deleted_at" IS NULL;
    `);

    // ── Table: ai_executive_messages ────────────────────────────────────
    // Shape mirrors `AbstractAiResult` (target_id, target_kind,
    // content_hash, computed_at, result_json, score_0_100, band,
    // staleness_policy, model, endpoint, timestamps) and adds the
    // chat-specific columns.
    //
    // NOTE (§17.3): `target_id` is a plain uuid — NO FK. The ONLY FK
    // is intra-AI: `conversation_id` REFERENCES
    // `ai_executive_conversations(id) ON DELETE CASCADE`.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "ai_executive_messages" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "conversation_id" uuid NOT NULL,
        "role" "ai_chat_role" NOT NULL,
        "content_text" text NULL,
        "tool_calls_json" jsonb NULL,
        "tool_name" varchar(64) NULL,
        "tool_result_json" jsonb NULL,
        "tokens_in" integer NULL,
        "tokens_out" integer NULL,
        "target_kind" "ai_target_kind" NULL,
        "target_id" uuid NULL,
        "content_hash" varchar(64) NOT NULL,
        "computed_by_work_history_id" uuid NULL,
        "result_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "score_0_100" integer NULL,
        "band" "ai_score_band" NULL,
        "staleness_policy" "ai_staleness_policy"
          NOT NULL DEFAULT 'snapshot-only',
        "model" varchar(128) NOT NULL DEFAULT 'gpt-4o',
        "endpoint" varchar(256) NOT NULL DEFAULT 'executive-chat',
        "computed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NULL,
        "deleted_at" TIMESTAMP WITH TIME ZONE NULL,
        CONSTRAINT "pk_ai_executive_messages" PRIMARY KEY ("id"),
        CONSTRAINT "fk_ai_executive_messages_conversation"
          FOREIGN KEY ("conversation_id")
          REFERENCES "ai_executive_conversations" ("id")
          ON DELETE CASCADE,
        CONSTRAINT "chk_ai_executive_messages_score_range"
          CHECK ("score_0_100" IS NULL
                 OR ("score_0_100" >= 0 AND "score_0_100" <= 100))
      );
    `);

    // ── Indexes ─────────────────────────────────────────────────────────
    // Chat transcript order — ascending by created_at within a conversation.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS
        "ix_ai_executive_messages_conversation_created"
      ON "ai_executive_messages"
        ("conversation_id", "created_at" ASC);
    `);

    // Idempotency / hash lookup scoped by conversation.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS
        "ix_ai_executive_messages_conversation_hash"
      ON "ai_executive_messages" ("conversation_id", "content_hash");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // LIFO — drop child indexes + table, then parent index + table,
    // then the local enum. Foundation enums are intentionally NOT
    // dropped here (owned by 1745366400000-CreateAiResultFoundation).
    await queryRunner.query(`
      DROP INDEX IF EXISTS "ix_ai_executive_messages_conversation_hash";
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "ix_ai_executive_messages_conversation_created";
    `);
    await queryRunner.query(`
      DROP TABLE IF EXISTS "ai_executive_messages";
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "ix_ai_executive_conversations_owner_updated";
    `);
    await queryRunner.query(`
      DROP TABLE IF EXISTS "ai_executive_conversations";
    `);
    await queryRunner.query(`
      DROP TYPE IF EXISTS "ai_chat_role";
    `);
  }
}
