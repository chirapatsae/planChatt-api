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
  Req,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdateMyPreferencesDto } from './dto/update-my-preferences.dto';
import { JwtAuthGuard } from 'src/auth/auth.guard';

@Controller({
  path: 'users',
  version: '1',
})
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

  @Patch(':id/profile-image')
  @UseInterceptors(FileInterceptor('image'))
  async uploadProfileImage(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 5 * 1024 * 1024 }), // 5MB limit
          new FileTypeValidator({ fileType: /(jpg|jpeg|png|webp)$/ }), // Format validation
        ],
        exceptionFactory: (errors) => {
          return new BadRequestException('Validation failed. Make sure it is an image (jpg/jpeg/png/webp) and under 5MB.');
        },
      }),
    )
    file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('Image file is required');
    }
    return this.usersService.uploadProfileImage(id, file);
  }
}
