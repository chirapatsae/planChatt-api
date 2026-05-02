import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: W96AddLineNotificationSchema (Wave 96 / W96-MIGRATION).
 *
 * Adds the database foundations for the LINE notification dispatch
 * pipeline (mirror of Wave 21 / 22 email infrastructure):
 *
 *   1. Adds `line_enabled` boolean column to `notification_settings`
 *      (per-channel kill-switch; defaults to FALSE per "ปิดไว้ก่อน").
 *   2. Backfills the singleton `'global'` row so `line_enabled` is
 *      materialized on environments where the row already exists from
 *      Wave 22's seed (idempotent UPSERT).
 *   3. Creates `notification_line_logs` audit table mirroring
 *      `notification_email_logs` (see W21 / W22 migrations).
 *
 * Source of truth:
 *   - docs/tasks/wave96/W96-MIGRATION.md (this task spec)
 *   - docs/reports/wave96/W96-INVESTIGATE.md
 *   - CLAUDE.md §12 (TrackingStatus is exclusive workflow audit —
 *     this table is operational/notification audit, NOT workflow audit)
 *   - CLAUDE.md §17.3 (audit separation: NO FK from notification audit
 *     into project tables; loose UUID reference only)
 *   - CLAUDE.md §14 / §14.6 (rollback hard-deletes MUST NOT cascade
 *     into audit; user FKs use ON DELETE SET NULL)
 *   - W83 (LINE userId masking discipline — column is operator-only)
 *
 * Guardrails:
 *   - Zero foreign keys to project tables (`project_groups`,
 *     `revised_project_groups`, `supplement_project_groups`,
 *     `development_plan*`). The only FK is to `users(id)` and uses
 *     ON DELETE SET NULL so audit rows survive user hard-delete.
 *   - All statements use `IF NOT EXISTS` / `IF EXISTS` for idempotency.
 *   - up → down → up round-trip leaves no orphan data.
 */
export class W96AddLineNotificationSchema1777593600000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Ensure uuid extension (shared; usually already present) ─────────
    await queryRunner.query(`
      CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
    `);

    // ─────────────────────────────────────────────────────────────────────
    // (1) Per-channel kill-switch column on notification_settings
    //
    //   - Defaults to FALSE per user directive ("ปิดไว้ก่อน").
    //   - Existing W22 rows take the column default automatically.
    //   - Idempotent via IF NOT EXISTS.
    // ─────────────────────────────────────────────────────────────────────
    await queryRunner.query(`
      ALTER TABLE "notification_settings"
        ADD COLUMN IF NOT EXISTS "line_enabled" boolean NOT NULL DEFAULT FALSE;
    `);

    // ─────────────────────────────────────────────────────────────────────
    // (2) Backfill / re-affirm singleton row.
    //
    //   - The W22 D1 migration seeds id='global' with email_enabled=FALSE.
    //   - On a fresh DB where W22 has not run, INSERT...ON CONFLICT DO
    //     NOTHING materializes the row so line_enabled has a place to
    //     live. The column default already guarantees FALSE for the
    //     existing row; this UPDATE is a defensive idempotent re-affirm
    //     that does NOT overwrite an operator's explicit toggle (only
    //     fires when line_enabled is somehow NULL — should never happen
    //     given NOT NULL constraint, but guards against legacy rows).
    // ─────────────────────────────────────────────────────────────────────
    await queryRunner.query(`
      INSERT INTO "notification_settings" ("id", "email_enabled", "line_enabled")
      VALUES ('global', FALSE, FALSE)
      ON CONFLICT ("id") DO NOTHING;
    `);

    // ─────────────────────────────────────────────────────────────────────
    // (3) notification_line_logs — mirrors notification_email_logs.
    //
    //   - NO FK to project tables (§17.3). target_id is a loose uuid;
    //     target_kind is the discriminator.
    //   - recipient_user_id FK → users(id) ON DELETE SET NULL.
    //   - actor_user_id FK → users(id) ON DELETE SET NULL (W22 B1 parity).
    //   - actor_work_history_id is a plain uuid — no FK because
    //     WorkHistory is archival per CLAUDE.md §4.
    //   - recipient_line_user_id stored as-is for operator audit.
    //     Application code MUST NEVER log this column in plaintext;
    //     reuse LineMessagingService.shortHash for log lines (W83).
    //   - status is a free-form discriminator covering every dispatch
    //     outcome the W96-DISPATCH state machine emits:
    //       queued | sent | failed |
    //       skipped-preference | skipped-killswitch |
    //       skipped-not-linked | skipped-unlinked
    // ─────────────────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notification_line_logs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "event_type" varchar(64) NOT NULL,
        "target_kind" varchar(32) NOT NULL,
        "target_id" uuid NOT NULL,
        "recipient_user_id" uuid NULL,
        "recipient_line_user_id" varchar(64) NOT NULL,
        "actor_user_id" uuid NULL,
        "actor_work_history_id" uuid NULL,
        "queued_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "sent_at" TIMESTAMP WITH TIME ZONE NULL,
        "status" varchar(32) NOT NULL,
        "attempts" integer NOT NULL DEFAULT 0,
        "provider" varchar(32) NULL DEFAULT 'line-messaging',
        "provider_message_id" varchar(255) NULL,
        "error_message" text NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_notification_line_logs" PRIMARY KEY ("id"),
        CONSTRAINT "fk_notification_line_logs_recipient_user"
          FOREIGN KEY ("recipient_user_id")
          REFERENCES "users"("id")
          ON DELETE SET NULL
          ON UPDATE CASCADE
          DEFERRABLE INITIALLY IMMEDIATE,
        CONSTRAINT "fk_notification_line_logs_actor_user"
          FOREIGN KEY ("actor_user_id")
          REFERENCES "users"("id")
          ON DELETE SET NULL
          ON UPDATE CASCADE
          DEFERRABLE INITIALLY IMMEDIATE
      );
    `);

    // ── Indexes (mirror notification_email_logs) ────────────────────────
    // Per-project timeline ("every LINE push fired for this project").
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS
        "ix_notification_line_logs_target"
      ON "notification_line_logs" ("target_kind", "target_id");
    `);

    // Per-user inbox ("every LINE push sent to this user").
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS
        "ix_notification_line_logs_recipient"
      ON "notification_line_logs" ("recipient_user_id");
    `);

    // Queue age / retry sweep ordering.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS
        "ix_notification_line_logs_queued_at"
      ON "notification_line_logs" ("queued_at");
    `);

    // Ops dashboards — filter by event type and current status.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS
        "ix_notification_line_logs_event_status"
      ON "notification_line_logs" ("event_type", "status");
    `);

    // Top-senders / actor-attributed query (mirror of W22 B1 actor index).
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS
        "ix_notification_line_logs_actor_queued"
      ON "notification_line_logs" ("actor_user_id", "queued_at" DESC);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // LIFO — indexes → table → column. Do NOT drop "uuid-ossp"
    // (shared schema-wide). Do NOT delete the singleton 'global' row
    // (owned by W22 D1).
    await queryRunner.query(`
      DROP INDEX IF EXISTS "ix_notification_line_logs_actor_queued";
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "ix_notification_line_logs_event_status";
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "ix_notification_line_logs_queued_at";
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "ix_notification_line_logs_recipient";
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "ix_notification_line_logs_target";
    `);
    await queryRunner.query(`
      DROP TABLE IF EXISTS "notification_line_logs";
    `);
    await queryRunner.query(`
      ALTER TABLE "notification_settings"
        DROP COLUMN IF EXISTS "line_enabled";
    `);
  }
}
