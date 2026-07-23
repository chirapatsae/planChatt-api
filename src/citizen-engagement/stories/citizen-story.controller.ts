import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { Response } from 'express';

import { CitizenJwtGuard } from '../citizen-auth/citizen-jwt.guard';
import { CitizenOptionalJwtGuard } from '../citizen-auth/citizen-optional-jwt.guard';
import {
  CITIZEN_RATE_LIMITS,
  CITIZEN_THROTTLE_TTL_MS,
} from '../constants/citizen-rate-limits';
import { CitizenStoryAudienceQueryDto } from '../dto/citizen-story-audience-query.dto';
import { CitizenStoryReactionDto } from '../dto/citizen-story-reaction.dto';
import {
  StoryAudienceDto,
  StoryDto,
  StoryGroupDto,
} from '../dto/citizen-story-response.dto';
import { CitizenStoryEngagementService } from './citizen-story-engagement.service';
import { CitizenStoryService } from './citizen-story.service';

/** Default / max audience page size (FB-6 "who viewed my story" sheet). */
const AUDIENCE_DEFAULT_LIMIT = 30;
const AUDIENCE_MAX_LIMIT = 100;

/** `req.user` shape set by CitizenJwtGuard / CitizenJwtStrategy. */
interface CitizenRequest {
  user: { identityId: string };
}

/**
 * `req.user` on a PUBLIC read gated by `CitizenOptionalJwtGuard`: present (with
 * `identityId`) for a logged-in viewer, `undefined` for an anonymous one.
 */
interface OptionalCitizenRequest {
  user?: { identityId: string };
}

const MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB — multer pre-reject (service re-validates)

/**
 * Citizen ephemeral 24h stories (W-GATE-3, §17.2 advisory).
 *
 * CREATE is citizen-gated + throttled; the acting identity is
 * `req.user.identityId` (never a body field). The privacy strip happens in the
 * service BEFORE persistence (mirrors citizen-media upload).
 *
 * GET active / GET :id/image are PUBLIC (no guard) — stories on a public board
 * are public bytes; the image-serve refuses an expired/deleted story (404).
 * DELETE is citizen-gated + owner-scoped.
 *
 * multer default memory storage → `file.buffer` is present (no disk temp file).
 */
@Controller({ path: 'citizen-engagement/stories', version: '1' })
export class CitizenStoryController {
  constructor(
    private readonly storyService: CitizenStoryService,
    private readonly engagementService: CitizenStoryEngagementService,
  ) {}

