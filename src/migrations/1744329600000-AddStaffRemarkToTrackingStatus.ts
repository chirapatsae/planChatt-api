import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: AddStaffRemarkToTrackingStatus
 *
 * Adds a nullable TEXT column `staff_remark` to the `tracking_status` table.
 *
 * Business purpose:
 *   Staff (staff / admin / super-admin) need a dedicated internal field to
 *   record the administrative reason behind each workflow transition they
 *   perform. This is separate from the existing `comment` field which carries
 *   user-facing review feedback.
 *
 *   CLAUDE.md §12 (Audit Rule) requires all mutations to be traceable.
 *   This column extends that traceability for staff-initiated transitions.
 *
 * Design decisions:
 *   - TEXT type: no length cap needed for administrative notes
 *   - Nullable: existing rows and user-initiated records carry NULL safely
 *   - NULL default: no backfill required; old records remain unaffected
 *   - Write-once by design: the service layer enforces immutability after creation
 */
export class AddStaffRemarkToTrackingStatus1744329600000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "tracking_status" ADD COLUMN IF NOT EXISTS "staff_remark" TEXT DEFAULT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "tracking_status" DROP COLUMN IF EXISTS "staff_remark"`,
    );
  }
}
