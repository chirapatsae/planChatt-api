import { Type } from 'class-transformer';
import { IsBoolean, IsOptional, IsUUID } from 'class-validator';

/**
 * Wave Unified Equipment Tab — BE-01.
 *
 * Query DTO for `GET /v1/unified-equipment/owner-list`. All filters are
 * optional and combine with AND semantics.
 *
 * - `developmentPlanId` — §10 plan-scope binding. When omitted the
 *   service returns the merged unified equipment list across all plans
 *   the caller can read (the FE always passes the active/latest plan,
 *   mirroring the prior FE-only latest-plan default).
 * - `mineOnly` — §4 owner scope. When `true`, only rows whose
 *   `createdBy.id === caller.currentWorkHistory.id` are returned.
 */
export class ListUnifiedEquipmentQueryDto {
  @IsOptional()
  @IsUUID()
  developmentPlanId?: string;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  mineOnly?: boolean;
}
