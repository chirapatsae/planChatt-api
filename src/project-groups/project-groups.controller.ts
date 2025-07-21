import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  ParseUUIDPipe,
  Req,
  UseGuards,
  Query,
} from '@nestjs/common';
import { ProjectGroupsService } from './project-groups.service';
import { CreateProjectGroupDto } from './dto/create-project-group.dto';
import { UpdateProjectGroupDto } from './dto/update-project-group.dto';
import { JwtPayloadUser } from 'src/auth/jwt.strategy';
import { JwtAuthGuard } from 'src/auth/auth.guard';

@Controller({
  path: 'project-groups',
  version: '1',
})
@UseGuards(JwtAuthGuard)
export class ProjectGroupsController {
  constructor(private readonly projectGroupsService: ProjectGroupsService) { }

  @Post()
  async create(@Body() dto: CreateProjectGroupDto, @Req() req: Request & { user: JwtPayloadUser }) {
    return this.projectGroupsService.create(dto, req.user.userId);
  }

  @Get('/by-status')
  async findByStatus(
    @Req() req: Request & { user: JwtPayloadUser },
    @Query('type') type: 'draft' | 'pending' | 'edit' | 'approved',
    @Query('countOnly') countOnly?: string,
  ) {
    return this.projectGroupsService.findProjectsByStatus({
      userId: req.user.userId,
      type,
      countOnly: countOnly === 'true' || countOnly === '1',
    });
  }

  @Get('delete')
  async findDelete(@Req() req: Request & { user: JwtPayloadUser }) {
    return this.projectGroupsService.findDelete(req.user.userId);
  }

  @Get(':id')
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.projectGroupsService.findOne(id);
  }

  @Delete('deleted/purge')
  async purgeDeletedProjects() {
    return this.projectGroupsService.handleProjectCleanUp();
  }

  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProjectGroupDto,
    @Req() req : Request & {user : JwtPayloadUser}
  ) {
    return this.projectGroupsService.update(id, dto , req.user.userId);
  }

  @Delete(':id')
  remove(
    @Param('id') id: string,
    @Query('mode') mode: 'soft' | 'hard' = 'soft',
  ) {
    return mode === 'soft'
      ? this.projectGroupsService.softRemove(id)
      : this.projectGroupsService.remove(id);
  }

  @Patch(':id/restore')
  async restore(@Param('id', ParseUUIDPipe) id: string) {
    return this.projectGroupsService.restore(id);
  }
}
