import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: W97NotificationOpsSchema (Wave 97 / W97-MIGRATION).
 *
 * Ships three schema changes in a single migration to support the LINE
 * notification operations surface (force-unlink + reveal admin actions,
 * per-channel quota alerts, and per-channel notification settings audit):
 *
 *   1. NEW table `line_binding_admin_actions` — audit trail for
 *      admin force-unlink and reveal actions on LINE bindings.
 *   2. NEW table `notification_quota_alerts` — configurable threshold
 *      alerts for email + LINE notification quotas (OpenAI org-budget
 *      style UX).
 *   3. ALTER existing `notification_settings_audit` — add `channel`
 *      discriminator column (W22 audit table predates LINE; existing
 *      rows are implicitly 'email' and are backfilled via DEFAULT).
 *
 * Source of truth:
 *   - docs/tasks/wave97/W97-MIGRATION.md (this task spec)
 *   - docs/reports/wave97/W97-INVESTIGATE.md
 *   - CLAUDE.md §12 (TrackingStatus is exclusive workflow audit —
 *     these tables are operational/notification audit, NOT workflow
 *     audit; they MUST NOT touch tracking_status).
 *   - CLAUDE.md §17.3 (audit separation: NO FK from operational audit
 *     tables into project tables; FK to users(id) is allowed and uses
 *     ON DELETE SET NULL so audit rows survive user hard-delete).
 *   - CLAUDE.md §14 / §14.6 (rollback hard-deletes MUST NOT cascade
 *     into audit).
 *   - W83 (LINE userId masking — the binding row stores the raw
 *     lineUserId and admin audit references the binding row by id;
 *     no raw lineUserId is duplicated into this audit table).
 *
 * Guardrails:
 *   - Zero foreign keys to project tables (`project_groups`,
 *     `revised_project_groups`, `supplement_project_groups`,
 *     `tracking_status`, `development_plan*`).
 *   - FKs are limited to `users(id)` (ON DELETE SET NULL) and
 *     `line_user_bindings(id)` (ON DELETE CASCADE — soft-unlink is
 *     the canonical lifecycle, hot-delete is forbidden by policy).
 *   - All statements use `IF NOT EXISTS` / `IF EXISTS` for idempotency.
 *   - up → down → up round-trip leaves no orphan data.
 */
