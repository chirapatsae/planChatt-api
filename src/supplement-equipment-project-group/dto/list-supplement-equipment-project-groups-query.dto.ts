import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

/**
 * Wave wave-supplement-equipment-por03 — BE-B1 (2026-06-08).
 *
 * Query DTO for the supplement-equipment list endpoint. All filters are
 * optional and combine with AND semantics. `status` filter is matched
 * case-sensitively against `status.name` (canonical §3 names). Mirrors
 * `ListEquipmentProjectGroupsQueryDto` but scopes by
 * `developmentPlanSupplementId` instead of `developmentPlanId`.
 */
export class ListSupplementEquipmentProjectGroupsQueryDto {
  @IsOptional()
  @IsUUID()
  developmentPlanSupplementId?: string;

  /** Canonical status name (e.g., 'Ready', 'Pending', 'Approved'). */
  @IsOptional()
  @IsString()
  status?: string;

  /** When `true`, only items owned by the caller's current WorkHistory. */
  @IsOptional()
  @Type(() => Boolean)
  mineOnly?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}
