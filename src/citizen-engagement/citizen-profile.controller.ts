import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  ParseIntPipe,
  Patch,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';

import { CitizenJwtGuard } from './citizen-auth/citizen-jwt.guard';
import { CitizenProfileService } from './citizen-profile.service';
import { UpdateCitizenProfileDto } from './dto/update-citizen-profile.dto';

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
  constructor(private readonly citizenProfileService: CitizenProfileService) {}

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
