import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CitizenFollowNotification — C3 of the civic-community plan (follow + notify).
 *
 * `synchronize: true` creates the `citizen_follow` + `citizen_notification`
 * tables + plain columns + plain indexes from the entity decorators. It does
 * NOT create the PARTIAL-UNIQUE index or the CHECK constraints — those live
 * here (project memory: `project_typeorm_synchronize`), mirroring the M0 / C2
 * migration pattern. Run this migration after the entities sync.
 *
 * §17.3 isolation: every object below is inside the `citizen_*` namespace.
 * There is NO FK to project_groups / any project table / users / work_history
 * / tracking_status — isolation is by construction (the only FKs are
 * citizen_* → citizen_*, declared on the entities, not added here).
 */
export class CitizenFollowNotification1784000000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // One live follow per (follower, target_kind, target_key) —
    // toggle = soft-delete / re-insert (same shape as the C2 reaction toggle).
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_citizen_follow_unique"
      ON "citizen_follow" ("follower_identity_id", "target_kind", "target_key")
      WHERE "deleted_at" IS NULL;
    `);

    // ── CHECK constraints (enum-shaped varchars kept additive, no PG enum) ──
    const checks: [string, string, string][] = [
      [
        'citizen_follow',
        'ck_citizen_follow_kind',
        `"target_kind" IN ('amphoe','category')`,
      ],
      [
        'citizen_notification',
        'ck_citizen_notification_kind',
        `"kind" IN ('comment','heart')`,
      ],
    ];

    for (const [table, name, expr] of checks) {
      // Drop-then-add so the migration is idempotent (no IF NOT EXISTS for constraints).
      await queryRunner.query(
        `ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "${name}";`,
      );
      await queryRunner.query(
        `ALTER TABLE "${table}" ADD CONSTRAINT "${name}" CHECK (${expr});`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "citizen_notification" DROP CONSTRAINT IF EXISTS "ck_citizen_notification_kind";`,
    );
    await queryRunner.query(
      `ALTER TABLE "citizen_follow" DROP CONSTRAINT IF EXISTS "ck_citizen_follow_kind";`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_citizen_follow_unique";`,
    );
  }
}
