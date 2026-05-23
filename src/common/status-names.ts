/**
 * Canonical backend status-name constants.
 *
 * Source of truth:
 *   - CLAUDE.md -> Core Status Machine
 *     The 8 canonical workflow statuses used across the Project Bank system:
 *       Ready, Pending, Verified, Pending_Approval, Approved, Pull_Back,
 *       Returned_For_Revision, Rejected (W67 — "เกินศักยภาพ" workflow exit).
 *   - CLAUDE.md -> Status Naming Constraint
 *     The literal name "Revision" is RESERVED and MUST NOT be used as a status
 *     value (it collides with the DevelopmentPlanRevision entity). The approved
 *     replacement is "Returned_For_Revision".
 *   - CLAUDE.md -> Returned_For_Revision Rule
 *     Semantics for the staff-triggered "return to owner for correction" flow.
 *   - CLAUDE.md -> Rejected Status (W67)
 *     8th canonical status; workflow exit state indicating the project exceeds
 *     organizational capacity.
 *
 * Purpose:
 *   Give backend code (services, filters, specs, future migrations) a single
 *   import site for the canonical status names so that drift between code and
 *   the seeded DB rows becomes impossible to introduce silently. The frozen
 *   object pattern (rather than a TS enum) preserves the exact string values
 *   that the DB stores and keeps the module free of any framework coupling.
 *
 * Constraints:
 *   - This module MUST remain dependency-free. It MUST NOT import from NestJS,
 *     TypeORM, or any runtime framework — so that it can safely be imported
 *     from migrations, unit tests, filters, and services alike.
 *   - String values MUST match the DB-seeded `status.name` rows EXACTLY
 *     (case-sensitive, underscores preserved).
 *   - The object MUST be frozen at runtime to prevent accidental mutation by
 *     callers.
 */

export const STATUS_NAMES = Object.freeze({
  READY: 'Ready',
  PENDING: 'Pending',
  VERIFIED: 'Verified',
  PENDING_APPROVAL: 'Pending_Approval',
  APPROVED: 'Approved',
  PULL_BACK: 'Pull_Back',
  RETURNED_FOR_REVISION: 'Returned_For_Revision',
  REJECTED: 'Rejected',
} as const);

/**
 * Union of the 8 canonical status-name string literals.
 *
 * Derived directly from {@link STATUS_NAMES} so that adding / renaming a key
 * in the frozen object automatically updates the type surface.
 */
export type StatusName = (typeof STATUS_NAMES)[keyof typeof STATUS_NAMES];

/**
 * Runtime type-guard for {@link StatusName}.
 *
 * Useful at boundaries where an untyped string (e.g., a request body, a raw
 * DB value, a CSV import row) must be narrowed to the canonical union before
 * downstream business logic executes.
 */
export function isStatusName(value: string): value is StatusName {
  return (Object.values(STATUS_NAMES) as readonly string[]).includes(value);
}
