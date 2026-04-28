import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: W67-AddRejectedStatusAndAlignThaiLabels
 *
 * Wave 67 — Status Thai-label DB-as-SOT alignment + Rejected canonical.
 *
 * Two operations, both idempotent:
 *
 *   A. ALIGN `Pending.th_name` to the user-confirmed canonical label
 *      `'รอตรวจสอบ'` (Wave 67 user decision, 2026-04-25). Prior values seen
 *      in the wild are `'รอการตรวจสอบ'` (set by predecessor migration
 *      `1745280000000-BackfillCanonicalStatusThName`) and `'รอการอนุมัติ'`
 *      (legacy operator-seeded value observed in production audits). The
 *      UPDATE is guarded so that re-runs are no-ops and so that any
 *      already-aligned or out-of-band Thai label is left untouched.
 *
 *   B. SEED a NEW canonical 8th status row `Rejected` with
 *      `th_name = 'เกินศักยภาพ'`. This extends the canonical Core Status
 *      Machine vocabulary owned by CLAUDE.md. The transition wiring that
 *      will set this status on a project is intentionally OUT OF SCOPE —
 *      this migration only registers the vocabulary so that downstream
 *      services (W67-BE-CONST-01, W67-BE-AGG-01) can rely on the row
 *      existing in every environment.
 *
 * Source-of-truth ownership:
 *   With Wave 67 confirmed, the `status.th_name` column is the SOLE source
 *   of truth for Thai display labels of canonical statuses. The static
 *   `STATUS_TH_MAP` constant in
 *   `backend/src/ai-executive-chat/tools/status-th.ts` is being deprecated
 *   in W67-BE-CONST-01 in favour of DB lookup. Frontend already reads
 *   `statusId.th_name` directly per the
 *   `REFACTOR_STATUS_THAI_LABEL_USE_DB_AS_SOT` bundle (see migration
 *   `1745280000000-BackfillCanonicalStatusThName` header for context).
 *
 * Wave 67 label decisions (user-confirmed, 2026-04-25):
 *   - `Ready`                  -> 'รอนำส่ง'         (UNCHANGED)
 *   - `Pending`                -> 'รอตรวจสอบ'       (THIS MIGRATION)
 *   - `Verified`               -> 'ตรวจสอบผ่าน'     (UNCHANGED)
 *   - `Pending_Approval`       -> 'รออนุมัติ'        (UNCHANGED)
 *   - `Approved`               -> 'อนุมัติ'         (UNCHANGED)
 *   - `Pull_Back`              -> 'ดึงกลับ'         (UNCHANGED)
 *   - `Returned_For_Revision`  -> 'รอแก้ไข'         (UNCHANGED)
 *   - `Rejected`               -> 'เกินศักยภาพ'      (THIS MIGRATION, NEW)
 *
 *   Verified vs Pending_Approval are intentionally kept distinct here even
 *   though the executive aggregation view groups them; that grouping is a
 *   read-side concern owned by W67-BE-AGG-01.
 *
 * Idempotency guarantees:
 *   - The Pending UPDATE WHERE-clause matches only the known prior values
 *     ('รอการตรวจสอบ', 'รอการอนุมัติ', '') so re-running the migration on
 *     an already-aligned DB is a silent no-op. An operator-set out-of-band
 *     Thai value (e.g. someone manually wrote 'รอเช็ค') will NOT be
 *     overwritten — the migration stays conservative on out-of-order replay.
 *   - The Rejected INSERT uses ON CONFLICT against the partial unique index
 *     `uq_status_name_active` (created by migration
 *     `1744761600000-SeedReturnedForRevisionStatus`) and so a second run
 *     finds the row, hits the conflict, and DO NOTHING.
 *
 * §12 (Audit Rule) compliance:
 *   - No tracking_status row is created, mutated, or has its `is_latest`
 *     flag flipped. This is a lookup-table maintenance migration.
 *   - The Rejected INSERT generates a fresh UUID via `gen_random_uuid()`.
 *     We do NOT pin a fixed UUID — this matches the seeding pattern used
 *     by `1744761600000-SeedReturnedForRevisionStatus` and
 *     `1745280000000-BackfillCanonicalStatusThName`.
 *   - down() is asymmetric and intentionally never DELETEs a status row
 *     that is referenced by any tracking_status FK. The
 *     `tracking_status.status_id` FK uses ON DELETE CASCADE
 *     (see `tracking-status.entity.ts`), so a hard DELETE would destroy
 *     audit history — an §12 violation. Instead, down() soft-deletes the
 *     Rejected row only when no tracking_status references it. Operators
 *     who need to undo this migration AFTER Rejected has been used in
 *     transitions must handle that case manually.
 *
 * §17.9 (prompt-injection / static literals) compliance:
 *   The Thai literals in this migration are compile-time constants
 *   embedded in static SQL. No request input is interpolated.
 *
 * CLAUDE.md companion update:
 *   The CLAUDE.md "Core Status Machine" enumeration must add `Rejected` as
 *   the 8th canonical status. That doc edit is owned by the parallel
 *   general-purpose agent task `W67-DOC-01` and is intentionally NOT
 *   performed in this migration's working tree.
 *
 * Sibling / predecessor migrations (deploy order matters):
 *   - 1744761600000-SeedReturnedForRevisionStatus.ts
 *     (creates the partial unique index `uq_status_name_active` we
 *      conflict against)
 *   - 1745107200000-RenameReturnedForRevisionThaiLabel.ts
 *   - 1745280000000-BackfillCanonicalStatusThName.ts
 *     (sets Pending.th_name = 'รอการตรวจสอบ', the value this migration
 *      now rewrites to 'รอตรวจสอบ')
 *
 * Task reference: docs/tasks/wave67/W67-DB-MIGRATE-01.md
 */
