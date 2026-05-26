// ===================================================================
// MainBookDisplayStateDto — Wave A1 / BE-01 (OPTION-A-FULL-SPLIT)
// ===================================================================
//
// Display-state envelope returned by
// `GET /v1/main-assembly/:developmentPlanId/book-state`.
//
// Shape kept parity with `SupplementBookDisplayStateDto` and the
// main-plan branch of `BookDisplayStateDto` so the shared FE
// `BookAssemblyDashboard` components can consume it once FE-01
// switches over. Q3=B isolation — duplicated, not shared.
//
// CLAUDE.md compliance:
//   - §15 — `isLeaf` is derived from `BookLockService.assertEditable(
//     planId, 'development_plan', em)` which encodes the canonical
//     "any non-soft-deleted child locks the plan" predicate.
//   - §17.2 — advisory only; display state MUST NOT gate any workflow
//     transition. The FE overflow menu is the only consumer.
//   - §18 — no orphan-cleanup interaction; pure read.
// ===================================================================

export enum MainBookDisplayStateEnum {
  NO_BOOK = 'no_book',
  DRAFT = 'draft',
  PUBLISHED_LATEST = 'published_latest',
  FROZEN_HISTORICAL = 'frozen_historical',
}

export class MainBookDisplayStateDto {
  /** Echoed for self-identification; FE re-sets its own value. */
  developmentPlanId: string;

  /**
   * True when the development plan has no non-soft-deleted revision /
   * supplement child (per §15 plan predicate). A locked main plan is
   * always FROZEN_HISTORICAL.
   */
  isLeaf: boolean;

  state: MainBookDisplayStateEnum;

  /**
   * Wave A1 / BE-01 — hard-coded false. Main-plan books have no
   * cross-book dependency tracking equivalent to RPG sibling-draft
   * overlap (which lives on the revision branch of the legacy
   * service). Kept on the contract for FE parity with the
   * `BookDisplayStateDto` shape.
   */
  hasActiveDraftDependency: boolean;

  /**
   * Wave A1 / BE-01 — hard-coded 0. Main-plan books today have a
   * single leaf per PG via `main_project_lineage`; per-PG "blocked"
   * counting is meaningful only when multiple sibling books share
   * the same PG, which doesn't happen at the plan level. Kept on
   * the contract for FE parity.
   */
  blockedProjectCount: number;
}
