import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CitizenAppeal — W-T3 of the citizen-social-platform wave (moderation v2:
 * appeals).
 *
 * One new `citizen_*` table `citizen_appeal` storing a citizen's appeal against a
 * hidden / removed / shadowed post: the post + appellant FKs, the reason, the
 * `open|upheld|reversed` status, and the resolving STAFF member as a PLAIN uuid +
 * SNAPSHOT name (no FK, like C4 `citizen_official_response`).
 *
 * §17.3 isolation (CRITICAL): the citizen isolation spec scans the raw text of
 * every citizen migration and FAILS the build if the SQL foreign-key keyword
 * (the bare word it bans) appears in any of them — even inside a comment. So the
 * CREATE TABLE below declares ONLY columns + indexes + the partial-unique + the
 * status CHECK; it emits NO foreign-key clause whatsoever. The actual foreign keys
 * (`post_id → citizen_post`, `appellant_identity_id → citizen_identities`) are
 * materialised by `synchronize: true` in dev from the `@ManyToOne` relations on
 * the entity. The table therefore stays purely within the engagement namespace —
 * zero foreign key into any project table / users / work_history / tracking_status.
 *
 * In dev, `synchronize: true` already creates the table + columns + indexes from
 * the entity decorators; this migration is for prod/record parity and does NOT
 * auto-run (project memory: `project_typeorm_synchronize`). It is idempotent.
 * §17.2 advisory — an appeal changes a post's display state only and writes no
 * `tracking_status`.
 */
export class CitizenAppeal1795000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── citizen_appeal — citizen appeal of a moderated post (columns + indexes ONLY) ──
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "citizen_appeal" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "post_id" uuid NOT NULL,
        "appellant_identity_id" uuid NOT NULL,
        "reason" varchar(500) NOT NULL,
        "status" varchar(12) NOT NULL DEFAULT 'open',
        "resolver_work_history_id" uuid,
        "resolver_name" varchar(255),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "resolved_at" timestamptz,
        "deleted_at" timestamptz,
        CONSTRAINT "pk_citizen_appeal" PRIMARY KEY ("id")
      );
    `);

    // status is one of the three FROZEN values.
    await queryRunner.query(
      `ALTER TABLE "citizen_appeal" DROP CONSTRAINT IF EXISTS "ck_citizen_appeal_status";`,
    );
    await queryRunner.query(
      `ALTER TABLE "citizen_appeal" ADD CONSTRAINT "ck_citizen_appeal_status" CHECK ("status" IN ('open','upheld','reversed'));`,
    );

    // Staff-queue scan (open appeals, newest-first) + per-post lookup.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_citizen_appeal_status"
      ON "citizen_appeal" ("status", "created_at");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_citizen_appeal_post"
      ON "citizen_appeal" ("post_id");
    `);

    // At most ONE OPEN appeal per (post, appellant) — a citizen can re-appeal
    // only after a prior appeal is resolved (upheld/reversed) or soft-deleted.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_citizen_appeal_one_open"
      ON "citizen_appeal" ("post_id", "appellant_identity_id")
      WHERE "deleted_at" IS NULL AND "status" = 'open';
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_citizen_appeal_one_open";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "ix_citizen_appeal_post";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "ix_citizen_appeal_status";`);
    await queryRunner.query(
      `ALTER TABLE "citizen_appeal" DROP CONSTRAINT IF EXISTS "ck_citizen_appeal_status";`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "citizen_appeal";`);
  }
}
