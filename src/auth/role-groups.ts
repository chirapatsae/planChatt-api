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
 * System-usage read — admin / super-admin / c-level (NO staff).
 *
 * Distinct from `EXEC_READ` because the legacy `STATS_READ_ROLES` constant
 * in `system-usage.controller.ts` deliberately excludes `staff`. Per SEC-01
 * Required Fix #5, BE-03 MUST map system-usage read endpoints to this
 * group, NOT to `EXEC_READ`.
 */
export const STATS_READ: readonly Role[] = [
  Role.ADMIN,
  Role.SUPER_ADMIN,
  Role.C_LEVEL,
] as const;
