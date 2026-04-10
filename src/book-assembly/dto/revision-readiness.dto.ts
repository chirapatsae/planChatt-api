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
