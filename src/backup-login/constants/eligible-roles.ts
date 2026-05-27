import { Role } from 'src/auth/roles.enum';

/**
 * SECURITY-01 §7.9 — Phase 1 eligibility matrix (user-locked).
 *
 * ALL six roles are eligible to hold a backup credential and use the
 * `/v1/auth/backup-login/*` surface. Listed explicitly (not
 * `Object.values(Role)`) so a future addition to the `Role` enum does
 * NOT silently widen the backup-login attack surface — adding a new
 * role must require a deliberate edit to this list.
 */
export const BACKUP_LOGIN_ELIGIBLE_ROLES: readonly Role[] = [
  Role.USER,
  Role.STAFF,
  Role.ADMIN,
  Role.SUPER_ADMIN,
  Role.C_LEVEL,
] as const;

export function isBackupLoginEligibleRole(role: string | null | undefined): boolean {
  if (!role) return false;
  return BACKUP_LOGIN_ELIGIBLE_ROLES.includes(role as Role);
}
