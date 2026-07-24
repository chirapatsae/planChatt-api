import {
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';

import {
  CITIZEN_RATE_LIMITS,
  CITIZEN_THROTTLE_TTL_MS,
} from '../constants/citizen-rate-limits';
import { CitizenJwtGuard } from './citizen-jwt.guard';
import { CitizenSessionRegistryService } from './citizen-session-registry.service';

/**
 * Citizen device / session self-management (login-alerts /
 * device-session-management, Batch 2). All routes are gated by the strict
 * `CitizenJwtGuard` and bound to `req.user.identityId` (+ `req.user.sid` for the
 * "current" flag). The registry helpers enforce ownership (no IDOR).
 *
 *   GET    /api/v1/citizen-engagement/sessions               → active sessions
 *   DELETE /api/v1/citizen-engagement/sessions/:sid          → revoke one (own)
 *   POST   /api/v1/citizen-engagement/sessions/revoke-others → sign out others
 *
 * These operate regardless of the SESSION_REGISTRY_ENABLED flag (they only read
 * / revoke rows); with the flag OFF no rows are ever minted, so the listing is
 * simply empty. The master switch stays purely about MINT-time behavior.
 */
@Controller({ path: 'citizen-engagement/sessions', version: '1' })
export class CitizenSessionController {
  constructor(private readonly sessions: CitizenSessionRegistryService) {}

  private currentUser(req: {
    user: { identityId: string; sid?: string };
  }): { identityId: string; sid?: string } {
    return req.user;
  }

  @Get()
  @UseGuards(CitizenJwtGuard, ThrottlerGuard)
  @Throttle({
    default: {
      limit: CITIZEN_RATE_LIMITS.MANAGE_SESSIONS,
      ttl: CITIZEN_THROTTLE_TTL_MS,
    },
  })
  list(@Req() req: { user: { identityId: string; sid?: string } }) {
    const { identityId, sid } = this.currentUser(req);
    return this.sessions.listForIdentity(identityId, sid);
  }

  @Delete(':sid')
  @UseGuards(CitizenJwtGuard, ThrottlerGuard)
  @Throttle({
    default: {
      limit: CITIZEN_RATE_LIMITS.MANAGE_SESSIONS,
      ttl: CITIZEN_THROTTLE_TTL_MS,
    },
  })
  async revoke(
    @Param('sid', new ParseUUIDPipe()) sid: string,
    @Req() req: { user: { identityId: string; sid?: string } },
  ): Promise<{ ok: true }> {
    const { identityId } = this.currentUser(req);
    // Ownership-checked in the service: a row that is missing OR belongs to
    // another identity yields a flat 404 (never confirm another account's sid).
    const ok = await this.sessions.revokeOwned(sid, identityId);
    if (!ok) throw new NotFoundException();
    return { ok: true };
  }

  @Post('revoke-others')
  @UseGuards(CitizenJwtGuard, ThrottlerGuard)
  @Throttle({
    default: {
      limit: CITIZEN_RATE_LIMITS.MANAGE_SESSIONS,
      ttl: CITIZEN_THROTTLE_TTL_MS,
    },
  })
  async revokeOthers(
    @Req() req: { user: { identityId: string; sid?: string } },
  ): Promise<{ ok: true }> {
    const { identityId, sid } = this.currentUser(req);
    // With a `sid` present, every OTHER device is revoked and the current one is
    // kept. A caller with NO sid (legacy token / flag was OFF at mint) has no
    // registry row of its own, so passing '' revokes ALL registry sessions for
    // the identity — and the caller's own legacy token is unaffected (registry
    // enforcement only applies to tokens that carry a sid). That is the correct
    // "sign out every other device" outcome for a legacy caller.
    await this.sessions.revokeOthers(identityId, sid ?? '');
    return { ok: true };
  }
}
