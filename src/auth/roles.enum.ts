/**
 * Canonical Role enum — single source of truth for application role names.
 *
 * The string values MUST exactly match the values stored in the database
 * `roles.name` column and emitted in the JWT `role` claim. Any drift between
 * this enum and the DB seed is a P0 bug (see auth-roles-guard-unification §7.1
 * and §9 "Role-string-vs-enum").
 *
 * Verified against:
 *   - backend/src/work-history/dto/update-work-history.dto.ts (UserRole enum)
 *   - backend/src/ai-executive-chat/guards/executive-role.guard.ts (ALLOWED_ROLES)
 *   - JWT claim shape from backend/src/auth/jwt.strategy.ts (`role: string`)
 *
 * CLAUDE.md references:
 *   - "Staff-Lead Definition" — role IN ('staff', 'admin', 'super-admin')
 *   - §4.1 Ownership vs Workflow Authority — role gating is identity-scoped
 *   - §17.11 No role exemption — no override path is permitted
 */
export enum Role {
  USER = 'user',
  STAFF = 'staff',
  ADMIN = 'admin',
  SUPER_ADMIN = 'super-admin',
  C_LEVEL = 'c-level',
}
