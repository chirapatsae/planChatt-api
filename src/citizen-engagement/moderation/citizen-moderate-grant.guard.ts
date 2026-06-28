import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

import { CitizenGrantService } from '../grant/citizen-grant.service';

/**
 * CitizenModerateGrantGuard — gates the staff moderation queue + actions on a
 * live `moderate` grant (C5, plan D6 + D13). Sibling of
 * `CitizenRespondGrantGuard`; placed AFTER `JwtAuthGuard` so `req.user.userId`
 * is populated. The grant table — NOT a global role — is the authority:
 *   - missing `req.user.userId` → 401
 *   - no live `moderate` grant   → 403 `CITIZEN_MODERATE_NOT_GRANTED`
 *
 * The BE is the source of truth; any FE role gate is advisory (§17.11).
 */
@Injectable()
export class CitizenModerateGrantGuard implements CanActivate {
  constructor(private readonly grantService: CitizenGrantService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<{ user?: { userId?: string } }>();

    const userId = request?.user?.userId;
    if (!userId) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const granted = await this.grantService.hasGrant(userId, 'moderate');
    if (!granted) {
      throw new ForbiddenException('CITIZEN_MODERATE_NOT_GRANTED');
    }

    return true;
  }
}
