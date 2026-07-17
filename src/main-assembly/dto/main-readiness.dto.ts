// ===================================================================
// MainReadinessDto — Wave A1 / BE-01 (OPTION-A-FULL-SPLIT)
// ===================================================================
//
// Readiness envelope returned by
// `GET /v1/main-assembly/:developmentPlanId/readiness`.
//
// 2026-07-14 — single-อปท (หนองกระทุ่ม): the LAO / "การประสานแผน"
// coordination axis is retired for the MAIN book. This DTO now
// INTENTIONALLY DIVERGES from `RevisionReadinessDto` /
// `SupplementReadinessDto` (which keep vestigial agencyCount/laoCount):
// the four LAO-axis fields (agencyCount / laoCount / approvedAgencyCount /
// approvedLaoCount) are dropped and readiness is single agency-source.
// Do NOT re-add them "for parity". The shared FE `ReadinessBreakdown`
// interface makes agencyCount/laoCount optional so all three siblings
// still compile.
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
  /**
   * Approved equipment (ผ.03) rows under the plan. Per §5.3,
   * equipment is agency-origin-only by construction. Surfaced so the
   * agency-only checklist can show "มีโครงการ/ครุภัณฑ์อนุมัติ".
   */
  approvedEquipmentCount: number;
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
