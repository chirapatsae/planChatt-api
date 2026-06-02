import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Wave Equipment Revision Management — add `reason` to RELPG.
 *
 * Adds the nullable free-form `reason` text column to
 * `revised_equipment_project_groups` — the equipment analog of
 * `RevisedProjectGroup.additionalDetail`. Captured by the equipment
 * revision wizard so the author can explain the fork/edit request.
 *
 * Purely additive metadata: does NOT participate in workflow / shape
 * (§16.5) / lineage (§14) validation.
 *
 * # Idempotency
 * `ADD COLUMN IF NOT EXISTS` tolerates a `synchronize:true` pre-creation
 * of the column on boot (per MEMORY: typeorm synchronize). This migration
 * exists for production safety + documentation.
 *
 * Sibling pattern: `1782300000000-CreateRevisedEquipmentProjectGroup.ts`.
 */
export class AddReasonToRevisedEquipmentProjectGroup1782500000000
  implements MigrationInterface
{
  name = 'AddReasonToRevisedEquipmentProjectGroup1782500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "revised_equipment_project_groups"
        ADD COLUMN IF NOT EXISTS "reason" text;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "revised_equipment_project_groups"
        DROP COLUMN IF EXISTS "reason";
    `);
  }
}
