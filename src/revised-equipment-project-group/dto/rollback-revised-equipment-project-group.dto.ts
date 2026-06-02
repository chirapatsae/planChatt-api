import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Wave Equipment Revision Management — BE-02 (Phase 3).
 *
 * Staff-led rollback payload for RELPG (RevisedEquipmentProjectGroup).
 *
 * `reason` is an OPTIONAL free-text note for the rollback action. Staff-led
 * rollback per §14.6 does NOT write a new `TrackingStatus` row (it
 * hard-deletes the current latest and restores the previous to latest), so
 * `reason` is not persisted on a tracking row — it is logged with the
 * rollback for traceability.
 *
 * There is NO `clearResponsibleAgency` flag — RELPG is agency-origin by
 * construction (equipment is agency-only authoring, §5.3), so the §7.3 LAO
 * `responsibleAgency` clearing context is VACUOUS and MUST NEVER fire for
 * equipment rows (mirrors the §7.1 agency-origin invariant).
 */
export class RollbackRevisedEquipmentProjectGroupDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}
