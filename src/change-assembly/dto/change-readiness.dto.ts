// ===================================================================
// ChangeReadinessDto — Wave A3 / BE-01 (OPTION-A-FULL-SPLIT)
// ===================================================================
//
// Readiness envelope returned by
// `GET /v1/change-assembly/:developmentPlanRevisionId/readiness`.
//
// Shape kept byte-for-byte parity with `EditReadinessDto` /
// `MainReadinessDto` / `RevisionReadinessDto` / `SupplementReadinessDto`
// so the shared FE `BookAssemblyDashboard` / `DraftPanel` components
// can consume it without an adapter fork. Q3=B isolation — duplicated,
// not shared.
//
// CLAUDE.md compliance:
//   - §15 — `hasOpenPhase` is derived from
//     `DevelopmentPlanRevision.isOpen` (single-row predicate). An open
//     revision keeps `isReady = false` (mirrors the legacy
//     `getRevisionRoundReadiness` semantic).
//   - §17.2 — advisory only; readiness MUST NOT gate any workflow
//     transition. Truthfulness of `isReady` is bounded to the
//     snapshot at call time.
//   - §18 — no orphan-cleanup interaction; pure read.
// ===================================================================

export class ChangeReadinessBreakdownDto {
  /** RPGs created by agency-classified WorkHistory (amphoe.id=3001 AND lao.id=3001027). */
  agencyCount: number;
  /** RPGs created by lao-classified WorkHistory (all other cases). */
  laoCount: number;
  /** RPGs whose latest TrackingStatus is Pending. */
  pendingCount: number;
  /** RPGs whose latest TrackingStatus is Verified. */
  verifiedCount: number;
  /** RPGs whose latest TrackingStatus is Pending_Approval. */
  pendingApprovalCount: number;
  /** RPGs whose latest TrackingStatus is Approved. */
  approvedCount: number;
  /** RPGs whose latest TrackingStatus is Ready (pre-submission). */
  readyCount: number;
  /** RPGs whose latest TrackingStatus is Returned_For_Revision. */
  returnedForRevisionCount: number;
  /** RPGs whose latest TrackingStatus is Pull_Back. */
  pullBackCount: number;
  /** RPGs whose latest TrackingStatus is Rejected (W67 "เกินศักยภาพ"). */
  rejectedCount: number;
  /** Total non-deleted RPGs in scope (excludes Ready / Pull_Back / Rejected). */
  totalCount: number;
  /**
   * Approved RELPG (ครุภัณฑ์ ผ.03) rows under the revision — surfaced as a
   * separate ผ.03 line in the readiness bar. Approved-only to mirror the
   * §20.2 EDIT/CHANGE ผ.03 append (the formal booked set,
   * `renderApprovedRevisionScopedPor03Buffer`) and to stay on the same
   * "อนุมัติแล้ว" basis as `approvedCount` (ผ.02). CHANGE is agency-only,
   * so the FE agency-only checklist uses the top-level `approvedCount`;
   * this is simply projects (ผ.02) + equipment (ผ.03).
   */
  approvedEquipmentCount: number;
}

export class ChangeReadinessDto {
  approvedCount: number;
  totalCount: number;
  isReady: boolean;
  /** True when the parent `DevelopmentPlanRevision.isOpen = true`. */
  hasOpenPhase: boolean;
  breakdown: ChangeReadinessBreakdownDto;
}
