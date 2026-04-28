import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: FixAiExecutiveMessagesNullableColumns
 *
 * Wave 44 fixup — the base `AbstractAiResult` declares `target_id` and
 * `target_kind` as NOT NULL at the TypeORM level. For chat messages that
 * shape is wrong: a chat turn does NOT have to be about a specific
 * project (the executive may be asking a global question).
 *
 * The original `1746259200000-CreateAiExecutiveChatTables` migration
 * creates the table with `target_id uuid NULL` and `target_kind ... NULL`
 * — but any environment where that migration ran against a pre-existing
 * table (via `CREATE TABLE IF NOT EXISTS`) may still be carrying the
 * older NOT NULL shape. Runtime symptom:
 *
 *   ERROR: null value in column "target_id" of relation
 *   "ai_executive_messages" violates not-null constraint
 *
 * This migration force-drops NOT NULL on both columns. It is idempotent
 * (ALTER ... DROP NOT NULL on an already-nullable column is a no-op in
 * Postgres) and therefore safe to run in every environment.
 *
 * CLAUDE.md references:
 *   - §17.3 Audit separation. target_id remains a plain uuid without FK
 *     into any project / plan / tracking table. This migration ONLY
 *     changes nullability, NOT the relationship shape.
 *   - §17.4 Snapshot-only staleness is preserved — staleness_policy
 *     default remains 'snapshot-only'.
 */
export class FixAiExecutiveMessagesNullableColumns1746259300000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // target_id: nullable because a chat turn may be global (no project
    // context). The ONLY FK on this table is conversation_id — not
    // affected by this migration.
    await queryRunner.query(`
      ALTER TABLE "ai_executive_messages"
      ALTER COLUMN "target_id" DROP NOT NULL;
    `);

    // target_kind: nullable companion to target_id — if there is no
    // project to discriminate, there is no kind either.
    await queryRunner.query(`
      ALTER TABLE "ai_executive_messages"
      ALTER COLUMN "target_kind" DROP NOT NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverting requires backfilling any NULL rows first. We leave the
    // rollback path intentionally strict — production chat history MUST
    // NOT be lost to migration churn. If a downgrade is truly needed,
    // operators can:
    //
    //   UPDATE "ai_executive_messages"
    //      SET "target_id"   = '00000000-0000-0000-0000-000000000000',
    //          "target_kind" = 'project-group'
    //    WHERE "target_id" IS NULL;
    //
    // and then run this `down` migration. The placeholder uuid is
    // intentional — it does NOT reference any real project (no FK).
    await queryRunner.query(`
      ALTER TABLE "ai_executive_messages"
      ALTER COLUMN "target_kind" SET NOT NULL;
    `);
    await queryRunner.query(`
      ALTER TABLE "ai_executive_messages"
      ALTER COLUMN "target_id" SET NOT NULL;
    `);
  }
}
