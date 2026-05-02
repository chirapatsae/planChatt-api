import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';

import { JwtAuthGuard } from 'src/auth/auth.guard';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';
import { UsersService } from 'src/users/users.service';
import { AuthEmailService } from './auth-email.service';

/**
 * W95-VERIFY-FLOW — Public + authenticated endpoints for the link-based
 * email verification flow (Q1).
 *
 * Routes (global prefix `/api`, URI versioning):
 *   - POST /api/v1/auth/email/verify-request  (JWT-guarded — caller's own email)
 *   - GET  /api/v1/auth/email/verify          (public — clicked from email)
 *
 * Constraints (CLAUDE.md):
 *   - §4.1  — verification is integrity, NOT workflow authority. The
 *     verify-request endpoint MUST NOT gate any workflow transition.
 *   - §12   — neither endpoint writes to `tracking_status`.
 *   - §17.2 — verification is advisory; the JWT gate remains the workflow
 *     authority everywhere else.
 *   - W83   — token MUST NOT be logged in plaintext. Logged via
 *     first-8-char prefix only. Token MUST NOT appear in error responses.
 *   - W90   — sandbox guard remains active because the email goes through
 *     the same Bull queue + EmailService chokepoint as every other
 *     outbound (handled inside `AuthEmailService`).
 */
@Controller({ path: 'auth/email', version: '1' })
export class EmailVerificationController {
  private readonly logger = new Logger(EmailVerificationController.name);

  /**
   * In-memory cooldown map keyed by `${userId}::email-verify-request`.
   * Per spec §7 a single-process Map is acceptable for this wave; if the
   * deployment scales horizontally this MUST migrate to Redis.
   *
   * Behavior:
   *   - 60s window per user.
   *   - Successful enqueue arms the cooldown.
   *   - 5xx / unexpected errors do NOT arm the cooldown (§17.8 pattern).
   *   - 429 response includes `retryAfterSeconds` so the frontend can show
   *     remaining cooldown in the resend button tooltip.
   */
  private static readonly COOLDOWN_MS = 60_000;
  private static readonly cooldownMap = new Map<string, number>();

  constructor(
    private readonly authEmailService: AuthEmailService,
    private readonly usersService: UsersService,
  ) {}

  // ---------------------------------------------------------------------------
  // POST /api/v1/auth/email/verify-request
  // ---------------------------------------------------------------------------

