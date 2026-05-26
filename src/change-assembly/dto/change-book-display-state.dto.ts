// ===================================================================
// ChangeBookDisplayStateDto — Wave A3 / BE-01 (OPTION-A-FULL-SPLIT)
// ===================================================================
//
// Display-state envelope returned by
// `GET /v1/change-assembly/:developmentPlanRevisionId/book-state`.
//
// Shape kept parity with `EditBookDisplayStateDto` /
// `SupplementBookDisplayStateDto` and the change-revision branch of the
// legacy `BookDisplayStateDto` so the shared FE
// `BookAssemblyDashboard` components can consume it once FE-01
// switches over. Q3=B isolation — duplicated, not shared.
//
// CLAUDE.md compliance:
//   - §15 — `isLeaf` is derived from `BookLockService.assertEditable(
//     revisionId, 'development_plan_revision', em)` which encodes the
//     canonical strict-newer-bookedAt sibling predicate across
//     revision + supplement tables.
//   - §17.2 — advisory only; display state MUST NOT gate any workflow
//     transition. The FE overflow menu is the only consumer.
//   - §18 — no orphan-cleanup interaction; pure read.
// ===================================================================

export enum ChangeBookDisplayStateEnum {
  NO_BOOK = 'no_book',
  DRAFT = 'draft',
  PUBLISHED_LATEST = 'published_latest',
  FROZEN_HISTORICAL = 'frozen_historical',
}

export class ChangeBookDisplayStateDto {
  /** Echoed for self-identification; FE re-sets its own value. */
  developmentPlanRevisionId: string;

  /**
   * True when the development plan revision has no strictly-newer
   * sibling under the same plan (per §15 cross-category predicate).
   * A locked revision is always FROZEN_HISTORICAL.
   */
  isLeaf: boolean;

  state: ChangeBookDisplayStateEnum;

  /**
   * Wave A3 / BE-01 — hard-coded false. The cross-revision
   * sibling-draft dependency tracking that the legacy
   * `BookAssemblyService.checkActiveDraftDependency` exposed crossed
   * EDIT ↔ CHANGE boundaries. The split subsystems compute their own
   * intra-subsystem state without that cross-type concern; kept on
   * the contract for FE parity with `BookDisplayStateDto`.
   */
  hasActiveDraftDependency: boolean;

  /**
   * Wave A3 / BE-01 — hard-coded 0. Per-RPG "blocked" counting was
   * meaningful only against the legacy unified lineage table.
   * `change_project_lineage` enforces "at most one leaf per RPG" at the
   * DB layer, so blocking is binary per RPG, not countable in the
   * same way. Kept on the contract for FE parity.
   */
  blockedProjectCount: number;
}
