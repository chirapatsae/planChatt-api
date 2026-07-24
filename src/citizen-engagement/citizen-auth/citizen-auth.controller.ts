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
import { CitizenLoginOtpService } from './citizen-login-otp.service';
import { CitizenRegistrationOtpService } from './citizen-registration-otp.service';
import { CitizenPasswordResetService } from './citizen-password-reset.service';
import { CitizenJwtGuard } from './citizen-jwt.guard';
import { CitizenRegisterDto } from './dto/citizen-register.dto';
import { CitizenRegisterRequestOtpDto } from './dto/citizen-register-request-otp.dto';
import { CitizenRegisterVerifyOtpDto } from './dto/citizen-register-verify-otp.dto';
import { CitizenRegisterResendDto } from './dto/citizen-register-resend.dto';
import { CitizenRegisterCompleteDto } from './dto/citizen-register-complete.dto';
import { CitizenLoginDto } from './dto/citizen-login.dto';
import { CitizenLoginOtpDto } from './dto/citizen-login-otp.dto';
import { CitizenOtpResendDto } from './dto/citizen-otp-resend.dto';
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
    private readonly loginOtpService: CitizenLoginOtpService,
    private readonly registrationOtpService: CitizenRegistrationOtpService,
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

  /**
   * Master feature flag for mandatory email-OTP 2FA. ENABLED by default; only
   * an explicit `CITIZEN_LOGIN_OTP_ENABLED='false'` disables the OTP endpoints
   * (→ 404, indistinguishable from a route that does not exist). When disabled,
   * login/register/google mint a session directly (rollback path) so these
   * step-2 routes carry no challenge to verify.
   */
  private assertOtpEnabled(): void {
    if (process.env.CITIZEN_LOGIN_OTP_ENABLED === 'false') {
      throw new NotFoundException();
    }
  }

  /**
   * Verify-email-first 3-step registration master flag. ENABLED by default; only
   * an explicit `CITIZEN_VERIFY_FIRST_REGISTER='false'` disables it. The two
   * paths are MUTUALLY EXCLUSIVE (mirror-guard):
   *   - ON  → the 4 `register/*` step routes live; the legacy one-shot
   *           `POST register` returns 404 (indistinguishable from a missing
   *           route) so no identity is ever created without a verified email.
   *   - OFF → the 4 step routes return 404; the legacy `POST register`
   *           (create-account-then-OTP) works again (rollback path).
   */
  private verifyFirstEnabled(): boolean {
    return process.env.CITIZEN_VERIFY_FIRST_REGISTER !== 'false';
  }

  private assertVerifyFirstEnabled(): void {
    if (!this.verifyFirstEnabled()) {
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
  register(@Body() dto: CitizenRegisterDto, @Req() req: Request) {
    // Mirror-guard: when verify-email-first is ON (default) the legacy one-shot
    // register is retired → 404 (indistinguishable from a missing route), so an
    // identity is never created without a verified email. Flip
    // CITIZEN_VERIFY_FIRST_REGISTER='false' to restore this rollback path (the
    // old register() + CITIZEN_OTP_ON_REGISTER code is kept intact for exactly
    // that — it is a NO-OP while verify-first is ON).
    if (this.verifyFirstEnabled()) {
      throw new NotFoundException();
    }
    return this.citizenAuthService.register({
      email: dto.email,
      password: dto.password,
      displayName: dto.displayName,
      consentAccepted: dto.consentAccepted,
      ip: this.clientIp(req),
      userAgent: req.headers['user-agent'] ?? null,
    });
  }

  @Throttle({
    default: { limit: CITIZEN_RATE_LIMITS.THAID_LOGIN, ttl: CITIZEN_THROTTLE_TTL_MS },
  })
  @UseGuards(ThrottlerGuard)
  @Post('login')
  login(@Body() dto: CitizenLoginDto, @Req() req: Request) {
    return this.citizenAuthService.login({
      email: dto.email,
      password: dto.password,
      ip: this.clientIp(req),
      userAgent: req.headers['user-agent'] ?? null,
    });
  }

  @Throttle({
    default: { limit: CITIZEN_RATE_LIMITS.THAID_LOGIN, ttl: CITIZEN_THROTTLE_TTL_MS },
  })
  @UseGuards(ThrottlerGuard)
  @Post('google')
  google(@Body() dto: CitizenGoogleLoginDto, @Req() req: Request) {
    return this.citizenAuthService.loginWithGoogle(
      dto.idToken,
      this.clientIp(req),
      req.headers['user-agent'] ?? null,
    );
  }

  // ===================================================================
  //  Mandatory email-OTP 2FA (step 2) — the ONLY place a login session
  //  is minted. Step 1 (login/register/google) returns an otpChallengeToken.
  // ===================================================================

  /**
   * Verify the 6-digit code against the challenge → `{ accessToken, profile }`.
   * EVERY failure surfaces the SAME generic 401 from the service (never
   * distinguishes bad-token / expired / consumed / attempt-cap / wrong-code).
   */
  @Throttle({
    default: { limit: CITIZEN_RATE_LIMITS.OTP_VERIFY, ttl: CITIZEN_THROTTLE_TTL_MS },
  })
  @UseGuards(ThrottlerGuard)
  @Post('login/otp')
  loginOtp(@Body() dto: CitizenLoginOtpDto, @Req() req: Request) {
    this.assertOtpEnabled();
    // Thread the STEP-2 request's ip/ua (cleaner than trusting the step-1
    // fingerprint) so the recorded session reflects the device that actually
    // completed the login. No-op unless SESSION_REGISTRY_ENABLED === 'true'.
    return this.loginOtpService.verify(
      dto.otpChallengeToken,
      dto.code,
      this.clientIp(req),
      req.headers['user-agent'] ?? null,
    );
  }

  /**
   * Re-issue a fresh code on the SAME challenge. ALWAYS 200
   * `{ ok:true, resendCooldownSec }` — silent no-op on cooldown / cap / bad
   * token (anti-enumeration + anti-mailbomb).
   */
  @Throttle({
    default: { limit: CITIZEN_RATE_LIMITS.OTP_RESEND, ttl: CITIZEN_THROTTLE_TTL_MS },
  })
  @UseGuards(ThrottlerGuard)
  @Post('login/otp/resend')
  loginOtpResend(
    @Body() dto: CitizenOtpResendDto,
  ): Promise<{ ok: true; resendCooldownSec: number }> {
    this.assertOtpEnabled();
    return this.loginOtpService.resend(dto.otpChallengeToken);
  }

  // ===================================================================
  //  Verify-email-first registration (3 steps). Prove email ownership BEFORE
  //  any identity is created — the citizen_identities row is minted ONLY at
  //  `register/complete`. Gated by CITIZEN_VERIFY_FIRST_REGISTER (default ON;
  //  mutually exclusive with the legacy `POST register`).
  // ===================================================================

  /**
   * STEP 1 — email a 6-digit code, return a `challengeToken`. NO identity is
   * created. ALWAYS uniform (anti-enumeration): a registered email gets an
   * "account already exists" notice instead of an OTP, but the response shape +
   * timing are indistinguishable.
   */
  @Throttle({
    default: { limit: CITIZEN_RATE_LIMITS.REGISTER_OTP_REQUEST, ttl: CITIZEN_THROTTLE_TTL_MS },
  })
  @UseGuards(ThrottlerGuard)
  @Post('register/request-otp')
  registerRequestOtp(
    @Body() dto: CitizenRegisterRequestOtpDto,
    @Req() req: Request,
  ) {
    this.assertVerifyFirstEnabled();
    return this.registrationOtpService.requestOtp(
      dto.email,
      this.clientIp(req),
      req.headers['user-agent'] ?? null,
    );
  }

  /**
   * STEP 2 — verify the 6-digit code against the challenge → `registrationToken`.
   * EVERY failure surfaces the SAME generic 401 from the service (never
   * distinguishes bad-token / expired / consumed / attempt-cap / wrong-code).
   */
  @Throttle({
    default: { limit: CITIZEN_RATE_LIMITS.OTP_VERIFY, ttl: CITIZEN_THROTTLE_TTL_MS },
  })
  @UseGuards(ThrottlerGuard)
  @Post('register/verify-otp')
  registerVerifyOtp(@Body() dto: CitizenRegisterVerifyOtpDto) {
    this.assertVerifyFirstEnabled();
    return this.registrationOtpService.verifyOtp(dto.challengeToken, dto.code);
  }

  /**
   * STEP 2 helper — re-issue a fresh code on the SAME challenge. ALWAYS 200
   * `{ ok:true, resendCooldownSec }` — silent no-op on cooldown / cap / bad
   * token (anti-enumeration + anti-mailbomb).
   */
  @Throttle({
    default: { limit: CITIZEN_RATE_LIMITS.OTP_RESEND, ttl: CITIZEN_THROTTLE_TTL_MS },
  })
  @UseGuards(ThrottlerGuard)
  @Post('register/otp/resend')
  registerOtpResend(
    @Body() dto: CitizenRegisterResendDto,
  ): Promise<{ ok: true; resendCooldownSec: number }> {
    this.assertVerifyFirstEnabled();
    return this.registrationOtpService.resend(dto.challengeToken);
  }

  /**
   * STEP 3 — create the citizen identity (email already verified) + mint the
   * real session. Requires `consentAccepted===true` (PDPA). EVERY token failure
   * surfaces the SAME generic error from the service.
   */
  @Throttle({
    default: { limit: CITIZEN_RATE_LIMITS.REGISTER_COMPLETE, ttl: CITIZEN_THROTTLE_TTL_MS },
  })
  @UseGuards(ThrottlerGuard)
  @Post('register/complete')
  registerComplete(@Body() dto: CitizenRegisterCompleteDto, @Req() req: Request) {
    this.assertVerifyFirstEnabled();
    return this.registrationOtpService.complete(
      dto.registrationToken,
      {
        password: dto.password,
        displayName: dto.displayName,
        consentAccepted: dto.consentAccepted,
      },
      this.clientIp(req),
      req.headers['user-agent'] ?? null,
    );
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