  /**
   * Send a verification email to the authenticated user's CURRENT email.
   *
   * Per spec §9 (account enumeration defense) the response shape is always
   * `{ ok: true }` regardless of whether:
   *   - the user has an email on file
   *   - the email is already verified
   *   - the email provider successfully accepted the message
   *
   * The single non-success response is `429` when the cooldown is active.
   */
  @Post('verify-request')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async verifyRequest(@Req() req: Request): Promise<{ ok: true }> {
    const user = req.user as JwtPayloadUser | undefined;
    const userId = user?.userId;

    if (!userId) {
      // JwtAuthGuard normally rejects this case; defensive belt-and-braces.
      throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
    }

    const cooldownKey = `${userId}::email-verify-request`;
    const now = Date.now();
    const armedAt = EmailVerificationController.cooldownMap.get(cooldownKey);
    if (typeof armedAt === 'number') {
      const remainingMs =
        armedAt + EmailVerificationController.COOLDOWN_MS - now;
      if (remainingMs > 0) {
        const retryAfterSeconds = Math.ceil(remainingMs / 1000);
        this.logger.log(
          `auth.email.verify-request.cooldown userId=${userId} retryAfter=${retryAfterSeconds}s`,
        );
        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            message: 'cooldown-active',
            retryAfterSeconds,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }

    try {
      // User-initiated resend path — `bypassAllowEmailNotification` MUST
      // remain false so consent is honored. Only the first-login auto-fire
      // path (a future caller) may set this to true.
      await this.authEmailService.queueVerificationEmail({
        userId,
        bypassAllowEmailNotification: false,
      });
      // Arm cooldown ONLY on successful enqueue. 5xx errors fall through to
      // the catch block below and do NOT arm the cooldown (§17.8).
      EmailVerificationController.cooldownMap.set(cooldownKey, now);
      return { ok: true };
    } catch (err) {
      this.logger.error(
        `auth.email.verify-request.error userId=${userId} error=${(err as Error)?.constructor?.name ?? 'UnknownError'}`,
      );
      // Per spec §9 we do not surface the error to the client to avoid
      // enumeration via timing / error code differences.
      return { ok: true };
    }
  }

  // ---------------------------------------------------------------------------
  // POST /api/v1/auth/email/verify-confirm   (Wave 95 amendment — Pattern B)
  // ---------------------------------------------------------------------------

  /**
   * FE-handled verify endpoint. The frontend `/verify-email` page reads the
   * `?u=&t=&exp=` query params from the URL it landed on (clicked from
   * email), then POSTs them here. Returns a discriminated-union JSON
   * envelope; the FE renders loading → success/error UX and self-redirects.
   *
   * Public route — the click itself is the proof of intent. No JWT required.
   * Rate-limit lives on the upstream resend endpoint, not here (cheap CPU).
   *
   * Side effect on success: `usersService.markEmailVerified(userId)` is
   * called. Idempotent — re-clicking a still-valid link is a no-op.
   */
  @Post('verify-confirm')
  @HttpCode(HttpStatus.OK)
  async verifyConfirm(
    @Body()
    body: { u?: unknown; t?: unknown; exp?: unknown } | undefined,
  ): Promise<
    | { valid: true }
    | { valid: false; reason: 'expired' | 'tampered' | 'malformed' }
  > {
    const u = typeof body?.u === 'string' ? body.u : '';
    const t = typeof body?.t === 'string' ? body.t : '';
    const expRaw = body?.exp;
    const expiryNum =
      typeof expRaw === 'number'
        ? expRaw
        : typeof expRaw === 'string'
          ? Number(expRaw)
          : NaN;

    const result = await this.authEmailService.verifyToken({
      userId: u,
      token: t,
      expiry: expiryNum,
    });

    const tokenPrefix = t.slice(0, 8);
    const userPrefix = u.slice(0, 8);

    if (result.valid) {
      try {
        await this.usersService.markEmailVerified(result.userId);
        this.logger.log(
          `auth.email.verify-confirm.success userId=${result.userId} token=${tokenPrefix}`,
        );
        return { valid: true };
      } catch (err) {
        // markEmailVerified is documented as tolerant; if it does throw
        // (DB outage) we surface as 'tampered' to avoid leaking infra state.
        this.logger.error(
          `auth.email.verify-confirm.mark-failed userId=${result.userId} error=${(err as Error)?.constructor?.name ?? 'UnknownError'}`,
        );
        return { valid: false, reason: 'tampered' };
      }
    }

    this.logger.log(
      `auth.email.verify-confirm.failed userId=${userPrefix} token=${tokenPrefix} reason=${result.reason}`,
    );
    return { valid: false, reason: result.reason };
  }

  // ---------------------------------------------------------------------------
  // GET /api/v1/auth/email/verify  (legacy — backward compat for old emails)
  // ---------------------------------------------------------------------------

  /**
   * Validate a clicked verification link and redirect the user to the
   * frontend `/profile` page with a success / failure query parameter.
   *
   * Public route — no JWT required. The frontend handles re-authentication
   * after the redirect (the verify token IS the proof of intent for this
   * single account-scope action).
   *
   * On success: redirect to `${FRONTEND}/profile?verified=1`
   * On failure: redirect to `${FRONTEND}/profile?verified=0&reason=<x>`
   */
  @Get('verify')
  async verify(
    @Query('u') u: string | undefined,
    @Query('exp') exp: string | undefined,
    @Query('t') t: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const frontendBase = AuthEmailService.resolveFrontendBase().replace(
      /\/+$/,
      '',
    );

    // Up-front parse of `exp` so a non-numeric value lands as `malformed`
    // rather than throwing inside the service.
    const expiryNum = typeof exp === 'string' ? Number(exp) : NaN;

    const result = await this.authEmailService.verifyToken({
      userId: u ?? '',
      token: t ?? '',
      expiry: expiryNum,
    });

    // W83 — log only the first 8 chars of the token, the userId UUID, and
    // the verdict reason. Never log the full token or the emailHash.
    const tokenPrefix = typeof t === 'string' ? t.slice(0, 8) : '';
    const userPrefix = typeof u === 'string' ? u.slice(0, 8) : '';

    if (result.valid) {
      try {
        await this.usersService.markEmailVerified(result.userId);
        this.logger.log(
          `auth.email.verify.success userId=${result.userId} token=${tokenPrefix}`,
        );
      } catch (err) {
        // markEmailVerified is documented as tolerant; if it does throw
        // (DB outage) we still redirect with verified=0&reason=tampered to
        // avoid leaking infra state. The user can retry after the
        // outage clears.
        this.logger.error(
          `auth.email.verify.mark-failed userId=${result.userId} error=${(err as Error)?.constructor?.name ?? 'UnknownError'}`,
        );
        return res.redirect(
          302,
          `${frontendBase}/profile?verified=0&reason=tampered`,
        );
      }
      return res.redirect(302, `${frontendBase}/profile?verified=1`);
    }

    this.logger.log(
      `auth.email.verify.failed userId=${userPrefix} token=${tokenPrefix} reason=${result.reason}`,
    );
    return res.redirect(
      302,
      `${frontendBase}/profile?verified=0&reason=${encodeURIComponent(result.reason)}`,
    );
  }
}
