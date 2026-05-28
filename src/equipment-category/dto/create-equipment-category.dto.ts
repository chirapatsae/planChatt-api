import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/**
 * Wave Equipment ผ.03, Phase 1 — BE-01.
 *
 * Body for `POST /v1/equipment-category`. Duplicate `code` is enforced
 * at the service layer via the unique index seeded by DB-01.
 */
export class CreateEquipmentCategoryDto {
  @IsInt()
  @Min(1)
  code: number;

  @IsString()
  @MaxLength(255)
  name: string;

  /**
   * Optional — defaults to `code` if omitted (matches the seed behavior
   * where `sort_order` mirrors `code` 1:1).
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
