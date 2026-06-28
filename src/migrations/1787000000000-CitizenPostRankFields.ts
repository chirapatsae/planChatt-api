import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CitizenPostRankFields — W-F1 of the citizen-social-platform wave (ranked feed
 * foundation). Adds the advisory rank columns + the ranked keyset index to
 * `citizen_post`.
 *
 * In dev, `synchronize: true` already creates the `rank_score` /
 * `last_activity_at` columns and the `ix_citizen_post_feed_rank` index from the
 * entity decorators; existing rows take the column defaults (0 rows today → no
 * backfill needed). This migration is for prod/record parity and does NOT
 * auto-run (project memory: `project_typeorm_synchronize`). It is idempotent.
 *
 * §17.3 isolation: pure scalar columns + an index on the existing `citizen_*`
 * table. NO foreign key is added, so the table stays purely within the
 * engagement namespace. §17.2 advisory — `rank_score` only sorts the feed.
 */
export class CitizenPostRankFields1787000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "citizen_post" ADD COLUMN IF NOT EXISTS "rank_score" double precision NOT NULL DEFAULT 0;`,
    );
    await queryRunner.query(
      `ALTER TABLE "citizen_post" ADD COLUMN IF NOT EXISTS "last_activity_at" timestamptz NOT NULL DEFAULT now();`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "ix_citizen_post_feed_rank" ON "citizen_post" ("moderation_state", "rank_score", "id");`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "ix_citizen_post_feed_rank";`,
    );
    await queryRunner.query(
      `ALTER TABLE "citizen_post" DROP COLUMN IF EXISTS "last_activity_at";`,
    );
    await queryRunner.query(
      `ALTER TABLE "citizen_post" DROP COLUMN IF EXISTS "rank_score";`,
    );
  }
}
