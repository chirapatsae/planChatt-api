import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: W110-LegacyOrphanCleanup
 *
 * Wave 110 W110-BE-01 — One-shot legacy orphan backfill.
 *
 * Purpose
 * -------
 * Pre-W110, cancelling a `DevelopmentPlan` / `DevelopmentPlanRevision`
 * did NOT cascade to the child PG / RPG rows. The result is a small
 * population of "ตกหล่น" (orphan) projects whose parent book is
 * soft-deleted but whose `tracking_status` still reports a workflow
 * status (most commonly `Approved`).
 *
 * This migration is the one-shot fix specified in CLAUDE.md §18.9 and
 * `docs/workflow-orphan-cleanup.md` (Legacy Migration). It is
 * IDEMPOTENT — projects whose latest tracking row is already `Ready`
 * are skipped.
 *
 * Detection predicate (FROZEN)
 * ----------------------------
 *   PG: `pg.deleted_at IS NULL`
 *       AND `pg.is_booked = FALSE`
 *       AND latest `tracking_status.status_id` -> `Status.name = 'Approved'`
 *       AND parent `development_plan.deleted_at IS NOT NULL`
 *
 *   RPG: `rpg.deleted_at IS NULL`
 *        AND parent `development_plan_revision.deleted_at IS NOT NULL`
 *        (any status — pre-W110 revision cancellation also did not
 *         cascade)
 *
 * Action (per match)
 * ------------------
 *   PG  — write a new `Ready` `tracking_status` row with
 *         `staff_remark = 'ระบบทำความสะอาดโครงการคงค้างย้อนหลัง'`,
 *         flip prior `is_latest = FALSE`. The PG row itself is NOT
 *         updated (no `is_booked` flip, no `responsible_agency` clear
 *         — this is a historical sweep, not a live cancel).
 *
 *   RPG — write a tombstone `tracking_status` row with
 *         `is_latest = FALSE` carrying the same staff_remark, then
 *         soft-delete the RPG row.
 *
 * The migration uses raw SQL (no EntityManager) so it can run inside
 * the standard NestJS / TypeORM migration runner without booting the
 * Nest container. The semantics match what
 * `OrphanCleanupService.migrateLegacyOrphans` would emit at runtime —
 * the Nest service exists for ad-hoc re-runs from a maintenance
 * endpoint or admin script (NOT exposed in this wave).
 *
 * Idempotency / re-run safety
 * ---------------------------
 *   - The PG predicate joins on `tracking_status.is_latest = TRUE` AND
 *     `status.name = 'Approved'`. After the first run the rewritten row
 *     has `name = 'Ready'`, so re-runs return zero matches.
 *   - The RPG predicate matches `rpg.deleted_at IS NULL`. After the
 *     first run the row is soft-deleted, so re-runs return zero matches.
 *
 * §17.3 / §18 audit separation
 * ----------------------------
 *   This migration does NOT touch any AI snapshot table — `ai_*` rows
 *   reference projects by UUID without referential integrity per §17.3
 *   and survive both the cascade and this backfill untouched.
 */
export class W110LegacyOrphanCleanup1778000000000
  implements MigrationInterface
{
  private static readonly LEGACY_REMARK =
    'ระบบทำความสะอาดโครงการคงค้างย้อนหลัง';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Resolve the canonical Ready status id once.
    const readyRows = await queryRunner.query(
      `SELECT "id"
         FROM "status"
        WHERE "name" = 'Ready'
          AND ("delete_at" IS NULL)
        LIMIT 1`,
    );
    if (!readyRows || readyRows.length === 0) {
      // Defensive — cannot reset without the canonical status row.
      // Skip the migration silently; subsequent migrations may seed
      // it, after which this migration may be re-run via the runtime
      // service.
      return;
    }
    const readyStatusId: string = readyRows[0].id;

    // ------------------------------------------------------------------
    // PHASE A — PG legacy reset
    // ------------------------------------------------------------------
    const orphanPgs = await queryRunner.query(
      `SELECT pg."id" AS "pg_id",
              ts."id" AS "ts_id",
              ts."created_by" AS "ts_created_by"
         FROM "project_groups" pg
         JOIN "development_plan" dp
           ON dp."id" = pg."development_plan_id"
         JOIN "tracking_status" ts
           ON ts."project_group_id" = pg."id"
          AND ts."is_latest" = TRUE
         JOIN "status" st
           ON st."id" = ts."status_id"
        WHERE pg."deleted_at" IS NULL
          AND pg."isBooked" = FALSE   -- camelCase column (no @Column name)
          AND st."name" = 'Approved'
          AND dp."deleted_at" IS NOT NULL`,
    );

    for (const row of orphanPgs ?? []) {
      // Demote prior latest.
      await queryRunner.query(
        `UPDATE "tracking_status"
            SET "is_latest" = FALSE
          WHERE "id" = $1`,
        [row.ts_id],
      );
      // Insert new Ready row carrying the legacy remark. `created_by`
      // falls back to the original tracking row's creator so the audit
      // chain stays intact even though the operator who originally
      // cancelled the plan is no longer reachable.
      await queryRunner.query(
        `INSERT INTO "tracking_status"
           ("status_id", "is_latest", "staff_remark",
            "project_group_id", "created_by", "create_at")
         VALUES ($1, TRUE, $2, $3, $4, NOW())`,
        [
          readyStatusId,
          W110LegacyOrphanCleanup1778000000000.LEGACY_REMARK,
          row.pg_id,
          row.ts_created_by,
        ],
      );
    }

    // ------------------------------------------------------------------
    // PHASE B — RPG legacy soft-delete + tombstone
    // ------------------------------------------------------------------
    const orphanRpgs = await queryRunner.query(
      `SELECT rpg."id" AS "rpg_id",
              ts."id" AS "ts_id",
              ts."status_id" AS "ts_status_id",
              ts."created_by" AS "ts_created_by"
         FROM "revised_project_groups" rpg
         JOIN "development_plan_revision" dpr
           ON dpr."id" = rpg."development_plan_revision_id"
         LEFT JOIN "tracking_status" ts
           ON ts."revised_project_group_id" = rpg."id"
          AND ts."is_latest" = TRUE
        WHERE rpg."deleted_at" IS NULL
          AND dpr."deleted_at" IS NOT NULL`,
    );

    for (const row of orphanRpgs ?? []) {
      // Demote prior latest if any.
      if (row.ts_id) {
        await queryRunner.query(
          `UPDATE "tracking_status"
              SET "is_latest" = FALSE
            WHERE "id" = $1`,
          [row.ts_id],
        );
      }
      // Tombstone — preserves the original status_id; falls back to
      // Ready when no prior tracking row existed.
      await queryRunner.query(
        `INSERT INTO "tracking_status"
           ("status_id", "is_latest", "staff_remark",
            "revised_project_group_id", "created_by", "create_at")
         VALUES ($1, FALSE, $2, $3, $4, NOW())`,
        [
          row.ts_status_id ?? readyStatusId,
          W110LegacyOrphanCleanup1778000000000.LEGACY_REMARK,
          row.rpg_id,
          row.ts_created_by,
        ],
      );
      // Soft-delete the RPG row.
      await queryRunner.query(
        `UPDATE "revised_project_groups"
            SET "deleted_at" = NOW()
          WHERE "id" = $1`,
        [row.rpg_id],
      );
    }
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Down migration is intentionally a no-op. Reverting the legacy
    // backfill would require restoring the prior Approved status on
    // each PG and undoing the RPG soft-delete — neither operation is
    // safe without operator intent. Per CLAUDE.md §12 audit
    // preservation, the cleanup tracking rows must remain.
  }
}
