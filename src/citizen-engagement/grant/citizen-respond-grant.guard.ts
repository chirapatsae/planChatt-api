import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

import { CitizenGrantService } from './citizen-grant.service';

/**
 * CitizenRespondGrantGuard — gates the official-response write on a live
 * `respond` grant (C4, plan D6 + D12).
 *
 * Placed AFTER `JwtAuthGuard` so `req.user.userId` (set by `JwtStrategy`) is
 * populated. The grant table — NOT a global role — is the authority:
 *   - missing `req.user.userId` → 401 (auth-chain misconfiguration)
 *   - no live `respond` grant   → 403 `CITIZEN_RESPOND_NOT_GRANTED`
 *
 * This is the BE source of truth; any FE role gate is advisory only.
 */
@Injectable()
export class CitizenRespondGrantGuard implements CanActivate {
  constructor(private readonly grantService: CitizenGrantService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<{ user?: { userId?: string } }>();

    const userId = request?.user?.userId;
    if (!userId) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const granted = await this.grantService.hasGrant(userId, 'respond');
    if (!granted) {
      throw new ForbiddenException('CITIZEN_RESPOND_NOT_GRANTED');
    }

    return true;
  }
}
