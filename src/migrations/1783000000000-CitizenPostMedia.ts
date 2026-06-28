import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CitizenPostMedia — C2 v1 of the civic-community plan (photo media on posts).
 *
 * `synchronize: true` creates the `citizen_post_media` table + plain columns +
 * plain indexes from the entity decorators. It does NOT create the CHECK
 * constraint — that lives here (project memory: `project_typeorm_synchronize`),
 * mirroring the M0 migration pattern. Run this migration after the entity syncs.
 *
 * §17.3 isolation: the table lives in the `citizen_*` namespace. There is NO
 * FK to project_groups / any project table / users / work_history /
 * tracking_status — isolation is by construction (the only FKs are
 * citizen_* → citizen_*, declared on the entity, not added here).
 */
export class CitizenPostMedia1783000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Drop-then-add so the migration is idempotent (no IF NOT EXISTS for constraints).
    await queryRunner.query(
      `ALTER TABLE "citizen_post_media" DROP CONSTRAINT IF EXISTS "ck_citizen_media_status";`,
    );
    await queryRunner.query(
      `ALTER TABLE "citizen_post_media" ADD CONSTRAINT "ck_citizen_media_status" CHECK ("status" IN ('ready','pending','rejected'));`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "citizen_post_media" DROP CONSTRAINT IF EXISTS "ck_citizen_media_status";`,
    );
  }
}
