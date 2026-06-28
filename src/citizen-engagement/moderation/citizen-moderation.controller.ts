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

import { JwtAuthGuard } from '../../auth/auth.guard';
import { ModeratePostDto } from '../dto/moderate-post.dto';
import { CitizenModerateGrantGuard } from './citizen-moderate-grant.guard';
import { CitizenModerationService } from './citizen-moderation.service';

/** `req.user` shape set by JwtAuthGuard / JwtStrategy (INTERNAL identity). */
interface InternalRequest {
  user: { userId: string; role: string };
}

/**
 * Staff moderation surface (C5, plan D13). INTERNAL identity ONLY: `JwtAuthGuard`
 * THEN `CitizenModerateGrantGuard` (requires a live `moderate` grant — the
 * authoritative BE gate, 403 CITIZEN_MODERATE_NOT_GRANTED otherwise). A citizen
 * token can NOT reach these (JwtAuthGuard rejects aud:'citizen', M1).
 *
 * §17.2 advisory / §17.3 isolation — moderation changes a post's display state
 * only; it creates no project and writes no `tracking_status`.
 */
@Controller({ path: 'citizen-engagement/moderation', version: '1' })
@UseGuards(JwtAuthGuard, CitizenModerateGrantGuard)
export class CitizenModerationController {
  constructor(private readonly moderationService: CitizenModerationService) {}

  /** Posts with open reports, most-reported first. */
  @Get('queue')
  queue() {
    return this.moderationService.queue();
  }

  /** Hide / remove / restore a reported post. Actor is the JWT staff identity. */
  @Post('posts/:id')
  moderate(
    @Req() req: InternalRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ModeratePostDto,
  ) {
    return this.moderationService.moderate(
      req.user.userId,
      req.user.role ?? 'staff',
      id,
      dto.action,
    );
  }

  /**
   * W-T3 — lift a suspended author back to `active` (re-enables their writes).
   * Staff-gated via the `moderate` grant (§4.1 — authority, NOT ownership).
   */
  @Post('identities/:id/reinstate')
  reinstate(
    @Req() req: InternalRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.moderationService.reinstate(
      req.user.userId,
      req.user.role ?? 'staff',
      id,
    );
  }
}