  // W-GATE-3 — story create is an image write (strip + store); tight cap.
  @Throttle({
    default: { limit: CITIZEN_RATE_LIMITS.CREATE_STORY, ttl: CITIZEN_THROTTLE_TTL_MS },
  })
  @Post()
  @UseGuards(CitizenJwtGuard, ThrottlerGuard)
  @UseInterceptors(
    // Explicit memoryStorage (so `file.buffer` is populated) — the app's global
    // MulterModule.register (users.module) default does NOT yield a buffer here,
    // matching the staff upload controllers which all set memoryStorage().
    FileInterceptor('image', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_SIZE_BYTES },
    }),
  )
  create(
    @UploadedFile() file: Express.Multer.File,
    @Body('caption') caption: string | undefined,
    @Req() req: CitizenRequest,
  ): Promise<StoryDto> {
    return this.storyService.create(
      req.user.identityId,
      file?.buffer,
      file?.mimetype,
      caption,
    );
  }

  // FB-6: PUBLIC read with OPTIONAL auth. A logged-in caller gets per-story
  // personalization (`viewedByMe` / `myReaction`, + `viewCount` on their OWN
  // stories); an ANONYMOUS caller gets the byte-identical pre-FB-6 shape.
  @Get('active')
  @UseGuards(CitizenOptionalJwtGuard)
  async listActive(
    @Req() req: OptionalCitizenRequest,
  ): Promise<StoryGroupDto[]> {
    const groups = await this.storyService.listActive();
    const viewerId = req.user?.identityId;
    if (!viewerId) {
      return groups; // anonymous — unchanged shape (backward compat)
    }
    return this.engagementService.personalizeActive(groups, viewerId);
  }

  @Get(':id/image')
  async serveImage(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { contentType, buffer } = await this.storyService.getImage(id);
    res.setHeader('Content-Type', contentType);
    // Ephemeral + deletable: browser-only short cache, NO shared/CDN cache, so a
    // deleted/expired story stops being served almost immediately (privacy).
    res.setHeader('Cache-Control', 'private, max-age=60');
    return new StreamableFile(buffer);
  }

  // FB-6: record the caller's view of a story (idempotent first-view). A missing
  // /expired story → 404; own story or a blocked-either-way pair → SILENT no-op
  // (a passive read-signal must never leak block state). Returns 204.
  @Throttle({
    default: { limit: CITIZEN_RATE_LIMITS.VIEW_STORY, ttl: CITIZEN_THROTTLE_TTL_MS },
  })
  @Post(':id/view')
  @HttpCode(204)
  @UseGuards(CitizenJwtGuard, ThrottlerGuard)
  async recordView(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: CitizenRequest,
  ): Promise<void> {
    await this.engagementService.recordView(req.user.identityId, id);
  }

  // FB-6: upsert the caller's ONE emoji reaction (add / switch-in-place). Invalid
  // emoji → 400; missing/expired → 404; blocked-either-way → 403 CITIZEN_BLOCKED
  // (an ACTIVE write, unlike the passive view). Reacting also records a view.
  @Throttle({
    default: { limit: CITIZEN_RATE_LIMITS.STORY_REACTION, ttl: CITIZEN_THROTTLE_TTL_MS },
  })
  @Put(':id/reaction')
  @UseGuards(CitizenJwtGuard, ThrottlerGuard)
  react(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CitizenStoryReactionDto,
    @Req() req: CitizenRequest,
  ): Promise<{ emoji: string }> {
    return this.engagementService.react(req.user.identityId, id, dto.emoji);
  }

  // FB-6: hard-delete the caller's reaction (idempotent — 204 even if none).
  @Throttle({
    default: { limit: CITIZEN_RATE_LIMITS.STORY_REACTION, ttl: CITIZEN_THROTTLE_TTL_MS },
  })
  @Delete(':id/reaction')
  @HttpCode(204)
  @UseGuards(CitizenJwtGuard, ThrottlerGuard)
  async removeReaction(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: CitizenRequest,
  ): Promise<void> {
    await this.engagementService.removeReaction(req.user.identityId, id);
  }

  // FB-6: OWNER-ONLY audience page ("who viewed my story"). Missing/expired →
  // 404; exists but caller ≠ owner → 403 CITIZEN_STORY_NOT_OWNER. Offset-paged,
  // newest-viewer-first, with the per-emoji reaction breakdown.
  @Throttle({
    default: { limit: CITIZEN_RATE_LIMITS.STORY_REACTION, ttl: CITIZEN_THROTTLE_TTL_MS },
  })
  @Get(':id/audience')
  @UseGuards(CitizenJwtGuard, ThrottlerGuard)
  audience(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() query: CitizenStoryAudienceQueryDto,
    @Req() req: CitizenRequest,
  ): Promise<StoryAudienceDto> {
    const limit = Math.min(query.limit ?? AUDIENCE_DEFAULT_LIMIT, AUDIENCE_MAX_LIMIT);
    const offset = query.offset ?? 0;
    return this.engagementService.getAudience(
      req.user.identityId,
      id,
      limit,
      offset,
    );
  }

  @Delete(':id')
  @HttpCode(204)
  @UseGuards(CitizenJwtGuard)
  async remove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: CitizenRequest,
  ): Promise<void> {
    await this.storyService.removeOwn(req.user.identityId, id);
  }
}
