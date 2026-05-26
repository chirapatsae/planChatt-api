import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { handleException } from 'src/util/handleException';
import { Division } from './entities/division.entity';
import { CreateDivisionDto } from './dto/create-division.dto';
import { UpdateDivisionDto } from './dto/update-division.dto';

@Injectable()
export class DivisionsService {
  private readonly logger = new Logger(DivisionsService.name);
  constructor(
    @InjectRepository(Division)
    private readonly divisionRepository: Repository<Division>,
  ) {}

  async create(createDivisionDto: CreateDivisionDto) {
    try {
      const { name, governmentAgencyId } = createDivisionDto;
      const division = this.divisionRepository.create({
        name,
        // String-typed FK on the related entity (legacy type lie); cast to any
        // matches the existing lookup-entity pattern.
        governmentAgency: { id: governmentAgencyId as any } as any,
      });
      return await this.divisionRepository.save(division);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findAll(governmentAgencyId?: string) {
    try {
      const where: Record<string, unknown> = { deletedAt: undefined };
      if (governmentAgencyId !== undefined && governmentAgencyId !== '') {
        // Eq-by-FK filter; nested relation filter form keeps the eager-load
        // join in one round-trip.
        where.governmentAgency = { id: governmentAgencyId };
      }
      return await this.divisionRepository.find({
        where,
        relations: ['governmentAgency'],
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findOne(id: string) {
    try {
      const division = await this.divisionRepository.findOne({
        where: { id },
        relations: ['governmentAgency'],
      });

      if (!division) {
        throw new NotFoundException(`Division with ID ${id} not found`);
      }
      return division;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async update(id: string, updateDivisionDto: UpdateDivisionDto) {
    try {
      // `divisions.id` is a UUID PK — `string` round-trips cleanly, no
      // numeric coercion needed (unlike the legacy integer-PK lookup
      // entities such as GovernmentAgency).
      const toUpdate = await this.divisionRepository.preload({
        id,
        ...(updateDivisionDto.name !== undefined
          ? { name: updateDivisionDto.name }
          : {}),
        ...(updateDivisionDto.governmentAgencyId !== undefined
          ? {
              governmentAgency: {
                id: updateDivisionDto.governmentAgencyId as any,
              } as any,
            }
          : {}),
      });

      if (!toUpdate) {
        throw new NotFoundException(`Division with ID ${id} not found`);
      }

      return await this.divisionRepository.save(toUpdate);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async remove(id: string): Promise<{ message: string }> {
    try {
      const result = await this.divisionRepository.delete(id);
      if (result.affected === 0) {
        throw new NotFoundException(`Division with ID ${id} not found`);
      }
      return {
        message: `Division with ID ${id} has been permanently removed.`,
      };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async softRemove(id: string): Promise<{ message: string }> {
    try {
      const result = await this.divisionRepository.softDelete(id);
      if (result.affected === 0) {
        throw new NotFoundException(`Division with ID ${id} not found`);
      }
      return {
        message: `Division with ID ${id} has been soft-removed.`,
      };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async restore(id: string): Promise<{ message: string }> {
    try {
      const result = await this.divisionRepository.restore(id);
      if (result.affected === 0) {
        throw new NotFoundException(
          `Division with ID ${id} not found or was not deleted.`,
        );
      }
      return { message: `Division with ID ${id} has been restored.` };
    } catch (error) {
      handleException(this.logger, error);
    }
  }
}
