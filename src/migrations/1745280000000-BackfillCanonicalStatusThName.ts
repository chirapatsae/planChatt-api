import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: BackfillCanonicalStatusThName
 *
 * Business purpose:
 *   Guarantee that every non-soft-deleted row in the `status` lookup table
 *   whose `name` is one of the 7 canonical Core Status Machine values has a
 *   non-empty, correct Thai label in the `th_name` column.
 *
 *   This is the hard prerequisite for the frontend bundle
 *   `REFACTOR_STATUS_THAI_LABEL_USE_DB_AS_SOT`, which removes the hardcoded
 *   English->Thai fallback map in `frontend/src/utils/statusUtils.ts` and
 *   `frontend/src/components/modal/ModalChangeStatus.tsx` in favour of
 *   rendering `statusId.th_name` directly. Before this migration runs,
 *   only `Returned_For_Revision` is seeded (by migrations 1744761600000 +
 *   1745107200000). The other 6 canonical rows (`Ready`, `Pending`,
 *   `Verified`, `Pending_Approval`, `Approved`, `Pull_Back`) are created
 *   outside migrations in production and may have `th_name = ''`. After
 *   this migration, every canonical row is guaranteed to have the correct
 *   Thai label regardless of how it was originally created.
 *
 * Deploy order (non-negotiable):
 *   This migration MUST be merged and deployed to every target environment
 *   BEFORE the frontend bundle REFACTOR_STATUS_THAI_LABEL_USE_DB_AS_SOT is
 *   released to users. FE nodes in that bundle delete the hardcoded
 *   English->Thai fallback map in favour of reading status.th_name directly.
 *   Shipping FE before this migration would cause canonical statuses other
 *   than Returned_For_Revision to render as raw English enum literals
 *   (e.g., "Ready", "Pending") in badge chips across the app.
 *
 * Idempotency guarantee:
 *   up() is safe to re-run. For each canonical row:
 *     1. INSERT uses ON CONFLICT ... DO NOTHING keyed on the partial unique
 *        index `uq_status_name_active` (created by migration 1744761600000).
 *        Re-running against an existing row is a silent no-op.
 *     2. UPDATE only rewrites `th_name` when the current value is empty
 *        string or NULL. Pre-existing non-empty Thai labels are preserved.
 *        In particular `Returned_For_Revision.th_name = 'รอแก้ไข'` (set by
 *        migration 1745107200000) is NOT overwritten.
 *
 * CLAUDE.md compliance:
 *   - Core Status Machine: the 7 canonical statuses are seeded exactly.
 *     No extra rows (e.g. `Draft`, `Rejected`) are introduced — those are
 *     not in the canonical set.
 *   - Status Naming Constraint: the reserved literal `Revision` is NOT
 *     used. The approved replacement `Returned_For_Revision` is used
 *     verbatim and with exact casing.
 *   - §12 Audit Rule: NO tracking_status row is created, mutated, or has
 *     its `isLatest` flag flipped. This is a lookup-table maintenance
 *     migration. Status transition history is fully preserved. The
 *     `status.id` UUIDs of any pre-existing canonical rows are preserved,
 *     so every `tracking_status.statusId` FK remains valid.
 *
 * down() semantics:
 *   This migration is intentionally asymmetric in down() to avoid ever
 *   cascade-deleting audit history. The `tracking_status.statusId` FK uses
 *   ON DELETE CASCADE (see `status.entity.ts` @OneToMany relation and
 *   `tracking-status.entity.ts` @ManyToOne), so DELETEing a status row
 *   would destroy every TrackingStatus row that references it — an
 *   audit-rule violation.
 *
 *   Strategy: down() reverts `th_name` back to empty string ONLY when:
 *     (a) the row's current `th_name` exactly matches the canonical Thai
 *         value that up() would have set, AND
 *     (b) no `tracking_status` row references the status id.
 *
 *   This is conservative: a DB that already had the canonical Thai value
 *   BEFORE up() ran (e.g., Returned_For_Revision seeded by 1745107200000)
 *   will have its label cleared by down() — but that is a theoretical
 *   out-of-order replay concern in dev only; production always runs
 *   migrations in order. Rows with tracking references are LEFT AT their
 *   current `th_name`; no DELETE is ever issued.
 *
 *   down() never deletes a row. Rows that up() INSERTed are not removed —
 *   the idempotent up() simply becomes a no-op on a re-run. This trades
 *   strict symmetry for safety: audit history is uncompromisable.
 *
 * Task reference: docs/tasks/DB_SEED_STATUS_TH_NAME_BACKFILL.md
 * Investigation:  docs/reports/STATUS_SOT_REFACTOR_INVESTIGATION.md (§3 seed
 *                 audit, §5 fallback decision, §6 R1/R5/R8 risk register).
 *
 * Sibling / predecessor migrations:
 *   - 1744761600000-SeedReturnedForRevisionStatus.ts
 *     (creates `uq_status_name_active` partial unique index; seeds the one
 *      canonical row known to the system at that time)
 *   - 1745107200000-RenameReturnedForRevisionThaiLabel.ts
 *     (rewrites `Returned_For_Revision.th_name` from 'ส่งกลับแก้ไข' to
 *      the canonical 'รอแก้ไข')
 *
 * Edge case — soft-deleted canonical rows:
 *   A soft-deleted canonical row (`delete_at IS NOT NULL`) does NOT
 *   satisfy the partial unique index `uq_status_name_active` and so does
 *   NOT collide with INSERT. If an operator later restores such a row,
 *   its `th_name` stays at whatever value was set at delete time — this
 *   migration does not re-patch it. That is operator responsibility.
 */
