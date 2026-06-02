import { OmitType, PartialType } from '@nestjs/mapped-types';
import { CreateRevisedEquipmentProjectGroupDto } from './create-revised-equipment-project-group.dto';

/**
 * Wave Equipment Revision Management — BE-01 (Phase 3).
 *
 * PartialType clone of `CreateRevisedEquipmentProjectGroupDto` with the
 * structural / lineage FKs omitted — `developmentPlanRevisionId` and
 * `equipmentProjectGroupId` are fixed at fork time and MUST NOT change on
 * an update (re-pointing the parent revision or the source EPG is a
 * structural change indistinguishable from delete + recreate, mirroring
 * the `EQUIPMENT_PLAN_IMMUTABLE` guard on the EPG update path).
 *
 * Every remaining field is optional. Shape-aware re-validation runs at the
 * service layer: when classification slots are touched the
 * `ProjectClassificationValidator` re-runs against the parent plan's
 * `reportFormat`; otherwise the existing shape is preserved.
 */
export class UpdateRevisedEquipmentProjectGroupDto extends PartialType(
  OmitType(CreateRevisedEquipmentProjectGroupDto, [
    'developmentPlanRevisionId',
    'equipmentProjectGroupId',
    'isDraft',
  ] as const),
) {}
