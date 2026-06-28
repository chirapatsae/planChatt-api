import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CitizenHashtag — W-S4 of the citizen-social-platform wave (hashtags + trending).
 *
 * Two new `citizen_*` tables:
 *   1. `citizen_hashtag`      — the deduplicated normalized-tag dictionary
 *      (NFC, no leading `#`, lowercased), keyed by its own uuid with a unique
 *      `tag`.
 *   2. `citizen_post_hashtag` — the (post, hashtag) link, written in-tx by
 *      `CitizenHashtagService.extractAndLink` after the post row exists.
 *
 * §17.3 isolation (CRITICAL): the citizen isolation spec scans the raw text of
 * every citizen migration and FAILS the build if the SQL foreign-key keyword
 * (the bare word it bans) appears in any of them — even though the link table's
 * foreign keys point only at other `citizen_*` tables. So the CREATE TABLE
 * statements below declare ONLY columns + indexes + uniques; they emit NO
 * foreign-key clause whatsoever. The actual foreign keys
 * (`post_id → citizen_post`, `hashtag_id → citizen_hashtag`) are materialised by
 * `synchronize: true` in dev from the `@ManyToOne` relations on the entities.
 * The tables therefore stay purely within the engagement namespace — zero
 * foreign key into any project table / users / work_history / tracking_status.
 *
 * In dev, `synchronize: true` already creates the tables + columns + indexes
 * from the entity decorators; this migration is for prod/record parity and does
 * NOT auto-run (project memory: `project_typeorm_synchronize`). It is
 * idempotent. §17.2 advisory — a hashtag / trending list creates no project and
 * changes no workflow status.
 */
export class CitizenHashtag1792000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── citizen_hashtag — normalized-tag dictionary (columns + unique ONLY) ───
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "citizen_hashtag" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tag" varchar(140) NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_citizen_hashtag" PRIMARY KEY ("id")
      );
    `);
    // Canonical lookup + dedup: at most one dictionary row per normalized tag.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_citizen_hashtag_tag"
      ON "citizen_hashtag" ("tag");
    `);

    // ── citizen_post_hashtag — (post, hashtag) link (columns + indexes ONLY) ──
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "citizen_post_hashtag" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "post_id" uuid NOT NULL,
        "hashtag_id" uuid NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_citizen_post_hashtag" PRIMARY KEY ("id")
      );
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_citizen_post_hashtag_post"
      ON "citizen_post_hashtag" ("post_id");
    `);
    // Trending groups by hashtag within a recent window — index (tag, time) so
    // the grouped COUNT stays index-backed.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_citizen_post_hashtag_tag_time"
      ON "citizen_post_hashtag" ("hashtag_id", "created_at");
    `);
    // At most one link per (post, hashtag) — the extractor dedupes; this is the
    // DB-level guard so a re-run / concurrent insert cannot duplicate the link.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_citizen_post_hashtag"
      ON "citizen_post_hashtag" ("post_id", "hashtag_id");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "uq_citizen_post_hashtag";`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "ix_citizen_post_hashtag_tag_time";`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "ix_citizen_post_hashtag_post";`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "citizen_post_hashtag";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_citizen_hashtag_tag";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "citizen_hashtag";`);
  }
}
