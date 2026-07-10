import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';

import {
  CITIZEN_RATE_LIMITS,
  CITIZEN_THROTTLE_TTL_MS,
} from '../constants/citizen-rate-limits';
import { CitizenAuthService } from './citizen-auth.service';
import { CitizenJwtGuard } from './citizen-jwt.guard';
import { CitizenRegisterDto } from './dto/citizen-register.dto';
import { CitizenLoginDto } from './dto/citizen-login.dto';
import { CitizenGoogleLoginDto } from './dto/citizen-google-login.dto';

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
  constructor(private readonly citizenAuthService: CitizenAuthService) {}

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

  @Get('me')
  @UseGuards(CitizenJwtGuard)
  me(@Req() req: { user: { identityId: string } }) {
    return this.citizenAuthService.me(req.user.identityId);
  }
}
