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

import { CitizenJwtGuard } from '../citizen-auth/citizen-jwt.guard';
import {
  CITIZEN_RATE_LIMITS,
  CITIZEN_THROTTLE_TTL_MS,
} from '../constants/citizen-rate-limits';
import { CitizenPollService } from './citizen-poll.service';
import { CreateCitizenPollDto } from '../dto/create-citizen-poll.dto';
import { VoteCitizenPollDto } from '../dto/vote-citizen-poll.dto';

/** `req.user` shape set by CitizenJwtGuard / CitizenJwtStrategy. */
interface CitizenRequest {
  user: { identityId: string };
}

/**
 * Citizen POLL surface (W-S7, §17.2 advisory).
 *
 * Poll creation rides a DEDICATED `POST polls` route (NOT a branch on the
 * existing `POST posts` create DTO) so the poll-specific body
 * (`question` + `options[]` + `closesAt?`) stays cleanly typed and the
 * generic post DTO is unchanged. Voting is `POST posts/:id/poll/vote`. The
 * caller's own live votes come from the owner-scoped `GET me/poll-votes`
 * (D16 — never exposes other citizens' votes). The acting identity is ALWAYS
 * `req.user.identityId` (NEVER a body/param).
 */
@Controller({ path: 'citizen-engagement', version: '1' })
export class CitizenPollController {
  constructor(private readonly pollService: CitizenPollService) {}

  // W-SEC-2 — poll creation is a heavier write; reuse the post-create ceiling.
  @Throttle({
    default: { limit: CITIZEN_RATE_LIMITS.CREATE_POST, ttl: CITIZEN_THROTTLE_TTL_MS },
  })
  @Post('polls')
  @UseGuards(CitizenJwtGuard, ThrottlerGuard)
  createPoll(@Req() req: CitizenRequest, @Body() dto: CreateCitizenPollDto) {
    return this.pollService.createPoll(req.user.identityId, dto);
  }

  // W-SEC-2 — votes are frequent (one tap per poll, plus change-vote) but
  // spam-capped: POLL_VOTE:30 per 60s.
  @Throttle({
    default: { limit: CITIZEN_RATE_LIMITS.POLL_VOTE, ttl: CITIZEN_THROTTLE_TTL_MS },
  })
  @Post('posts/:id/poll/vote')
  @UseGuards(CitizenJwtGuard, ThrottlerGuard)
  vote(
    @Req() req: CitizenRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: VoteCitizenPollDto,
  ) {
    return this.pollService.vote(req.user.identityId, id, dto.optionId);
  }

  // W-S7 / D16: the caller's live poll votes as `{ [postId]: optionId }` for FE
  // card marking. Owner-scoped from `req.user.identityId` (NO IDOR). This is the
  // ONLY surface that reveals a vote — and ONLY the caller's own.
  @Get('me/poll-votes')
  @UseGuards(CitizenJwtGuard)
  myPollVotes(@Req() req: CitizenRequest) {
    return this.pollService.listMyVotes(req.user.identityId);
  }
}
