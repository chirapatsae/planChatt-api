import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: RenameReturnedForRevisionThaiLabel
 *
 * Renames the Thai display label (`th_name`) of the `Returned_For_Revision`
 * status row in the `status` lookup table from the legacy string
 * `'ส่งกลับแก้ไข'` to the unified canonical string `'รอแก้ไข'`.
 *
 * Business purpose:
 *   User directive (2026-04-16): "use only รอแก้ไข as a thai string".
 *   The system previously exposed two Thai labels for the same canonical
 *   workflow status — `'ส่งกลับแก้ไข'` on the DB-joined `status.th_name`
 *   column and `'รอแก้ไข'` on various FE surfaces. This migration is the
 *   backend half of unifying that label across every surface.
 *
 * CLAUDE.md Status Naming Constraint compliance:
 *   The Status Naming Constraint governs only the English `name` column
 *   (reserving the bare name `'Revision'` in favor of the approved
 *   replacement `'Returned_For_Revision'`). This migration does NOT touch
 *   the `name` column — only the display-only `th_name` column is renamed.
 *   Canonical status semantics are therefore fully preserved:
 *     - `name = 'Returned_For_Revision'`  (UNCHANGED)
 *     - `th_name = 'รอแก้ไข'`             (renamed from 'ส่งกลับแก้ไข')
 *
 * Blast radius — single row, no schema change:
 *   The `status` table is a lookup table. Every `TrackingStatus` record
 *   references it via an FK (`statusId`) and renders the Thai label by
 *   JOIN, not by column copy. Updating this single row therefore causes
 *   every historical and future `TrackingStatus` row to render the new
 *   label automatically, without any backfill or per-row mutation. No
 *   column is added, no constraint is added, no entity is touched.
 *
 * Idempotency:
 *   Both `up()` and `down()` guard on the current value of `th_name` so
 *   that re-running either direction is a safe no-op. This protects dev
 *   databases where the label may have been manually updated during
 *   testing, and guarantees replay safety on shared staging environments.
 *
 * Rollback safety:
 *   The partial unique index `uq_status_name_active` (created by
 *   `1744761600000-SeedReturnedForRevisionStatus`) keys on `name`, NOT on
 *   `th_name`. Updating `th_name` cannot produce a unique-constraint
 *   violation, and the symmetric `down()` is therefore always safe to run
 *   regardless of what other status rows carry the new Thai string in the
 *   future.
 *
 * Sibling work:
 *   - `docs/tasks/FIX_STATUS_UTILS_UNIFY_THAI_LABEL.md` (FIX-1b) covers
 *     the frontend mapping swap and the transitional aliases that keep
 *     the chip color correct during the interim window between backend
 *     and frontend deploys (either deploy order is safe).
 *
 * CLAUDE.md references:
 *   - Status Naming Constraint (English `name` unchanged)
 *   - §12 Audit Rule (TrackingStatus rows are NOT mutated; only the
 *     joined lookup row's display label changes — audit history semantics
 *     unaffected)
 *
 * Task reference: docs/tasks/FIX_BACKEND_RENAME_RETURNED_FOR_REVISION_TH_NAME.md
 */
export class RenameReturnedForRevisionThaiLabel1745107200000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "status"
       SET "th_name" = 'รอแก้ไข'
       WHERE "name" = 'Returned_For_Revision'
         AND "th_name" = 'ส่งกลับแก้ไข'
         AND "delete_at" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "status"
       SET "th_name" = 'ส่งกลับแก้ไข'
       WHERE "name" = 'Returned_For_Revision'
         AND "th_name" = 'รอแก้ไข'
         AND "delete_at" IS NULL`,
    );
  }
}
