import { Injectable, NotFoundException, InternalServerErrorException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateProjectTypeDto } from './dto/create-project-type.dto';
import { UpdateProjectTypeDto } from './dto/update-project-type.dto';
import { ProjectType } from './entities/project-type.entity';
import { handleException } from 'src/util/handleException';

@Injectable()
export class ProjectTypesService {
  constructor(
    private readonly logger: Logger,
    
    @InjectRepository(ProjectType)
    private readonly projectTypeRepository: Repository<ProjectType>,
  ) {}

  async create(createProjectTypeDto: CreateProjectTypeDto): Promise<ProjectType> {
    try {
      const projectType = this.projectTypeRepository.create(createProjectTypeDto);
      return await this.projectTypeRepository.save(projectType);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findAll(): Promise<ProjectType[]> {
    try {
      return await this.projectTypeRepository.find();
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findOne(id: string): Promise<ProjectType> {
    try {
      const projectType = await this.projectTypeRepository.findOne({ where: { id } });
      if (!projectType) {
        throw new NotFoundException(`Project type with ID ${id} not found`);
      }
      return projectType;
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      handleException(this.logger, error);
    }
  }

  async update(id: string, updateProjectTypeDto: UpdateProjectTypeDto): Promise<ProjectType> {
    try {
      const projectType = await this.findOne(id);
      Object.assign(projectType, updateProjectTypeDto);
      return await this.projectTypeRepository.save(projectType);
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      handleException(this.logger, error);
    }
  }

  async remove(id: string): Promise<void> {
    try {
      const projectType = await this.findOne(id);
      await this.projectTypeRepository.remove(projectType);
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      handleException(this.logger, error);
    }
  }
}
