import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { ProjectTypesService } from './project-types.service';
import { CreateProjectTypeDto } from './dto/create-project-type.dto';
import { UpdateProjectTypeDto } from './dto/update-project-type.dto';
import { ProjectType } from './entities/project-type.entity';

@Controller('project-types')
export class ProjectTypesController {
  constructor(private readonly projectTypesService: ProjectTypesService) {}

  @Post()
  async create(@Body() createProjectTypeDto: CreateProjectTypeDto): Promise<ProjectType> {
    return await this.projectTypesService.create(createProjectTypeDto);
  }

  @Get()
  async findAll(): Promise<ProjectType[]> {
    return await this.projectTypesService.findAll();
  }

  @Get(':id')
  async findOne(@Param('id') id: string): Promise<ProjectType> {
    return await this.projectTypesService.findOne(id);
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() updateProjectTypeDto: UpdateProjectTypeDto): Promise<ProjectType> {
    return await this.projectTypesService.update(id, updateProjectTypeDto);
  }

  @Delete(':id')
  async remove(@Param('id') id: string): Promise<void> {
    return await this.projectTypesService.remove(id);
  }
}
