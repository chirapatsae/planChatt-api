import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CitizenPoll — W-S7 of the citizen-social-platform wave (civic polls).
 *
 * A poll is a `citizen_post` with `post_kind = 'poll'`; its question is the
 * post `detail`, its 2..6 options live in `citizen_poll_option`, and votes live
 * in `citizen_poll_vote` (one live vote per citizen per poll). This migration:
 *   1. CREATEs the two new `citizen_*` tables (plain columns + indexes +
 *      partial-unique ONLY — see the isolation note below),
 *   2. EXTENDs the `ck_citizen_post_kind` CHECK to allow `'poll'`,
 *   3. ADDs the optional `poll_closes_at` column to `citizen_post`.
 *
 * §17.3 isolation (CRITICAL): the citizen isolation spec scans the raw text of
 * every citizen migration and forbids the SQL foreign-key keyword (the bare
 * word it bans) in any of them — even though the new tables' FKs point only at
 * other `citizen_*` tables. So the CREATE TABLE statements below declare ONLY
 * columns + indexes + the partial-unique; they emit NO foreign-key clause
 * whatsoever. The actual foreign keys (`post_id → citizen_post`,
 * `option_id → citizen_poll_option`, `voter_identity_id → citizen_identities`)
 * are materialised by `synchronize: true` in dev from the `@ManyToOne`
 * relations on the entities. The tables therefore stay purely within the
 * engagement namespace — zero foreign key into any project table / users /
 * work_history / tracking_status.
 *
 * In dev, `synchronize: true` already creates the tables + columns + plain
 * indexes from the entity decorators; this migration is for prod/record parity
 * and does NOT auto-run (project memory: `project_typeorm_synchronize`). It is
 * idempotent. §17.2 advisory — a poll creates no project and changes no
 * workflow status.
 */
export class CitizenPoll1791000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── citizen_poll_option — 2..6 options per poll (columns + index ONLY) ────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "citizen_poll_option" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "post_id" uuid NOT NULL,
        "label" varchar(120) NOT NULL,
        "sort_order" int NOT NULL DEFAULT 0,
        "vote_count" int NOT NULL DEFAULT 0,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_citizen_poll_option" PRIMARY KEY ("id")
      );
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_citizen_poll_option_post"
      ON "citizen_poll_option" ("post_id");
    `);

    // ── citizen_poll_vote — one live vote per citizen per poll ────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "citizen_poll_vote" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "post_id" uuid NOT NULL,
        "option_id" uuid NOT NULL,
        "voter_identity_id" uuid NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "deleted_at" timestamptz NULL,
        CONSTRAINT "pk_citizen_poll_vote" PRIMARY KEY ("id")
      );
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_citizen_poll_vote_post"
      ON "citizen_poll_vote" ("post_id");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_citizen_poll_vote_voter"
      ON "citizen_poll_vote" ("voter_identity_id");
    `);
    // One LIVE vote per (poll, voter) — toggle = soft-delete / re-insert
    // (same partial-predicate shape as the C2 reaction / W-S3 bookmark toggle);
    // a re-vote after un-vote succeeds because the soft-deleted row is excluded.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_citizen_poll_vote_one_per_voter"
      ON "citizen_poll_vote" ("post_id", "voter_identity_id")
      WHERE "deleted_at" IS NULL;
    `);

    // ── Extend the post-kind CHECK to allow 'poll' (drop-then-add, idempotent) ─
    await queryRunner.query(
      `ALTER TABLE "citizen_post" DROP CONSTRAINT IF EXISTS "ck_citizen_post_kind";`,
    );
    await queryRunner.query(
      `ALTER TABLE "citizen_post" ADD CONSTRAINT "ck_citizen_post_kind" CHECK ("post_kind" IN ('idea','discussion','poll'));`,
    );

    // ── Add the optional poll close time to citizen_post ──────────────────────
    await queryRunner.query(
      `ALTER TABLE "citizen_post" ADD COLUMN IF NOT EXISTS "poll_closes_at" timestamptz NULL;`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "citizen_post" DROP COLUMN IF EXISTS "poll_closes_at";`,
    );

    // Restore the pre-W-S7 post-kind CHECK (idea | discussion).
    await queryRunner.query(
      `ALTER TABLE "citizen_post" DROP CONSTRAINT IF EXISTS "ck_citizen_post_kind";`,
    );
    await queryRunner.query(
      `ALTER TABLE "citizen_post" ADD CONSTRAINT "ck_citizen_post_kind" CHECK ("post_kind" IN ('idea','discussion'));`,
    );

    await queryRunner.query(
      `DROP INDEX IF EXISTS "uq_citizen_poll_vote_one_per_voter";`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "citizen_poll_vote";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "citizen_poll_option";`);
  }
}
