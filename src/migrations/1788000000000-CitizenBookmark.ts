import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CitizenBookmark — W-S3 of the civic-community plan (save / un-save posts).
 *
 * `synchronize: true` creates the `citizen_bookmark` table + plain columns +
 * plain indexes from the entity decorators. It does NOT create the
 * PARTIAL-UNIQUE index — that lives here (project memory:
 * `project_typeorm_synchronize`), mirroring the C3 follow migration pattern.
 * Run this migration after the entities sync.
 *
 * §17.3 isolation: every object below is inside the `citizen_*` namespace. The
 * only two foreign keys are citizen_* → citizen_* (declared on the entity, not
 * added here): `bookmarker_identity_id → citizen_identities` and
 * `post_id → citizen_post`. There is NO foreign key into any project table /
 * users / work_history / tracking_status — isolation is by construction.
 */
export class CitizenBookmark1788000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // One live bookmark per (bookmarker, post) — toggle = soft-delete /
    // re-insert (same shape as the C3 follow toggle). The partial predicate
    // lets a re-save after un-save succeed (the soft-deleted row is excluded).
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_citizen_bookmark_unique"
      ON "citizen_bookmark" ("bookmarker_identity_id", "post_id")
      WHERE "deleted_at" IS NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_citizen_bookmark_unique";`,
    );
  }
}
