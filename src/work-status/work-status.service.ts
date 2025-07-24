import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CreateWorkStatusDto } from './dto/create-work-status.dto';
import { UpdateWorkStatusDto } from './dto/update-work-status.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { WorkStatus } from './entities/work-status.entity';
import { Repository } from 'typeorm';
import { handleException } from 'src/util/handleException';

@Injectable()
export class WorkStatusService {
  private readonly logger = new Logger(WorkStatusService.name);

  constructor(
    @InjectRepository(WorkStatus)
    private readonly workStatusRepository: Repository<WorkStatus>,
  ) {}

  async create(createWorkStatusDto: CreateWorkStatusDto) {
    try {
      const { name } = createWorkStatusDto;
      const workStatus = this.workStatusRepository.create({ name });
      return await this.workStatusRepository.save(workStatus);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findAll() {
    try {
      return await this.workStatusRepository.find({
        where: { deletedAt: undefined },
        relations: [],
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findOne(id: string) {
    try {
      const workStatus = await this.workStatusRepository.findOne({
        where: { id },
        relations: [],
      });

      if (!workStatus) {
        throw new NotFoundException(`Work Status with ID ${id} not found`);
      }
      return workStatus;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async update(id: string, updateWorkStatusDto: UpdateWorkStatusDto) {
    try {
      const roleToUpdate = await this.workStatusRepository.preload({
        id,
        ...updateWorkStatusDto,
      });

      if (!roleToUpdate) {
        throw new NotFoundException(`Work Status with ID ${id} not found`);
      }

      return await this.workStatusRepository.save(roleToUpdate);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async remove(id: string): Promise<{ message: string }> {
    try {
      const result = await this.workStatusRepository.delete(id);
      if (result.affected === 0) {
        throw new NotFoundException(`Work Status with ID ${id} not found`);
      }
      return {
        message: `Work Status with ID ${id} has been permanently removed.`,
      };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async softRemove(id: string): Promise<{ message: string }> {
    try {
      const result = await this.workStatusRepository.softDelete(id);
      if (result.affected === 0) {
        throw new NotFoundException(`Work Status with ID ${id} not found`);
      }
      return { message: `Work Status with ID ${id} has been soft-removed.` };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async restore(id: string): Promise<{ message: string }> {
    try {
      const result = await this.workStatusRepository.restore(id);
      if (result.affected === 0) {
        throw new NotFoundException(
          `Work Status with ID ${id} not found or was not deleted.`,
        );
      }
      return { message: `Work Status with ID ${id} has been restored.` };
    } catch (error) {
      handleException(this.logger, error);
    }
  }
}
