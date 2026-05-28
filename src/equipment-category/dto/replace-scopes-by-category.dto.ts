import {
  ArrayUnique,
  IsArray,
  IsString,
  IsUUID,
  Matches,
} from 'class-validator';

/**
 * Wave Equipment ผ.03, Phase 1 — BE-01.
 *
 * Body for `PUT /v1/equipment-category/scopes/by-category`. Replaces
 * the full set of plans valid for one `(equipmentCategoryId, tacticId)`
 * pair atomically.
 *
 * `equipmentCategoryId` is a UUID; `tacticId` and `planIds` are STRING
 * natural keys — see `find-scoped-categories.query.dto.ts` header for
 * the spec-deviation rationale.
 */
export class ReplaceScopesByCategoryDto {
  @IsUUID()
  equipmentCategoryId: string;

  @IsString()
  @Matches(/^TACT\d+$/, { message: 'tacticId must look like "TACT004"' })
  tacticId: string;

  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  @Matches(/^PLAN\d+$/, {
    each: true,
    message: 'each planId must look like "PLAN003"',
  })
  planIds: string[];
}
