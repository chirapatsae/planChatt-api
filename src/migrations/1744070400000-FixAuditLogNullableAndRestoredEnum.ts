import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * FixAuditLogNullableAndRestoredEnum
 *
 * Fixes two critical defects in the audit log system:
 *
 * D1 — Nullable columns:
 *   version_id, operator_work_history_id, and operator_role on
 *   deprecation_audit_logs must be nullable to support FAILED audit records
 *   written before a valid version or operator is known. Previously these
 *   columns were NOT NULL, causing FK violations when persistFailedAudit()
 *   attempted to write with placeholder UUIDs.
 *
 * D2 — RESTORED enum value:
 *   DeprecationAuditAction.RESTORED = 'restored' was added at the TypeScript
 *   level and used in discardDraft() correction path, but the value was never
 *   added to the PostgreSQL deprecation_audit_action_enum type. This caused
 *   the entire discardDraft() transaction to fail with an invalid enum value
 *   error, leaving the system in an inconsistent state (version DEPRECATED,
 *   draft PREPARING).
 *
 * Note on rollback:
 *   down() restores NOT NULL on the three columns. This will fail if any
 *   existing rows have null values in those columns. This is an acceptable
 *   constraint — rolling back this migration on a live database is an
 *   exceptional operation requiring manual data cleanup first.
 *   PostgreSQL does not support removing enum values; 'restored' will remain
 *   in the enum after rollback. This is safe — unused enum values cause no harm.
 */
export class FixAuditLogNullableAndRestoredEnum1744070400000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Step 1: Commit current transaction.
    // ALTER TYPE ... ADD VALUE cannot run inside a PostgreSQL transaction.
    // TypeORM wraps migrations in a transaction by default, so we must
    // commit the current transaction, run the ALTER TYPE, then re-open
    // a transaction for the remaining DDL statements.
    await queryRunner.commitTransaction();

    // Step 2: Add 'restored' to the deprecation_audit_action_enum.
    // IF NOT EXISTS prevents an error if the value is somehow already present.
    await queryRunner.query(
      `ALTER TYPE "deprecation_audit_action_enum" ADD VALUE IF NOT EXISTS 'restored';`,
    );

    // Step 3: Re-open transaction for remaining DDL.
    await queryRunner.startTransaction();

    // Step 4: Make version_id nullable.
    // FAILED audit records may be written before the target version is known.
    await queryRunner.query(`
      ALTER TABLE "deprecation_audit_logs"
      ALTER COLUMN "version_id" DROP NOT NULL;
    `);

    // Step 5: Make operator_work_history_id nullable.
    // FAILED audit records may be written before operator identity is confirmed.
    await queryRunner.query(`
      ALTER TABLE "deprecation_audit_logs"
      ALTER COLUMN "operator_work_history_id" DROP NOT NULL;
    `);

    // Step 6: Make operator_role nullable.
    // operator_role is derived from WorkHistory. If WorkHistory lookup fails,
    // the role is unknown. Must accept null for early-failure FAILED records.
    await queryRunner.query(`
      ALTER TABLE "deprecation_audit_logs"
      ALTER COLUMN "operator_role" DROP NOT NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // WARNING: These SET NOT NULL statements will fail if any rows contain
    // null values in these columns. Manual cleanup is required before rollback
    // if the system has produced any FAILED audit records since this migration
    // was applied.
    //
    // Note: PostgreSQL does not support removing enum values.
    // 'restored' will remain in deprecation_audit_action_enum after rollback.

    await queryRunner.query(`
      ALTER TABLE "deprecation_audit_logs"
      ALTER COLUMN "operator_role" SET NOT NULL;
    `);

    await queryRunner.query(`
      ALTER TABLE "deprecation_audit_logs"
      ALTER COLUMN "operator_work_history_id" SET NOT NULL;
    `);

    await queryRunner.query(`
      ALTER TABLE "deprecation_audit_logs"
      ALTER COLUMN "version_id" SET NOT NULL;
    `);
  }
}
