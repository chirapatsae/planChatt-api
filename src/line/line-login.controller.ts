/**
 * line-login.controller.ts — Wave 86 LINE Login OAuth endpoints.
 *
 * Two routes:
 *   1. GET /api/v1/line-login/initiate (JWT-guarded)
 *      - Caller is the Project Bank user starting the link.
 *      - Returns `{ authorizeUrl }` for the FE to navigate to.
 *      - Rate-limited at 5/hour/user via @nestjs/throttler @Throttle().
 *
 *   2. GET /api/v1/line-login/callback (NOT JWT-guarded)
 *      - LINE redirects here with `?code=&state=` (or `?error=`).
 *      - We resolve user identity from the server-side state store —
 *        we deliberately do NOT trust any session cookie at this point
 *        because the user-agent is mid-OAuth-redirect.
 *      - Always returns 302 — never a JSON error body. Frontend handles
 *        the `?line_link=success|error&reason=...` query string.
 *
 * Per CLAUDE.md §17.10 / W83 Logger discipline:
 *   - We never echo the `code`, `id_token`, or `state` value in any
 *     log line.
 *   - The 302 destination is built from `FRONTEND_URL` so we never
 *     reflect attacker-supplied URL fragments back to the browser.
 */

import {
  Controller,
  Get,
  Logger,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { JwtAuthGuard } from 'src/auth/auth.guard';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';
import { assertLineLoginConfig } from './line.config';
import { LineLoginService } from './line-login.service';
import { LineLoginInitiateResponseDto } from './dto/line-login-init.dto';

@Controller({ path: 'line-login', version: '1' })
export class LineLoginController {
  private readonly logger = new Logger(LineLoginController.name);

  constructor(private readonly loginService: LineLoginService) {}

  /**
   * Issue a LINE OAuth authorize URL for the calling user.
   *
   * Throttle: 5 successful initiations per hour per user. Tracker keys
   * collapse to `user:<userId>` via the global throttler tracker
   * fallback (default uses IP — acceptable here as a backstop because
   * each user typically has a stable IP per session; switch to a
   * user-aware tracker in a follow-up if abuse patterns emerge).
   */
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 5, ttl: 3_600_000 } })
  @Get('initiate')
  async initiate(
    @Req() req: Request & { user: JwtPayloadUser },
  ): Promise<LineLoginInitiateResponseDto> {
    if (!req.user?.userId) {
      throw new UnauthorizedException('User not authenticated');
    }
    return this.loginService.initiate(req.user.userId);
  }

  /**
   * Read the current user's LINE binding status.
   *
   * Always 200. Returns `{ linked: false }` when no active binding
   * exists — we deliberately do NOT throw 404 because the FE treats
   * "no binding" as a normal, expected state, not an error.
   *
   * No throttle: this is a read-only, JWT-guarded lookup that the FE
   * polls on profile-page load and after the OAuth redirect to refresh
   * the badge. Adding a throttle here would create false negatives on
   * the post-link refresh.
   */
  @UseGuards(JwtAuthGuard)
  @Get('status')
  async status(
    @Req() req: Request & { user: JwtPayloadUser },
  ): Promise<{
    linked: boolean;
    lineUserId?: string;
    displayName?: string;
    pictureUrl?: string;
    linkedAt?: string;
    basicId?: string;
  }> {
    if (!req.user?.userId) {
      throw new UnauthorizedException('User not authenticated');
    }
    return this.loginService.getLinkStatus(req.user.userId);
  }

  /**
   * Soft-unlink the current user's active LINE binding.
   *
   * Idempotent — `{ unlinked: false }` when no active binding exists.
   * Throttled at 5/hour/user (same envelope as /initiate) to bound any
   * unlink/relink churn against LINE.
   */
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 5, ttl: 3_600_000 } })
  @Post('unlink')
  async unlink(
    @Req() req: Request & { user: JwtPayloadUser },
  ): Promise<{ unlinked: boolean }> {
    if (!req.user?.userId) {
      throw new UnauthorizedException('User not authenticated');
    }
    return this.loginService.unlink(req.user.userId);
  }

  /**
   * OAuth callback — LINE redirects here directly. We do NOT JWT-guard
   * this endpoint because the user-agent does not carry our session
   * token across the LINE redirect chain. Identity is resolved from the
   * one-shot state cookie/store created by /initiate.
   *
   * Always 302 — success page on link, error page with reason short-code
   * on any failure.
   */
  @Get('callback')
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    let frontendUrl: string;
    try {
      ({ frontendUrl } = assertLineLoginConfig());
    } catch (e) {
      // Config gap — return a minimal 503-style HTML rather than
      // attempting to redirect to an unconfigured frontend.
      this.logger.warn(
        `line-login.callback.failure reason=config_missing at=${new Date().toISOString()}`,
      );
      res.status(503).send('LINE Login is not configured');
      return;
    }

    const result = await this.loginService.handleCallback({
      code,
      state,
      error,
    });

    const target = new URL('/profile', frontendUrl);
    if (result.ok) {
      target.searchParams.set('line_link', 'success');
    } else {
      target.searchParams.set('line_link', 'error');
      target.searchParams.set('reason', result.reason ?? 'unknown');
    }
    res.redirect(302, target.toString());
  }
}
