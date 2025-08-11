import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateAmphoeDto } from './dto/create-amphoe.dto';
import { UpdateAmphoeDto } from './dto/update-amphoe.dto';
import { Amphoe } from './entities/amphoe.entity';
import { handleException } from 'src/util/handleException';

@Injectable()
export class AmphoesService {
  private readonly logger = new Logger(AmphoesService.name);

  constructor(
    @InjectRepository(Amphoe)
    private readonly amphoeRepository: Repository<Amphoe>,
  ) {}

  async create(dto: CreateAmphoeDto): Promise<Amphoe> {
    try {
      const { code, name } = dto;
      const amphoe = this.amphoeRepository.create({ id: code, name });
      return await this.amphoeRepository.save(amphoe);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findAll(): Promise<Amphoe[]> {
    try {
      return await this.amphoeRepository.find({
        relations: ['localAdministrativeOrganization'],
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findOne(id: string): Promise<Amphoe> {
    try {
      const amphoe = await this.amphoeRepository.findOne({
        where: { id },
        relations: ['localAdministrativeOrganization'],
      });

      if (!amphoe) {
        throw new NotFoundException(`Amphoe with ID ${id} not found`);
      }
      return amphoe;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async update(id: string, dto: UpdateAmphoeDto): Promise<Amphoe> {
    try {
      const amphoeToUpdate = await this.amphoeRepository.preload({
        id: id,
        ...dto,
      });

      if (!amphoeToUpdate) {
        throw new NotFoundException(`Amphoe with ID ${id} not found`);
      }

      return await this.amphoeRepository.save(amphoeToUpdate);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async remove(id: string): Promise<{ message: string }> {
    try {
      const result = await this.amphoeRepository.delete(id);
      if (result.affected === 0) {
        throw new NotFoundException(`Amphoe with ID ${id} not found`);
      }
      return { message: `Amphoe with ID ${id} has been permanently removed.` };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async softRemove(id: string): Promise<{ message: string }> {
    try {
      const result = await this.amphoeRepository.softDelete(id);
      if (result.affected === 0) {
        throw new NotFoundException(`Amphoe with ID ${id} not found`);
      }
      return { message: `Amphoe with ID ${id} has been soft-removed.` };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async restore(id: string): Promise<{ message: string }> {
    try {
      const result = await this.amphoeRepository.restore(id);
      if (result.affected === 0) {
        throw new NotFoundException(
          `Amphoe with ID ${id} not found or was not deleted.`,
        );
      }
      return { message: `Amphoe with ID ${id} has been restored.` };
    } catch (error) {
      handleException(this.logger, error);
    }
  }
}
