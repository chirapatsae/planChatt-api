import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: AddEngagementCountersToSupplementProjectGroups
 *
 * Wave public-archive-supplement BE-01.
 *
 * Adds the denormalized engagement counter columns (`like_count`,
 * `view_count`) to `supplement_project_groups` so SPG can participate
 * in the same anonymous public-archive engagement surface that already
 * backs `project_groups` and `revised_project_groups`
 * (see migration `1780100000000-AddEngagementCountersAndEvents`).
 *
 * Critical invariants preserved by this migration:
 *
 *   - CLAUDE.md §17.3 audit-separation — engagement event tables
 *     (`engagement_likes`, `engagement_view_events`) keep their plain
 *     UUID `target_id` discriminator with NO foreign key. This
 *     migration adds COUNTER columns only; no new FK is introduced.
 *
 *   - CLAUDE.md §12 — engagement counter columns are denormalized
 *     read-side optimizations; they NEVER touch `tracking_status`.
 *
 *   - PostgreSQL ≥ 11 — adding `INT NOT NULL DEFAULT 0` is a
 *     metadata-only operation (instant ALTER, no table rewrite). The
 *     project already targets Postgres 14+, so the cost is constant.
 *
 *   - Reversible — `down()` drops the two columns in the same order
 *     they were added. Drops are guarded with `IF EXISTS` so re-running
 *     on a partially-migrated database is safe.
 *
 * PDPA: no PII column is added; counters are plain integers.
 */
export class AddEngagementCountersToSupplementProjectGroups1781000000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "supplement_project_groups"
        ADD COLUMN IF NOT EXISTS "like_count" integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "view_count" integer NOT NULL DEFAULT 0;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "supplement_project_groups"
        DROP COLUMN IF EXISTS "view_count",
        DROP COLUMN IF EXISTS "like_count";
    `);
  }
}
