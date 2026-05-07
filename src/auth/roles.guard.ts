import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from './roles.decorator';
import { Role } from './roles.enum';

/**
 * RolesGuard — canonical role gate.
 *
 * Reads the `@Roles(...)` metadata from the route handler (and falls back to
 * the controller class if no per-method override is set). Compares against
 * the JWT-cached `req.user.role` (populated by `JwtStrategy.validate`).
 *
 * Behavior contract:
 *   - No `@Roles()` metadata on the route or class → returns true (no-op).
 *     This preserves backward compatibility for un-migrated controllers
 *     and is intentional per §7.3 / §11 "Risk: globally registered guard".
 *   - Missing `req.user` (i.e., JwtAuthGuard did not run first or did not
 *     populate the request) → throws `ForbiddenException('FORBIDDEN_ROLE')`.
 *     The auth-chain ordering check (`JwtAuthGuard` BEFORE `RolesGuard`) is
 *     a Phase 2/3 migration responsibility per §7.6.
 *   - `req.user.role` not in the required set → throws
 *     `ForbiddenException('FORBIDDEN_ROLE')`. Phase 3 may extend per-route
 *     Thai copy via a wrapper guard or method-level decorator (§6).
 *
 * Case sensitivity: matching is strict (case-sensitive) against the `Role`
 * enum string values. JWT tokens issued by this system always carry
 * lowercase hyphenated role names (`'super-admin'`, `'c-level'`); a
 * mixed-case token claim is treated as a mismatch and rejected.
 *
 * §17.11 compliance: there is NO bypass / skip metadata. Defense-in-depth.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<Role[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    // No @Roles() decorator → guard is a no-op. JwtAuthGuard remains in
    // charge of authentication; RolesGuard simply has nothing to enforce.
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<{ user?: { role?: string } }>();

    const userRole = request?.user?.role;

    if (!userRole || !requiredRoles.includes(userRole as Role)) {
      throw new ForbiddenException('FORBIDDEN_ROLE');
    }

    return true;
  }
}
