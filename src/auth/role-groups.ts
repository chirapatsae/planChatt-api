import { Role } from './roles.enum';

/**
 * Centralized role groups. Replaces the per-controller `Set<string>` constants
 * (WH_ADMIN_ROLES, WH_SUPER_ADMIN_ROLES, STATS_READ_ROLES, SUPER_ADMIN_ONLY,
 * SUPER_ADMIN_ROLES, ADMIN_OR_ABOVE_ROLES, EXEC_READ_ROLES, STAFF_LEAD_ROLES,
 * SETTINGS_WRITE_ROLES, ALLOWED_ROLES) per
 * docs/tasks/auth-roles-guard-unification.md §3 / §7.7.
 *
 * Spread these into `@Roles(...)` at the controller / method level, e.g.
 *   `@Roles(...STAFF_LEAD)`
 *   `@Roles(...ADMIN_OR_ABOVE)`
 *
 * The exported arrays are typed `readonly Role[]` so callers cannot mutate
 * the canonical groups at runtime.
 */

/**
 * Staff-Lead — per CLAUDE.md "Staff-Lead Definition":
 *   role IN ('staff', 'admin', 'super-admin')
 *
 * Use for staff-controlled workflow transitions (review, verification,
 * approval) and staff-led rollback per §4.1.
 */
export const STAFF_LEAD: readonly Role[] = [
  Role.STAFF,
  Role.ADMIN,
  Role.SUPER_ADMIN,
] as const;

/**
 * Admin or above — admin and super-admin only. Excludes `staff` because per
 * §4.1 staff cannot mutate user identity / WorkHistory rows. Use for
 * work-history mutation endpoints (SEC-01 P0 gates).
 */
export const ADMIN_OR_ABOVE: readonly Role[] = [
  Role.ADMIN,
  Role.SUPER_ADMIN,
] as const;

/**
 * Super-admin only — most restrictive. Use for destructive ops such as
 * hard-delete, system-usage CSV export, notification-alert mutations.
 */
export const SUPER_ADMIN_ONLY: readonly Role[] = [Role.SUPER_ADMIN] as const;

/**
 * Executive read — staff-lead plus c-level. Use for read-only executive
 * dashboards / AI exec chat / notification-alerts LIST (W98 widening) /
 * notification-quota read.
 *
 * Important: `EXEC_READ` includes `staff`. DO NOT reuse this group for
 * `system-usage` read endpoints — those endpoints currently exclude `staff`
 * (per `STATS_READ_ROLES` in `system-usage.controller.ts`). Use `STATS_READ`
 * below instead. Misusing `EXEC_READ` here would silently widen access and
 * is flagged as a regression vector by SEC-01 Required Fix #5.
 */
export const EXEC_READ: readonly Role[] = [
  Role.STAFF,
  Role.ADMIN,
  Role.SUPER_ADMIN,
  Role.C_LEVEL,
] as const;

/**
 * System-usage read — staff / admin / super-admin / c-level.
 *
 * 2026-05-22 widening — `staff` added per user direction. The original
 * SEC-01 Required Fix #5 guidance deliberately excluded `staff` to keep
 * system-usage limited to admin-tier roles, but the product owner has
 * since determined that staff need visibility into login/page-visit
 * counts as part of their day-to-day verification workflow. The
 * underlying data (login events, page visits) does not contain PII or
 * project content; it is operational telemetry. Re-tightening this gate
 * to admin-only MUST be reflected in BOTH this constant AND the FE
 * menu config (`layout/Sidebar/menuConfig.tsx` — system-usage rail row)
 * to avoid drift between the visible menu item and the BE 403 response.
 */
export const STATS_READ: readonly Role[] = [
  Role.STAFF,
  Role.ADMIN,
  Role.SUPER_ADMIN,
  Role.C_LEVEL,
] as const;
