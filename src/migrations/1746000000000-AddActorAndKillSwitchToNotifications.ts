import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: AddActorAndKillSwitchToNotifications (Wave 22 / D1).
 *
 * Delivers the database foundations for:
 *   - B1: email-stats dashboard (actor attribution on send events)
 *   - B2: global email kill switch + audit trail
 *
 * Source of truth:
 *   - docs/tasks/IMPLEMENT_EMAIL_STATS_ENDPOINTS.md §8 (DB requirements)
 *   - docs/tasks/IMPLEMENT_EMAIL_KILL_SWITCH.md §8 (DB requirements)
 *   - docs/reports/REPORT_EMAIL_STATS_DASHBOARD_AND_KILL_SWITCH.md
 *   - CLAUDE.md §14 / §14.6 (no FK to project tables; user-FK uses
 *     ON DELETE SET NULL so audit rows survive user hard-delete)
 *   - CLAUDE.md §17.3 (audit separation pattern by analogy)
 *
 * Four logical steps:
 *   1. Add actor columns + index to `notification_email_logs`
 *   2. Create `notification_settings` singleton config table
 *   3. Create `notification_settings_audit` append-only trail
 *   4. Seed the 'global' singleton row with email_enabled = FALSE
 *
 * Kill-switch seed MUST default to FALSE per user directive ("ปิดไว้ก่อน").
 *
 * Guardrails:
 *   - Zero foreign keys to project tables (project_groups,
 *     revised_project_groups, supplement_project_groups,
 *     development_plan*). Only FK is to `users.id`.
 *   - All user FKs use `ON DELETE SET NULL` (§14.6 compatibility —
 *     rollback hard-deletes of users MUST NOT cascade-destroy audit rows).
 *   - All statements use `IF NOT EXISTS` / `IF EXISTS` for idempotency.
 *   - Appended chronologically after Wave 21's
 *     `1745712000000-CreateNotificationEmailLogs`.
 */
