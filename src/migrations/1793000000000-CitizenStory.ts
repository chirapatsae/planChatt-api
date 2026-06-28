import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CitizenStory — W-GATE-3 of the civic-community plan (ephemeral 24h stories).
 *
 * `synchronize: true` creates the `citizen_story` table + plain columns + plain
 * indexes from the entity decorators. This migration re-asserts the two query
 * indexes idempotently (project memory: `project_typeorm_synchronize`), so the
 * active-feed read paths stay index-backed even on a legacy DB. Run after the
 * entity syncs.
 *
 * §17.3 isolation: every object below is inside the `citizen_*` namespace. The
 * ONLY foreign key is citizen_* → citizen_* (declared on the entity, not added
 * here): `author_identity_id → citizen_identities`. There is NO foreign key
 * into any project table / users / work_history / tracking_status — isolation
 * is by construction. (No foreign-key DDL is emitted in this file — the
 * isolation spec forbids the bare keyword even inside a comment.)
 */
export class CitizenStory1793000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // (author, expires_at) — author-grouped active-story lookup.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_citizen_story_author_expires"
      ON "citizen_story" ("author_identity_id", "expires_at");
    `);

    // (expires_at) — active-window scan (expires_at > now) + future expiry sweep.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_citizen_story_expires"
      ON "citizen_story" ("expires_at");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "ix_citizen_story_expires";`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "ix_citizen_story_author_expires";`,
    );
  }
}
