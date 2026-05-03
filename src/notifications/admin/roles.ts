/**
 * Wave 98 PR2 — shared role-gate constants for the admin notifications
 * controllers.
 *
 * Source of truth: `docs/tasks/wave98/W98-BE-PR2-WIDEN-READ-ENDPOINTS.md` §7.1
 *
 * Three sets, each with a different operational profile:
 *
 *   - `EXEC_READ_ROLES`     — read-only observation surface; the executive
 *                             notifications-overview page (Wave 98 PR1)
 *                             consumes these endpoints. Adds `c-level` to the
 *                             pre-W98 staff-lead list. Used for:
 *                               GET /admin/notifications/quota
 *                               GET /admin/email-settings  (kill-switch state)
 *                               GET /admin/notifications/alerts/summary
 *
 *   - `STAFF_LEAD_ROLES`    — pre-W98 staff-lead read surface, retained for
 *                             endpoints we are NOT widening (e.g. the alert
 *                             LIST endpoint, which exposes threshold values
 *                             that c-level should not see).
 *
 *   - `SETTINGS_WRITE_ROLES`— super-admin only. Kill-switch flips, alert
 *                             CRUD writes, force-unlink — all unchanged by
 *                             W98 PR2.
 *
 * CLAUDE.md gates:
 *   - §4.1   — adding `c-level` to the read set grants NO workflow authority;
 *              all workflow-transition guards are unaffected.
 *   - §17.2  — the data exposed remains advisory display data.
 *   - §17.3  — endpoints reading this set MUST NOT write `tracking_status`
 *              and MUST NOT FK any project table.
 *   - §17.11 — this is additive READ access, not a write override; no role
 *              exemption is being introduced.
 */

export const EXEC_READ_ROLES: ReadonlySet<string> = new Set([
  'staff',
  'admin',
  'super-admin',
  'c-level',
]);

export const STAFF_LEAD_ROLES: ReadonlySet<string> = new Set([
  'staff',
  'admin',
  'super-admin',
]);

export const SETTINGS_WRITE_ROLES: ReadonlySet<string> = new Set([
  'super-admin',
]);
