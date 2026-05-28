import { PartialType } from '@nestjs/mapped-types';
import { CreateEquipmentCategoryDto } from './create-equipment-category.dto';

/**
 * Wave Equipment ผ.03, Phase 1 — BE-01.
 *
 * Body for `PATCH /v1/equipment-category/:id`. All fields optional.
 */
export class UpdateEquipmentCategoryDto extends PartialType(
  CreateEquipmentCategoryDto,
) {}
