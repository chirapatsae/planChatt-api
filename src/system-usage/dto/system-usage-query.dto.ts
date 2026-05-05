/**
 * W107-BE-PR2 — Query DTOs for /v1/system-usage/* endpoints.
 *
 * Validation order (CLAUDE.md): auth → role → DTO → query. These DTOs
 * own the param-shape contract; service-level guards own the date-range
 * cap and other cross-field rules.
 *
 * §17.2 — these DTOs describe advisory aggregates. No field here changes
 * a workflow transition, ownership, or authority.
 */

import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

// Canonical role whitelist (matches DB-PR1 D4 / D5).
export const CANONICAL_ROLES = [
  'user',
  'staff',
  'admin',
  'super-admin',
  'c-level',
] as const;
export type CanonicalRole = (typeof CANONICAL_ROLES)[number];

// Metric enums per spec §7.1.
export const TIMESERIES_METRICS = [
  'dau',
  'transitions',
  'comments',
  'pdfExports',
  // Backward-compatibility aliases used by the user prompt:
  'ai',
  'notifications',
] as const;
export type TimeseriesMetric = (typeof TIMESERIES_METRICS)[number];

export const TIMESERIES_BUCKETS = ['daily', 'weekly', 'monthly'] as const;
export type TimeseriesBucket = (typeof TIMESERIES_BUCKETS)[number];

export const HEATMAP_METRICS = ['transitions', 'dau'] as const;
export type HeatmapMetric = (typeof HEATMAP_METRICS)[number];

export const TOP_USERS_METRICS = [
  'transitions',
  'comments',
  'pdfExports',
  // Master-plan alias surfaces this as "projects"; not a v1 source — falls
  // back to transitions when requested.
  'projects',
  // W107 reframe — distinct active days per user across tracking_status,
  // ai_usage_logs, and users.last_seen_at sources. Proxies "login
  // frequency" without a dedicated login-event table. See
  // SystemUsageQueryService.getTopUsers().
  'loginDays',
] as const;
export type TopUsersMetric = (typeof TOP_USERS_METRICS)[number];

// Hard caps (per spec §7.5 + master-plan §9).
export const MAX_DATE_RANGE_DAYS = 365;
export const MIN_FROM_DATE = '2024-01-01';

// -----------------------------------------------------------------------------
// Base / shared shapes
// -----------------------------------------------------------------------------

export class DateRangeQueryDto {
  @IsISO8601({ strict: false })
  from!: string;

  @IsISO8601({ strict: false })
  to!: string;
}

export class SegmentFilterDto {
  @IsOptional()
  @IsEnum(CANONICAL_ROLES, {
    message: `role must be one of: ${CANONICAL_ROLES.join(', ')}`,
  })
  role?: CanonicalRole;

  // amphoes.id and government_agencies.id are varchar(32) in this codebase.
  @IsOptional()
  @IsString()
  @Length(1, 32)
  amphoeId?: string;

  @IsOptional()
  @IsString()
  @Length(1, 32)
  governmentAgencyId?: string;
}

// -----------------------------------------------------------------------------
// Per-endpoint query DTOs
// -----------------------------------------------------------------------------

export class OverviewQueryDto extends DateRangeQueryDto {
  @IsOptional()
  @IsEnum(CANONICAL_ROLES)
  role?: CanonicalRole;

  @IsOptional()
  @IsString()
  @Length(1, 32)
  amphoeId?: string;

  @IsOptional()
  @IsString()
  @Length(1, 32)
  governmentAgencyId?: string;
}

export class TimeseriesQueryDto extends DateRangeQueryDto {
  @IsEnum(TIMESERIES_METRICS, {
    message: `metric must be one of: ${TIMESERIES_METRICS.join(', ')}`,
  })
  metric!: TimeseriesMetric;

  @IsOptional()
  @IsEnum(TIMESERIES_BUCKETS, {
    message: `bucket must be one of: ${TIMESERIES_BUCKETS.join(', ')}`,
  })
  bucket?: TimeseriesBucket;

  @IsOptional()
  @IsEnum(CANONICAL_ROLES)
  role?: CanonicalRole;

  @IsOptional()
  @IsString()
  @Length(1, 32)
  amphoeId?: string;

  @IsOptional()
  @IsString()
  @Length(1, 32)
  governmentAgencyId?: string;
}

export class HeatmapQueryDto extends DateRangeQueryDto {
  @IsOptional()
  @IsEnum(HEATMAP_METRICS, {
    message: `metric must be one of: ${HEATMAP_METRICS.join(', ')}`,
  })
  metric?: HeatmapMetric;

  @IsOptional()
  @IsEnum(CANONICAL_ROLES)
  role?: CanonicalRole;
}

export class RoleDistributionQueryDto extends DateRangeQueryDto {}

export class TopUsersQueryDto extends DateRangeQueryDto {
  @IsEnum(TOP_USERS_METRICS, {
    message: `metric must be one of: ${TOP_USERS_METRICS.join(', ')}`,
  })
  metric!: TopUsersMetric;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @IsOptional()
  @IsEnum(CANONICAL_ROLES)
  role?: CanonicalRole;

  @IsOptional()
  @IsString()
  @Length(1, 32)
  amphoeId?: string;
}

export class InactiveUsersQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(7)
  @Max(365)
  days!: number;

  @IsOptional()
  @IsEnum(CANONICAL_ROLES)
  role?: CanonicalRole;

  @IsOptional()
  @IsString()
  @Length(1, 32)
  amphoeId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
