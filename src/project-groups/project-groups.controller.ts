import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Logger,
  ParseUUIDPipe,
  BadRequestException,
  InternalServerErrorException,
  ConflictException,
  NotFoundException,
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
  private readonly logger = new Logger(ProjectGroupsController.name);
  
  constructor(private readonly projectGroupsService: ProjectGroupsService) {}

  @Post()
  async create(@Body() dto: CreateProjectGroupDto ,  @Req() req: Request & { user: JwtPayloadUser }) {
    this.logger.log('Creating project group'); 
    try {
      return await this.projectGroupsService.create(dto , req.user.userId);

    } catch (error) {
      this.logger.error('Error creating project group', error.stack);
      if (
        error instanceof ConflictException ||
        error instanceof BadRequestException ||
        error instanceof NotFoundException
      ) {
        throw error; 
      }
      throw new InternalServerErrorException('Unexpected error occurred');
    }
  }

  @Get()
  async findAll(@Req() req : Request  & { user: JwtPayloadUser }) {
    this.logger.log('Fetching all project groups');
    try {
      return await this.projectGroupsService.findAll();
    } catch (error) {
      this.logger.error('Error fetching project groups', error.stack);
      throw this.handleException(error);
    }
  }

  @Get('/draft-project')
  async findDraft( @Req() req: Request & { user: JwtPayloadUser }) {
    this.logger.log('Fetching all draft status project groups');
    try {
      return await this.projectGroupsService.findDraft(req.user.role , req.user.userId);
    } catch (error) {
      this.logger.error('Error fetching project groups', error.stack);
      throw this.handleException(error);
    }
  }
  @Get('/draft-project/count')
  async findDraftLength( @Req() req: Request & { user: JwtPayloadUser }) {
    this.logger.log('Fetching all project groups');
    try {
      return await this.projectGroupsService.findDraftdLength(req.user.role , req.user.userId);
    } catch (error) {
      this.logger.error('Error fetching project groups', error.stack);
      throw this.handleException(error);
    }
  }
  
  @Get('/edit-project')
  async findEdit( @Req() req: Request & { user: JwtPayloadUser }) {
    this.logger.log('Fetching all edits status project groups');
    try {
      return await this.projectGroupsService.findEdit(req.user.role , req.user.userId);
    } catch (error) {
      this.logger.error('Error fetching project groups', error.stack);
      throw this.handleException(error);
    }
  }
  @Get('/edit-project/count')
  async findEditLength( @Req() req: Request & { user: JwtPayloadUser }) {
    this.logger.log('Fetching all project groups');
    try {
      return await this.projectGroupsService.findEditLength(req.user.role , req.user.userId);
    } catch (error) {
      this.logger.error('Error fetching project groups', error.stack);
      throw this.handleException(error);
    }
  }

  @Get('/verify-project/')
  async findAVerify(@Req() req: Request & { user: JwtPayloadUser }) {
    this.logger.log('Fetching all project groups');
    try {
      return await this.projectGroupsService.findAVerify(req.user.role , req.user.userId);
    } catch (error) {
      this.logger.error('Error fetching project groups', error.stack);
      throw this.handleException(error);
    }
  }
  @Get('/verify-project/count')
  async findVerifyLength( @Req() req: Request & { user: JwtPayloadUser }) {
    this.logger.log('Fetching all project groups');
    try {
      return await this.projectGroupsService.findVerifyLength(req.user.role , req.user.userId);
    } catch (error) {
      this.logger.error('Error fetching project groups', error.stack);
      throw this.handleException(error);
    }
  }

  @Get('/approve-project/count')
  async findApproveLength() {
    this.logger.log('Fetching all project groups');
    try {
      return await this.projectGroupsService.findApproveLength();
    } catch (error) {
      this.logger.error('Error fetching project groups', error.stack);
      throw this.handleException(error);
    }
  }
  @Get('delete')
  async findDelete(@Req() req : Request  & { user: JwtPayloadUser }) {
    this.logger.log('Fetching all project groups');
    try {
      return await this.projectGroupsService.findDelete(req.user.userId);
    } catch (error) {
      this.logger.error('Error fetching  delete project groups', error.stack);
      throw this.handleException(error);
    }
  }
  @Get('delete-project/count')
  async findDeleteLength() {
    this.logger.log('Fetching all project groups');
    try {
      return await this.projectGroupsService.findDeleteLength();
    } catch (error) {
      this.logger.error('Error fetching project groups', error.stack);
      throw this.handleException(error);
    }
  }


  @Get(':id')
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    this.logger.log(`Fetching project group ${id}`);
    try {
      return await this.projectGroupsService.findOne(id);
    } catch (error) {
      this.logger.error(`Error fetching project group ${id}`, error.stack);
      throw this.handleException(error);
    }
  }

  @Delete('deleted/purge')
  async purgeDeletedProjects() {
    return await this.projectGroupsService.handleProjectCleanUp();
  }
  
  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProjectGroupDto,
  ) {
    this.logger.log(`Updating project group ${id}`);
    try {
      return await this.projectGroupsService.update(id, dto);
    } catch (error) {
      this.logger.error(`Error updating project group ${id}`, error.stack);
      throw this.handleException(error);
    }
  }

  @Delete(':id')
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    this.logger.warn(`Removing project group ${id}`);
    try {
      return await this.projectGroupsService.remove(id);
    } catch (error) {
      this.logger.error(`Error removing project group ${id}`, error.stack);
      throw this.handleException(error);
    }
  }

  @Delete(':id/soft-remove')
  async softRemove(@Param('id', ParseUUIDPipe) id: string) {
    this.logger.warn(`Soft Removing project group ${id}`);
    try {
      return await this.projectGroupsService.softRemove(id);
    } catch (error) {
      this.logger.error(`Error removing project group ${id}`, error.stack);
      throw this.handleException(error);
    }
  }

  @Patch(':id/restore')
  async restore(@Param('id', ParseUUIDPipe) id: string,) {
    this.logger.log(`Restoere project group ${id}`);
    try {
      return await this.projectGroupsService.restore(id);
    } catch (error) {
      this.logger.error(`Error updating project group ${id}`, error.stack);
      throw this.handleException(error);
    }
  }


  private handleException(error: any) {
    if (error instanceof BadRequestException) return error;
    return new InternalServerErrorException('Unexpected error occurred');
  }
}
