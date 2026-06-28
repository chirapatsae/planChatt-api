import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';

import { CitizenJwtGuard } from '../citizen-auth/citizen-jwt.guard';
import {
  CITIZEN_RATE_LIMITS,
  CITIZEN_THROTTLE_TTL_MS,
} from '../constants/citizen-rate-limits';
import { CitizenPostService } from '../citizen-post.service';
import { ListCitizenPostsQueryDto } from '../dto/list-citizen-posts-query.dto';
import { ToggleFollowDto } from '../dto/toggle-follow.dto';
import { CitizenFollowService } from './citizen-follow.service';

/** `req.user` shape set by CitizenJwtGuard / CitizenJwtStrategy. */
interface CitizenRequest {
  user: { identityId: string };
}

/**
 * Citizen FOLLOW surface (C3, §17.2 advisory).
 *
 * The acting identity is ALWAYS `req.user.identityId` (NEVER a body/param).
 * D11: follow targets are amphoe / category ONLY. The "following" feed reads
 * the caller's live follow sets, then defers to the post service.
 */
@Controller({ path: 'citizen-engagement', version: '1' })
export class CitizenFollowController {
  constructor(
    private readonly followService: CitizenFollowService,
    private readonly postService: CitizenPostService,
  ) {}

  // W-SEC-2 — follow toggles are frequent (browsing) but capped against churn abuse.
  @Throttle({
    default: { limit: CITIZEN_RATE_LIMITS.TOGGLE_FOLLOW, ttl: CITIZEN_THROTTLE_TTL_MS },
  })
  @Post('follows/toggle')
  @UseGuards(CitizenJwtGuard, ThrottlerGuard)
  toggleFollow(@Req() req: CitizenRequest, @Body() dto: ToggleFollowDto) {
    return this.followService.toggleFollow(
      req.user.identityId,
      dto.targetKind,
      dto.targetKey,
    );
  }

  @Get('me/follows')
  @UseGuards(CitizenJwtGuard)
  myFollows(@Req() req: CitizenRequest) {
    return this.followService.listFollows(req.user.identityId);
  }

  // W-GATE-1: the caller's OWN followed-people identity ids (for FE follow-button
  // marking). Owner-scoped from `req.user.identityId` — PRIVACY (D16): this is
  // the ONLY roster ever exposed (the caller's own outbound follows). Returns
  // `string[]`.
  @Get('me/following-people')
  @UseGuards(CitizenJwtGuard)
  myFollowingPeople(@Req() req: CitizenRequest): Promise<string[]> {
    return this.followService.listFollowedPeople(req.user.identityId);
  }

  @Get('me/feed')
  @UseGuards(CitizenJwtGuard)
  async feed(
    @Req() req: CitizenRequest,
    @Query() query: ListCitizenPostsQueryDto,
  ) {
    const sets = await this.followService.listFollowSets(req.user.identityId);
    return this.postService.listFollowedFeed(req.user.identityId, sets, query);
  }
}
