import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional, Max, Min } from 'class-validator';

/**
 * Wave wave-orphan-cleanup-history / BE-01 (2026-06-01).
 *
 * Query DTO for the owner-scoped orphan-cleanup history endpoint at
 * `GET /api/v1/tracking-status/orphan-cleanup-history`. Read-side
 * aggregator over `tracking_status` rows whose `staff_remark` matches
 * one of the FROZEN §18.6 reason patterns.
 *
 * Source of truth: CLAUDE.md §18.13 (read-side aggregator allowance),
 * §18.5 (no new write-side storage), §17.2 (advisory-only).
 */
export type OrphanCleanupReasonKind =
  | 'all'
  | 'cancelled'
  | 'owner-timeout'
  | 'staff-timeout'
  | 'legacy';

export class OrphanCleanupHistoryQueryDto {
  @IsOptional()
  @Transform(({ value }) =>
    value !== undefined && value !== null && value !== ''
      ? Number(value)
      : value,
  )
  @IsInt({ message: 'page ต้องเป็นจำนวนเต็ม' })
  @Min(1, { message: 'page ต้องมากกว่าหรือเท่ากับ 1' })
  page?: number;

  @IsOptional()
  @Transform(({ value }) =>
    value !== undefined && value !== null && value !== ''
      ? Number(value)
      : value,
  )
  @IsInt({ message: 'limit ต้องเป็นจำนวนเต็ม' })
  @Min(1, { message: 'limit ต้องมากกว่าหรือเท่ากับ 1' })
  @Max(100, { message: 'limit ต้องไม่เกิน 100' })
  limit?: number;

  @IsOptional()
  @IsIn(['all', 'cancelled', 'owner-timeout', 'staff-timeout', 'legacy'], {
    message:
      "kind ต้องเป็น 'all' | 'cancelled' | 'owner-timeout' | 'staff-timeout' | 'legacy'",
  })
  kind?: OrphanCleanupReasonKind;

  @IsOptional()
  @IsISO8601({}, { message: 'from ต้องเป็นรูปแบบ ISO 8601' })
  from?: string;

  @IsOptional()
  @IsISO8601({}, { message: 'to ต้องเป็นรูปแบบ ISO 8601' })
  to?: string;
}

/** Per-row item returned by the history endpoint. */
export interface OrphanCleanupHistoryItem {
  /** UUID of the cascade-produced `tracking_status` row. */
  trackingId: string;
  /** UUID of the affected project (PG / RPG / SPG / Equipment / RELPG). */
  projectId: string;
  /** Project kind discriminator — determines which join populated the row. */
  projectKind:
    | 'project-group'
    | 'revised-project-group'
    | 'supplement-project-group'
    | 'equipment-project-group'
    | 'revised-equipment-project-group';
  /** Project title; null only if the project row was deleted with NULL title. */
  projectTitle: string | null;
  /** Cascade reset timestamp (TrackingStatus.createAt) as ISO 8601 UTC. */
  resetAt: string;
  /** Verbatim `staff_remark` text from the cascade row (§18.6). */
  reason: string;
  /** Classified reason kind for FE chip rendering. */
  reasonKind: 'cancelled' | 'owner-timeout' | 'staff-timeout' | 'legacy';
  /** Best-effort book name extracted from the reason text; null if unknown. */
  bookName: string | null;
  /**
   * Status name of the tracking row that was demoted from `isLatest=true`
   * immediately before the cascade row was inserted. Null if no prior
   * tracking row exists (extremely rare — would imply the cascade was the
   * very first tracking record for the project).
   */
  previousStatus: string | null;
}

export interface OrphanCleanupHistoryResponse {
  items: OrphanCleanupHistoryItem[];
  total: number;
  page: number;
  limit: number;
}
