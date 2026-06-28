import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { Response } from 'express';

import { CitizenJwtGuard } from '../citizen-auth/citizen-jwt.guard';
import {
  CITIZEN_RATE_LIMITS,
  CITIZEN_THROTTLE_TTL_MS,
} from '../constants/citizen-rate-limits';
import { CitizenDsarService } from './citizen-dsar.service';

/** `req.user` shape set by CitizenJwtGuard / CitizenJwtStrategy. */
interface CitizenRequest {
  user: { identityId: string };
}

/**
 * OWNER-scoped PDPA DSAR surface (W-G1) at `/v1/citizen-engagement/me/*`.
 *
 * Sibling of `CitizenProfileController` — both mount on the `me` segment. The
 * acting identity is ALWAYS `req.user.identityId` (NEVER a body/param), so a
 * citizen can only ever export / erase their OWN data (no IDOR). Both routes
 * are gated by the STRICT `CitizenJwtGuard` + a tight `ThrottlerGuard`.
 *
 * §17.2 advisory / §17.3 isolated.
 */
@Controller({ path: 'citizen-engagement/me', version: '1' })
export class CitizenDsarController {
  constructor(private readonly dsarService: CitizenDsarService) {}

  /**
   * PDPA data export — streams ONE JSON object of everything the caller owns as
   * a downloadable attachment. Heavy full-account read → very low cap.
   */
  @Throttle({
    default: { limit: CITIZEN_RATE_LIMITS.DSAR_EXPORT, ttl: CITIZEN_THROTTLE_TTL_MS },
  })
  @Get('data-export')
  @UseGuards(CitizenJwtGuard, ThrottlerGuard)
  async dataExport(
    @Req() req: CitizenRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    const data = await this.dsarService.exportMine(req.user.identityId);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="my-community-data.json"',
    );
    return data;
  }

  /**
   * PDPA right-to-erasure — soft-deletes ALL the caller's content, anonymizes
   * the identity, bumps `session_version` (invalidating the live JWT), and
   * writes a retained audit row. Irreversible → tightest cap. Returns 200.
   */
  @Throttle({
    default: { limit: CITIZEN_RATE_LIMITS.DSAR_ERASE, ttl: CITIZEN_THROTTLE_TTL_MS },
  })
  @Delete('account')
  @HttpCode(200)
  @UseGuards(CitizenJwtGuard, ThrottlerGuard)
  deleteAccount(@Req() req: CitizenRequest) {
    return this.dsarService.eraseMine(req.user.identityId);
  }
}
