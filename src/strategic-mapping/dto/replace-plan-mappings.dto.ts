import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsOptional,
  IsUUID,
} from 'class-validator';

/**
 * ReplacePlanMappingsDto — Strategic Graph BE-05 composite plan-mapping payload.
 *
 * Used by `POST /v1/strategic-graph/plans/:id/mappings`. Replace mode is
 * per-dimension:
 *   - Field present → dimension is replaced (DELETE all existing rows for
 *     the plan, then INSERT the new set).
 *   - Field omitted → dimension is preserved untouched.
 *   - Field = [] → dimension is cleared (DELETE existing rows, INSERT none).
 *
 * Plan id is read from URL param (varchar PK on `plans`); it is NOT part
 * of this body DTO. The four target id arrays carry UUIDs (master tables
 * `sdg`, `national_strategy`, `milestone`, `province_strategy` all use
 * UUID PKs per the BE-03 junction entities).
 *
 * Mirrors `ReplaceMappingDto` (BE-04) validation guardrails:
 *   - `@ArrayUnique` rejects duplicate ids inside a single dimension.
 *   - `@ArrayMaxSize(1000)` caps blast radius per dimension.
 *   - `@IsUUID('all', { each: true })` enforces UUID shape on each entry.
 *
 * §12 — these are config rows; no TrackingStatus interaction.
 */
export class ReplacePlanMappingsDto {
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(1000)
  @IsUUID('all', { each: true })
  sdgIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(1000)
  @IsUUID('all', { each: true })
  nationalStrategyIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(1000)
  @IsUUID('all', { each: true })
  milestoneIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(1000)
  @IsUUID('all', { each: true })
  provinceStrategyIds?: string[];
}
