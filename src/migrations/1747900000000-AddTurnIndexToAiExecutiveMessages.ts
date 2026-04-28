import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: AddTurnIndexToAiExecutiveMessages — Wave 50 DB-W50-01.
 *
 * Adds a deterministic per-conversation monotonic counter column
 * `turn_index INTEGER NOT NULL` to `ai_executive_messages`, plus the
 * composite index `ix_ai_executive_messages_conversation_turn` on
 * `(conversation_id, turn_index)` that supports O(log N) sorted reads.
 *
 * Problem this solves
 * -------------------
 * Wave 48 (`BE-W48-01`) attempted to fix chat-turn ordering drift by
 * injecting `createdAt: new Date()` in every persist helper. That fix
 * works for the common case but has two production-observable gaps:
 *
 *   Gap A — Millisecond collision. JS `new Date()` resolves to ms. Two
 *   `repo.save()` calls that resolve within the same ms produce rows
 *   with identical `created_at`; the `ORDER BY created_at ASC, id ASC`
 *   tiebreaker then falls back to `id ASC`, which is UUID v4 (random).
 *   The user sees tool-result before its tool-call.
 *
 *   Gap B — `DISTINCT ON (conversation_id) ... ORDER BY created_at DESC`
 *   in the conversation-list preview can pick the wrong "last" row when
 *   `created_at` collides at the ms.
 *
 * The correct production fix is a single explicit integer that encodes
 * ordering intent deterministically. See RCA:
 *   `docs/reports/wave50/WAVE50_CHAT_PRODUCTION_HARDENING_RCA.md`
 *   §1 Concern 2 and §7.
 *
 * Backfill semantics
 * ------------------
 * Existing rows are backfilled using the legacy tuple:
 *
 *   row_number() OVER (
 *     PARTITION BY conversation_id
 *     ORDER BY created_at ASC, id ASC
 *   ) - 1
 *
 * so historical conversations remain coherent (the `turn_index = 0`
 * row is the oldest message in each conversation, and indices are
 * strictly increasing per conversation). Tiebreaking on `id ASC` is
 * accepted for the backfill ONLY — going forward, `turn_index` is
 * explicitly assigned by the service layer (BE-W50-01).
 *
 * Idempotency
 * -----------
 * The up migration uses `IF NOT EXISTS` / `IF EXISTS` guards on both
 * the column add and the index create, mirroring the
 * `BootstrapMigrationsService` DDL hook. A partially-applied run can
 * be safely re-run; a fully-applied run is a guaranteed no-op.
 *
 * Reversibility
 * -------------
 * Down migration drops the index first, then the column. No data is
 * lost on the forward path (the column is new); rollback cleanly
 * restores the pre-migration shape.
 *
 * CLAUDE.md compliance
 * --------------------
 *   - §17.3 Audit separation — adds an integer metadata column only.
 *     NO foreign key is introduced. The only FK on this table remains
 *     `conversation_id → ai_executive_conversations(id) ON DELETE
 *     CASCADE`, which pre-existed and is untouched by this migration.
 *   - §17.4 Snapshot-only — `staleness_policy` is UNTOUCHED. Chat
 *     continues to use `snapshot-only` with `isStale: false`.
 *   - §17.11 No role exemption — ordering is integrity, not a
 *     permission. No role (including super-admin) may coerce
 *     `turn_index` to a non-monotonic value; service-layer assignment
 *     is the single writer (BE-W50-01).
 *   - §12 — no `tracking_status` writes.
 */
export class AddTurnIndexToAiExecutiveMessages1747900000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1) Add the column nullable so we can backfill without violating
    //    NOT NULL on pre-existing rows. `IF NOT EXISTS` makes re-runs
    //    (and the bootstrap DDL hook) safe.
    await queryRunner.query(`
      ALTER TABLE "ai_executive_messages"
      ADD COLUMN IF NOT EXISTS "turn_index" INTEGER;
    `);

    // 2) Backfill with deterministic row_number over (created_at, id).
    //    Indices are 0-based per conversation (oldest row = 0). The
    //    WHERE guard keeps the backfill idempotent — once a row has
    //    been assigned a turn_index, a re-run leaves it untouched.
    await queryRunner.query(`
      UPDATE "ai_executive_messages" AS m
         SET "turn_index" = sub.rn - 1
        FROM (
          SELECT "id",
                 row_number() OVER (
                   PARTITION BY "conversation_id"
                   ORDER BY "created_at" ASC, "id" ASC
                 ) AS rn
            FROM "ai_executive_messages"
           WHERE "turn_index" IS NULL
        ) AS sub
       WHERE m."id" = sub."id"
         AND m."turn_index" IS NULL;
    `);

    // 3) Enforce NOT NULL now that every row has a meaningful value.
    //    ALTER ... SET NOT NULL is a no-op when already NOT NULL, so
    //    this statement is idempotent on its own.
    await queryRunner.query(`
      ALTER TABLE "ai_executive_messages"
      ALTER COLUMN "turn_index" SET NOT NULL;
    `);

    // 4) Composite index on (conversation_id, turn_index). This is the
    //    primary read path for hydration ORDER BY and for the preview
    //    DISTINCT ON query (BE-W50-01). Index name follows the
    //    existing `ix_ai_executive_messages_*` convention.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS
        "ix_ai_executive_messages_conversation_turn"
        ON "ai_executive_messages" ("conversation_id", "turn_index");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverse in strict LIFO order: drop index first, then column.
    await queryRunner.query(`
      DROP INDEX IF EXISTS "ix_ai_executive_messages_conversation_turn";
    `);
    await queryRunner.query(`
      ALTER TABLE "ai_executive_messages"
      DROP COLUMN IF EXISTS "turn_index";
    `);
  }
}
