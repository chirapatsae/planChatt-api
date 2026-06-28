import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';

import { CitizenOptionalJwtGuard } from '../citizen-auth/citizen-optional-jwt.guard';
import { CitizenPostService } from '../citizen-post.service';
import { ListCitizenPostsQueryDto } from '../dto/list-citizen-posts-query.dto';
import { ListTrendingHashtagsQueryDto } from '../dto/list-trending-hashtags-query.dto';
import { CitizenHashtagService } from './citizen-hashtag.service';

/** `req.user` shape on the OPTIONAL-auth tag-posts read (undefined = anonymous). */
interface OptionalCitizenRequest {
  user?: { identityId: string };
}

/**
 * Public hashtag / trending surface (W-S4, §17.2 advisory).
 *
 * ALL routes here are PUBLIC reads (no guard) — there is NO write endpoint for
 * hashtags: tags are extracted + linked automatically inside post / poll create.
 * Reads return only `moderation_state = 'visible'` + `deleted_at IS NULL` rows.
 */
@Controller({ path: 'citizen-engagement', version: '1' })
export class CitizenHashtagController {
  constructor(
    private readonly hashtagService: CitizenHashtagService,
    private readonly postService: CitizenPostService,
  ) {}

  /**
   * Trending hashtags within the recent window (default 24h), ordered by the
   * number of distinct VISIBLE posts that used each tag. §17.2 advisory.
   */
  @Get('hashtags/trending')
  trending(@Query() query: ListTrendingHashtagsQueryDto) {
    return this.hashtagService.listTrending(query.windowHours, query.limit);
  }

  /**
   * Visible posts that carry a given hashtag — same PostDto / keyset / cursor as
   * the global feed. The `:tag` param is normalized server-side (NFC, strip `#`,
   * lowercase), so `#สวน`, `สวน`, and `Park` all resolve. An unknown tag → an
   * empty page (never 404).
   */
  @Get('hashtags/:tag/posts')
  @UseGuards(CitizenOptionalJwtGuard)
  postsByTag(
    @Req() req: OptionalCitizenRequest,
    @Param('tag') tag: string,
    @Query() query: ListCitizenPostsQueryDto,
  ) {
    return this.postService.listByHashtag(tag, query, req.user?.identityId);
  }
}
