import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CitizenOfficialResponse — C4 of the civic-community plan (official-response).
 *
 * `synchronize: true` creates the `citizen_official_response` table + plain
 * columns + the plain `(post_id, created_at)` index from the entity decorators.
 * No CHECK is required on that table, so it is NOT created here.
 *
 * This migration does the belt-and-braces work `synchronize` won't:
 *   1. Extend the C3 `ck_citizen_notification_kind` CHECK to ADD
 *      `official_response` (drop-then-add → idempotent).
 *   2. Defensively DROP NOT NULL on `citizen_notification.actor_identity_id`
 *      — official-response notices have NO citizen actor. The C4 entity change
 *      already relaxes it via `synchronize`; this ALTER is idempotent insurance
 *      (project memory: `project_typeorm_synchronize`).
 *
 * §17.3 isolation: every object below lives in the `citizen_*` namespace. There
 * is NO foreign key to project_groups / any project table / users /
 * work_history / tracking_status — the only FK is the entity-declared
 * citizen_official_response.post_id → citizen_post (citizen_* → citizen_*).
 */
export class CitizenOfficialResponse1785000000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Extend the notification kind CHECK with 'official_response'.
    //    Drop-then-add so the migration is idempotent (no IF NOT EXISTS for
    //    constraints).
    await queryRunner.query(
      `ALTER TABLE "citizen_notification" DROP CONSTRAINT IF EXISTS "ck_citizen_notification_kind";`,
    );
    await queryRunner.query(
      `ALTER TABLE "citizen_notification" ADD CONSTRAINT "ck_citizen_notification_kind" CHECK ("kind" IN ('comment','heart','official_response'));`,
    );

    // 2. Relax NOT NULL on actor_identity_id (official-response notices have no
    //    citizen actor). DROP NOT NULL is idempotent — re-running on an
    //    already-nullable column is a no-op.
    await queryRunner.query(
      `ALTER TABLE "citizen_notification" ALTER COLUMN "actor_identity_id" DROP NOT NULL;`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Revert the kind CHECK back to the C3 set.
    await queryRunner.query(
      `ALTER TABLE "citizen_notification" DROP CONSTRAINT IF EXISTS "ck_citizen_notification_kind";`,
    );
    await queryRunner.query(
      `ALTER TABLE "citizen_notification" ADD CONSTRAINT "ck_citizen_notification_kind" CHECK ("kind" IN ('comment','heart'));`,
    );

    // Re-asserting NOT NULL is intentionally OMITTED: rows inserted by C4 may
    // carry NULL actor_identity_id, so a blind `SET NOT NULL` would fail. The
    // table-create / drop is owned by `synchronize`, not this migration.
  }
}
