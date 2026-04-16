import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: SwapCommentStep2And3
 *
 * Swaps historical `comment.step` values 2 and 3 for every row, bringing
 * archived tracking-status comments into alignment with the NEW semantic
 * contract adopted across the staff review / send-to-edit surfaces:
 *
 *   - step 2 = พิกัด           (location)
 *   - step 3 = ข้อมูลโครงการ   (project detail)
 *
 * Previously the order was inverted (step 2 = ข้อมูลโครงการ, step 3 = พิกัด).
 * Frontend and backend write-paths have already been switched to the NEW
 * contract via FE-01, FE-02, FE-03, BE-01, and BE-02; this migration closes
 * the loop on historical rows so that owner-side chips rendered from
 * persisted comments carry the correct semantic number.
 *
 * User directive (2026-04-16):
 *   "yes we swap step 2 to be location and step 3 as a project detail"
 *
 * Sibling investigation:
 *   docs/reports/VERIFY_STEP_COORDS_REALIGNMENT_INVESTIGATION.md
 *   — Clarifications Q1, Strategy A (destructive swap) signed off by user.
 *
 * Sibling tasks already landed (Batch 1):
 *   - FE-01: staff panels now write NEW-contract step values
 *   - FE-02: send-to-edit confirmation copy matches NEW contract
 *   - FE-03: mapper reads NEW-contract values
 *   - BE-01: CreateComments DTO bounded to @Min(1) @Max(6) @IsInt()
 *           preventing malformed values mid-flight
 *   - BE-02: sibling backend alignment (see Batch 1 report)
 *
 * CLAUDE.md §12 Audit Rule compliance:
 *   The migration itself is recorded in TypeORM's `migrations` bookkeeping
 *   table with name + timestamp, satisfying the traceability requirement.
 *   `TrackingStatus` rows are NOT touched — only the foreign-keyed
 *   `comment.step` column is updated. Audit history on TrackingStatus
 *   remains intact.
 *
 * Rerun-safety caveat (IMPORTANT):
 *   The SQL is symmetric — running the exact same UPDATE twice returns
 *   the data to its pre-migration state. Protection against accidental
 *   double-execution relies on TypeORM's `migrations` bookkeeping table,
 *   which records the migration once and will NOT re-run it unless an
 *   operator manually reverts or deletes the bookkeeping row. Operators
 *   MUST NOT execute this migration's SQL by hand outside the
 *   `migration:run` / `migration:revert` lifecycle.
 *
 *   Consequently `down()` is defined as the identical swap: running
 *   `migration:revert` re-inverts the data back to the OLD contract, which
 *   is exactly what a rollback of the code deploy would require. See the
 *   rollback procedure in the deploy runbook for the required ordering
 *   (DB revert BEFORE code revert).
 *
 * No-collision rationale:
 *   `comment.step` has NO unique constraint (verified against
 *   `comment.entity.ts`), so the CASE expression can freely swap 2↔3 in
 *   a single atomic UPDATE without a transient third value. The UPDATE
 *   runs inside TypeORM's default per-migration transaction, so other
 *   sessions observe either the pre-swap or post-swap state — never a
 *   partially applied one.
 *
 * Scope constraint:
 *   `WHERE step IN (2, 3)` avoids a full-table scan; any legacy row with
 *   step outside 1..6 is left untouched. BE-01 prevents new malformed
 *   inserts going forward.
 */
export class SwapCommentStep2And31745193600000 implements MigrationInterface {
  name = 'SwapCommentStep2And31745193600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE comment
      SET step = CASE
        WHEN step = 2 THEN 3
        WHEN step = 3 THEN 2
        ELSE step
      END
      WHERE step IN (2, 3);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Symmetric swap — re-running the same UPDATE reverts to the OLD contract.
    // See the rerun-safety caveat in the class JSDoc above.
    await queryRunner.query(`
      UPDATE comment
      SET step = CASE
        WHEN step = 2 THEN 3
        WHEN step = 3 THEN 2
        ELSE step
      END
      WHERE step IN (2, 3);
    `);
  }
}
