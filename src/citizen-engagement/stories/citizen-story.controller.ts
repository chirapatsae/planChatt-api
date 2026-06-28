import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
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
import {
  CITIZEN_RATE_LIMITS,
  CITIZEN_THROTTLE_TTL_MS,
} from '../constants/citizen-rate-limits';
import { StoryDto, StoryGroupDto } from '../dto/citizen-story-response.dto';
import { CitizenStoryService } from './citizen-story.service';

/** `req.user` shape set by CitizenJwtGuard / CitizenJwtStrategy. */
interface CitizenRequest {
  user: { identityId: string };
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
  constructor(private readonly storyService: CitizenStoryService) {}

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

  @Get('active')
  listActive(): Promise<StoryGroupDto[]> {
    return this.storyService.listActive();
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
