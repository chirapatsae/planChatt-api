import { Controller, Get, Param, ParseUUIDPipe, Req, UseGuards } from '@nestjs/common';

import { CitizenJwtGuard } from '../citizen-auth/citizen-jwt.guard';
import { CitizenAchievementsService } from './citizen-achievements.service';

/** `req.user` shape set by CitizenJwtGuard / CitizenJwtStrategy. */
interface CitizenRequest {
  user: { identityId: string };
}

/**
 * W-P4 civic-gamification badge surface (§17.2 advisory / §18.13 zero-write).
 *
 * Two reads:
 *   - `GET me/achievements` — OWNER-scoped (CitizenJwtGuard). The acting identity
 *     is ALWAYS `req.user.identityId` (NEVER a param), so a citizen only ever
 *     reads their OWN stats + full badge progress.
 *   - `GET citizens/:id/achievements` — PUBLIC (no guard). Returns EARNED badges
 *     ONLY — no raw stats leak (PDPA / §17.3). Mirrors the public profile route
 *     `citizens/:id/profile`.
 *
 * Both endpoints are pure reads — zero writes, no tracking_status / ai_* rows.
 */
@Controller({ path: 'citizen-engagement', version: '1' })
export class CitizenAchievementsController {
  constructor(
    private readonly achievementsService: CitizenAchievementsService,
  ) {}

  // OWNER — full catalog with stats + earned + progress. Identity from the token.
  @Get('me/achievements')
  @UseGuards(CitizenJwtGuard)
  getMine(@Req() req: CitizenRequest) {
    return this.achievementsService.getMine(req.user.identityId);
  }

  // PUBLIC — earned badges ONLY for any citizen's public profile (no stats leak).
  @Get('citizens/:id/achievements')
  getPublic(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.achievementsService.getPublic(id);
  }
}
