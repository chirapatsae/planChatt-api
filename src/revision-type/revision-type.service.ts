import {
  Injectable,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateRevisionTypeDto } from './dto/create-revision-type.dto';
import { UpdateRevisionTypeDto } from './dto/update-revision-type.dto';
import { RevisionType } from './entities/revision-type.entity';
import { handleException } from 'src/util/handleException';

@Injectable()
export class RevisionTypeService {
  private readonly logger = new Logger(RevisionTypeService.name);

  constructor(
    @InjectRepository(RevisionType)
    private readonly revisionTypeRepository: Repository<RevisionType>,
  ) {}

  async create(createRevisionTypeDto: CreateRevisionTypeDto): Promise<RevisionType> {
    try {
      const revisionType = this.revisionTypeRepository.create(createRevisionTypeDto);
      return await this.revisionTypeRepository.save(revisionType);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findAll(): Promise<RevisionType[]> {
    try {
      return await this.revisionTypeRepository.find({
        order: { id: 'ASC' },
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findOne(id: string): Promise<RevisionType> {
    try {
      const revisionType = await this.revisionTypeRepository.findOne({
        where: { id },
      });

      if (!revisionType) {
        this.logger.warn(`RevisionType not found: ${id}`);
        throw new NotFoundException(`RevisionType with id ${id} not found`);
      }

      return revisionType;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async update(id: string, updateRevisionTypeDto: UpdateRevisionTypeDto): Promise<RevisionType> {
    try {
      const revisionType = await this.findOne(id);
      const updated = this.revisionTypeRepository.merge(revisionType, updateRevisionTypeDto);
      return await this.revisionTypeRepository.save(updated);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async remove(id: string): Promise<{ message: string }> {
    try {
      const result = await this.revisionTypeRepository.delete(id);
      if (result.affected === 0) {
        throw new NotFoundException(`RevisionType with ID ${id} not found`);
      }
      return { message: `RevisionType with ID ${id} has been permanently removed.` };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async softRemove(id: string): Promise<{ message: string }> {
    try {
      const result = await this.revisionTypeRepository.softDelete(id);
      if (result.affected === 0) {
        throw new NotFoundException(`RevisionType with ID ${id} not found`);
      }
      return { message: `RevisionType with ID ${id} has been soft-removed.` };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async restore(id: string): Promise<{ message: string }> {
    try {
      const result = await this.revisionTypeRepository.restore(id);
      if (result.affected === 0) {
        throw new NotFoundException(
          `RevisionType with ID ${id} not found or was not deleted.`,
        );
      }
      return { message: `RevisionType with ID ${id} has been restored.` };
    } catch (error) {
      handleException(this.logger, error);
    }
  }
}
