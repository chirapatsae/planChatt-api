import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: AddBookedFieldsToSupplementProjectGroups
 *
 * Wave wave-supplement-convergence-milestone-2-spg-booked-fields / DB-01
 * (2026-05-25).
 *
 * Brings `supplement_project_groups` (SPG) to PG / RPG parity per
 * CLAUDE.md §20 by adding the two finalize-state columns SPG was
 * intentionally missing in Wave-A (per the SPG "always-booked-when-
 * persisted" lite design noted in
 * `ai-executive-chat/tools/tool-registry.ts:128`). User direction
 * 2026-05-25 confirmed the convergence ("เก็บให้เหมือนกัน"), so the
 * Wave-A-lite shortcut is being lifted.
 *
 * Schema deltas (additive only):
 *
 *   supplement_project_groups:
 *     - is_booked  BOOLEAN     NOT NULL  DEFAULT false
 *     - booked_at  TIMESTAMP   NULL
 *
 * Byte-for-byte typing source of truth:
 *
 *   - `ProjectGroup.isBooked / bookedAt`        — entity lines 69-73
 *   - `RevisedProjectGroup.isBooked / bookedAt` — entity lines 91-95
 *
 * Both use `{ default: false }` for `isBooked` and `{ type: 'timestamp',
 * nullable: true }` for `bookedAt`. We match exactly — no `TIMESTAMPTZ`
 * here even though the book-level Wave 116 columns
 * (`development_plan(_revision|_supplement).booked_at`) use TZ. Project-
 * level columns historically have used `timestamp` (no TZ) and the §20
 * parity contract is with PG / RPG, not with the book-level tables.
 *
 * `pageNumber` (already present on SPG since
 * 1748300000000-AddPageNumberToSupplementProjectGroups) is KEPT AS-IS.
 * M3 may eventually retire the "pageNumber = booked-state signal"
 * semantic, but that is out of scope for M2 — this migration is purely
 * additive.
 *
 * Backfill (idempotent guard `is_booked = false`):
 *
 *   For every SPG whose parent `development_plan_supplement` row has
 *   `is_booked = true AND booked_at IS NOT NULL`, set the SPG's
 *   `is_booked = true` and copy the parent's `booked_at`. Live data at
 *   the time of this wave is exactly one booked supplement; the
 *   predicate is shape-correct for future bookings as well.
 *
 *   Legacy SPG rows whose parent supplement is `is_booked = false`
 *   (draft / unmerged supplement, never finalized) keep
 *   `is_booked = false` / `booked_at = NULL` — correct because their
 *   parent book never reached the finalize moment.
 *
 *   Reverse direction (parent booked but child already booked) is a
 *   no-op due to the `spg.is_booked = false` guard.
 *
 * Critical invariants preserved:
 *
 *   - CLAUDE.md §15 — additive, NULL-able / DEFAULT-friendly. No book-
 *     lock or workflow path is altered. The new columns are read-side
 *     metadata only at this migration step; BE-01 will wire the write
 *     paths in this same wave.
 *
 *   - CLAUDE.md §17.2 — advisory metadata. The new columns do not gate
 *     any workflow transition. AI snapshot logic is untouched.
 *
 *   - CLAUDE.md §18 — orphan-cleanup cascade is unaffected. The cascade
 *     soft-deletes SPG rows by writing a tombstone TrackingStatus row
 *     and flipping `deleted_at`; it never reads or writes `is_booked` /
 *     `booked_at` on the project-level rows.
 *
 *   - Idempotent — `ADD COLUMN IF NOT EXISTS` + UPDATE guarded by
 *     `is_booked = false` means re-run is a no-op.
 *
 *   - Reversibility — `down()` drops both columns with `IF EXISTS`. No
 *     data restoration is needed because the columns are additive and
 *     downstream consumers do not exist yet (BE-01 ships in the same
 *     wave; this migration is the first to introduce the column).
 *
 *   - synchronize: true caveat — on environments where the schema is
 *     auto-synced from entities (CLAUDE.md / memory note), the columns
 *     will be added automatically on BE restart but the backfill UPDATE
 *     below will NOT run. The orchestrator MUST execute the backfill
 *     SQL manually via psql after deploy. The backfill is idempotent
 *     so running it twice is harmless.
 */
export class AddBookedFieldsToSupplementProjectGroups1781400000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Step 1: Add columns to supplement_project_groups ─────────────────

    // Column-naming convention note:
    //   - Project-group entities (PG / RPG / SPG) use TypeORM default
    //     JS-property → column-name mapping → DB columns are camelCase
    //     (`"isBooked"`, `"bookedAt"`). Verified against
    //     `project_groups`.`isBooked` / `bookedAt`.
    //   - Book entities (DPS / DPR / DP) use explicit `@Column({ name: ... })`
    //     overrides → DB columns are snake_case (`"is_booked"`,
    //     `"booked_at"`). Verified against `development_plan_supplement`.
    // This migration adds camelCase columns to SPG (parity with PG/RPG)
    // and joins parent via snake_case (matches DPS).

    await queryRunner.query(`
      ALTER TABLE "supplement_project_groups"
        ADD COLUMN IF NOT EXISTS "isBooked" BOOLEAN NOT NULL DEFAULT false;
    `);

    await queryRunner.query(`
      ALTER TABLE "supplement_project_groups"
        ADD COLUMN IF NOT EXISTS "bookedAt" TIMESTAMP NULL;
    `);

    // ── Step 2: Backfill from PUBLISHED VERSION SNAPSHOT (parity-correct) ─
    //
    // PG/RPG `isBooked=true` semantic is "row appears in a non-deprecated
    // published version's part3 snapshot" — NOT "parent plan is booked".
    // Mirror that here. Title-based JSONB containment (snapshot stores
    // titles per existing supplement metadata-parity wave) is the
    // canonical predicate.
    //
    // Idempotency guard: `spg."isBooked" = false` ensures re-runs are
    // no-ops. Draft SPGs / SPGs created after merge stay
    // `isBooked=false` correctly.

    await queryRunner.query(`
      UPDATE "supplement_project_groups" AS spg
         SET "isBooked" = true,
             "bookedAt" = v."merged_at"
        FROM "supplement_assembly_versions" AS v
       WHERE v."development_plan_supplement_id" = spg."development_plan_supplement_id"
         AND v."status" = 'completed'
         AND v."part3_project_snapshot" @> to_jsonb(spg."title"::text)
         AND spg."isBooked" = false;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverse: drop the two columns. No index was added by up(), so
    // there is nothing else to undo. IF EXISTS makes partial-state
    // databases safe.

    await queryRunner.query(`
      ALTER TABLE "supplement_project_groups"
        DROP COLUMN IF EXISTS "bookedAt";
    `);

    await queryRunner.query(`
      ALTER TABLE "supplement_project_groups"
        DROP COLUMN IF EXISTS "isBooked";
    `);
  }
}
