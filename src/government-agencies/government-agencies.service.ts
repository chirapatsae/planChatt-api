import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CreateGovernmentAgencyDto } from './dto/create-government-agency.dto';
import { UpdateGovernmentAgencyDto } from './dto/update-government-agency.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { GovernmentAgency } from './entities/government-agency.entity';
import { Repository } from 'typeorm';
import { handleException } from 'src/util/handleException';

@Injectable()
export class GovernmentAgenciesService {
  private readonly logger = new Logger(GovernmentAgenciesService.name);
  constructor(
    @InjectRepository(GovernmentAgency)
    private readonly governmentAgencyRepository: Repository<GovernmentAgency>,
  ) {}

  async create(createGovernmentAgencyDto: CreateGovernmentAgencyDto) {
    try {
      const { name } = createGovernmentAgencyDto;
      const governmentAgency = this.governmentAgencyRepository.create({ name });
      return await this.governmentAgencyRepository.save(governmentAgency);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findAll() {
    try {
      return await this.governmentAgencyRepository.find({
        where: { deletedAt: undefined },
        relations: [],
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findOne(id: string) {
    try {
      const governmentAgency = await this.governmentAgencyRepository.findOne({
        where: { id },
        relations: [],
      });

      if (!governmentAgency) {
        throw new NotFoundException(
          `Government Agency with ID ${id} not found`,
        );
      }
      return governmentAgency;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async update(
    id: string,
    updateGovernmentAgencyDto: UpdateGovernmentAgencyDto,
  ) {
    try {
      const governmentAgencyToUpdate =
        await this.governmentAgencyRepository.preload({
          id,
          ...updateGovernmentAgencyDto,
        });

      if (!governmentAgencyToUpdate) {
        throw new NotFoundException(
          `Government Agency with ID ${id} not found`,
        );
      }

      return await this.governmentAgencyRepository.save(
        governmentAgencyToUpdate,
      );
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async remove(id: string): Promise<{ message: string }> {
    try {
      const result = await this.governmentAgencyRepository.delete(id);
      if (result.affected === 0) {
        throw new NotFoundException(
          `Government Agency with ID ${id} not found`,
        );
      }
      return {
        message: `Government Agency with ID ${id} has been permanently removed.`,
      };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async softRemove(id: string): Promise<{ message: string }> {
    try {
      const result = await this.governmentAgencyRepository.softDelete(id);
      if (result.affected === 0) {
        throw new NotFoundException(
          `Government Agency with ID ${id} not found`,
        );
      }
      return {
        message: `Government Agency with ID ${id} has been soft-removed.`,
      };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async restore(id: string): Promise<{ message: string }> {
    try {
      const result = await this.governmentAgencyRepository.restore(id);
      if (result.affected === 0) {
        throw new NotFoundException(
          `Government Agency with ID ${id} not found or was not deleted.`,
        );
      }
      return { message: `Government Agency with ID ${id} has been restored.` };
    } catch (error) {
      handleException(this.logger, error);
    }
  }
}
