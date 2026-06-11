import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: BackfillEquipmentBookedState
 *
 * Wave: equipment-booking-stamp-completeness  /  Task DB-01  (2026-06-11).
 *
 * DOCUMENTATION / FUTURE-PROOFING ONLY — NOT AUTO-RUN.
 *   TypeORM `synchronize: true` is ON in this project. It auto-applies
 *   entity COLUMN changes on server restart but NEVER runs migration files,
 *   and the data source's migration glob targets `src/migrations/` (NOT
 *   `src/database/migrations/`), so this file is never discovered by the
 *   TypeORM CLI either. The RUNNABLE artifact is the sibling plain-SQL file:
 *
 *     docs/tasks/wave-equipment-booking-stamp-completeness/backfill-equipment-booked-state.sql
 *
 *   which the orchestrator executes via psql after deploy. The up()/down()
 *   below mirror that SQL byte-for-spirit so a future environment that DOES
 *   adopt a migration runner stays consistent.
 *
 * WHAT up() DOES
 *   Stamps is_booked = true + booked_at = parent-book.booked_at on RELPG
 *   (revised_equipment_project_groups) and SEPG
 *   (supplement_equipment_project_groups) rows that already live under a
 *   FINALIZED parent book but were stranded with is_booked = false because
 *   the merge-side equipment stamp did not exist before this wave (§20.3
 *   Invariant 1). page_number is left NULL — it cannot be reconstructed
 *   without re-rendering the ผ.03 PDF (accepted per task file §11).
 *
 * BACKFILL GATE (every row must satisfy ALL of):
 *   1. equipment.deleted_at IS NULL
 *   2. equipment.is_booked = false (idempotency — re-run is a no-op)
 *   3. parent book is_booked = true AND deleted_at IS NULL
 *   4. equipment row's LATEST tracking_status resolves to status 'Approved'
 *      (a row rolled back after publish is NOT legitimately in the book)
 *
 * Column-name verification (against the real entities — these equipment
 * entities use explicit @Column({ name: ... }) so the DB columns are
 * snake_case, UNLIKE PG/RPG/SPG which map to camelCase):
 *   revised_equipment_project_groups: is_booked, booked_at, page_number,
 *     development_plan_revision_id, deleted_at
 *   supplement_equipment_project_groups: is_booked, booked_at, page_number,
 *     development_plan_supplement_id, deleted_at
 *   tracking_status: revised_equipment_project_group_id,
 *     supplement_equipment_project_group_id, status_id, is_latest, deleted_at
 *   development_plan_revision / development_plan_supplement: is_booked,
 *     booked_at, deleted_at
 *   status: name, delete_at (soft-delete column is `delete_at`)
 *
 * §17.2 — touches ONLY equipment table columns. NO tracking_status insert,
 * NO ai_* write, NO notification dispatch.
 *
 * down() — best-effort revert with a DOCUMENTED CAVEAT.
 *   There is no marker column distinguishing rows stamped BY THIS BACKFILL
 *   from rows legitimately stamped by a real merge. We approximate "rows
 *   this backfill touched" as: is_booked = true AND page_number IS NULL
 *   (the backfill never sets page_number; a genuine merge DOES set it),
 *   under a still-booked parent book. This best-effort predicate may also
 *   revert a row that a future merge stamped but whose page_number happened
 *   to be NULL — accepted for a documentation-only down().
 */
export class BackfillEquipmentBookedState1781700000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── RELPG backfill ──────────────────────────────────────────────────
    await queryRunner.query(`
      UPDATE revised_equipment_project_groups e
      SET is_booked = true,
          booked_at = dpr.booked_at
      FROM development_plan_revision dpr
      WHERE e.development_plan_revision_id = dpr.id
        AND e.deleted_at IS NULL
        AND e.is_booked = false
        AND dpr.is_booked = true
        AND dpr.deleted_at IS NULL
        AND EXISTS (
          SELECT 1
          FROM tracking_status ts
          JOIN status s ON s.id = ts.status_id AND s.delete_at IS NULL
          WHERE ts.revised_equipment_project_group_id = e.id
            AND ts.is_latest = true
            AND ts."deletedAt" IS NULL
            AND s.name = 'Approved'
        );
    `);

    // ── SEPG backfill ───────────────────────────────────────────────────
    await queryRunner.query(`
      UPDATE supplement_equipment_project_groups e
      SET is_booked = true,
          booked_at = dps.booked_at
      FROM development_plan_supplement dps
      WHERE e.development_plan_supplement_id = dps.id
        AND e.deleted_at IS NULL
        AND e.is_booked = false
        AND dps.is_booked = true
        AND dps.deleted_at IS NULL
        AND EXISTS (
          SELECT 1
          FROM tracking_status ts
          JOIN status s ON s.id = ts.status_id AND s.delete_at IS NULL
          WHERE ts.supplement_equipment_project_group_id = e.id
            AND ts.is_latest = true
            AND ts."deletedAt" IS NULL
            AND s.name = 'Approved'
        );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Best-effort revert (documented caveat above): only rows whose
    // page_number IS NULL AND is_booked = true under a still-booked parent
    // book — the signature of a row this backfill stamped (a genuine merge
    // sets page_number).
    await queryRunner.query(`
      UPDATE revised_equipment_project_groups e
      SET is_booked = false,
          booked_at = NULL
      FROM development_plan_revision dpr
      WHERE e.development_plan_revision_id = dpr.id
        AND e.deleted_at IS NULL
        AND e.is_booked = true
        AND e.page_number IS NULL
        AND dpr.is_booked = true
        AND dpr.deleted_at IS NULL;
    `);

    await queryRunner.query(`
      UPDATE supplement_equipment_project_groups e
      SET is_booked = false,
          booked_at = NULL
      FROM development_plan_supplement dps
      WHERE e.development_plan_supplement_id = dps.id
        AND e.deleted_at IS NULL
        AND e.is_booked = true
        AND e.page_number IS NULL
        AND dps.is_booked = true
        AND dps.deleted_at IS NULL;
    `);
  }
}
