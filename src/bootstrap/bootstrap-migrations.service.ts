import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * BootstrapMigrationsService — Wave 44 DB-W44-02.
 *
 * Purpose:
 *   Guarantee that a short, hard-coded catalog of corrective DDL lands
 *   in every environment (dev `synchronize: true`, staging, production)
 *   WITHOUT requiring operators to run `typeorm migration:run` manually.
 *
 *   Wave 44 RCA (`docs/reports/WAVE44_RUNTIME_FAILURE_RCA.md` §5, fix F3c)
 *   identified that the follow-up migration
 *   `1746259300000-FixAiExecutiveMessagesNullableColumns` never runs on
 *   dev (no migration wiring) and the base migration uses
 *   `CREATE TABLE IF NOT EXISTS`, so a dev DB carrying the older
 *   NOT NULL shape is never corrected. This service is the dev-path
 *   mirror of that migration.
 *
 * Design constraints (from `docs/tasks/wave44/DB-W44-02.md`):
 *   - Explicit allow-list ONLY. No reflection, no loading of the
 *     `src/migrations/` folder at runtime.
 *   - Idempotent. Every statement MUST be a no-op when the target
 *     schema already matches the desired shape. Postgres
 *     `ALTER COLUMN … DROP NOT NULL` on an already-nullable column is
 *     a no-op, so we can run unconditionally on each boot.
 *   - Fail-safe. On a truly fresh DB where the table does not yet
 *     exist (synchronize has not yet built it), `ALTER` raises
 *     `relation does not exist`. We catch, log at WARN, and continue —
 *     TypeORM's `synchronize` will create the table with the correct
 *     nullable shape on the same boot cycle.
 *   - MUST NOT throw. A crash-loop on startup is strictly worse than
 *     a request-time failure, so any error is swallowed.
 *
 * Governance (CLAUDE.md):
 *   - §17.3 Audit separation — statements change only column
 *     nullability on `ai_executive_messages`. No FK is introduced
 *     between the AI table and any project / plan / tracking table.
 *   - §17.11 No role exemption — this service runs during bootstrap,
 *     outside any request / role context. It does NOT gate workflow
 *     and does NOT override permissions.
 *   - §12 Audit Rule — no `TrackingStatus` writes.
 */
