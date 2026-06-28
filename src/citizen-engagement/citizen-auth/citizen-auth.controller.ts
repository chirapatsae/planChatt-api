import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';

import {
  CITIZEN_RATE_LIMITS,
  CITIZEN_THROTTLE_TTL_MS,
} from '../constants/citizen-rate-limits';
import { CitizenAuthService } from './citizen-auth.service';
import { CitizenJwtGuard } from './citizen-jwt.guard';
import { CitizenThaidLoginDto } from './dto/citizen-thaid-login.dto';

/**
 * Citizen ThaID auth endpoints (public board identity).
 *
 * `thaid-login` is PUBLIC (no guard) — it exchanges a ThaID id_token for a
 * citizen session, exactly like the staff `/auth/oauth-login` principle, but
 * issues an `aud:'citizen'` token bound to `citizen_identities`. `me` is
 * gated by the citizen guard.
 */
@Controller({ path: 'citizen-engagement/auth', version: '1' })
export class CitizenAuthController {
  constructor(private readonly citizenAuthService: CitizenAuthService) {}

  // W-SEC-2 — anti-brute-force on the public login exchange. ThrottlerGuard
  // runs FIRST so a flood is rejected with 429 BEFORE any id_token decode work.
  @Throttle({
    default: { limit: CITIZEN_RATE_LIMITS.THAID_LOGIN, ttl: CITIZEN_THROTTLE_TTL_MS },
  })
  @UseGuards(ThrottlerGuard)
  @Post('thaid-login')
  login(@Body() dto: CitizenThaidLoginDto) {
    return this.citizenAuthService.loginWithThaid(dto.id_token);
  }

  @Get('me')
  @UseGuards(CitizenJwtGuard)
  me(@Req() req: { user: { identityId: string } }) {
    return this.citizenAuthService.me(req.user.identityId);
  }
}
