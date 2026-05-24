import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: AddEngagementCountersAndEvents
 *
 * Wave engagement-counters BE-01.
 *
 * Adds:
 *   - denormalized counter columns on `project_groups`,
 *     `revised_project_groups`, `development_plan`
 *   - three append-only event tables (`engagement_likes`,
 *     `engagement_view_events`, `engagement_download_events`)
 *
 * Critical invariants enforced by this migration:
 *
 *   - CLAUDE.md §17.3 audit-separation — engagement event tables MUST
 *     NOT carry a foreign key to project_groups, revised_project_groups,
 *     or development_plan. `target_id` / `source_id` / `development_plan_id`
 *     are plain UUID columns. This guarantees §14.6 staff-led rollback
 *     and §18 orphan-cleanup cascades do NOT touch engagement history.
 *
 *   - CLAUDE.md §12 — engagement tables MUST NOT touch `tracking_status`.
 *
 *   - PostgreSQL ≥ 11 — adding `INT NOT NULL DEFAULT 0` is metadata-only
 *     (instant ALTER, no table rewrite). Confirm production PG version
 *     before running.
 *
 *   - Reversible — `down()` drops indexes, then tables, then columns in
 *     LIFO order. Drops are guarded with IF EXISTS so re-running on a
 *     partially-migrated DB is safe.
 *
 * PDPA: no IP, no User-Agent column anywhere in this migration.
 */
export class AddEngagementCountersAndEvents1780100000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Counter columns (NOT NULL DEFAULT 0) ──────────────────────
    // PostgreSQL ≥ 11: metadata-only operation; no table rewrite.
    await queryRunner.query(`
      ALTER TABLE "project_groups"
        ADD COLUMN IF NOT EXISTS "like_count" integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "view_count" integer NOT NULL DEFAULT 0;
    `);
    await queryRunner.query(`
      ALTER TABLE "revised_project_groups"
        ADD COLUMN IF NOT EXISTS "like_count" integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "view_count" integer NOT NULL DEFAULT 0;
    `);
    await queryRunner.query(`
      ALTER TABLE "development_plan"
        ADD COLUMN IF NOT EXISTS "view_count" integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "download_count" integer NOT NULL DEFAULT 0;
    `);

    // ── engagement_likes ──────────────────────────────────────────
    // §17.3 — NO REFERENCES clause; `target_id` is a plain uuid.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "engagement_likes" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "target_kind" varchar(32) NOT NULL,
        "target_id" uuid NOT NULL,
        "device_id" uuid NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_engagement_likes" PRIMARY KEY ("id"),
        CONSTRAINT "uq_engagement_likes_target_device"
          UNIQUE ("target_kind", "target_id", "device_id")
      );
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_engagement_likes_target"
      ON "engagement_likes" ("target_kind", "target_id");
    `);

    // ── engagement_view_events ────────────────────────────────────
    // §17.3 — NO REFERENCES clause; `target_id` is a plain uuid.
    // Debounce key: (target_kind, target_id, device_id, view_date).
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "engagement_view_events" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "target_kind" varchar(32) NOT NULL,
        "target_id" uuid NOT NULL,
        "device_id" uuid NOT NULL,
        "view_date" date NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_engagement_view_events" PRIMARY KEY ("id"),
        CONSTRAINT "uq_engagement_views_target_device_day"
          UNIQUE ("target_kind", "target_id", "device_id", "view_date")
      );
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_engagement_views_target"
      ON "engagement_view_events" ("target_kind", "target_id");
    `);

    // ── engagement_download_events ────────────────────────────────
    // §17.3 — NO REFERENCES clause; both `development_plan_id` and
    // `source_id` are plain uuid columns. Append-only, no uniqueness.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "engagement_download_events" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "development_plan_id" uuid NOT NULL,
        "source_type" varchar(32) NOT NULL,
        "source_id" uuid NOT NULL,
        "version_number" integer NOT NULL,
        "device_id" uuid NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_engagement_download_events" PRIMARY KEY ("id")
      );
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_engagement_downloads_plan"
      ON "engagement_download_events" ("development_plan_id");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // LIFO — drop indexes first, then tables, then counter columns.
    await queryRunner.query(`
      DROP INDEX IF EXISTS "ix_engagement_downloads_plan";
    `);
    await queryRunner.query(`
      DROP TABLE IF EXISTS "engagement_download_events";
    `);

    await queryRunner.query(`
      DROP INDEX IF EXISTS "ix_engagement_views_target";
    `);
    await queryRunner.query(`
      DROP TABLE IF EXISTS "engagement_view_events";
    `);

    await queryRunner.query(`
      DROP INDEX IF EXISTS "ix_engagement_likes_target";
    `);
    await queryRunner.query(`
      DROP TABLE IF EXISTS "engagement_likes";
    `);

    await queryRunner.query(`
      ALTER TABLE "development_plan"
        DROP COLUMN IF EXISTS "download_count",
        DROP COLUMN IF EXISTS "view_count";
    `);
    await queryRunner.query(`
      ALTER TABLE "revised_project_groups"
        DROP COLUMN IF EXISTS "view_count",
        DROP COLUMN IF EXISTS "like_count";
    `);
    await queryRunner.query(`
      ALTER TABLE "project_groups"
        DROP COLUMN IF EXISTS "view_count",
        DROP COLUMN IF EXISTS "like_count";
    `);
  }
}