export class BackfillCanonicalStatusThName1745280000000
  implements MigrationInterface
{
  /**
   * The 7 canonical Core Status Machine statuses with their canonical
   * Thai display labels. Source: CLAUDE.md Core Status Machine +
   * docs/reports/STATUS_SOT_REFACTOR_INVESTIGATION.md §3.
   *
   * English `name` values MUST match `backend/src/common/status-names.ts`
   * STATUS_NAMES literals exactly. Any drift in this array is caught by
   * `backend/src/common/status-names.spec.ts` (scans the migrations
   * directory for canonical names).
   */
  private static readonly CANONICAL_ROWS: ReadonlyArray<{
    name: string;
    th_name: string;
  }> = [
    { name: 'Ready', th_name: 'รอนำส่ง' },
    { name: 'Pending', th_name: 'รอการตรวจสอบ' },
    { name: 'Verified', th_name: 'ตรวจสอบผ่าน' },
    { name: 'Pending_Approval', th_name: 'รออนุมัติ' },
    { name: 'Approved', th_name: 'อนุมัติ' },
    { name: 'Pull_Back', th_name: 'ดึงกลับ' },
    { name: 'Returned_For_Revision', th_name: 'รอแก้ไข' },
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const row of BackfillCanonicalStatusThName1745280000000.CANONICAL_ROWS) {
      // Step 1: ensure the canonical row exists (idempotent).
      //
      // - ON CONFLICT target is the existing partial unique index
      //   `uq_status_name_active` (from migration 1744761600000), which is
      //   keyed on `name` WHERE `delete_at IS NULL`.
      // - `id = gen_random_uuid()` (PostgreSQL built-in, same as
      //   predecessor seed migration).
      // - `created_by` is intentionally omitted (= NULL) because this is a
      //   system seed row, not user-created. The FK is nullable via
      //   `ON DELETE CASCADE / ON UPDATE CASCADE` but NULL is the
      //   appropriate value for system rows.
      // - `create_at` = NOW() only applies for a freshly INSERTed row; the
      //   DO NOTHING branch preserves the existing `create_at`.
      await queryRunner.query(
        `INSERT INTO "status" ("id", "name", "th_name", "create_at")
         VALUES (gen_random_uuid(), $1, $2, NOW())
         ON CONFLICT ("name") WHERE "delete_at" IS NULL
         DO NOTHING`,
        [row.name, row.th_name],
      );

      // Step 2: patch empty th_name only; preserve any non-empty value.
      //
      // This guard is non-negotiable:
      //   - It protects Returned_For_Revision.th_name = 'รอแก้ไข' (set by
      //     migration 1745107200000) from being clobbered by an identical
      //     rewrite (the UPDATE simply does not match).
      //   - It makes this migration safe to re-run any number of times.
      //   - If an operator manually set a non-canonical Thai label for
      //     dev/testing, this migration leaves that value alone (out-of-
      //     order replay safety).
      await queryRunner.query(
        `UPDATE "status"
         SET "th_name" = $2
         WHERE "name" = $1
           AND "delete_at" IS NULL
           AND ("th_name" = '' OR "th_name" IS NULL)`,
        [row.name, row.th_name],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // See the header comment "down() semantics" block for the full rationale.
    //
    // We do NOT delete any status row here. Cascade-deleting a status row
    // would destroy every tracking_status row that references it (FK
    // ON DELETE CASCADE), violating CLAUDE.md §12 Audit Rule.
    //
    // Instead, for each canonical row we revert `th_name` back to empty
    // string ONLY when:
    //   (a) the current `th_name` exactly matches the canonical Thai value
    //       this migration would have set, AND
    //   (b) no tracking_status row references this status id.
    //
    // Rows referenced by tracking_status are left at their current value.
    // This is conservative on purpose — preserving audit integrity and
    // the user-facing badge label takes precedence over strict symmetry
    // with up().
    for (const row of BackfillCanonicalStatusThName1745280000000.CANONICAL_ROWS) {
      await queryRunner.query(
        `UPDATE "status"
         SET "th_name" = ''
         WHERE "name" = $1
           AND "delete_at" IS NULL
           AND "th_name" = $2
           AND NOT EXISTS (
             SELECT 1 FROM "tracking_status" ts
             WHERE ts."status_id" = "status"."id"
           )`,
        [row.name, row.th_name],
      );
    }
  }
}
