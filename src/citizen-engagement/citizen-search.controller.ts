import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';

import { CitizenOptionalJwtGuard } from './citizen-auth/citizen-optional-jwt.guard';
import {
  CITIZEN_RATE_LIMITS,
  CITIZEN_THROTTLE_TTL_MS,
} from './constants/citizen-rate-limits';
import { CitizenSearchService } from './citizen-search.service';
import { SearchCitizenPostsQueryDto } from './dto/search-citizen-posts-query.dto';

/** `req.user` shape on the OPTIONAL-auth search read (undefined = anonymous). */
interface OptionalCitizenRequest {
  user?: { identityId: string };
}

/**
 * W-S5 search & discovery (§17.2 advisory).
 *
 * The READ is PUBLIC (no auth — the board is public) and returns only
 * `moderation_state = 'visible'` + `deleted_at IS NULL` rows. The service
 * enforces the all-or-none geo triple and the at-least-one (`q` or geo)
 * requirement (400 `CITIZEN_SEARCH_EMPTY`).
 *
 * W-SEC: even though it is unauthenticated, the endpoint IS rate-limited by IP
 * (`ThrottlerGuard` + `@Throttle`) — an ILIKE `%q%` scan is the most expensive
 * public read, so a flood is capped. The `q` length is also bounded at the DTO.
 */
@Controller({ path: 'citizen-engagement', version: '1' })
export class CitizenSearchController {
  constructor(private readonly searchService: CitizenSearchService) {}

  @Throttle({
    default: { limit: CITIZEN_RATE_LIMITS.SEARCH, ttl: CITIZEN_THROTTLE_TTL_MS },
  })
  // OPTIONAL citizen auth applies the W-T1 block/mute filter for a logged-in
  // searcher; ThrottlerGuard still caps anonymous IP floods. Neither rejects
  // an anonymous searcher.
  @UseGuards(CitizenOptionalJwtGuard, ThrottlerGuard)
  @Get('search')
  search(
    @Req() req: OptionalCitizenRequest,
    @Query() query: SearchCitizenPostsQueryDto,
  ) {
    return this.searchService.search(query, req.user?.identityId);
  }
}
