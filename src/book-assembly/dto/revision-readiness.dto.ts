export class ReadinessBreakdownDto {
  /** Projects created by agency-classified WorkHistory (amphoe.id=3001 AND lao.id=3001027) */
  agencyCount: number;
  /** Projects created by lao-classified WorkHistory (all other cases) */
  laoCount: number;
  /** Projects whose latest TrackingStatus is Pending */
  pendingCount: number;
  /** Projects whose latest TrackingStatus is Verified */
  verifiedCount: number;
  /** Projects whose latest TrackingStatus is Pending_Approval */
  pendingApprovalCount: number;
  /** Projects whose latest TrackingStatus is Approved */
  approvedCount: number;
  /**
   * Wave 22-followup — Projects whose latest TrackingStatus is Ready
   * (pre-submission state; owner has not yet submitted to review).
   */
  readyCount: number;
  /**
   * Wave 22-followup — Projects whose latest TrackingStatus is
   * Returned_For_Revision (staff returned to owner for correction;
   * owner has NOT resubmitted yet). These commonly become silent
   * stragglers — admins use this count to find owners who need a
   * nudge before merge.
   */
  returnedForRevisionCount: number;
  /**
   * Wave 22-followup — Projects whose latest TrackingStatus is
   * Pull_Back (owner withdrew from review; awaiting resubmit).
   */
  pullBackCount: number;
  /**
   * Wave 22-followup — Projects whose latest TrackingStatus is
   * Rejected (W67 "เกินศักยภาพ" — workflow exit state).
   */
  rejectedCount: number;
  /** Total non-deleted projects in scope */
  totalCount: number;
}

export class RevisionReadinessDto {
  approvedCount: number;
  totalCount: number;
  isReady: boolean;
  hasOpenPhase: boolean;
  breakdown: ReadinessBreakdownDto;
}
