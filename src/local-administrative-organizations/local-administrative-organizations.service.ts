import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateLocalAdministrativeOrganizationDto } from './dto/create-local-administrative-organization.dto';
import { UpdateLocalAdministrativeOrganizationDto } from './dto/update-local-administrative-organization.dto';
import { LocalAdministrativeOrganization } from './entities/local-administrative-organization.entity';
import { Amphoe } from 'src/amphoes/entities/amphoe.entity';
import { handleException } from 'src/util/handleException';

@Injectable()
export class LocalAdministrativeOrganizationsService {
  private readonly logger = new Logger(LocalAdministrativeOrganizationsService.name);

  constructor(
    @InjectRepository(LocalAdministrativeOrganization)
    private readonly laoRepository: Repository<LocalAdministrativeOrganization>,

    @InjectRepository(Amphoe)
    private readonly amphoeRepository: Repository<Amphoe>,
  ) {}

  /**
   * Creates a new Local Administrative Organization.
   */
  async create(dto: CreateLocalAdministrativeOrganizationDto): Promise<LocalAdministrativeOrganization> {
    try {
      const { code, name, type, amphoeId } = dto;

      const amphoe = await this.amphoeRepository.findOneBy({ id: amphoeId });
      if (!amphoe) {
        throw new NotFoundException(`Amphoe with ID ${amphoeId} not found`);
      }

      const lao = this.laoRepository.create({
        id: code,
        name,
        type,
        amphoe,
      });

      return await this.laoRepository.save(lao);
    } catch (error) {
      // Handles unique constraint violations and other errors
      handleException(this.logger, error);
    }
  }

  /**
   * Retrieves all Local Administrative Organizations with their Amphoe relation.
   */
  async findAll(): Promise<LocalAdministrativeOrganization[]> {
    try {
      return await this.laoRepository.find({
        relations: ['amphoe'],
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * Retrieves a single Local Administrative Organization by ID with its Amphoe relation.
   */
  async findOne(id: string): Promise<LocalAdministrativeOrganization> {
    try {
      const lao = await this.laoRepository.findOne({
        where: { id },
        relations: ['amphoe'],
      });

      if (!lao) {
        throw new NotFoundException(`Local Administrative Organization with ID ${id} not found`);
      }
      return lao;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * Updates a Local Administrative Organization.
   */
  async update(id: string, dto: UpdateLocalAdministrativeOrganizationDto): Promise<LocalAdministrativeOrganization> {
    try {
      // Use a partial type for the payload for better type safety
      const updatePayload: Partial<UpdateLocalAdministrativeOrganizationDto> & { amphoe?: Amphoe } = { ...dto };

      if (dto.amphoeId) {
        const amphoe = await this.amphoeRepository.findOneBy({ id: dto.amphoeId });
        if (!amphoe) {
          throw new NotFoundException(`Amphoe with ID ${dto.amphoeId} not found`);
        }
        updatePayload.amphoe = amphoe;
      }

      const laoToUpdate = await this.laoRepository.preload({
        id: id,
        ...updatePayload,
      });

      if (!laoToUpdate) {
        throw new NotFoundException(`Local Administrative Organization with ID ${id} not found`);
      }

      return await this.laoRepository.save(laoToUpdate);
    } catch (error)
    {
      handleException(this.logger, error);
    }
  }

  /**
   * Permanently removes a Local Administrative Organization by its ID.
   */
  async remove(id: string): Promise<{ message: string }> {
    try {
      const result = await this.laoRepository.delete(id);
      if (result.affected === 0) {
        throw new NotFoundException(`LAO with ID ${id} not found`);
      }
      return { message: `LAO with ID ${id} has been permanently removed.` };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * Soft-deletes a Local Administrative Organization by its ID.
   */
  async softRemove(id: string): Promise<{ message: string }> {
    try {
      const result = await this.laoRepository.softDelete(id);
      if (result.affected === 0) {
        throw new NotFoundException(`LAO with ID ${id} not found`);
      }
      return { message: `LAO with ID ${id} has been soft-removed.` };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * Restores a soft-deleted Local Administrative Organization by its ID.
   */
  async restore(id: string): Promise<{ message: string }> {
    try {
      const result = await this.laoRepository.restore(id);
      if (result.affected === 0) {
        throw new NotFoundException(`LAO with ID ${id} not found or was not deleted.`);
      }
      return { message: `LAO with ID ${id} has been restored.` };
    } catch (error) {
      handleException(this.logger, error);
    }
  }
}