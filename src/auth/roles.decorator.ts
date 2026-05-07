import { SetMetadata } from '@nestjs/common';
import { Role } from './roles.enum';

/**
 * Metadata key used by `RolesGuard` to read the required-roles list from a
 * route handler / controller class.
 */
export const ROLES_KEY = 'roles';

/**
 * `@Roles(...roles)` — declares the canonical role gate for a route.
 *
 * Usage:
 *   ```ts
 *   @UseGuards(JwtAuthGuard, RolesGuard)
 *   @Roles(Role.ADMIN, Role.SUPER_ADMIN)
 *   @Patch(':id')
 *   update(...) { ... }
 *   ```
 *
 * Or with role groups:
 *   ```ts
 *   @Roles(...STAFF_LEAD)
 *   ```
 *
 * Constraints (per §17.11 / §9 of the task):
 *   - There is no `@SkipRoles()` companion decorator. If a route should be
 *     un-gated, omit `@Roles()` entirely (the guard becomes a no-op).
 *   - Auth-chain ordering MUST be `JwtAuthGuard` THEN `RolesGuard` so that
 *     `req.user.role` is populated before the guard reads it (§7.6).
 */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
