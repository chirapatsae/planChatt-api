import {
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';

import { CitizenJwtGuard } from './citizen-auth/citizen-jwt.guard';
import { CitizenProfileService } from './citizen-profile.service';
import { CitizenAvatarService } from './media/citizen-avatar.service';
import { UpdateCitizenProfileDto } from './dto/update-citizen-profile.dto';

const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

/** `req.user` shape set by CitizenJwtGuard / CitizenJwtStrategy. */
interface CitizenRequest {
  user: { identityId: string };
}

/**
 * OWNER-scoped citizen profile surface (C1) at `/v1/citizen-engagement/me/*`.
 *
 * Every endpoint is gated by `CitizenJwtGuard`; the acting identity is ALWAYS
 * `req.user.identityId` (NEVER a body/param), so a citizen can only ever read
 * or edit their OWN profile and post history. §17.2 advisory / §17.3 isolated.
 */
@Controller({ path: 'citizen-engagement/me', version: '1' })
@UseGuards(CitizenJwtGuard)
export class CitizenProfileController {
  constructor(
    private readonly citizenProfileService: CitizenProfileService,
    private readonly avatarService: CitizenAvatarService,
  ) {}

  /** Upload / replace the caller's profile photo (jpg/png, EXIF-stripped). */
  @Post('avatar')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: AVATAR_MAX_BYTES },
    }),
  )
  async uploadAvatar(
    @Req() req: CitizenRequest,
    @UploadedFile() file: Express.Multer.File,
  ) {
    await this.avatarService.upload(req.user.identityId, file);
    return this.citizenProfileService.getProfile(req.user.identityId);
  }

  /** Remove the caller's profile photo (back to the gradient + initial). */
  @Delete('avatar')
  async removeAvatar(@Req() req: CitizenRequest) {
    await this.avatarService.remove(req.user.identityId);
    return this.citizenProfileService.getProfile(req.user.identityId);
  }

  @Get('profile')
  getProfile(@Req() req: CitizenRequest) {
    return this.citizenProfileService.getProfile(req.user.identityId);
  }

  @Get('posts')
  getMyPosts(
    @Req() req: CitizenRequest,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('beforeCreatedAt') beforeCreatedAt?: string,
    @Query('beforeId') beforeId?: string,
  ) {
    return this.citizenProfileService.getMyPosts(
      req.user.identityId,
      limit,
      beforeCreatedAt,
      beforeId,
    );
  }

  @Patch('profile')
  updateProfile(
    @Req() req: CitizenRequest,
    @Body() dto: UpdateCitizenProfileDto,
  ) {
    return this.citizenProfileService.updateProfile(req.user.identityId, dto);
  }
}
