import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: AddVersionDimsToViewEvents
 *
 * Wave per-version-engagement-counts DB-01 (2026-06-01).
 *
 * Makes `engagement_view_events` per-version by aligning it to the same
 * `(source_type, source_id, version_number)` shape that
 * `engagement_download_events` already carries. This lets the public
 * archive surface per-sub-book-version view counts in each
 * `<VersionRow>`.
 *
 * Critical invariants preserved:
 *
 *   - CLAUDE.md §17.3 audit-separation — the new `source_type` /
 *     `source_id` / `version_number` columns are PLAIN columns. NO
 *     foreign key to project / plan / revision / supplement tables.
 *     §14.6 rollback + §18 orphan-cleanup cascades stay isolated from
 *     engagement history.
 *
 *   - PDPA — no IP, no User-Agent column.
 *
 *   - Debounce semantics — the unique debounce key WIDENS from
 *     `(target_kind, target_id, device_id, view_date)` to
 *     `(target_kind, target_id, source_type, source_id, version_number,
 *     device_id, view_date)`. The legacy four members remain in the
 *     key, so legacy plan-level / project-level rows (version columns
 *     NULL) keep their exact once-per-(target,device,day) debounce —
 *     the NULL version columns are additive and never block a legacy
 *     insert.
 *
 * Deploy note (synchronize:true instances): the three NULLABLE columns
 * are also declared on the `EngagementViewEvent` entity, so TypeORM
 * `synchronize` adds the COLUMNS automatically on backend restart. The
 * CONSTRAINT swap below is what `synchronize` does NOT apply reliably
 * for an existing named constraint — run this migration (or the SQL it
 * contains) manually so the wide debounce key is active. The service
 * layer references the NEW constraint column-list in its `ON CONFLICT`
 * clause, so the migration MUST be applied for the per-version view
 * debounce to function on a non-fresh DB. (Legacy column-only
 * `synchronize` deploys: the columns appear; apply this migration to
 * complete the constraint swap.)
 *
 * Reversible — `down()` restores the narrow constraint and drops the
 * three columns (LIFO, IF EXISTS guards).
 */
export class AddVersionDimsToViewEvents1781200000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── New nullable columns (idempotent — covers non-synchronize DBs)
    // §17.3 — NO REFERENCES clause; `source_id` is a plain uuid.
    await queryRunner.query(`
      ALTER TABLE "engagement_view_events"
        ADD COLUMN IF NOT EXISTS "source_type" varchar(32) NULL,
        ADD COLUMN IF NOT EXISTS "source_id" uuid NULL,
        ADD COLUMN IF NOT EXISTS "version_number" integer NULL;
    `);

    // ── Swap the debounce unique constraint to the wide key.
    //
    // We use a COALESCE-based EXPRESSION UNIQUE INDEX rather than a
    // plain multi-column UNIQUE constraint. Reason: Postgres treats
    // NULL as DISTINCT under a plain unique constraint, so two
    // legacy / project-level views (version columns all NULL) on the
    // same (target, device, day) would NOT conflict and the
    // once-per-day debounce would silently break. COALESCing the three
    // nullable version columns to sentinels ('' / zero-uuid / -1)
    // collapses every NULL-version row to a single arbiter value,
    // preserving the EXACT legacy debounce while still distinguishing
    // distinct version-scoped rows.
    //
    // The service's INSERT references the SAME expression list in its
    // ON CONFLICT target so this index is the conflict arbiter.
    await queryRunner.query(`
      ALTER TABLE "engagement_view_events"
        DROP CONSTRAINT IF EXISTS "uq_engagement_views_target_device_day";
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "uq_engagement_views_target_ver_device_day";
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_engagement_views_target_ver_device_day"
        ON "engagement_view_events" (
          "target_kind",
          "target_id",
          COALESCE("source_type", ''),
          COALESCE("source_id", '00000000-0000-0000-0000-000000000000'::uuid),
          COALESCE("version_number", -1),
          "device_id",
          "view_date"
        );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Restore the narrow constraint, then drop the columns (LIFO).
    await queryRunner.query(`
      DROP INDEX IF EXISTS "uq_engagement_views_target_ver_device_day";
    `);
    await queryRunner.query(`
      ALTER TABLE "engagement_view_events"
        ADD CONSTRAINT "uq_engagement_views_target_device_day"
        UNIQUE ("target_kind", "target_id", "device_id", "view_date");
    `);
    await queryRunner.query(`
      ALTER TABLE "engagement_view_events"
        DROP COLUMN IF EXISTS "version_number",
        DROP COLUMN IF EXISTS "source_id",
        DROP COLUMN IF EXISTS "source_type";
    `);
  }
}
