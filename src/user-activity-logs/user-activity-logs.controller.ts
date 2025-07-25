import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards, Req } from '@nestjs/common';
import { UserActivityLogsService } from './user-activity-logs.service';
import { CreateUserActivityLogDto } from './dto/create-user-activity-log.dto';
import { UpdateUserActivityLogDto } from './dto/update-user-activity-log.dto';
import { JwtAuthGuard } from 'src/auth/auth.guard';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';
import { Request } from 'express';

@Controller('user-activity-logs')
@UseGuards(JwtAuthGuard)
export class UserActivityLogsController {
  constructor(private readonly userActivityLogsService: UserActivityLogsService) {}

  @Post()
  create(
    @Body() createUserActivityLogDto: CreateUserActivityLogDto,
    @Req() req: Request & { user: JwtPayloadUser },
  ) {
    return this.userActivityLogsService.create(createUserActivityLogDto, req.user.userId);
  }

  @Get()
  findAll() {
    return this.userActivityLogsService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.userActivityLogsService.findOne(id);
  }

}
