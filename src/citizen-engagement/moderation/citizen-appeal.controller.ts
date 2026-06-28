import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';

import { JwtAuthGuard } from '../../auth/auth.guard';
import { UsersService } from '../../users/users.service';
import { CitizenJwtGuard } from '../citizen-auth/citizen-jwt.guard';
import {
  CITIZEN_RATE_LIMITS,
  CITIZEN_THROTTLE_TTL_MS,
} from '../constants/citizen-rate-limits';
import { ResolveAppealDto } from '../dto/resolve-appeal.dto';
import { SubmitAppealDto } from '../dto/submit-appeal.dto';
import { CitizenAppealService } from './citizen-appeal.service';
import { CitizenModerateGrantGuard } from './citizen-moderate-grant.guard';

/** `req.user` shape set by CitizenJwtGuard / CitizenJwtStrategy. */
interface CitizenRequest {
  user: { identityId: string };
}

/** `req.user` shape set by JwtAuthGuard / JwtStrategy (INTERNAL identity). */
interface InternalRequest {
  user: { userId: string; role: string };
}

/**
 * W-T3 appeals surface (moderation v2).
 *
 * SUBMIT is CITIZEN-gated (`CitizenJwtGuard`); the acting identity is
 * `req.user.identityId` (NEVER a body field) and ownership is re-asserted in the
 * service. QUEUE + RESOLVE are STAFF-gated (`JwtAuthGuard` THEN
 * `CitizenModerateGrantGuard` — §4.1 staff authority via the C5 `moderate` grant,
 * NOT ownership); the resolver name is snapshotted from the JWT context via the
 * UsersService bridge (§17.3 — plain string, no FK).
 *
 * §17.2 advisory / §17.3 isolation — an appeal changes a post's display state
 * only; it creates no project and writes no `tracking_status`.
 */
@Controller({ path: 'citizen-engagement', version: '1' })
export class CitizenAppealController {
  constructor(
    private readonly appealService: CitizenAppealService,
    private readonly usersService: UsersService,
  ) {}

  // --- CITIZEN — submit an appeal on an own removed/hidden post --------------

  @Throttle({
    default: { limit: CITIZEN_RATE_LIMITS.SUBMIT_APPEAL, ttl: CITIZEN_THROTTLE_TTL_MS },
  })
  @Post('posts/:id/appeal')
  @UseGuards(CitizenJwtGuard, ThrottlerGuard)
  appeal(
    @Req() req: CitizenRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: SubmitAppealDto,
  ) {
    return this.appealService.appeal(req.user.identityId, id, dto.reason);
  }

  // --- STAFF — review queue + resolve ----------------------------------------

  @Get('moderation/appeals')
  @UseGuards(JwtAuthGuard, CitizenModerateGrantGuard)
  queue() {
    return this.appealService.queue();
  }

  @Post('moderation/appeals/:id')
  @UseGuards(JwtAuthGuard, CitizenModerateGrantGuard)
  async resolve(
    @Req() req: InternalRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ResolveAppealDto,
  ) {
    const userId = req.user.userId;
    const user = await this.usersService.findOne(userId);
    // Snapshot the resolver's name at resolve time (§17.3 — plain string into a
    // citizen_* column, no FK). The action's organizational context (§4); fall
    // back to userId when the user has no current WorkHistory (still a plain uuid).
    const displayName = `${user?.firstname ?? ''} ${user?.lastname ?? ''}`.trim();
    const current = user?.workHistory?.find((wh) => wh.isCurrent);
    const workHistoryId = current?.id ?? userId;

    return this.appealService.resolve(
      { workHistoryId, role: req.user.role ?? 'staff', displayName },
      id,
      dto.decision,
    );
  }
}
