import { PartialType } from '@nestjs/mapped-types';
import { CreateSupplementEquipmentProjectGroupDto } from './create-supplement-equipment-project-group.dto';

/**
 * Wave wave-supplement-equipment-por03 — BE-B1 (2026-06-08).
 *
 * PartialType clone of CreateSupplementEquipmentProjectGroupDto. Every
 * field is optional on update. Shape-aware re-validation is performed at
 * the service layer — if classification slots are touched the
 * `ProjectClassificationValidator` MUST re-run, otherwise the existing
 * shape is preserved. Mirrors `UpdateEquipmentProjectGroupDto`.
 */
export class UpdateSupplementEquipmentProjectGroupDto extends PartialType(
  CreateSupplementEquipmentProjectGroupDto,
) {}
