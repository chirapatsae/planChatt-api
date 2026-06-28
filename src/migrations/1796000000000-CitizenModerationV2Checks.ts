import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CitizenModerationV2Checks — W-T3 of the citizen-social-platform wave
 * (moderation v2). For-record/prod parity of the two CHECK widenings the
 * BootstrapMigrationsService applies idempotently on every boot:
 *
 *   1. `citizen_identities.status` — allow `'suspended'` (the offender ladder
 *      sets it when staff remove N posts of an author). The M0 CHECK allowed
 *      ('active','blocked'); W-G1 widened to add 'deleted'; this adds 'suspended'.
 *   2. `citizen_moderation_log.action` — allow `'appeal_uphold'`,
 *      `'suspend_author'`, `'reinstate_author'` (the appeal-uphold + offender
 *      suspend/reinstate log writes). The M0 CHECK allowed
 *      ('report','hide','remove','restore','block_author').
 *
 * §17.3 isolation: ALTER-CONSTRAINT only — both CHECKs live on `citizen_*` tables;
 * no foreign key, no forbidden table touched (the isolation spec bans the SQL
 * foreign-key keyword in any citizen migration, even in a comment). `synchronize:
 * true` does NOT alter CHECKs, so this corrective DDL is required on existing prod
 * boxes (project memory: `project_typeorm_synchronize`). Idempotent DROP+ADD; does
 * NOT auto-run.
 */
export class CitizenModerationV2Checks1796000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "citizen_identities" DROP CONSTRAINT IF EXISTS "ck_citizen_identity_status";`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "citizen_identities" ADD CONSTRAINT "ck_citizen_identity_status" CHECK ("status" IN ('active','blocked','deleted','suspended'));`,
    );

    await queryRunner.query(
      `ALTER TABLE IF EXISTS "citizen_moderation_log" DROP CONSTRAINT IF EXISTS "ck_citizen_moderation_action";`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "citizen_moderation_log" ADD CONSTRAINT "ck_citizen_moderation_action" CHECK ("action" IN ('report','hide','remove','restore','block_author','appeal_uphold','suspend_author','reinstate_author'));`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Revert to the W-G1 / M0 shapes (drop the W-T3 additions).
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "citizen_moderation_log" DROP CONSTRAINT IF EXISTS "ck_citizen_moderation_action";`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "citizen_moderation_log" ADD CONSTRAINT "ck_citizen_moderation_action" CHECK ("action" IN ('report','hide','remove','restore','block_author'));`,
    );

    await queryRunner.query(
      `ALTER TABLE IF EXISTS "citizen_identities" DROP CONSTRAINT IF EXISTS "ck_citizen_identity_status";`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "citizen_identities" ADD CONSTRAINT "ck_citizen_identity_status" CHECK ("status" IN ('active','blocked','deleted'));`,
    );
  }
}