export class W97NotificationOpsSchema1777680000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Ensure uuid extension (shared; usually already present) ─────────
    await queryRunner.query(`
      CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
    `);

    // ─────────────────────────────────────────────────────────────────────
    // (0) Precondition — verify W96 has run (notification_settings.line_enabled).
    //
    //   W96 owns this column. If the column is missing here, the
    //   environment is mis-ordered and we fail fast rather than silently
    //   re-create it.
    // ─────────────────────────────────────────────────────────────────────
    const lineEnabledCheck: Array<{ exists: boolean }> =
      await queryRunner.query(`
        SELECT EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_name = 'notification_settings'
            AND column_name = 'line_enabled'
        ) AS "exists";
      `);
    if (!lineEnabledCheck?.[0]?.exists) {
      throw new Error(
        'W97 precondition failed: notification_settings.line_enabled is missing. ' +
          'Run W96AddLineNotificationSchema first.',
      );
    }

    // ─────────────────────────────────────────────────────────────────────
    // (1) line_binding_admin_actions — admin action audit table.
    //
    //   - action: enum-by-CHECK ('force-unlink' | 'reveal').
    //   - reason: REQUIRED for 'force-unlink' (length 12..200), null
    //     for 'reveal'. Enforced via CHECK constraint.
    //   - actor_user_id → users(id) ON DELETE SET NULL (§17.3 — users
    //     is NOT a project table; SET NULL preserves audit on user
    //     deletion).
    //   - actor_work_history_id is a plain uuid — no FK because
    //     WorkHistory is archival per CLAUDE.md §4.
    //   - target_binding_id → line_user_bindings(id) ON DELETE CASCADE
    //     (binding is the subject of the audit row; hot-delete of
    //     bindings is forbidden by policy so the cascade is dormant).
    //   - target_user_id is denormalized for query speed; no FK so
    //     §17.3 audit isolation is preserved if a future user
    //     hard-delete is ever introduced.
    //   - request_ip / request_user_agent: diagnostic operator metadata.
    // ─────────────────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "line_binding_admin_actions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "action" text NOT NULL,
        "actor_user_id" uuid NULL,
        "actor_work_history_id" uuid NULL,
        "target_binding_id" uuid NOT NULL,
        "target_user_id" uuid NOT NULL,
        "reason" text NULL,
        "request_ip" inet NULL,
        "request_user_agent" text NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_line_binding_admin_actions" PRIMARY KEY ("id"),
        CONSTRAINT "ck_lba_actions_action"
          CHECK ("action" IN ('force-unlink', 'reveal')),
        CONSTRAINT "ck_lba_actions_reason_required_for_force_unlink"
          CHECK (
            "action" <> 'force-unlink'
            OR (
              "reason" IS NOT NULL
              AND length("reason") BETWEEN 12 AND 200
            )
          ),
        CONSTRAINT "fk_lba_actions_actor_user"
          FOREIGN KEY ("actor_user_id")
          REFERENCES "users"("id")
          ON DELETE SET NULL
          ON UPDATE CASCADE
          DEFERRABLE INITIALLY IMMEDIATE,
        CONSTRAINT "fk_lba_actions_target_binding"
          FOREIGN KEY ("target_binding_id")
          REFERENCES "line_user_bindings"("id")
          ON DELETE CASCADE
          ON UPDATE CASCADE
          DEFERRABLE INITIALLY IMMEDIATE
      );
    `);

    // Per-actor activity audit ("every admin action this operator took").
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS
        "ix_lba_actions_actor_created"
      ON "line_binding_admin_actions" ("actor_user_id", "created_at" DESC);
    `);

    // Per-binding history ("every admin action targeting this binding").
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS
        "ix_lba_actions_target_binding"
      ON "line_binding_admin_actions" ("target_binding_id", "created_at" DESC);
    `);

    // Global audit by action type.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS
        "ix_lba_actions_action_created"
      ON "line_binding_admin_actions" ("action", "created_at" DESC);
    `);

    // ─────────────────────────────────────────────────────────────────────
    // (2) notification_quota_alerts — configurable threshold alerts.
    //
    //   - channel: enum-by-CHECK ('email' | 'line').
    //   - threshold_percent: 1..200 (>100 allowed because providers may
    //     permit overage; alert at any %).
    //   - recipient_email: free-form destination; not necessarily a
    //     user in the system.
    //   - last_fired_at / last_fired_window_key: dedupe so we fire once
    //     per threshold per quota window. Window key format:
    //       email = YYYY-MM-DD (daily), line = YYYY-MM (monthly).
    //   - created_by_user_id → users(id) ON DELETE SET NULL (§17.3).
    //   - NO FK to project tables.
    // ─────────────────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notification_quota_alerts" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "channel" text NOT NULL,
        "threshold_percent" integer NOT NULL,
        "recipient_email" text NOT NULL,
        "enabled" boolean NOT NULL DEFAULT TRUE,
        "last_fired_at" TIMESTAMP WITH TIME ZONE NULL,
        "last_fired_window_key" text NULL,
        "created_by_user_id" uuid NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_notification_quota_alerts" PRIMARY KEY ("id"),
        CONSTRAINT "ck_nqa_channel"
          CHECK ("channel" IN ('email', 'line')),
        CONSTRAINT "ck_nqa_threshold_percent"
          CHECK ("threshold_percent" BETWEEN 1 AND 200),
        CONSTRAINT "fk_nqa_created_by_user"
          FOREIGN KEY ("created_by_user_id")
          REFERENCES "users"("id")
          ON DELETE SET NULL
          ON UPDATE CASCADE
          DEFERRABLE INITIALLY IMMEDIATE
      );
    `);

    // Worker hot-path lookup — "all enabled alerts for this channel".
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS
        "ix_nqa_channel_enabled"
      ON "notification_quota_alerts" ("channel", "enabled");
    `);

    // Operator-attributed query — "alerts created by this user".
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS
        "ix_nqa_created_by"
      ON "notification_quota_alerts" ("created_by_user_id");
    `);

    // ─────────────────────────────────────────────────────────────────────
    // (3) ALTER notification_settings_audit — add channel discriminator.
    //
    //   - W22 introduced this audit table as email-only. Adding LINE
    //     flips without a discriminator would mix the two channels'
    //     audit history with no way to query by channel.
    //   - DEFAULT 'email' backfills existing rows (all current rows are
    //     email flips per W22 semantics).
    //   - DROP DEFAULT after backfill so future inserts must explicitly
    //     specify the channel.
    //   - CHECK constraint pins the enum.
    //   - Index supports the dashboard's per-channel last-flip lookup.
    // ─────────────────────────────────────────────────────────────────────
    await queryRunner.query(`
      ALTER TABLE "notification_settings_audit"
        ADD COLUMN IF NOT EXISTS "channel" varchar(8) NOT NULL DEFAULT 'email';
    `);

    // Verify backfill landed on every row before we drop the default.
    const auditChannelNullCheck: Array<{ count: string }> =
      await queryRunner.query(`
        SELECT COUNT(*)::text AS "count"
        FROM "notification_settings_audit"
        WHERE "channel" IS NULL;
      `);
    if (Number(auditChannelNullCheck?.[0]?.count ?? '0') > 0) {
      throw new Error(
        'W97: notification_settings_audit.channel backfill failed — ' +
          'NULLs remain after DEFAULT application.',
      );
    }

    await queryRunner.query(`
      ALTER TABLE "notification_settings_audit"
        ALTER COLUMN "channel" DROP DEFAULT;
    `);

    // CHECK constraint — guard against typos / non-enum writes.
    // Idempotent via DO block (CHECK constraints don't support IF NOT
    // EXISTS in PG < 16).
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'ck_notification_settings_audit_channel'
        ) THEN
          ALTER TABLE "notification_settings_audit"
            ADD CONSTRAINT "ck_notification_settings_audit_channel"
            CHECK ("channel" IN ('email', 'line'));
        END IF;
      END
      $$;
    `);

    // Per-channel last-flip lookup index (dashboard).
    // QA C1 fix: column is `changed_at` (per W22 D1 entity at
    // notification-settings-audit.entity.ts:61), NOT `created_at`. Using the
    // wrong column name would throw mid-migration and leave the DB in an
    // inconsistent state.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS
        "ix_notification_settings_audit_channel_changed"
      ON "notification_settings_audit" ("channel", "changed_at" DESC);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // LIFO — reverse the up() ordering. Do NOT drop "uuid-ossp"
    // (shared schema-wide).

    // (3) Reverse notification_settings_audit channel discriminator.
    await queryRunner.query(`
      DROP INDEX IF EXISTS "ix_notification_settings_audit_channel_changed";
    `);
    await queryRunner.query(`
      ALTER TABLE "notification_settings_audit"
        DROP CONSTRAINT IF EXISTS "ck_notification_settings_audit_channel";
    `);
    await queryRunner.query(`
      ALTER TABLE "notification_settings_audit"
        DROP COLUMN IF EXISTS "channel";
    `);

    // (2) Reverse notification_quota_alerts.
    await queryRunner.query(`
      DROP INDEX IF EXISTS "ix_nqa_created_by";
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "ix_nqa_channel_enabled";
    `);
    await queryRunner.query(`
      DROP TABLE IF EXISTS "notification_quota_alerts";
    `);

    // (1) Reverse line_binding_admin_actions.
    await queryRunner.query(`
      DROP INDEX IF EXISTS "ix_lba_actions_action_created";
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "ix_lba_actions_target_binding";
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "ix_lba_actions_actor_created";
    `);
    await queryRunner.query(`
      DROP TABLE IF EXISTS "line_binding_admin_actions";
    `);
  }
}
