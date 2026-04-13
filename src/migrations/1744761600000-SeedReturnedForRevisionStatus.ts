import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: SeedReturnedForRevisionStatus
 *
 * Ensures the `Returned_For_Revision` status row exists in the `status` table.
 *
 * Business purpose:
 *   CLAUDE.md defines `Returned_For_Revision` as a canonical workflow status
 *   (Core Status Machine) that is staff-triggered and indicates a project has
 *   been reviewed and requires correction by the owner (Returned_For_Revision
 *   Rule). It is used in transitions:
 *
 *     - Pending -> Returned_For_Revision  (staff-lead)
 *     - Verified -> Returned_For_Revision (staff-lead)
 *     - Returned_For_Revision -> Pending  (owner resubmission)
 *
 *   CLAUDE.md Status Naming Constraint explicitly RESERVES the name "Revision"
 *   and mandates "Returned_For_Revision" as the approved replacement.
 *
 *   Without this row, no TrackingStatus record can reference this status,
 *   which would block the entire staff-rejection and user-resubmission flow.
 *
 * Design decisions:
 *   - Idempotent: uses INSERT ... ON CONFLICT DO NOTHING on `name` to avoid
 *     failure if the row already exists (e.g., manually created in a
 *     development database).
 *   - `created_by` is NULL: this is a system seed row, not user-created.
 *   - `th_name` = 'ส่งกลับแก้ไข': Thai translation consistent with the
 *     business meaning ("returned for revision / correction").
 *   - Uses gen_random_uuid() for id generation (PostgreSQL built-in).
 *
 * Rollback:
 *   - Down migration deletes the row by name. This is safe only if no
 *     TrackingStatus rows reference the status. The ON DELETE CASCADE on
 *     TrackingStatus.statusId would propagate, so the operator MUST confirm
 *     no tracking history references this status before rolling back.
 *
 * CLAUDE.md references: Core Status Machine, Status Naming Constraint,
 *   Returned_For_Revision Rule, section 3 (Role Responsibilities).
 *
 * Task reference: docs/tasks/FIX_TRACKING_STATUS_USER_TRANSITIONS.md (DB-01).
 */
export class SeedReturnedForRevisionStatus1744761600000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Create a unique index on name (if not exists) to support ON CONFLICT.
    // The status table does not have a unique constraint on `name` in the
    // entity definition, but the StatusService.create() already rejects
    // duplicates at the application level. Adding a partial unique index
    // (excluding soft-deleted rows) ensures database-level idempotency for
    // this seed without affecting soft-deleted rows.
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_status_name_active"
       ON "status" ("name")
       WHERE "delete_at" IS NULL`,
    );

    await queryRunner.query(
      `INSERT INTO "status" ("id", "name", "th_name", "create_at")
       VALUES (gen_random_uuid(), 'Returned_For_Revision', 'ส่งกลับแก้ไข', NOW())
       ON CONFLICT ("name") WHERE "delete_at" IS NULL
       DO NOTHING`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "status"
       WHERE "name" = 'Returned_For_Revision'
         AND "delete_at" IS NULL`,
    );

    await queryRunner.query(
      `DROP INDEX IF EXISTS "uq_status_name_active"`,
    );
  }
}
