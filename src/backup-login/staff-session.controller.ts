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
import type { Request } from 'express';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';

import { JwtAuthGuard } from 'src/auth/auth.guard';
import { StaffSessionRegistryService } from './staff-session-registry.service';

/**
 * Staff device / session self-management (login-alerts /
 * device-session-management, Batch 2). All routes are gated by the canonical
 * `JwtAuthGuard` and bound to `req.user.userId` (+ `req.user.sid` for the
 * "current" flag). The registry helpers enforce ownership (no IDOR).
 *
 *   GET    /api/v1/auth/sessions               → active sessions
 *   DELETE /api/v1/auth/sessions/:sid          → revoke one (own)
 *   POST   /api/v1/auth/sessions/revoke-others → sign out others
 *
 * These operate regardless of the SESSION_REGISTRY_ENABLED flag (read / revoke
 * only); with the flag OFF no rows are minted so the listing is simply empty.
 * NOT gated by `RequirePasswordChangeNotPendingGuard` — a caller mid forced-flow
 * must still be able to see and drop other devices.
 */
@Controller({ path: 'auth/sessions', version: '1' })
export class StaffSessionController {
  constructor(private readonly sessions: StaffSessionRegistryService) {}

  @Get()
  @UseGuards(JwtAuthGuard, ThrottlerGuard)
  @Throttle({ 'backup-login-ip': { limit: 30, ttl: 60_000 } })
  list(@Req() req: Request & { user: { userId: string; sid?: string } }) {
    return this.sessions.listForUser(req.user.userId, req.user.sid);
  }

  @Delete(':sid')
  @UseGuards(JwtAuthGuard, ThrottlerGuard)
  @Throttle({ 'backup-login-ip': { limit: 30, ttl: 60_000 } })
  async revoke(
    @Param('sid', new ParseUUIDPipe()) sid: string,
    @Req() req: Request & { user: { userId: string; sid?: string } },
  ): Promise<{ ok: true }> {
    // Ownership-checked in the service: a row that is missing OR belongs to
    // another user yields a flat 404 (never confirm another account's sid).
    const ok = await this.sessions.revokeOwned(sid, req.user.userId);
    if (!ok) throw new NotFoundException();
    return { ok: true };
  }

  @Post('revoke-others')
  @UseGuards(JwtAuthGuard, ThrottlerGuard)
  @Throttle({ 'backup-login-ip': { limit: 30, ttl: 60_000 } })
  async revokeOthers(
    @Req() req: Request & { user: { userId: string; sid?: string } },
  ): Promise<{ ok: true }> {
    // With a `sid` present, every OTHER device is revoked and the current one
    // is kept. A caller with NO sid (legacy token / flag OFF at mint) has no
    // registry row of its own, so passing '' revokes ALL registry sessions for
    // the user — and the caller's own legacy token is unaffected (registry
    // enforcement only applies to tokens that carry a sid). That is the correct
    // "sign out every other device" outcome for a legacy caller.
    await this.sessions.revokeOthers(req.user.userId, req.user.sid ?? '');
    return { ok: true };
  }
}
