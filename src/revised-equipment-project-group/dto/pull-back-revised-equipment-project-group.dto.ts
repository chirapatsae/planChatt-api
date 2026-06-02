import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Body for `PATCH /v1/revised-equipment-project-group/:id/pull-back`.
 *
 * 2026-06-02 — owner pull-back now carries an optional reason (เหตุผลการ
 * ขอดึงกลับ), mirroring the project RPG pull-back
 * (`create-by-revised-project-group` `comment`). Persisted on the new
 * `Pull_Back` TrackingStatus row's `comment` column (§12 audit). The FE
 * collects it via the confirm-dialog input; advisory metadata only — it
 * does NOT affect the transition or any authority check.
 */
export class PullBackRevisedEquipmentProjectGroupDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comment?: string;
}
