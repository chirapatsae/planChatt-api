// ===================================================================
// MainReadinessDto — Wave A1 / BE-01 (OPTION-A-FULL-SPLIT)
// ===================================================================
//
// Readiness envelope returned by
// `GET /v1/main-assembly/:developmentPlanId/readiness`.
//
// Shape kept byte-for-byte parity with `RevisionReadinessDto` /
// `SupplementReadinessDto` so the shared FE `BookAssemblyDashboard` /
// `DraftPanel` components can consume it without an adapter fork.
// Q3=B isolation — duplicated, not shared.
//
// CLAUDE.md compliance:
//   - §15 — `hasOpenPhase` is derived from any `PlanPhase.isOpen` row
//     under the plan. An open phase keeps `isReady = false`.
//   - §17.2 — advisory only; readiness MUST NOT gate any workflow
//     transition. Truthfulness of `isReady` is bounded to the
//     snapshot at call time.
//   - §18 — no orphan-cleanup interaction; pure read.
// ===================================================================

export class MainReadinessBreakdownDto {
  /** Projects created by agency-classified WorkHistory (amphoe.id=3001 AND lao.id=3001027). */
  agencyCount: number;
  /** Projects created by lao-classified WorkHistory (all other cases). */
  laoCount: number;
  /** Projects whose latest TrackingStatus is Pending. */
  pendingCount: number;
  /** Projects whose latest TrackingStatus is Verified. */
  verifiedCount: number;
  /** Projects whose latest TrackingStatus is Pending_Approval. */
  pendingApprovalCount: number;
  /** Projects whose latest TrackingStatus is Approved. */
  approvedCount: number;
  /** Projects whose latest TrackingStatus is Ready (pre-submission). */
  readyCount: number;
  /** Projects whose latest TrackingStatus is Returned_For_Revision. */
  returnedForRevisionCount: number;
  /** Projects whose latest TrackingStatus is Pull_Back. */
  pullBackCount: number;
  /** Projects whose latest TrackingStatus is Rejected (W67 "เกินศักยภาพ"). */
  rejectedCount: number;
  /** Total non-deleted projects in scope (excludes Ready / Pull_Back / Rejected). */
  totalCount: number;
}

export class MainReadinessDto {
  approvedCount: number;
  totalCount: number;
  isReady: boolean;
  /** True when any `PlanPhase.isOpen = true` row exists under the plan. */
  hasOpenPhase: boolean;
  breakdown: MainReadinessBreakdownDto;
}
