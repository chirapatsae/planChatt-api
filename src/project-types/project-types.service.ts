import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import {
  Injectable,
  Logger,
  ConflictException,
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateProjectTypeDto } from './dto/create-project-type.dto';
import { UpdateProjectTypeDto } from './dto/update-project-type.dto';
import { ProjectType } from './entities/project-type.entity';

@Injectable()
export class ProjectTypesService {
  private readonly logger = new Logger(ProjectTypesService.name);

  constructor(
    @InjectRepository(ProjectType)
    private readonly projectTypeRepo: Repository<ProjectType>,

    @InjectRepository(WorkHistory)
    private readonly workHistoryRepo: Repository<WorkHistory>,
  ) { }

  async create(dto: CreateProjectTypeDto): Promise<ProjectType> {
    try {
      const existing = await this.projectTypeRepo.findOne({ where: { name: dto.name } });
      if (existing) {
        throw new ConflictException('Project type with this name already exists');
      }

      const newType = this.projectTypeRepo.create({
        name: dto.name,
      });

      return await this.projectTypeRepo.save(newType);
    } catch (error) {
      this.logger.error('Failed to create project type', error.stack);
      this.handleError(error);
    }
  }

  async findAll(): Promise<ProjectType[]> {
    try {
      return await this.projectTypeRepo.find();
    } catch (error) {
      this.logger.error('Failed to fetch project types', error.stack);
      throw new InternalServerErrorException('Unable to fetch project types');
    }
  }

  async findOne(id: string): Promise<ProjectType> {
    try {
      const type = await this.projectTypeRepo.findOne({ where: { id }});
      if (!type) throw new NotFoundException(`Project type ${id} not found`);
      return type;
    } catch (error) {
      this.logger.error(`Failed to fetch project type ${id}`, error.stack);
      this.handleError(error);
    }
  }

  async update(id: string, dto: UpdateProjectTypeDto): Promise<ProjectType> {
    try {
      const type = await this.findOne(id);

      if (dto.name && dto.name !== type.name) {
        const duplicate = await this.projectTypeRepo.findOne({ where: { name: dto.name } });
        if (duplicate && duplicate.id !== id) {
          throw new ConflictException('Another project type with the same name already exists');
        }
      }

      Object.assign(type, dto);
      return await this.projectTypeRepo.save(type);
    } catch (error) {
      this.logger.error(`Failed to update project type ${id}`, error.stack);
      this.handleError(error);
    }
  }

  async remove(id: string): Promise<{ message: string }> {
    try {
      const type = await this.findOne(id);
      await this.projectTypeRepo.remove(type);
      return { message: `Project type ${id} removed successfully` };
    } catch (error) {
      this.logger.error(`Failed to remove project type ${id}`, error.stack);
      this.handleError(error);
    }
  }
  async softRemove(id: string): Promise<{ message: string }> {
    try {
      const type = await this.findOne(id);
      await this.projectTypeRepo.softRemove(type);
      return { message: `Project type ${id} has been soft removed successfully` };
    } catch (error) {
      this.logger.error(`Failed to remove project type ${id}`, error.stack);
      this.handleError(error);
    }
  }

  async restore(id: string) {
    try {
      const type = await this.projectTypeRepo.findOne({
        where: { id: id }, withDeleted: true
      })

      if (!type) {
        throw new NotFoundException(`Project type ${id} not found`);
      }

      await this.projectTypeRepo.restore(id)
      return { message: `Project type ${id} has been restored successfully` };
    } catch (error) {
      this.logger.error(`Failed to restore project group ${id}`, error.stack);
      this.handleError(error);
    }
  }

  private handleError(error: any): never {
    if (
      error instanceof ConflictException ||
      error instanceof NotFoundException ||
      error instanceof BadRequestException
    ) {
      throw error;
    }
    throw new InternalServerErrorException('Unexpected error occurred');
  }
}
