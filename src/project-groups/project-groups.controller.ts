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
  constructor(private readonly projectGroupsService: ProjectGroupsService) {}

  @Post()
  async create(@Body() dto: CreateProjectGroupDto, @Req() req: Request & { user: JwtPayloadUser }) {
    return this.projectGroupsService.create(dto, req.user.userId);
  }

  @Get()
  async findAll(@Req() req: Request & { user: JwtPayloadUser }) {
    return this.projectGroupsService.findAll();
  }

  @Get('/draft-project')
  async findDraft(@Req() req: Request & { user: JwtPayloadUser }) {
    return this.projectGroupsService.findDraft(req.user.role, req.user.userId);
  }

  @Get('/draft-project/count')
  async findDraftLength(@Req() req: Request & { user: JwtPayloadUser }) {
    return this.projectGroupsService.findDraftdLength(req.user.role, req.user.userId);
  }

  @Get('/edit-project')
  async findEdit(@Req() req: Request & { user: JwtPayloadUser }) {
    return this.projectGroupsService.findEdit(req.user.role, req.user.userId);
  }

  @Get('/edit-project/count')
  async findEditLength(@Req() req: Request & { user: JwtPayloadUser }) {
    return this.projectGroupsService.findEditLength(req.user.role, req.user.userId);
  }

  @Get('/verify-project/')
  async findAVerify(@Req() req: Request & { user: JwtPayloadUser }) {
    return this.projectGroupsService.findAVerify(req.user.role, req.user.userId);
  }

  @Get('/verify-project/count')
  async findVerifyLength(@Req() req: Request & { user: JwtPayloadUser }) {
    return this.projectGroupsService.findVerifyLength(req.user.role, req.user.userId);
  }

  @Get('/approve-project/count')
  async findApproveLength() {
    return this.projectGroupsService.findApproveLength();
  }

  @Get('delete')
  async findDelete(@Req() req: Request & { user: JwtPayloadUser }) {
    return this.projectGroupsService.findDelete(req.user.userId);
  }

  @Get('delete-project/count')
  async findDeleteLength() {
    return this.projectGroupsService.findDeleteLength();
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
  ) {
    return this.projectGroupsService.update(id, dto);
  }

  @Delete(':id')
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.projectGroupsService.remove(id);
  }

  @Delete(':id/soft-remove')
  async softRemove(@Param('id', ParseUUIDPipe) id: string) {
    return this.projectGroupsService.softRemove(id);
  }

  @Patch(':id/restore')
  async restore(@Param('id', ParseUUIDPipe) id: string) {
    return this.projectGroupsService.restore(id);
  }
}
