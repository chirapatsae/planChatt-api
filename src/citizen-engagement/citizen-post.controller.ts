import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';

import { CitizenJwtGuard } from './citizen-auth/citizen-jwt.guard';
import { CitizenOptionalJwtGuard } from './citizen-auth/citizen-optional-jwt.guard';
import {
  CITIZEN_RATE_LIMITS,
  CITIZEN_THROTTLE_TTL_MS,
} from './constants/citizen-rate-limits';
import { CitizenPostService } from './citizen-post.service';
import { CitizenMentionService } from './citizen-mention.service';
import { CitizenModerationService } from './moderation/citizen-moderation.service';
import { CreateCitizenCommentDto } from './dto/create-citizen-comment.dto';
import { CreateCitizenPostDto } from './dto/create-citizen-post.dto';
import { ListCitizenPostsQueryDto } from './dto/list-citizen-posts-query.dto';
import { ReactToPostDto } from './dto/react-to-post.dto';
import { RepostDto } from './dto/repost-citizen-post.dto';
import { ReportCitizenPostDto } from './dto/report-citizen-post.dto';
import { SearchCitizensQueryDto } from './dto/search-citizens-query.dto';

/** `req.user` shape set by CitizenJwtGuard / CitizenJwtStrategy. */
interface CitizenRequest {
  user: { identityId: string };
}

/**
 * `req.user` shape on a PUBLIC read gated by `CitizenOptionalJwtGuard`: present
 * (with `identityId`) for a logged-in viewer, `undefined` for an anonymous one.
 */
interface OptionalCitizenRequest {
  user?: { identityId: string };
}

/**
 * Public civic-community board (§17.2 advisory).
 *
 * READS are PUBLIC (no guard) and return only `moderation_state = 'visible'`
 * + `deleted_at IS NULL` rows. WRITES are gated by `CitizenJwtGuard`; the
 * acting identity is `req.user.identityId` (NEVER a body field).
 */
@Controller({ path: 'citizen-engagement', version: '1' })
export class CitizenPostController {
  constructor(
    private readonly citizenPostService: CitizenPostService,
    private readonly mentionService: CitizenMentionService,
    private readonly moderationService: CitizenModerationService,
  ) {}

  // --- READS (public; OPTIONAL citizen auth for the W-T1 block/mute filter) ---
  // CitizenOptionalJwtGuard sets req.user.identityId IF a valid citizen token is
  // present and NEVER rejects anonymous — so a logged-in viewer's block/mute
  // filter applies while anonymous sees the unfiltered public board.

  @Get('posts')
  @UseGuards(CitizenOptionalJwtGuard)
  list(
    @Req() req: OptionalCitizenRequest,
    @Query() query: ListCitizenPostsQueryDto,
  ) {
    return this.citizenPostService.list(query, req.user?.identityId);
  }

  @Get('posts/:id')
  @UseGuards(CitizenOptionalJwtGuard)
  detail(
    @Req() req: OptionalCitizenRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.citizenPostService.detail(id, req.user?.identityId);
  }

  // W-S6 — @mention autocomplete. Searches ACTIVE citizens by alias prefix →
  // `[{ id, displayAlias }]` (NO PII). OPTIONAL citizen auth applies the W-T1
  // block filter for a logged-in searcher (drops self + both-way block pairs);
  // ThrottlerGuard caps anonymous IP floods. MUST be registered BEFORE the
  // `citizens/:id/*` routes so the literal `search` segment is not captured as
  // an `:id` param.
  @Throttle({
    default: { limit: CITIZEN_RATE_LIMITS.SEARCH, ttl: CITIZEN_THROTTLE_TTL_MS },
  })
  @Get('citizens/search')
  @UseGuards(CitizenOptionalJwtGuard, ThrottlerGuard)
  searchCitizens(
    @Req() req: OptionalCitizenRequest,
    @Query() query: SearchCitizensQueryDto,
  ) {
    return this.mentionService.searchByAlias(query.q, req.user?.identityId);
  }

  // W-GATE-1 — PUBLIC citizen profile (no auth; a citizen profile is public).
  // `{ id, displayAlias, postCount, followerCount }`. PRIVACY (D16): the
  // follower COUNT is public, the follower ROSTER is NEVER exposed. 404 when
  // the identity is missing / blocked.
  @Get('citizens/:id/profile')
  publicProfile(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.citizenPostService.getPublicProfile(id);
  }

  // W-GATE-1 — PUBLIC keyset list of a citizen's visible posts. OPTIONAL citizen
  // auth applies the W-T1 block/mute filter (a viewer who muted/blocked this
  // author — or whom this author blocked — sees an empty page).
  @Get('citizens/:id/posts')
  @UseGuards(CitizenOptionalJwtGuard)
  publicPosts(
    @Req() req: OptionalCitizenRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() query: ListCitizenPostsQueryDto,
  ) {
    return this.citizenPostService.getPublicPosts(id, query, req.user?.identityId);
  }

