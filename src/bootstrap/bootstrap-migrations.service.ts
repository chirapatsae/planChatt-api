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
    // Wave Equipment ผ.03 Phase 2 — BE-06 (2026-05-28).
    //
    // Widen the shared `ai_target_kind` enum to accept the new
    // `'equipment-project-group'` value used by §17.4 baseline writes
    // from `EquipmentProjectGroupService.create` and the owner / staff
    // read paths in `PreSubmitSnapshotService`.
    //
    // Mirrors migration `1781000000000-EquipmentAiWidenTargetKind.ts`
    // for dev boxes that run `synchronize: true` without the migration
    // runner (TypeORM does NOT mutate enum values on synchronize per
    // user-memory `project_typeorm_synchronize.md`).
    //
    // `ALTER TYPE ... ADD VALUE` cannot run inside a transaction block.
    // `dataSource.query(...)` issues the statement on the default
    // connection without an explicit BEGIN, so it lands successfully
    // here. `IF NOT EXISTS` makes the statement an unconditional no-op
    // on subsequent boots.
    //
    // §17.3 audit separation preserved — no FK introduced. §17.11 no
    // role exemption — schema-level integrity, unreachable from any
    // request context.
    {
      name: 'ai_target_kind ADD VALUE equipment-project-group (BE-06)',
      sql: `ALTER TYPE "ai_target_kind" ADD VALUE IF NOT EXISTS 'equipment-project-group';`,
    },
    // Wave Equipment Revision Management — BE-01 (Phase 3).
    //
    // Widen the shared `ai_target_kind` enum to accept the new
    // `'revised-equipment-project-group'` value used by the §17.4
    // baseline write from `RevisedEquipmentProjectGroupService` (submit:
    // Ready → Pending) and the owner / staff read paths in
    // `PreSubmitSnapshotService`.
    //
    // Mirrors migration `1782400000000-RevisedEquipmentAiWidenTargetKind.ts`
    // for dev boxes that run `synchronize: true` without the migration
    // runner. `IF NOT EXISTS` makes the statement a no-op on subsequent
    // boots. §17.3 audit separation preserved — no FK introduced.
    {
      name: 'ai_target_kind ADD VALUE revised-equipment-project-group (Phase 3 BE-01)',
      sql: `ALTER TYPE "ai_target_kind" ADD VALUE IF NOT EXISTS 'revised-equipment-project-group';`,
    },
    // Wave wave-supplement-equipment-por03 — BE-B1 (2026-06-08).
    //
    // Widen the shared `ai_target_kind` enum to accept the new
    // `'supplement-equipment-project-group'` value used by the §17.4
    // baseline write from `SupplementEquipmentProjectGroupService.create`
    // (publish: Ready → Pending) and the owner / staff read paths in
    // `PreSubmitSnapshotService`.
    //
    // Mirrors migration `1782900000000-SupplementEquipmentAiWidenTargetKind.ts`
    // for dev boxes that run `synchronize: true` without the migration
    // runner. `IF NOT EXISTS` makes the statement a no-op on subsequent
    // boots. §17.3 audit separation preserved — no FK introduced.
    {
      name: 'ai_target_kind ADD VALUE supplement-equipment-project-group (BE-B1)',
      sql: `ALTER TYPE "ai_target_kind" ADD VALUE IF NOT EXISTS 'supplement-equipment-project-group';`,
    },
    // Wave wave-citizen-social-platform — W-GATE-1 (2026-06-25).
    //
    // §10 (APPROVED) permits follow-a-person. The C3 migration
    // (1784000000000-CitizenFollowNotification) installed the CHECK
    // `ck_citizen_follow_kind` restricting `target_kind` to
    // ('amphoe','category') — the pre-§10 D11 forbid. This widens it to
    // also allow 'person'. Mirrors migration
    // `1784500000000-CitizenFollowPersonKind.ts` for dev boxes that run
    // `synchronize: true` without the migration runner (synchronize does
    // NOT alter existing CHECK constraints — user-memory
    // `project_typeorm_synchronize.md`).
    //
    // Idempotent: DROP IF EXISTS + ADD converges the CHECK on every boot.
    // On a fresh dev DB where the C3 CHECK was never created (synchronize
    // does not emit it), the DROP is a no-op and the ADD installs the
    // widened CHECK. §17.3 isolation preserved — no FK introduced, the
    // CHECK lives on `citizen_follow` only; `target_key` for 'person' is a
    // plain uuid (NOT a new FK). §17.11 no role exemption.
    {
      name: 'citizen_follow widen ck_citizen_follow_kind to include person — DROP (W-GATE-1)',
      sql: `ALTER TABLE IF EXISTS "citizen_follow" DROP CONSTRAINT IF EXISTS "ck_citizen_follow_kind";`,
    },
    {
      name: 'citizen_follow widen ck_citizen_follow_kind to include person — ADD (W-GATE-1)',
      sql: `ALTER TABLE IF EXISTS "citizen_follow" ADD CONSTRAINT "ck_citizen_follow_kind" CHECK ("target_kind" IN ('amphoe','category','person'));`,
    },
    // Wave wave-citizen-social-platform — W-G1 PDPA DSAR (2026-06-26).
    //
    // Account erasure sets `citizen_identities.status = 'deleted'`. The M0
    // CHECK `ck_citizen_identity_status` (1782000000000-CitizenEngagementInit)
    // allowed only ('active','blocked') — widen to also allow 'deleted' so the
    // erase transaction does not violate the CHECK on prod boxes (synchronize
    // does NOT alter CHECKs; dev fresh boxes never had it). Idempotent DROP+ADD.
    // §17.3 isolation preserved (no FK; CHECK lives on citizen_identities only).
    {
      name: 'citizen_identities widen ck_citizen_identity_status to include deleted — DROP (W-G1)',
      sql: `ALTER TABLE IF EXISTS "citizen_identities" DROP CONSTRAINT IF EXISTS "ck_citizen_identity_status";`,
    },
    {
      name: 'citizen_identities widen ck_citizen_identity_status to include deleted — ADD (W-G1)',
      sql: `ALTER TABLE IF EXISTS "citizen_identities" ADD CONSTRAINT "ck_citizen_identity_status" CHECK ("status" IN ('active','blocked','deleted'));`,
    },
    // Wave wave-citizen-social-platform — W-T3 moderation v2 (2026-06-26).
    //
    // (1) The offender ladder sets `citizen_identities.status = 'suspended'` when
    // staff remove N posts of an author. Widen the CHECK (already W-G1-widened to
    // include 'deleted') to also allow 'suspended' so the suspend transaction does
    // not violate the CHECK on prod boxes (synchronize does NOT alter CHECKs).
    // Idempotent DROP+ADD; mirrors the W-G1 'deleted' widening above.
    {
      name: 'citizen_identities widen ck_citizen_identity_status to include suspended — DROP (W-T3)',
      sql: `ALTER TABLE IF EXISTS "citizen_identities" DROP CONSTRAINT IF EXISTS "ck_citizen_identity_status";`,
    },
    {
      name: 'citizen_identities widen ck_citizen_identity_status to include suspended — ADD (W-T3)',
      sql: `ALTER TABLE IF EXISTS "citizen_identities" ADD CONSTRAINT "ck_citizen_identity_status" CHECK ("status" IN ('active','blocked','deleted','suspended'));`,
    },
    // (2) The appeal-uphold + offender suspend/reinstate paths write new
    // `citizen_moderation_log.action` values. The M0 CHECK
    // (1782000000000-CitizenEngagementInit) allowed only
    // ('report','hide','remove','restore','block_author') — widen it to also allow
    // 'appeal_uphold','suspend_author','reinstate_author' so those log writes do
    // not violate the CHECK on prod boxes. Idempotent DROP+ADD.
    {
      name: 'citizen_moderation_log widen ck_citizen_moderation_action for W-T3 — DROP (W-T3)',
      sql: `ALTER TABLE IF EXISTS "citizen_moderation_log" DROP CONSTRAINT IF EXISTS "ck_citizen_moderation_action";`,
    },
    {
      name: 'citizen_moderation_log widen ck_citizen_moderation_action for W-T3 — ADD (W-T3)',
      sql: `ALTER TABLE IF EXISTS "citizen_moderation_log" ADD CONSTRAINT "ck_citizen_moderation_action" CHECK ("action" IN ('report','hide','remove','restore','block_author','appeal_uphold','suspend_author','reinstate_author'));`,
    },
    // Wave wave-citizen-social-platform — W-G2 official-response v2 (2026-06-26).
    //
    // C4 added the `status` + `status_updated_at` columns to
    // `citizen_official_response` (issue-handling lifecycle). `synchronize: true`
    // adds the columns but does NOT emit the value CHECK; install
    // `ck_citizen_official_response_status` here so the lifecycle values are
    // constrained on prod boxes (fresh dev boxes never had it). Idempotent
    // DROP+ADD; mirrors the W-G1 / W-T3 widenings above. §17.3 isolation
    // preserved — no FK; the CHECK lives on citizen_official_response only.
    // §17.2 advisory — this is the citizen issue-handling state, not a project
    // workflow status. §17.11 no role exemption.
    {
      name: 'citizen_official_response add ck_citizen_official_response_status — DROP (W-G2)',
      sql: `ALTER TABLE IF EXISTS "citizen_official_response" DROP CONSTRAINT IF EXISTS "ck_citizen_official_response_status";`,
    },
    {
      name: 'citizen_official_response add ck_citizen_official_response_status — ADD (W-G2)',
      sql: `ALTER TABLE IF EXISTS "citizen_official_response" ADD CONSTRAINT "ck_citizen_official_response_status" CHECK ("status" IN ('received','in_progress','resolved'));`,
    },
    // W-G2 latent-C4-defect fix: `citizen_notification.kind = 'official_response'`
    // (17 chars) overflowed the M0 `varchar(16)` column. Never triggered until
    // the W-G2 status-change notify (no official responses had ever been
    // created). Widen to 32. Idempotent — `ALTER COLUMN … TYPE` to the same
    // width is a no-op; widening never truncates. §17.3 preserved (length only).
    {
      name: 'citizen_notification widen kind to varchar(32) for official_response (W-G2)',
      sql: `ALTER TABLE IF EXISTS "citizen_notification" ALTER COLUMN "kind" TYPE varchar(32);`,
    },
    // Wave wave-citizen-social-platform — W-S6 @mention (2026-06-26).
    //
    // The W-S6 mention-notify path writes `citizen_notification.kind = 'mention'`.
    // The notification-kind CHECK was created in C3 as ('comment','heart') and
    // widened by C4 to add 'official_response'. Widen it to ALSO admit 'mention'
    // so the mention notify-write does not violate the CHECK on prod boxes
    // (synchronize does NOT alter existing CHECK constraints — user-memory
    // `project_typeorm_synchronize.md`). Idempotent DROP+ADD; re-asserts the full
    // set so it converges regardless of which prior widening last ran. Mirrors the
    // W-T3 status/action widenings above. §17.3 isolation preserved — no FK; the
    // CHECK lives on citizen_notification only. §17.2 advisory.
    {
      name: 'citizen_notification widen ck_citizen_notification_kind to include mention — DROP (W-S6)',
      sql: `ALTER TABLE IF EXISTS "citizen_notification" DROP CONSTRAINT IF EXISTS "ck_citizen_notification_kind";`,
    },
    {
      name: 'citizen_notification widen ck_citizen_notification_kind to include mention — ADD (W-S6)',
      sql: `ALTER TABLE IF EXISTS "citizen_notification" ADD CONSTRAINT "ck_citizen_notification_kind" CHECK ("kind" IN ('comment','heart','official_response','mention'));`,
    },

    // ===================================================================
    // AUTH-REDESIGN (2026-07-08) — remove ThaID, member login + Google.
    // See docs/AUTH-REDESIGN.md §3. All statements idempotent:
    //   - DROP NOT NULL on an already-nullable column is a no-op.
    //   - ADD COLUMN IF NOT EXISTS is a no-op after synchronize.
    //   - CREATE UNIQUE INDEX IF NOT EXISTS is a no-op once present.
    // §17.3 isolation preserved — no cross-table FK added. No workflow
    // gate touched (§17.11).
    // ===================================================================

    // P1a — `users.citizen_id` / `citizen_id_hash` no longer come from
    // ThaID; admin-created members have NO national ID. Drop NOT NULL so
    // NULL rows can be inserted. Postgres UNIQUE allows multiple NULLs,
    // so the existing unique constraints are safe to keep.
    {
      name: 'users.citizen_id DROP NOT NULL (AUTH-REDESIGN §3.1)',
      sql: `ALTER TABLE IF EXISTS "users" ALTER COLUMN "citizen_id" DROP NOT NULL;`,
    },
    {
      name: 'users.citizen_id_hash DROP NOT NULL (AUTH-REDESIGN §3.1)',
      sql: `ALTER TABLE IF EXISTS "users" ALTER COLUMN "citizen_id_hash" DROP NOT NULL;`,
    },

    // P1b — PDPA consent anchors on `users`.
    {
      name: 'users.consent_version ADD COLUMN (AUTH-REDESIGN §6)',
      sql: `ALTER TABLE IF EXISTS "users" ADD COLUMN IF NOT EXISTS "consent_version" varchar(32);`,
    },
    {
      name: 'users.consent_at ADD COLUMN (AUTH-REDESIGN §6)',
      sql: `ALTER TABLE IF EXISTS "users" ADD COLUMN IF NOT EXISTS "consent_at" timestamptz;`,
    },

    // P1c — citizen email/password + Google columns.
    // `thaid_sub_hash` was NOT NULL in the ThaID era; email/Google identities
    // carry no ThaID sub, so drop the constraint (existing rows keep values).
    {
      name: 'citizen_identities.thaid_sub_hash DROP NOT NULL (AUTH-REDESIGN §3.2)',
      sql: `ALTER TABLE IF EXISTS "citizen_identities" ALTER COLUMN "thaid_sub_hash" DROP NOT NULL;`,
    },
    {
      name: 'citizen_identities.email_enc ADD COLUMN (AUTH-REDESIGN §3.2)',
      sql: `ALTER TABLE IF EXISTS "citizen_identities" ADD COLUMN IF NOT EXISTS "email_enc" varchar(512);`,
    },
    {
      name: 'citizen_identities.email_hash ADD COLUMN (AUTH-REDESIGN §3.2)',
      sql: `ALTER TABLE IF EXISTS "citizen_identities" ADD COLUMN IF NOT EXISTS "email_hash" varchar(64);`,
    },
    {
      name: 'citizen_identities.password_hash ADD COLUMN (AUTH-REDESIGN §3.2)',
      sql: `ALTER TABLE IF EXISTS "citizen_identities" ADD COLUMN IF NOT EXISTS "password_hash" varchar(512);`,
    },
    {
      name: 'citizen_identities.google_sub_hash ADD COLUMN (AUTH-REDESIGN §3.2)',
      sql: `ALTER TABLE IF EXISTS "citizen_identities" ADD COLUMN IF NOT EXISTS "google_sub_hash" varchar(64);`,
    },
    {
      name: 'citizen_identities.email_verified_at ADD COLUMN (AUTH-REDESIGN §3.2)',
      sql: `ALTER TABLE IF EXISTS "citizen_identities" ADD COLUMN IF NOT EXISTS "email_verified_at" timestamptz;`,
    },
    {
      name: 'citizen_identities.auth_provider ADD COLUMN (AUTH-REDESIGN §3.2)',
      sql: `ALTER TABLE IF EXISTS "citizen_identities" ADD COLUMN IF NOT EXISTS "auth_provider" varchar(16) DEFAULT 'password';`,
    },
    // Partial-unique indexes: only one active citizen per email / Google sub.
    {
      name: 'citizen_identities.email_hash partial-unique (AUTH-REDESIGN §3.2)',
      sql: `CREATE UNIQUE INDEX IF NOT EXISTS "uq_citizen_identities_email_hash" ON "citizen_identities" ("email_hash") WHERE "email_hash" IS NOT NULL;`,
    },
    {
      name: 'citizen_identities.google_sub_hash partial-unique (AUTH-REDESIGN §3.2)',
      sql: `CREATE UNIQUE INDEX IF NOT EXISTS "uq_citizen_identities_google_sub_hash" ON "citizen_identities" ("google_sub_hash") WHERE "google_sub_hash" IS NOT NULL;`,
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
