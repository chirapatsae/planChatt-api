// ===================================================================
// SupplementBookDisplayStateDto
// ===================================================================
//
// Display-state envelope returned by
// `GET /v1/supplement-assembly/:supplementId/book-state`.
//
// Shape is byte-for-byte parity with `BookDisplayStateDto` from
// `src/book-assembly/dto/book-display-state.dto.ts` so the shared FE
// `BookAssemblyDashboard` / `VersionCard` components can consume it
// without an adapter fork. Per Q10=B (locked decision in
// `SupplementAssemblyService` header) the supplement-assembly module
// MUST NOT import from `src/book-assembly/`, so the DTO is duplicated
// here intentionally — it is a contract artefact, not an implementation
// re-use.
//
// CLAUDE.md compliance:
//   - §15 — `isLeaf` is computed via
//     `BookLockService.assertEditable(..., 'development_plan_supplement', ...)`
//     which now enforces the linear-chain-by-bookedAt predicate (any
//     strictly-newer-booked sibling locks this supplement).
//   - §17.2 — advisory only; the display state MUST NOT gate any
//     workflow transition. The FE overflow menu (จัดการ → ยกเลิก / แก้ไข)
//     is the only consumer today.
//   - §18 — no orphan-cleanup interaction; this is a pure read.
// ===================================================================

export enum SupplementBookDisplayStateEnum {
  NO_BOOK = 'no_book',
  DRAFT = 'draft',
  PUBLISHED_LATEST = 'published_latest',
  FROZEN_HISTORICAL = 'frozen_historical',
}

export class SupplementBookDisplayStateDto {
  /** Echoed for self-identification; FE re-sets its own value. */
  supplementId: string;

  /**
   * True when the supplement is the head-of-lineage on the §15 linear
   * chain (no strictly-newer-booked sibling under the same plan locks
   * it). A draft (`bookedAt IS NULL`) is always treated as a leaf.
   */
  isLeaf: boolean;

  state: SupplementBookDisplayStateEnum;

  /**
   * Wave-A defaulting — supplement has no cross-book dependency notion
   * equivalent to main-plan / revision lineage today. Hard-coded false.
   */
  hasActiveDraftDependency: boolean;

  /**
   * Wave-A defaulting — supplement has no per-project leaf-tracking
   * table equivalent to `book_project_lineage` today. Hard-coded 0.
   */
  blockedProjectCount: number;
}