  // --- WRITES (citizen-gated) ------------------------------------------------

  // W-SEC-2 — post creation is a heavier write; throttle below the global 100/60s.
  @Throttle({
    default: { limit: CITIZEN_RATE_LIMITS.CREATE_POST, ttl: CITIZEN_THROTTLE_TTL_MS },
  })
  @Post('posts')
  @UseGuards(CitizenJwtGuard, ThrottlerGuard)
  create(@Req() req: CitizenRequest, @Body() dto: CreateCitizenPostDto) {
    return this.citizenPostService.create(req.user.identityId, dto);
  }

  // W-SEC-2 — comments are frequent but still spam-capped.
  @Throttle({
    default: { limit: CITIZEN_RATE_LIMITS.CREATE_COMMENT, ttl: CITIZEN_THROTTLE_TTL_MS },
  })
  @Post('posts/:id/comments')
  @UseGuards(CitizenJwtGuard, ThrottlerGuard)
  addComment(
    @Req() req: CitizenRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CreateCitizenCommentDto,
  ) {
    return this.citizenPostService.addComment(
      req.user.identityId,
      id,
      dto.text,
      dto.mentions,
    );
  }

  // W-SEC-2 — reactions are the most frequent legit action; highest non-login ceiling.
  // W-S1: the body carries an OPTIONAL `reactionType` (one of the 4 FROZEN keys);
  // omitted → defaults to `like` (back-compat with the heart toggle).
  @Throttle({
    default: { limit: CITIZEN_RATE_LIMITS.TOGGLE_REACTION, ttl: CITIZEN_THROTTLE_TTL_MS },
  })
  @Post('posts/:id/reactions/toggle')
  @UseGuards(CitizenJwtGuard, ThrottlerGuard)
  toggleReaction(
    @Req() req: CitizenRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ReactToPostDto,
  ) {
    return this.citizenPostService.toggleReaction(
      req.user.identityId,
      id,
      dto.reactionType,
    );
  }

  // W-S2 — repost / quote. A write that fans into the feed; throttle against
  // share spam. Body carries an OPTIONAL `quoteText` (<= 2000); omitted → a
  // pure share. The acting identity is `req.user.identityId` (NEVER a body
  // field); the service flattens-to-root + bumps the root's repost_count.
  @Throttle({
    default: { limit: CITIZEN_RATE_LIMITS.REPOST, ttl: CITIZEN_THROTTLE_TTL_MS },
  })
  @Post('posts/:id/repost')
  @UseGuards(CitizenJwtGuard, ThrottlerGuard)
  repost(
    @Req() req: CitizenRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: RepostDto,
  ) {
    return this.citizenPostService.repost(req.user.identityId, id, dto.quoteText);
  }

  // W-S1: the caller's live reactions as `{ [postId]: reactionType }` for FE
  // card marking. Owner-scoped from `req.user.identityId` (NO IDOR), capped.
  @Get('me/reactions')
  @UseGuards(CitizenJwtGuard)
  myReactions(@Req() req: CitizenRequest) {
    return this.citizenPostService.listMyReactions(req.user.identityId);
  }

  // W-SEC-2 — bound reports to prevent mass false-flagging.
  @Throttle({
    default: { limit: CITIZEN_RATE_LIMITS.REPORT_POST, ttl: CITIZEN_THROTTLE_TTL_MS },
  })
  @Post('posts/:id/report')
  @UseGuards(CitizenJwtGuard, ThrottlerGuard)
  report(
    @Req() req: CitizenRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ReportCitizenPostDto,
  ) {
    // C5: de-duplicated report + auto-hide at AUTO_HIDE_THRESHOLD (D13).
    return this.moderationService.reportPost(req.user.identityId, id, dto.reason ?? null);
  }

  // Owner deletes their OWN post (soft-delete). The owner check is enforced
  // server-side (post.authorIdentityId === req.user.identityId) — never a body
  // field. Soft-delete (deletedAt) hides it from every read (all queries filter
  // `deletedAt IS NULL`). §17.2 advisory — no project / workflow side-effect.
  @Throttle({
    default: { limit: CITIZEN_RATE_LIMITS.CREATE_POST, ttl: CITIZEN_THROTTLE_TTL_MS },
  })
  @Delete('posts/:id')
  @UseGuards(CitizenJwtGuard, ThrottlerGuard)
  remove(@Req() req: CitizenRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.citizenPostService.softDeleteOwn(req.user.identityId, id);
  }
}
