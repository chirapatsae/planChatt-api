// ===================================================================
// SupplementReadinessDto — wave-supplement-assembly-button-gate / BE-01
// ===================================================================
//
// Readiness envelope returned by
// `GET /v1/supplement-assembly/:supplementId/readiness`.
//
// Shape is byte-for-byte parity with `RevisionReadinessDto` /
// `ReadinessBreakdownDto` from `src/book-assembly/dto/revision-
// readiness.dto.ts` so the shared FE `BookAssemblyDashboard` /
// `DraftPanel` components can consume it without an adapter fork.
// Per Q10=B (locked decision in `SupplementAssemblyService` header)
// the supplement-assembly module MUST NOT import from
// `src/book-assembly/`, so the DTO is duplicated here intentionally —
// it is a contract artefact, not an implementation re-use.
//
// CLAUDE.md compliance:
//   - §15 — supplement timeline; `hasOpenPhase` is derived from
//           `DevelopmentPlanSupplement.isOpen` (the supplement does not
//           have a separate `PlanPhase`).
//   - §17.2 — advisory only; readiness MUST NOT gate any workflow
//             transition. Truthfulness of `isReady` is bounded to the
//             snapshot at call time.
//   - §18 — no orphan-cleanup interaction; this is a pure read.
// ===================================================================

export class SupplementReadinessBreakdownDto {
  /** Projects created by agency-classified WorkHistory (amphoe.id=3001 AND lao.id=3001027). */
  agencyCount: number;
  /** Projects created by lao-classified WorkHistory (all other cases). SPG is agency-only today so this stays 0. */
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
  /** Total non-deleted projects in scope (excludes Ready / Pull_Back / Rejected — see service for rationale). */
  totalCount: number;
  /**
   * Approved SEPG (ครุภัณฑ์ ผ.03) rows under the supplement — surfaced as a
   * separate ผ.03 line in the readiness bar. Approved-only to mirror the
   * §20.2 supplement ผ.03 append (the formal booked set,
   * `renderApprovedSupplementScopedPor03Buffer`) and to stay on the same
   * "อนุมัติแล้ว" basis as `approvedCount` (ผ.02). SUPPLEMENT is agency-only
   * (§5.3 SEPG / §21.2.3) so there is NO อปท./อบจ. tri-split — just
   * projects (ผ.02) + equipment (ผ.03).
   */
  approvedEquipmentCount: number;
}

export class SupplementReadinessDto {
  approvedCount: number;
  totalCount: number;
  isReady: boolean;
  /** True when `DevelopmentPlanSupplement.isOpen = true` (round still open ⇒ NOT ready). */
  hasOpenPhase: boolean;
  breakdown: SupplementReadinessBreakdownDto;
}