export class AddActorAndKillSwitchToNotifications1746000000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Ensure uuid extension (shared; already present in most envs) ─────
    await queryRunner.query(`
      CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
    `);

    // ─────────────────────────────────────────────────────────────────────
    // (1) Add actor columns to `notification_email_logs`
    //
    //   - actor_user_id: the authenticated user whose action triggered the
    //     email (e.g. the staff who approved, the owner who submitted).
    //     FK → users(id) ON DELETE SET NULL per §14.6 (user hard-delete
    //     during rollback MUST NOT destroy the audit row).
    //
    //   - actor_work_history_id: the WorkHistory context at action time.
    //     NO FK declared — WorkHistory rows are archival (§4) and may be
    //     soft/hard cleaned up independently. The UUID remains valid as
    //     an audit reference even without referential integrity.
    //
    //   - ix_notification_email_logs_actor_queued: composite index on
    //     (actor_user_id, queued_at DESC) to power the top-senders query
    //     in the stats dashboard.
    // ─────────────────────────────────────────────────────────────────────
    await queryRunner.query(`
      ALTER TABLE "notification_email_logs"
        ADD COLUMN IF NOT EXISTS "actor_user_id" uuid NULL,
        ADD COLUMN IF NOT EXISTS "actor_work_history_id" uuid NULL;
    `);

    // Add FK only if not already present. Postgres has no IF NOT EXISTS
    // for ADD CONSTRAINT, so guard via information_schema.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM information_schema.table_constraints
          WHERE table_name = 'notification_email_logs'
            AND constraint_name = 'fk_notification_email_logs_actor_user'
        ) THEN
          ALTER TABLE "notification_email_logs"
            ADD CONSTRAINT "fk_notification_email_logs_actor_user"
            FOREIGN KEY ("actor_user_id")
            REFERENCES "users"("id")
            ON DELETE SET NULL
            ON UPDATE CASCADE
            DEFERRABLE INITIALLY IMMEDIATE;
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS
        "ix_notification_email_logs_actor_queued"
      ON "notification_email_logs" ("actor_user_id", "queued_at" DESC);
    `);

    // ─────────────────────────────────────────────────────────────────────
    // (2) Create `notification_settings` (singleton config)
    //
    //   - `id` is a short string key; only the 'global' row exists today.
    //   - `email_enabled` defaults to FALSE (kill switch closed by
    //     default — user directive "ปิดไว้ก่อน").
    //   - `last_changed_by` FK → users(id) ON DELETE SET NULL.
    // ─────────────────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notification_settings" (
        "id" varchar(32) NOT NULL,
        "email_enabled" boolean NOT NULL DEFAULT FALSE,
        "last_changed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "last_changed_by" uuid NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_notification_settings" PRIMARY KEY ("id"),
        CONSTRAINT "fk_notification_settings_last_changed_by"
          FOREIGN KEY ("last_changed_by")
          REFERENCES "users"("id")
          ON DELETE SET NULL
          ON UPDATE CASCADE
          DEFERRABLE INITIALLY IMMEDIATE
      );
    `);

    // ─────────────────────────────────────────────────────────────────────
    // (3) Create `notification_settings_audit` (append-only)
    //
    //   - Every kill-switch toggle writes one row here.
    //   - `setting_id` is a plain varchar (matches
    //     notification_settings.id). No FK — future-proofing to allow
    //     renaming/splitting settings without cascade pain.
    //   - `changed_by` FK → users(id) ON DELETE SET NULL.
    //   - `reason` is an optional operator note.
    //   - Index on changed_at DESC for the recent-history view.
    // ─────────────────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notification_settings_audit" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "setting_id" varchar(32) NOT NULL,
        "prev_enabled" boolean NOT NULL,
        "next_enabled" boolean NOT NULL,
        "changed_by" uuid NULL,
        "changed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "reason" text NULL,
        CONSTRAINT "pk_notification_settings_audit" PRIMARY KEY ("id"),
        CONSTRAINT "fk_notification_settings_audit_changed_by"
          FOREIGN KEY ("changed_by")
          REFERENCES "users"("id")
          ON DELETE SET NULL
          ON UPDATE CASCADE
          DEFERRABLE INITIALLY IMMEDIATE
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS
        "ix_notification_settings_audit_changed_at"
      ON "notification_settings_audit" ("changed_at" DESC);
    `);

    // ─────────────────────────────────────────────────────────────────────
    // (4) Seed the singleton row — email_enabled = FALSE.
    //
    // CRITICAL: kill switch ships CLOSED. Any attempt to change this
    // default must go through the B2 toggle endpoint, which will record
    // the transition in notification_settings_audit.
    // ─────────────────────────────────────────────────────────────────────
    await queryRunner.query(`
      INSERT INTO "notification_settings" ("id", "email_enabled")
      VALUES ('global', FALSE)
      ON CONFLICT ("id") DO NOTHING;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverse order — indexes first, then tables, then actor columns.
    // Do NOT drop the "uuid-ossp" extension (shared schema-wide).
    await queryRunner.query(`
      DROP INDEX IF EXISTS "ix_notification_settings_audit_changed_at";
    `);
    await queryRunner.query(`
      DROP TABLE IF EXISTS "notification_settings_audit";
    `);
    await queryRunner.query(`
      DROP TABLE IF EXISTS "notification_settings";
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "ix_notification_email_logs_actor_queued";
    `);
    await queryRunner.query(`
      ALTER TABLE "notification_email_logs"
        DROP CONSTRAINT IF EXISTS "fk_notification_email_logs_actor_user";
    `);
    await queryRunner.query(`
      ALTER TABLE "notification_email_logs"
        DROP COLUMN IF EXISTS "actor_work_history_id";
    `);
    await queryRunner.query(`
      ALTER TABLE "notification_email_logs"
        DROP COLUMN IF EXISTS "actor_user_id";
    `);
  }
}
