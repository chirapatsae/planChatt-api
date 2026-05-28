import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

/**
 * Wave Equipment ผ.03, Phase 2 — BE-04.
 *
 * Query DTO for the equipment list endpoint. All filters are optional
 * and combine with AND semantics. `status` filter is matched
 * case-sensitively against `status.name` (canonical §3 names).
 */
export class ListEquipmentProjectGroupsQueryDto {
  @IsOptional()
  @IsUUID()
  developmentPlanId?: string;

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
