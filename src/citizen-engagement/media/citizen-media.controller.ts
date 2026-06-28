import {
  Controller,
  Get,
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
import { CitizenMediaService } from './citizen-media.service';

/** `req.user` shape set by CitizenJwtGuard / CitizenJwtStrategy. */
interface CitizenRequest {
  user: { identityId: string };
}

const MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB — multer pre-reject (service re-validates)

/**
 * Citizen photo media (C2 v1, §17.2 advisory).
 *
 * UPLOAD is citizen-gated; the acting identity is `req.user.identityId` (never a
 * body field). The privacy strip happens in the service BEFORE persistence.
 * SERVE is PUBLIC (no guard) — images on a public board are public bytes; the
 * `*_enc` / hash identity columns are never on this row.
 *
 * multer default memory storage → `file.buffer` is present (no disk temp file).
 */
@Controller({ path: 'citizen-engagement/media', version: '1' })
export class CitizenMediaController {
  constructor(private readonly mediaService: CitizenMediaService) {}

  // W-SEC-2 — upload is the most resource-intensive write; tightest non-login cap.
  @Throttle({
    default: { limit: CITIZEN_RATE_LIMITS.UPLOAD_MEDIA, ttl: CITIZEN_THROTTLE_TTL_MS },
  })
  @Post()
  @UseGuards(CitizenJwtGuard, ThrottlerGuard)
  @UseInterceptors(
    // Explicit memoryStorage (so `file.buffer` is populated) — the app's global
    // MulterModule.register (users.module) default does NOT yield a buffer here,
    // matching the staff upload controllers which all set memoryStorage().
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_SIZE_BYTES },
    }),
  )
  upload(
    @UploadedFile() file: Express.Multer.File,
    @Req() req: CitizenRequest,
  ) {
    return this.mediaService.upload(req.user.identityId, file);
  }

  @Get(':id')
  async serve(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { contentType, buffer } = await this.mediaService.serve(id);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return new StreamableFile(buffer);
  }
}
