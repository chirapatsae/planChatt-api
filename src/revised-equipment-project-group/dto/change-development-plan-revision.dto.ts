import { IsUUID } from 'class-validator';

/**
 * Wave Equipment Revision Management — staff round-reassignment payload for
 * RELPG (RevisedEquipmentProjectGroup).
 *
 * Lets a staff-lead (staff / admin / super-admin) move a RELPG to a
 * DIFFERENT revision round of the SAME plan — e.g. to fix a wrong
 * edit↔change submission. Mirrors the project equivalent
 * (`RevisedProjectGroupService.updateChangeDevelopmentPlanRevision`).
 *
 * This is a §4.1 staff workflow data-correction, NOT an agency-only
 * authoring action (no `AgencyOnlyGuard`) and NOT a status transition (no
 * `TrackingStatus` write — §17.2). The §10 same-plan scope constraint is
 * enforced at the service layer (target DPR must belong to the RELPG's own
 * plan and be open + un-booked).
 */
export class ChangeDevelopmentPlanRevisionDto {
  @IsUUID()
  developmentPlanRevisionId: string;
}
