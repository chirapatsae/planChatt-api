import { PartialType } from '@nestjs/mapped-types';
import { CreateEquipmentProjectGroupDto } from './create-equipment-project-group.dto';

/**
 * Wave Equipment ผ.03, Phase 2 — BE-04.
 *
 * PartialType clone of CreateEquipmentProjectGroupDto. Every field is
 * optional on update. Shape-aware re-validation is performed at the
 * service layer — if classification slots are touched the
 * `ProjectClassificationValidator` MUST re-run, otherwise the existing
 * shape is preserved.
 */
export class UpdateEquipmentProjectGroupDto extends PartialType(
  CreateEquipmentProjectGroupDto,
) {}
