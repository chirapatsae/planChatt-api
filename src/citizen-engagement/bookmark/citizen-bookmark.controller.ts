import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
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
import { CitizenBookmarkService } from './citizen-bookmark.service';
import { ListCitizenBookmarksQueryDto } from '../dto/list-citizen-bookmarks-query.dto';

/** `req.user` shape set by CitizenJwtGuard / CitizenJwtStrategy. */
interface CitizenRequest {
  user: { identityId: string };
}

/**
 * Citizen BOOKMARK surface (W-S3, §17.2 advisory).
 *
 * The acting identity is ALWAYS `req.user.identityId` (NEVER a body/param).
 * Private: the saved list / id set are scoped to the caller. A bookmark gates
 * nothing.
 */
@Controller({ path: 'citizen-engagement', version: '1' })
export class CitizenBookmarkController {
  constructor(private readonly bookmarkService: CitizenBookmarkService) {}

  // W-SEC-2 — bookmark toggles are frequent (browsing) but capped against churn abuse.
  @Throttle({
    default: {
      limit: CITIZEN_RATE_LIMITS.TOGGLE_BOOKMARK,
      ttl: CITIZEN_THROTTLE_TTL_MS,
    },
  })
  @Post('posts/:id/bookmark/toggle')
  @UseGuards(CitizenJwtGuard, ThrottlerGuard)
  toggle(
    @Req() req: CitizenRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.bookmarkService.toggle(req.user.identityId, id);
  }

  @Get('me/bookmarks')
  @UseGuards(CitizenJwtGuard)
  myBookmarks(
    @Req() req: CitizenRequest,
    @Query() query: ListCitizenBookmarksQueryDto,
  ) {
    return this.bookmarkService.listMine(req.user.identityId, query);
  }

  @Get('me/bookmark-ids')
  @UseGuards(CitizenJwtGuard)
  myBookmarkIds(@Req() req: CitizenRequest) {
    return this.bookmarkService.listMyIds(req.user.identityId);
  }
}
