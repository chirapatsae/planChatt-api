import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: CreateNotificationEmailLogs (Wave 21 / N3).
 *
 * Creates the optional-but-recommended `notification_email_logs` audit
 * table used by the Wave 21 `NotificationsModule` to record every email
 * enqueue / dispatch attempt. The table is advisory/audit-only.
 *
 * Source of truth:
 *   - docs/architecture/EMAIL_NOTIFICATION.md §4.2 (audit table spec)
 *   - docs/tasks/IMPLEMENT_EMAIL_NOTIFICATION_SERVICE.md (Wave 21 N3 scope)
 *   - CLAUDE.md §14 (Version Lineage Immutability) — NO FK to project
 *     tables. §14.6 rollback hard-deletes MUST NOT cascade here.
 *   - CLAUDE.md §17 (AI-Assist Rule) — §17.3 style audit separation
 *     applies by analogy: this table is independent of `tracking_status`
 *     and `ai_*` result tables. It has no authority over workflow.
 *
 * Design points:
 *
 *   1. NO foreign key to `project_groups`, `revised_project_groups`,
 *      `supplement_project_groups`, or `development_plans`. `target_id`
 *      is a plain uuid; `target_kind` is the discriminator. This mirrors
 *      the §17.3 pattern used by `ai_pre_submit_snapshots` and
 *      `ai_smart_approve_revised_results`.
 *
 *   2. `recipient_user_id` FK to `users.id` IS allowed — users are not
 *      project tables, do not participate in §14 lineage locking, and do
 *      not have a hard-delete rollback path. Cascade on delete is SET
 *      NULL so audit history survives user deletion.
 *
 *   3. Indexes cover the four canonical query paths:
 *        - project timeline:  (target_kind, target_id)
 *        - per-user inbox:    (recipient_user_id)
 *        - queue age / retry: (queued_at)
 *        - ops dashboards:    (event_type, status)
 *
 *   4. `up`/`down` are idempotent via `IF NOT EXISTS` / `IF EXISTS`
 *      guards so the migration works on both a fresh DB and a
 *      prod-shaped DB.
 */
export class CreateNotificationEmailLogs1745712000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Ensure uuid extension (most envs already have this) ─────────────
    await queryRunner.query(`
      CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
    `);

    // ── Create audit table ──────────────────────────────────────────────
    // NOTE (§14 / §17.3): NO REFERENCES to any project table.
    // `target_id` is a loose uuid reference only.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notification_email_logs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "event_type" varchar(64) NOT NULL,
        "target_kind" varchar(32) NOT NULL,
        "target_id" uuid NOT NULL,
        "recipient_user_id" uuid NULL,
        "recipient_email" varchar(255) NOT NULL,
        "queued_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "sent_at" TIMESTAMP WITH TIME ZONE NULL,
        "status" varchar(32) NOT NULL,
        "attempts" integer NOT NULL DEFAULT 0,
        "provider" varchar(32) NULL,
        "provider_message_id" varchar(255) NULL,
        "error_message" text NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_notification_email_logs" PRIMARY KEY ("id"),
        CONSTRAINT "fk_notification_email_logs_recipient_user"
          FOREIGN KEY ("recipient_user_id")
          REFERENCES "users"("id")
          ON DELETE SET NULL
          ON UPDATE CASCADE
          DEFERRABLE INITIALLY IMMEDIATE
      );
    `);

    // NOTE: `recipient_user_id` is declared NULLABLE so the FK
    // `ON DELETE SET NULL` can fire without violating NOT NULL. The
    // application insert path guarantees non-null at write time; audit
    // rows only lose their recipient_user_id if the user is later hard-
    // deleted, which is rare and acceptable for audit semantics.

    // ── Indexes ─────────────────────────────────────────────────────────
    // Per-project timeline ("show me every email fired for this project").
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS
        "ix_notification_email_logs_target"
      ON "notification_email_logs" ("target_kind", "target_id");
    `);

    // Per-user inbox ("show me every email sent to this user").
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS
        "ix_notification_email_logs_recipient"
      ON "notification_email_logs" ("recipient_user_id");
    `);

    // Queue age / retry sweep ordering.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS
        "ix_notification_email_logs_queued_at"
      ON "notification_email_logs" ("queued_at");
    `);

    // Ops dashboards — filter by event type and current status.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS
        "ix_notification_email_logs_event_status"
      ON "notification_email_logs" ("event_type", "status");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // LIFO — drop indexes first, then the table. Do NOT drop the uuid
    // extension (shared with the rest of the schema).
    await queryRunner.query(`
      DROP INDEX IF EXISTS "ix_notification_email_logs_event_status";
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "ix_notification_email_logs_queued_at";
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "ix_notification_email_logs_recipient";
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "ix_notification_email_logs_target";
    `);
    await queryRunner.query(`
      DROP TABLE IF EXISTS "notification_email_logs";
    `);
  }
}
