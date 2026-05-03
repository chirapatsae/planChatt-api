import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Wave 98 follow-up — Relax `notification_quota_alerts.recipient_email`.
 *
 * Direction change: alerts no longer require an operator-supplied
 * destination. The new product spec is "fan out to every active
 * admin + super-admin mailbox automatically when the threshold
 * trips." `QuotaAlertWorkerService` resolves the recipient list at
 * fire time via `UsersService` rather than relying on the row's
 * stored value.
 *
 * Schema change in this migration:
 *   - `recipient_email` becomes NULLABLE.
 *
 * Backward compatibility:
 *   - Existing rows that already carry an explicit address keep
 *     working unchanged. The worker prefers the explicit value when
 *     `recipient_email IS NOT NULL`, falling back to the dynamic
 *     admin lookup otherwise.
 *   - This is a one-way relaxation; the down() migration restores
 *     the NOT NULL constraint, which will fail if any rows have a
 *     NULL value at that point. The down() implementation
 *     defensively backfills nulls with `'__auto__'` (a sentinel that
 *     the worker also recognises as "use dynamic lookup") before
 *     re-applying NOT NULL.
 *
 * CLAUDE.md compliance:
 *   - §4.1 / §17.2 — alerts remain advisory; no workflow authority
 *     change.
 *   - §12 — no `tracking_status` write touched.
 *   - §17.3 — `notification_quota_alerts` already has no FK into any
 *     project table; this migration does not introduce one.
 *   - §17.11 — schema relaxation, not a role-permission change.
 */
export class W98RelaxQuotaAlertRecipient1777819200000
  implements MigrationInterface
{
  name = 'W98RelaxQuotaAlertRecipient1777819200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "notification_quota_alerts"
      ALTER COLUMN "recipient_email" DROP NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Backfill any nulls so the NOT NULL re-application does not fail.
    await queryRunner.query(`
      UPDATE "notification_quota_alerts"
      SET "recipient_email" = '__auto__'
      WHERE "recipient_email" IS NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "notification_quota_alerts"
      ALTER COLUMN "recipient_email" SET NOT NULL
    `);
  }
}
