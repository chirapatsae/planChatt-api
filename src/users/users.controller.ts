import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  ParseUUIDPipe,
  UseGuards,
  Query,
  UseInterceptors,
  UploadedFile,
  ParseFilePipe,
  MaxFileSizeValidator,
  FileTypeValidator,
  BadRequestException,
  ForbiddenException,
  Req,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdateMyPreferencesDto } from './dto/update-my-preferences.dto';
import { JwtAuthGuard } from 'src/auth/auth.guard';

const STAFF_LEAD_ADMIN_ROLES = ['admin', 'super-admin'] as const;

/**
 * BE-IMPL-01 P0-2 — Self-or-admin authorization helper used by the
 * profile-image PATCH/DELETE handlers. `req.user` is shaped by
 * `JwtStrategy.validate`: `{ userId, citizenId, role }`. Throws
 * ForbiddenException with the BE-01 endpoint-contract Thai message so
 * the FE-01 toast resolver picks up `err.response.data.message`.
 *
 * NOTE: profile-image is a user-self surface, NOT a workflow surface.
 * CLAUDE.md §4 WorkHistory ownership does NOT apply here. The auth
 * predicate is `userId === target` OR role in (admin, super-admin).
 * `staff` is intentionally excluded — staff workflow authority does
 * NOT extend to mutating arbitrary users' profile data.
 */
function assertSelfOrAdmin(req: any, targetUserId: string): void {
  const callerId: string | undefined = req?.user?.userId;
  const callerRole: string | undefined = req?.user?.role;
  if (!callerId) {
    // Defense-in-depth — JwtAuthGuard should have thrown already.
    throw new ForbiddenException('forbidden');
  }
  const isSelf = callerId === targetUserId;
  const isAdmin =
    !!callerRole &&
    (STAFF_LEAD_ADMIN_ROLES as readonly string[]).includes(callerRole);
  if (!isSelf && !isAdmin) {
    throw new ForbiddenException('forbidden');
  }
}

@Controller({
  path: 'users',
  version: '1',
})
// BE-IMPL-01 — class-level guard intentionally NOT restored; fix is
// scoped to method-level on the profile-image routes only. The other
// UsersController routes (findAll/findOne/update/remove/restore)
// remain unprotected and are flagged for a separate hotfix wave per
// SEC-01 §4.
// @UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) { }

  @Post()
  create(@Body() createUserDto: CreateUserDto) {
    return this.usersService.create(createUserDto);
  }

  @Get()
  findAll() {
    return this.usersService.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.usersService.findOne(id);
  }

  /**
   * Wave 21 — Self-scoped preferences endpoint. MUST be declared BEFORE
   * `@Patch(':id')` so `me/preferences` is not swallowed as a UUID param.
   *
   * Self-scope rule (EMAIL_NOTIFICATION.md §4.3):
   *   - target userId is ALWAYS `req.user.userId`
   *   - DTO is whitelisted + forbidNonWhitelisted — extra body fields return 400
   *   - only the 3 preference fields may be mutated
   */
  @UseGuards(JwtAuthGuard)
  @Patch('me/preferences')
  @UsePipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  )
  updateMyPreferences(
    @Req() req: any,
    @Body() dto: UpdateMyPreferencesDto,
  ) {
    const userId: string | undefined = req?.user?.userId;
    if (!userId) {
      throw new BadRequestException('Authenticated user context missing');
    }
    return this.usersService.updateMyPreferences(userId, dto);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateUserDto: UpdateUserDto,
  ) {
    return this.usersService.update(id, updateUserDto);
  }

  @Delete(':id')
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('mode') mode: 'soft' | 'hard' = 'soft',
  ) {
    return mode === 'soft'
      ? this.usersService.softRemove(id)
      : this.usersService.remove(id);
  }

  @Patch(':id/restore')
  restore(@Param('id', ParseUUIDPipe) id: string) {
    return this.usersService.restore(id);
  }

  /**
   * BE-IMPL-01 P0-1/P0-2/P0-3/P2-C — Profile-image upload.
   * Method-level JwtAuthGuard restored (NOT class-level — see class
   * comment above). Throttler guards apply 30 req/min per IP+route.
   * Magic-byte sniff lives in `usersService.uploadProfileImage` and
   * provides defense-in-depth on top of the regex `FileTypeValidator`.
   */
  @UseGuards(JwtAuthGuard, ThrottlerGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Patch(':id/profile-image')
  @UseInterceptors(FileInterceptor('image'))
  async uploadProfileImage(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: any,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 5 * 1024 * 1024 }), // 5MB limit
          new FileTypeValidator({ fileType: /(jpg|jpeg|png|webp)$/ }), // Layer 1 — extension/MIME claim. Magic-byte sniff is layer 2 in service.
        ],
        exceptionFactory: () => {
          return new BadRequestException(
            'รูปต้องเป็น JPG, PNG หรือ WebP เท่านั้น และขนาดไม่เกิน 5 MB',
          );
        },
      }),
    )
    file: Express.Multer.File,
  ) {
    assertSelfOrAdmin(req, id);
    if (!file) {
      throw new BadRequestException('กรุณาเลือกไฟล์รูปภาพ');
    }
    return this.usersService.uploadProfileImage(id, file);
  }

  /**
   * BE-IMPL-01 P1-2 — Idempotent profile-image removal. Returns the
   * decrypted user with `profileImageUrl: null`. Calling on a user that
   * already has no profile image returns 200 with `profileImageUrl:
   * null` (no error). Same JWT + self-or-admin guard as upload.
   */
  @UseGuards(JwtAuthGuard, ThrottlerGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Delete(':id/profile-image')
  async removeProfileImage(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: any,
  ) {
    assertSelfOrAdmin(req, id);
    return this.usersService.removeProfileImage(id);
  }
}
