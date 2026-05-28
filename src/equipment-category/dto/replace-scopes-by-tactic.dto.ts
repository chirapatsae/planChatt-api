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
 * Body for `PUT /v1/equipment-category/scopes/by-tactic`. Replaces the
 * full set of equipment categories valid for one `(tacticId, planId)`
 * pair atomically.
 *
 * `equipmentCategoryIds` ARE UUIDs (PK of `equipment_categories`);
 * `tacticId` and `planId` are STRING natural keys — see
 * `find-scoped-categories.query.dto.ts` header for the spec-deviation
 * rationale.
 */
export class ReplaceScopesByTacticDto {
  @IsString()
  @Matches(/^TACT\d+$/, { message: 'tacticId must look like "TACT004"' })
  tacticId: string;

  @IsString()
  @Matches(/^PLAN\d+$/, { message: 'planId must look like "PLAN003"' })
  planId: string;

  @IsArray()
  @ArrayUnique()
  @IsUUID('all', { each: true })
  equipmentCategoryIds: string[];
}
