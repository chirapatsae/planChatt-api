import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

/**
 * Wave Equipment Revision Management — BE-01 (Phase 3).
 *
 * Query DTO for the RELPG list endpoint. All filters are optional and
 * combine with AND semantics. `status` is matched case-sensitively
 * against the canonical §3 `status.name`.
 *
 * §10 scope binding — `developmentPlanRevisionId` is the PRIMARY scope
 * key. RELPG rows are always scoped to a specific DPR; the service NEVER
 * falls back to a global "latest open revision" lookup.
 */
export class ListRevisedEquipmentProjectGroupsQueryDto {
  /** §10 — filter by the parent DevelopmentPlanRevision. */
  @IsOptional()
  @IsUUID()
  developmentPlanRevisionId?: string;

  /**
   * §10 — optional secondary narrowing by the parent DevelopmentPlan.
   * Consumed by the BE-02 staff queue finders (a DPR is always under a
   * single plan; this lets a staff reviewer scope by book).
   */
  @IsOptional()
  @IsUUID()
  developmentPlanId?: string;

  /** Canonical status name (e.g., 'Ready', 'Pending', 'Approved'). */
  @IsOptional()
  @IsString()
  status?: string;

  /** When `true`, only RELPG owned by the caller's current WorkHistory. */
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
