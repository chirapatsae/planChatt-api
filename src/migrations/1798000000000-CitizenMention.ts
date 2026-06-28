import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CitizenMention — W-S6 of the citizen-social-platform wave (@mention).
 *
 * One new `citizen_*` table `citizen_mention` storing an @mention edge from a
 * source POST or COMMENT to a resolved `mentioned_identity_id`. Plus the
 * widening of the C3 `ck_citizen_notification_kind` CHECK to admit the new
 * `'mention'` notification kind.
 *
 * §17.3 isolation (CRITICAL): the citizen isolation spec scans the raw text of
 * every citizen migration and FAILS the build if the SQL foreign-key keyword
 * (the bare word it bans) appears in any of them — even inside a comment. So the
 * CREATE TABLE below declares ONLY columns + indexes + the exactly-one CHECK; it
 * emits NO foreign-key clause whatsoever. The actual foreign keys
 * (`post_id → citizen_post`, `mentioned_identity_id → citizen_identities`) are
 * materialised by `synchronize: true` in dev from the `@ManyToOne` relations on
 * the entity. `comment_id` is a PLAIN uuid (no relation) by design — comments
 * live in `citizen_post_comment` and the mention does not couple to a comment
 * row's lifecycle. The table therefore stays purely within the engagement
 * namespace — zero foreign key into any project table / users / work_history /
 * tracking_status.
 *
 * In dev, `synchronize: true` already creates the table + columns + indexes from
 * the entity decorators; this migration is for prod/record parity and does NOT
 * auto-run (project memory: `project_typeorm_synchronize`). It is idempotent.
 * §17.2 advisory — a mention notifies and creates no project / changes no
 * workflow status.
 */
export class CitizenMention1798000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── citizen_mention — @mention edge (columns + indexes ONLY, no FK clause) ─
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "citizen_mention" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "post_id" uuid,
        "comment_id" uuid,
        "mentioned_identity_id" uuid NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_citizen_mention" PRIMARY KEY ("id")
      );
    `);

    // EXACTLY ONE of (post_id, comment_id) is set — a mention is either on a
    // post OR on a comment, never both, never neither.
    await queryRunner.query(
      `ALTER TABLE "citizen_mention" DROP CONSTRAINT IF EXISTS "ck_citizen_mention_source";`,
    );
    await queryRunner.query(
      `ALTER TABLE "citizen_mention" ADD CONSTRAINT "ck_citizen_mention_source" CHECK (("post_id" IS NOT NULL) <> ("comment_id" IS NOT NULL));`,
    );

    // Render-time linkify lookups: all mentions for a post / a comment.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_citizen_mention_post"
      ON "citizen_mention" ("post_id");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_citizen_mention_comment"
      ON "citizen_mention" ("comment_id");
    `);
    // "Who mentioned me" advisory lookups.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_citizen_mention_mentioned"
      ON "citizen_mention" ("mentioned_identity_id");
    `);

    // ── widen the notification-kind CHECK to admit 'mention' (W-S6) ───────────
    // The C3 migration created the CHECK as ('comment','heart'); C4 widened it
    // to add 'official_response'. Re-assert the full set + 'mention'
    // (drop-then-add → idempotent; no IF NOT EXISTS for constraints).
    await queryRunner.query(
      `ALTER TABLE "citizen_notification" DROP CONSTRAINT IF EXISTS "ck_citizen_notification_kind";`,
    );
    await queryRunner.query(
      `ALTER TABLE "citizen_notification" ADD CONSTRAINT "ck_citizen_notification_kind" CHECK ("kind" IN ('comment','heart','official_response','mention'));`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Revert the notification-kind CHECK back to the C4 set (without 'mention').
    await queryRunner.query(
      `ALTER TABLE "citizen_notification" DROP CONSTRAINT IF EXISTS "ck_citizen_notification_kind";`,
    );
    await queryRunner.query(
      `ALTER TABLE "citizen_notification" ADD CONSTRAINT "ck_citizen_notification_kind" CHECK ("kind" IN ('comment','heart','official_response'));`,
    );

    await queryRunner.query(`DROP INDEX IF EXISTS "ix_citizen_mention_mentioned";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "ix_citizen_mention_comment";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "ix_citizen_mention_post";`);
    await queryRunner.query(
      `ALTER TABLE "citizen_mention" DROP CONSTRAINT IF EXISTS "ck_citizen_mention_source";`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "citizen_mention";`);
  }
}
