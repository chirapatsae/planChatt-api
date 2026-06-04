import { IsIn, IsOptional, IsUUID } from 'class-validator';

/**
 * BE-02 — Scope keys for the scope-driven "promote every Verified RPG to
 * Pending_Approval" endpoint
 * (`POST /tracking-status/promote-verified/revised-project-group`).
 *
 * Scope keys ONLY — NO `page` / `limit` / id-array. The row set is
 * re-derived server-side using the SAME predicate as the
 * `GET /revised-project-group/tracking/{edit,change}/verify` list finder,
 * scoped to the supplied DPR (§10 scope binding, §9 revision-round
 * activation honored via the DPR's `isLatest` / `isBooked` gates).
 *
 * `revisionType` selects the edit ('แก้ไข') or change ('เปลี่ยนแปลง')
 * round. When omitted, BOTH rounds under the scope are promoted.
 */
export class PromoteVerifiedRevisedScopeDto {
  @IsUUID()
  developmentPlanId: string;

  @IsUUID()
  developmentPlanRevisionId: string;

  @IsOptional()
  @IsIn(['edit', 'change'])
  revisionType?: 'edit' | 'change';
}
