import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  ParseUUIDPipe,
  Logger,
  BadRequestException,
  InternalServerErrorException,
  ConflictException,
  NotFoundException,
  UseGuards,
} from '@nestjs/common';
import { ProjectTypesService } from './project-types.service';
import { CreateProjectTypeDto } from './dto/create-project-type.dto';
import { UpdateProjectTypeDto } from './dto/update-project-type.dto';
import { JwtAuthGuard } from 'src/auth/auth.guard';

@Controller({
  path: 'project-types',
  version: '1',
})
@UseGuards(JwtAuthGuard)
export class ProjectTypesController {
  private readonly logger = new Logger(ProjectTypesController.name);

  constructor(private readonly projectTypesService: ProjectTypesService) {}

  @Post()
  async create(@Body() dto: CreateProjectTypeDto) {
    this.logger.log('Creating project type');
    try {
      return await this.projectTypesService.create(dto);
    } catch (error) {
      this.logger.error('Error creating project type', error.stack);
      throw this.handleException(error);
    }
  }

  @Get()
  async findAll() {
    this.logger.log('Fetching all project types');
    try {
      return await this.projectTypesService.findAll();
    } catch (error) {
      this.logger.error('Error fetching project types', error.stack);
      throw this.handleException(error);
    }
  }

  @Get(':id')
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    this.logger.log(`Fetching project type ${id}`);
    try {
      return await this.projectTypesService.findOne(id);
    } catch (error) {
      this.logger.error(`Error fetching project type ${id}`, error.stack);
      throw this.handleException(error);
    }
  }

  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProjectTypeDto,
  ) {
    this.logger.log(`Updating project type ${id}`);
    try {
      return await this.projectTypesService.update(id, dto);
    } catch (error) {
      this.logger.error(`Error updating project type ${id}`, error.stack);
      throw this.handleException(error);
    }
  }

  @Delete(':id')
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    this.logger.warn(`Removing project type ${id}`);
    try {
      return await this.projectTypesService.remove(id);
    } catch (error) {
      this.logger.error(`Error removing project type ${id}`, error.stack);
      throw this.handleException(error);
    }
  }
  @Delete(':id/soft-remove')
  async softRemove(@Param('id', ParseUUIDPipe) id: string) {
    this.logger.warn(`Soft Removing project type ${id}`);
    try {
      return await this.projectTypesService.softRemove(id);
    } catch (error) {
      this.logger.error(`Error soft removing project type ${id}`, error.stack);
      throw this.handleException(error);
    }
  }
  @Patch(':id/restore')
  async restore(
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    this.logger.log(`Restore project type ${id}`);
    try {
      return await this.projectTypesService.restore(id);
    } catch (error) {
      this.logger.error(`Error restore project type ${id}`, error.stack);
      throw this.handleException(error);
    }
  }

  private handleException(error: any) {
    if (
      error instanceof BadRequestException ||
      error instanceof ConflictException ||
      error instanceof NotFoundException
    ) {
      return error;
    }
    return new InternalServerErrorException('Unexpected error occurred');
  }
}
