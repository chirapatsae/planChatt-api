import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CitizenReactionType — W-S1 of the citizen-social-platform wave (multi-reaction
 * set). Replaces heart-only with the 4 FROZEN civic reactions
 * (`like` | `love` | `support` | `insightful`) by adding a `reaction_type`
 * scalar to `citizen_post_reaction`.
 *
 * In dev, `synchronize: true` already creates the `reaction_type` column from
 * the entity decorator (default `like`), so existing heart rows take the default
 * (= back-compat: every pre-W-S1 row becomes `like`). This migration is for
 * prod/record parity and does NOT auto-run (project memory:
 * `project_typeorm_synchronize`). It is idempotent.
 *
 * It ALSO migrates the partial-unique from `(post_id, identity_id, reaction)` to
 * `(post_id, identity_id)` so the "ONE reaction per citizen per post" rule holds
 * regardless of which type — the switch path UPDATEs `reaction_type` in place,
 * which never trips the narrowed unique.
 *
 * §17.3 isolation: a pure scalar column + a CHECK + an index swap on the
 * existing `citizen_*` table. NO foreign key is added (no cross-table link),
 * so the table stays purely within the engagement namespace. §17.2 advisory —
 * `reaction_type` only colours the engagement count; ranking still uses the
 * TOTAL live-reaction count.
 */
export class CitizenReactionType1789000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add the scalar with default 'like' — the default backfills existing rows.
    await queryRunner.query(
      `ALTER TABLE "citizen_post_reaction" ADD COLUMN IF NOT EXISTS "reaction_type" varchar(16) NOT NULL DEFAULT 'like';`,
    );

    // Belt-and-braces backfill for any row inserted before the default landed.
    await queryRunner.query(
      `UPDATE "citizen_post_reaction" SET "reaction_type" = 'like' WHERE "reaction_type" IS NULL OR "reaction_type" = '';`,
    );

    // CHECK keeps the set FROZEN at the 4 keys (additive — a future key needs a
    // new migration to widen this).
    await queryRunner.query(
      `ALTER TABLE "citizen_post_reaction" DROP CONSTRAINT IF EXISTS "ck_citizen_reaction_type";`,
    );
    await queryRunner.query(
      `ALTER TABLE "citizen_post_reaction" ADD CONSTRAINT "ck_citizen_reaction_type" CHECK ("reaction_type" IN ('like', 'love', 'support', 'insightful'));`,
    );

    // Narrow the partial-unique to one LIVE reaction per (post, identity) —
    // independent of which type — so the switch UPDATE never trips it.
    await queryRunner.query(
      `DROP INDEX IF EXISTS "uq_citizen_reaction_one_per_identity";`,
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_citizen_reaction_one_per_identity"
      ON "citizen_post_reaction" ("post_id", "identity_id")
      WHERE "deleted_at" IS NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Restore the M0 partial-unique key shape (post, identity, reaction).
    await queryRunner.query(
      `DROP INDEX IF EXISTS "uq_citizen_reaction_one_per_identity";`,
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_citizen_reaction_one_per_identity"
      ON "citizen_post_reaction" ("post_id", "identity_id", "reaction")
      WHERE "deleted_at" IS NULL;
    `);

    await queryRunner.query(
      `ALTER TABLE "citizen_post_reaction" DROP CONSTRAINT IF EXISTS "ck_citizen_reaction_type";`,
    );
    await queryRunner.query(
      `ALTER TABLE "citizen_post_reaction" DROP COLUMN IF EXISTS "reaction_type";`,
    );
  }
}
