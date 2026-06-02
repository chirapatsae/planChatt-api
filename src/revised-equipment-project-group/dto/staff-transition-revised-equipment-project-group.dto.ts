import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Wave Equipment Revision Management — BE-02 (Phase 3).
 *
 * Staff workflow-transition payload for RELPG (RevisedEquipmentProjectGroup).
 * Mirrors the RPG / EPG staff-transition DTO shape:
 *   - `comment`     — free-text reviewer note (visible to the owner).
 *   - `staffRemark` — staff-lead-only remark recorded on the
 *                     `TrackingStatus` audit row (§3 / §12).
 *
 * Both fields are OPTIONAL. The transition itself is gated by role +
 * workStatus + area responsibility + current-status rules in the service
 * (§4.1 / §7.2) — this DTO carries only the optional annotation text.
 */
export class StaffTransitionRevisedEquipmentProjectGroupDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comment?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  staffRemark?: string;
}
