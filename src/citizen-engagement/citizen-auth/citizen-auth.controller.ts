import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';

import {
  CITIZEN_RATE_LIMITS,
  CITIZEN_THROTTLE_TTL_MS,
} from '../constants/citizen-rate-limits';
import { CitizenAuthService } from './citizen-auth.service';
import { CitizenPasswordResetService } from './citizen-password-reset.service';
import { CitizenJwtGuard } from './citizen-jwt.guard';
import { CitizenRegisterDto } from './dto/citizen-register.dto';
import { CitizenLoginDto } from './dto/citizen-login.dto';
import { CitizenGoogleLoginDto } from './dto/citizen-google-login.dto';
import { CitizenForgotPasswordDto } from './dto/citizen-forgot-password.dto';
import { CitizenResetPasswordDto } from './dto/citizen-reset-password.dto';

/**
 * Citizen auth endpoints (public board identity) — AUTH-REDESIGN 2026-07-08.
 *
 * ThaID is removed. Citizens self-register (email/password), log in, or use
 * "Login with Google". All three exchanges are PUBLIC (no guard) but
 * rate-limited; they issue an `aud:'citizen'` token bound to
 * `citizen_identities`. `me` is gated by the citizen guard.
 */
@Controller({ path: 'citizen-engagement/auth', version: '1' })
export class CitizenAuthController {
  constructor(
    private readonly citizenAuthService: CitizenAuthService,
    private readonly passwordResetService: CitizenPasswordResetService,
  ) {}

  /**
   * Feature flag — the two reset endpoints are ENABLED by default; only an
   * explicit `CITIZEN_PASSWORD_RESET_ENABLED='false'` disables them (→ 404,
   * indistinguishable from a route that does not exist).
   */
  private assertResetEnabled(): void {
    if (process.env.CITIZEN_PASSWORD_RESET_ENABLED === 'false') {
      throw new NotFoundException();
    }
  }

  /** Best-effort client IP for the token audit columns (behind a proxy `ips`
   *  is populated when `trust proxy` is set; fall back to the socket). */
  private clientIp(req: Request): string | null {
    return (
      (Array.isArray(req.ips) && req.ips.length > 0 ? req.ips[0] : undefined) ??
      req.ip ??
      req.socket?.remoteAddress ??
      null
    );
  }

  // ThrottlerGuard runs FIRST so a flood is rejected with 429 BEFORE any
  // Argon2 / Google-verify work (W-SEC-2 anti-brute-force principle).

  @Throttle({
    default: { limit: CITIZEN_RATE_LIMITS.THAID_LOGIN, ttl: CITIZEN_THROTTLE_TTL_MS },
  })
  @UseGuards(ThrottlerGuard)
  @Post('register')
  register(@Body() dto: CitizenRegisterDto) {
    return this.citizenAuthService.register({
      email: dto.email,
      password: dto.password,
      displayName: dto.displayName,
      consentAccepted: dto.consentAccepted,
    });
  }

  @Throttle({
    default: { limit: CITIZEN_RATE_LIMITS.THAID_LOGIN, ttl: CITIZEN_THROTTLE_TTL_MS },
  })
  @UseGuards(ThrottlerGuard)
  @Post('login')
  login(@Body() dto: CitizenLoginDto) {
    return this.citizenAuthService.login({
      email: dto.email,
      password: dto.password,
    });
  }

  @Throttle({
    default: { limit: CITIZEN_RATE_LIMITS.THAID_LOGIN, ttl: CITIZEN_THROTTLE_TTL_MS },
  })
  @UseGuards(ThrottlerGuard)
  @Post('google')
  google(@Body() dto: CitizenGoogleLoginDto) {
    return this.citizenAuthService.loginWithGoogle(dto.idToken);
  }

  // ===================================================================
  //  Password reset (email/password login) — AUTH-REDESIGN §3.2 follow-up
  // ===================================================================

  /**
   * Request a reset link. ALWAYS responds 200 `{ ok: true }` regardless of
   * whether the email exists / its provider / verification state
   * (anti-enumeration, PDPA). All error handling is swallowed in the service.
   */
  @Throttle({
    default: { limit: CITIZEN_RATE_LIMITS.FORGOT_PASSWORD, ttl: CITIZEN_THROTTLE_TTL_MS },
  })
  @UseGuards(ThrottlerGuard)
  @Post('forgot-password')
  async forgotPassword(
    @Body() dto: CitizenForgotPasswordDto,
    @Req() req: Request,
  ): Promise<{ ok: true }> {
    this.assertResetEnabled();
    await this.passwordResetService.requestPasswordReset({
      email: dto.email,
      ip: this.clientIp(req),
      userAgent: req.headers['user-agent'] ?? null,
    });
    return { ok: true };
  }

  /**
   * Consume a reset token and set the new password. Returns 200 `{ ok: true }`
   * on success; EVERY failure surfaces the SAME generic 400 from the service.
   * Does NOT auto-login (redirect-to-login model).
   */
  @Throttle({
    default: { limit: CITIZEN_RATE_LIMITS.RESET_PASSWORD, ttl: CITIZEN_THROTTLE_TTL_MS },
  })
  @UseGuards(ThrottlerGuard)
  @Post('reset-password')
  resetPassword(@Body() dto: CitizenResetPasswordDto): Promise<{ ok: true }> {
    this.assertResetEnabled();
    return this.passwordResetService.resetPassword({
      token: dto.token,
      newPassword: dto.newPassword,
    });
  }

  /**
   * Low-risk pre-check so the FE can show "link expired" before asking for a
   * new password. Generic — `{ valid }` never reveals WHY it is invalid.
   */
  @Throttle({
    default: { limit: CITIZEN_RATE_LIMITS.RESET_PASSWORD, ttl: CITIZEN_THROTTLE_TTL_MS },
  })
  @UseGuards(ThrottlerGuard)
  // SEC F2 — POST (token in body), NOT GET ?token=. A secret in the query
  // string leaks to access/proxy logs, browser history, and `Referer`. The
  // consume route already uses the body; the pre-check now matches.
  @Post('reset-password/verify')
  async verifyResetToken(
    @Body('token') token: string,
  ): Promise<{ valid: boolean }> {
    this.assertResetEnabled();
    const valid = await this.passwordResetService.verifyToken(token ?? '');
    return { valid };
  }

  @Get('me')
  @UseGuards(CitizenJwtGuard)
  me(@Req() req: { user: { identityId: string } }) {
    return this.citizenAuthService.me(req.user.identityId);
  }
}
