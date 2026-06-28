import {
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * CitizenJwtGuard — gate for ThaID-authenticated CITIZEN write actions.
 *
 * Mirrors the internal `JwtAuthGuard` session-version + status pattern, but
 * against `citizen_identities` (NEVER `users`), and WITHOUT the internal
 * `secret-key` header gate (the public board does not use LOGIN_SECRET). A
 * blocked or session-revoked citizen is rejected here.
 */
@Injectable()
export class CitizenJwtGuard extends AuthGuard('citizen-jwt') {
  private readonly logger = new Logger(CitizenJwtGuard.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const ok = (await super.canActivate(context)) as boolean;
    if (!ok) return false;

    const request = context.switchToHttp().getRequest();
    const user = request.user as { identityId?: string; sessionVersion?: number } | undefined;
    if (!user?.identityId) {
      throw new UnauthorizedException('Invalid citizen credentials');
    }

    try {
      const rows: Array<{ status: string; session_version: number }> = await this.dataSource.query(
        'SELECT status, session_version FROM citizen_identities WHERE id = $1 AND deleted_at IS NULL',
        [user.identityId],
      );
      const row = rows[0];
      if (!row) {
        throw new UnauthorizedException('Citizen identity not found');
      }
      // W-T3 offender ladder: a `suspended` author keeps a valid session but is
      // blocked from WRITES — distinct 403 CITIZEN_SUSPENDED (clear FE copy)
      // until a staff reinstate flips them back to `active`. Other non-active
      // states (`blocked` / `deleted`) stay the existing 401.
      if (row.status === 'suspended') {
        throw new ForbiddenException('CITIZEN_SUSPENDED');
      }
      if (row.status !== 'active') {
        throw new UnauthorizedException('Citizen identity blocked');
      }
      if ((user.sessionVersion ?? 0) < (row.session_version ?? 0)) {
        throw new UnauthorizedException('Session invalidated; please login again');
      }
    } catch (err) {
      // Re-throw our intentional auth rejections verbatim — UnauthorizedException
      // (blocked/deleted/stale session) AND the W-T3 suspended ForbiddenException
      // (CITIZEN_SUSPENDED) — so the catch's fail-closed fallback doesn't mask them.
      if (err instanceof UnauthorizedException) throw err;
      if (err instanceof ForbiddenException) throw err;
      // DB hiccup — fail closed for citizen writes (unlike the internal guard,
      // there is no hot-path correctness need to keep going).
      this.logger.warn(`[CitizenJwtGuard] identity read failed: ${(err as Error).message}`);
      throw new UnauthorizedException('Unable to verify citizen session');
    }

    return true;
  }

  handleRequest(err, user, info) {
    if (info?.name === 'TokenExpiredError') {
      throw new UnauthorizedException('Token has expired');
    }
    if (err || !user) {
      throw err || new UnauthorizedException('Invalid citizen credentials');
    }
    return user;
  }
}
