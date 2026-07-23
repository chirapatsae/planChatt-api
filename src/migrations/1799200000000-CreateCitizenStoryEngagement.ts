import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CreateCitizenStoryEngagement — story VIEW tracking + emoji REACTIONS for the
 * ephemeral 24h citizen stories (FB-6).
 *
 * `synchronize: true` creates the `citizen_story_views` /
 * `citizen_story_reactions` tables + columns + the plain indexes from the
 * entity decorators on dev boxes. This migration is the prod-parity path (and
 * dev boxes that run the migration runner without synchronize): every statement
 * is idempotent (`CREATE TABLE / INDEX IF NOT EXISTS`, and the CHECK is added
 * only if absent).
 *
 * §17.3 isolation: every object lives in the `citizen_*` namespace. `story_id`,
 * `viewer_identity_id`, and `identity_id` are ALL PLAIN uuid columns with NO FK
 * (mirrors citizen_password_reset_tokens / citizen_audit_logs), so a PDPA erase
 * never cascades and the 24h retention sweep purges independently. There is NO
 * FK into any project table / users / work_history / tracking_status.
 *
 * FB-6: `emoji` stores a CLOSED-SET KEY (`love` | `haha` | `wow` | `sad` |
 * `angry` | `like`), not the glyph — the CHECK is defense-in-depth behind the
 * service-layer validation. Un-react is a HARD DELETE (24h-ephemeral data, no
 * soft-delete).
 */
export class CreateCitizenStoryEngagement1799200000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- citizen_story_views -------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "citizen_story_views" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "story_id" uuid NOT NULL,
        "viewer_identity_id" uuid NOT NULL,
        "viewed_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_citizen_story_views" PRIMARY KEY ("id")
      );
    `);

    // One view row per viewer per story — first-view time kept, upsert-idempotent.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_citizen_story_view_story_viewer"
      ON "citizen_story_views" ("story_id", "viewer_identity_id");
    `);

    // Owner audience page — recent viewers of a story first.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_citizen_story_view_story_viewed"
      ON "citizen_story_views" ("story_id", "viewed_at" DESC);
    `);

    // DSAR erase — purge all views by a given viewer.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_citizen_story_view_viewer"
      ON "citizen_story_views" ("viewer_identity_id");
    `);

    // --- citizen_story_reactions --------------------------------------------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "citizen_story_reactions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "story_id" uuid NOT NULL,
        "identity_id" uuid NOT NULL,
        "emoji" varchar(16) NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_citizen_story_reactions" PRIMARY KEY ("id"),
        CONSTRAINT "ck_citizen_story_reaction_emoji"
          CHECK ("emoji" IN ('love','haha','wow','sad','angry','like'))
      );
    `);

    // One reaction per citizen per story — update-in-place.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_citizen_story_reaction_story_identity"
      ON "citizen_story_reactions" ("story_id", "identity_id");
    `);

    // Per-story emoji breakdown.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_citizen_story_reaction_story"
      ON "citizen_story_reactions" ("story_id");
    `);

    // DSAR erase — purge all reactions by a given citizen.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_citizen_story_reaction_identity"
      ON "citizen_story_reactions" ("identity_id");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "citizen_story_reactions";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "citizen_story_views";`);
  }
}