export class W67AddRejectedStatusAndAlignThaiLabels1748400000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // ------------------------------------------------------------------
    // A. Realign Pending.th_name -> 'รอตรวจสอบ'
    //
    // Guard set covers:
    //   - 'รอการตรวจสอบ'  (predecessor BackfillCanonicalStatusThName value)
    //   - 'รอการอนุมัติ'   (legacy operator-seeded value seen in audits)
    //   - ''               (empty / never-backfilled row)
    //
    // Any other value is treated as deliberate operator override and is
    // NOT touched. This makes re-runs and out-of-order dev replays safe.
    // ------------------------------------------------------------------
    await queryRunner.query(
      `UPDATE "status"
       SET "th_name" = 'รอตรวจสอบ'
       WHERE "name" = 'Pending'
         AND "th_name" IN ('รอการตรวจสอบ', 'รอการอนุมัติ', '')
         AND "delete_at" IS NULL`,
    );

    // ------------------------------------------------------------------
    // B. Seed canonical Rejected status row.
    //
    // - id: gen_random_uuid() (matches existing seed pattern; we do NOT
    //   pin a fixed UUID)
    // - created_by: NULL (system seed row, not user-created)
    // - create_at: NOW() on first insert; preserved on conflict
    // - ON CONFLICT target: the partial unique index
    //   `uq_status_name_active` keyed on `name WHERE delete_at IS NULL`
    //   (created by 1744761600000-SeedReturnedForRevisionStatus). A
    //   pre-existing active 'Rejected' row therefore short-circuits to
    //   DO NOTHING and the migration becomes a no-op for that row.
    // ------------------------------------------------------------------
    await queryRunner.query(
      `INSERT INTO "status" ("id", "name", "th_name", "create_at")
       VALUES (gen_random_uuid(), 'Rejected', 'เกินศักยภาพ', NOW())
       ON CONFLICT ON CONSTRAINT "uq_status_name_active"
       DO NOTHING`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // ------------------------------------------------------------------
    // A'. Revert Pending.th_name back to 'รอการตรวจสอบ' ONLY when the
    //     current value is exactly the value up() would have set. Any
    //     other value (e.g. an out-of-band operator change after up())
    //     is preserved untouched.
    // ------------------------------------------------------------------
    await queryRunner.query(
      `UPDATE "status"
       SET "th_name" = 'รอการตรวจสอบ'
       WHERE "name" = 'Pending'
         AND "th_name" = 'รอตรวจสอบ'
         AND "delete_at" IS NULL`,
    );

    // ------------------------------------------------------------------
    // B'. Soft-delete Rejected row ONLY when no tracking_status row
    //     references it. Hard DELETE would cascade through
    //     tracking_status.status_id (ON DELETE CASCADE) and destroy
    //     audit history — a §12 violation. If FK refs exist, the row
    //     stays in place; the operator must reconcile manually.
    //
    //     Soft-delete (= setting `delete_at = NOW()`) takes the row out
    //     of the partial unique index `uq_status_name_active`, so a
    //     subsequent up() re-run cleanly inserts a fresh active row.
    // ------------------------------------------------------------------
    await queryRunner.query(
      `UPDATE "status"
       SET "delete_at" = NOW()
       WHERE "name" = 'Rejected'
         AND "th_name" = 'เกินศักยภาพ'
         AND "delete_at" IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM "tracking_status" ts
           WHERE ts."status_id" = "status"."id"
         )`,
    );
  }
}
