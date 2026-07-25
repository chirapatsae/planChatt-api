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

  /**
   * When `true`, excludes rows that have already been เข้าเล่ม (booked):
   * `equipment.isBooked = true`. Opt-in so the staff review queues can
   * hide finalized-book items (parity with the project finder's
   * `projectGroup.isBooked = false` filter) WITHOUT affecting the
   * revision-equipment source picker, which legitimately lists booked
   * originals as revision sources.
   */
  @IsOptional()
  @Type(() => Boolean)
  excludeBooked?: boolean;

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
