import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';

import { CitizenJwtGuard } from '../citizen-auth/citizen-jwt.guard';
import {
  CITIZEN_RATE_LIMITS,
  CITIZEN_THROTTLE_TTL_MS,
} from '../constants/citizen-rate-limits';
import { SetCitizenBlockDto } from '../dto/set-citizen-block.dto';
import { CitizenBlockService } from './citizen-block.service';

/** `req.user` shape set by CitizenJwtGuard / CitizenJwtStrategy. */
interface CitizenRequest {
  user: { identityId: string };
}

/**
 * Citizen BLOCK / MUTE surface (W-T1, §17.2 advisory).
 *
 * The acting (blocker) identity is ALWAYS `req.user.identityId` (NEVER a
 * body/param). PRIVACY (W-T1): block/mute is PRIVATE — the target is never
 * notified; the lists are owner-scoped (a citizen reads / unsets only its OWN
 * blocks). All three routes are gated by the STRICT `CitizenJwtGuard` (these
 * are authenticated actions, not public reads).
 */
@Controller({ path: 'citizen-engagement', version: '1' })
export class CitizenBlockController {
  constructor(private readonly blockService: CitizenBlockService) {}

  // W-SEC — block/mute is a low-frequency moderation action; capped against churn.
  @Throttle({
    default: { limit: CITIZEN_RATE_LIMITS.SET_BLOCK, ttl: CITIZEN_THROTTLE_TTL_MS },
  })
  @Post('blocks')
  @UseGuards(CitizenJwtGuard, ThrottlerGuard)
  set(@Req() req: CitizenRequest, @Body() dto: SetCitizenBlockDto) {
    return this.blockService.set(
      req.user.identityId,
      dto.targetIdentityId,
      dto.kind,
    );
  }

  @Delete('blocks/:targetId')
  @UseGuards(CitizenJwtGuard)
  unset(
    @Req() req: CitizenRequest,
    @Param('targetId', new ParseUUIDPipe()) targetId: string,
  ) {
    return this.blockService.unset(req.user.identityId, targetId);
  }

  @Get('me/blocks')
  @UseGuards(CitizenJwtGuard)
  myBlocks(@Req() req: CitizenRequest) {
    return this.blockService.listMyBlocks(req.user.identityId);
  }
}