@Injectable()
export class BootstrapMigrationsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(BootstrapMigrationsService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /**
   * Allow-listed DDL catalog. Every entry MUST be idempotent on its
   * own — we do NOT rely on ordering semantics. New waves that need
   * corrective DDL MUST append here explicitly (no dynamic loading).
   */
  // Exposed for unit testing; safe to read but MUST NOT be mutated at
  // runtime. `readonly` on the tuple prevents append from callers.
  public static readonly STATEMENTS: ReadonlyArray<{
    readonly name: string;
    readonly sql: string;
  }> = [
    {
      name: 'ai_executive_messages.target_id DROP NOT NULL',
      sql: `ALTER TABLE "ai_executive_messages" ALTER COLUMN "target_id" DROP NOT NULL;`,
    },
    {
      name: 'ai_executive_messages.target_kind DROP NOT NULL',
      sql: `ALTER TABLE "ai_executive_messages" ALTER COLUMN "target_kind" DROP NOT NULL;`,
    },
    // WAVE-45 DB-W45-01 Option B — legacy sentinel backfill.
    //
    // Retroactively normalizes Wave 44 HOTFIX-W44-01 sentinel rows
    // (`target_id = '00000000-...' AND target_kind = 'project-group'
    // AND endpoint = 'executive-chat'`) to real NULLs so analytics /
    // reporting see a single shape post-BE-W45-01. Mirrors migration
    // `1747800000000-BackfillAiExecutiveMessagesSentinels.ts`.
    //
    // Safe to leave in perpetuity due to WHERE guard: once a legacy
    // row is normalized, `target_id` is NULL and the predicate no
    // longer matches. Re-running is a guaranteed no-op. §17.3 audit
    // separation preserved — field-value correction only, no row
    // delete, no FK introduced. §17.4 staleness_policy untouched.
    // §17.11 no role exemption — this runs outside any request
    // context and does NOT gate workflow.
    {
      name: 'ai_executive_messages legacy sentinel -> NULL backfill (DB-W45-01)',
      sql: `
        UPDATE "ai_executive_messages"
           SET "target_id"   = NULL,
               "target_kind" = NULL
         WHERE "target_id"   = '00000000-0000-0000-0000-000000000000'
           AND "target_kind" = 'project-group'
           AND "endpoint"    = 'executive-chat'
           AND "deleted_at"  IS NULL;
      `,
    },
    // WAVE-50 DB-W50-01 — `turn_index` column + composite index.
    //
    // Adds a deterministic per-conversation monotonic counter that
    // replaces the `(created_at ASC, id ASC)` tiebreak tuple. On dev
    // boxes that run `synchronize: true`, TypeORM creates the column
    // as NOT NULL with no default and then crashes on any pre-existing
    // row. These three statements add the column nullable, backfill
    // from row_number(), flip to NOT NULL, and create the composite
    // index — mirroring the migration `1747900000000-
    // AddTurnIndexToAiExecutiveMessages`.
    //
    // Idempotency:
    //   - ADD COLUMN IF NOT EXISTS is a no-op once applied
    //   - UPDATE is guarded by `turn_index IS NULL` so only
    //     un-backfilled rows are touched on subsequent boots (zero
    //     rows after the first boot)
    //   - SET NOT NULL is a no-op when already NOT NULL
    //   - CREATE INDEX IF NOT EXISTS is a no-op once applied
    //
    // §17.3 audit separation preserved — integer metadata only, NO FK
    // introduced. §17.11 no role exemption — ordering is integrity,
    // service layer (BE-W50-01) is the single writer.
    {
      name: 'ai_executive_messages.turn_index ADD COLUMN (DB-W50-01)',
      sql: `
        ALTER TABLE "ai_executive_messages"
        ADD COLUMN IF NOT EXISTS "turn_index" INTEGER;
      `,
    },
    {
      name: 'ai_executive_messages.turn_index BACKFILL (DB-W50-01)',
      sql: `
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
      `,
    },
    {
      name: 'ai_executive_messages.turn_index SET NOT NULL (DB-W50-01)',
      sql: `
        ALTER TABLE "ai_executive_messages"
        ALTER COLUMN "turn_index" SET NOT NULL;
      `,
    },
    {
      name: 'ai_executive_messages conversation_turn index (DB-W50-01)',
      sql: `
        CREATE INDEX IF NOT EXISTS
          "ix_ai_executive_messages_conversation_turn"
          ON "ai_executive_messages" ("conversation_id", "turn_index");
      `,
    },
    // WAVE-52 BE-W52-02 — Chat AI Decoupling bootstrap shim.
    //
    // Mirrors migration `1748000000000-DecoupleAiExecutiveMessages.ts`
    // (DB-W52-01). On a warm-boot against a legacy DB that still carries
    // the six dead columns inherited from `AbstractAiResult`, these
    // idempotent DROP statements converge the schema toward the
    // Wave 52 shape so that the decoupled entity (BE-W52-01) and the
    // service layer (BE-W52-03) observe a consistent column set.
    //
    // On a cold-boot against a fresh DB (or any DB where the migration
    // already ran), every statement becomes a no-op thanks to
    // `IF EXISTS` guards. synchronize: true will observe the shrunk
    // shape because the entity no longer declares those columns.
    //
    // Scope:
    //   - CHECK constraint `chk_ai_executive_messages_score_range` is
    //     dropped FIRST because it depends on `score_0_100`.
    //   - Six columns dropped: `score_0_100`, `band`, `result_json`,
    //     `computed_by_work_history_id`, `updated_at`, `staleness_policy`.
    //
    // IMPORTANT — enum type preservation:
    //   Enum types `ai_score_band` and `ai_staleness_policy` are NOT
    //   dropped. They remain in use by `ai_pre_submit_snapshots` (RF5)
    //   and `ai_staff_review_runs` (RF2). Dropping either type here
    //   would break unrelated AI result tables. See RCA §3 and
    //   DB-W52-01 QA §"Enum-drop Decision Rationale".
    //
    // §17.3 audit separation preserved — no FK added or removed on this
    // path; the existing `fk_ai_executive_messages_conversation` FK is
    // untouched. §17.4 staleness — per-row `staleness_policy` column
    // removal tightens enforcement to module-level (chat hard-codes
    // `isStale: false` via `toMessageDto`). §17.11 no role exemption —
    // schema-level integrity, unreachable from any request context.
    {
      name: 'ai_executive_messages DROP score_range CHECK (BE-W52-02)',
      sql: `
        ALTER TABLE IF EXISTS "ai_executive_messages"
        DROP CONSTRAINT IF EXISTS "chk_ai_executive_messages_score_range";
      `,
    },
    {
      name: 'ai_executive_messages DROP COLUMN score_0_100 (BE-W52-02)',
      sql: `
        ALTER TABLE IF EXISTS "ai_executive_messages"
        DROP COLUMN IF EXISTS "score_0_100";
      `,
    },
    {
      name: 'ai_executive_messages DROP COLUMN band (BE-W52-02)',
      sql: `
        ALTER TABLE IF EXISTS "ai_executive_messages"
        DROP COLUMN IF EXISTS "band";
      `,
    },
    {
      name: 'ai_executive_messages DROP COLUMN result_json (BE-W52-02)',
      sql: `
        ALTER TABLE IF EXISTS "ai_executive_messages"
        DROP COLUMN IF EXISTS "result_json";
      `,
    },
    {
      name: 'ai_executive_messages DROP COLUMN computed_by_work_history_id (BE-W52-02)',
      sql: `
        ALTER TABLE IF EXISTS "ai_executive_messages"
        DROP COLUMN IF EXISTS "computed_by_work_history_id";
      `,
    },
    {
      name: 'ai_executive_messages DROP COLUMN updated_at (BE-W52-02)',
      sql: `
        ALTER TABLE IF EXISTS "ai_executive_messages"
        DROP COLUMN IF EXISTS "updated_at";
      `,
    },
    {
      name: 'ai_executive_messages DROP COLUMN staleness_policy (BE-W52-02)',
      sql: `
        ALTER TABLE IF EXISTS "ai_executive_messages"
        DROP COLUMN IF EXISTS "staleness_policy";
      `,
    },
  ];

  async onApplicationBootstrap(): Promise<void> {
    // Defensive guard: if the DataSource is not initialized for any
    // reason (e.g. test harness stub), do not attempt to query.
    if (!this.dataSource?.isInitialized) {
      this.logger.warn(
        '[bootstrap] DataSource not initialized; skipping bootstrap DDL catalog.',
      );
      return;
    }

    for (const stmt of BootstrapMigrationsService.STATEMENTS) {
      try {
        await this.dataSource.query(stmt.sql);
        this.logger.log(`[bootstrap] applied: ${stmt.name}`);
      } catch (err) {
        // Table may not exist yet in a truly fresh DB (synchronize
        // has not yet built it). TypeORM will create the table with
        // the correct nullable shape on the same boot cycle, so the
        // corrective ALTER is unnecessary in that case. Log and
        // continue — NEVER rethrow.
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`[bootstrap] skipped ${stmt.name}: ${message}`);
      }
    }
  }
}
