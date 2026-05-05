/**
 * W107-BE-PR2 — Response DTOs (typed shapes consumed by FE-PR1).
 *
 * §17.2 — purely advisory aggregates. No field here is a workflow gate.
 * §17.3 — these shapes intentionally avoid embedding any project / plan
 *         identifiers; only user identifiers + counts are exposed (and
 *         only behind the role gate).
 */

export interface OverviewResponseDto {
  rangeFrom: string;
  rangeTo: string;
  rangeDays: number;
  // KPI strip — user-access framing (W107 reframe: page is about
  // "ใครใช้ระบบ" not "ระบบทำงานกี่ครั้ง").
  dauToday: number;
  wau: number;
  mau: number;
  /** % of registered users who have ever logged in (0..1). */
  adoptionRate: number;
  /** Users created within the queried range (count). */
  newUsersInRange: number;
  /** Total users with NULL last_seen_at — registered but never used. */
  neverLoggedInCount: number;
  // Workflow metrics retained for backwards compat / drill-down; the FE
  // page no longer surfaces these on the headline strip.
  totalTransitions: number;
  transitionsAvgPerDay: number;
  totalComments: number;
  totalPdfExports: number;
  aiInvocations: number;
  notificationDeliveries: number;
  lastRollupAt: string | null;
}

/**
 * Adoption funnel — answers the budget-justification question
 * "ระบบที่ลงทุนไปคุ้มไหม" by walking from total registrations down to
 * users active in the last 24h. Shape: every level is a strict subset
 * of the previous, so chart libraries can render as a funnel.
 */
export interface AdoptionFunnelResponseDto {
  totalRegistered: number;
  everLoggedIn: number;
  activeIn30Days: number;
  activeIn7Days: number;
  activeIn24h: number;
}

export interface TimeseriesPointDto {
  bucket: string; // ISO date for daily; week-start ISO date for weekly; YYYY-MM-01 for monthly.
  value: number;
}

export interface TimeseriesResponseDto {
  metric: string;
  bucket: string;
  points: TimeseriesPointDto[];
}

export interface HeatmapCellDto {
  dayOfWeek: number; // 0=Sun..6=Sat (matches Postgres EXTRACT(DOW))
  hour: number; // 0..23
  value: number;
}

export interface HeatmapResponseDto {
  metric: string;
  matrix: HeatmapCellDto[];
}

export interface RoleDistributionSliceDto {
  role: string;
  dauCount: number;
  transitionCount: number;
  share: number;
}

export interface RoleDistributionResponseDto {
  slices: RoleDistributionSliceDto[];
}

export interface TopUserRowDto {
  userId: string;
  fullName: string;
  role: string;
  amphoeId: string | null;
  count: number;
  lastSeenAt: string | null;
}

export interface TopUsersResponseDto {
  metric: string;
  users: TopUserRowDto[];
}

export interface InactiveUserRowDto {
  userId: string;
  fullName: string;
  role: string | null;
  lastSeenAt: string | null;
  daysSinceLastSeen: number | null;
}

export interface InactiveUsersResponseDto {
  thresholdDays: number;
  asOf: string;
  total: number;
  users: InactiveUserRowDto[];
}
