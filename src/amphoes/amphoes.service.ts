import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull, Not } from 'typeorm';
import { CreateAmphoeDto } from './dto/create-amphoe.dto';
import { UpdateAmphoeDto } from './dto/update-amphoe.dto';
import { Amphoe } from './entities/amphoe.entity';
import { User } from 'src/users/entities/user.entity';

@Injectable()
export class AmphoesService {
  private readonly logger = new Logger(AmphoesService.name);

  constructor(
    @InjectRepository(Amphoe)
    private readonly amphoeRepository: Repository<Amphoe>,

  ) { }

  async create(dto: CreateAmphoeDto): Promise<Amphoe> {
    try {
      const { code, name } = dto;

      const existing = await this.amphoeRepository.findOne({ where: { id: code } });
      if (existing) {
        throw new BadRequestException('Amphoe with this code already exists');
      }

      const amphoe = this.amphoeRepository.create({ id: code, name, });
      this.logger.log(amphoe)
      return await this.amphoeRepository.save(amphoe);
    } catch (error) {
      this.logger.error(`Failed to create amphoe. DTO: ${JSON.stringify(dto)}`, error.stack);
      // If it's a known client error, re-throw it. Otherwise, wrap it.
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new InternalServerErrorException('An unexpected error occurred while creating the amphoe.');
    }
  }

  async findAll(): Promise<Amphoe[]> {
    try {
      return await this.amphoeRepository.find({
        where: { deletedAt: IsNull() },
        relations: ["localAdministrativeOrganization"],
      });
    } catch (error) {
      this.logger.error('Find all amphoes failed', error.stack);
      throw new BadRequestException('Failed to fetch amphoes');
    }
  }

  async findOne(id: string): Promise<Amphoe> {
    try {
      return await this.getAmphoeOrThrow(id);
    } catch (error) {
      this.logger.error(`Find amphoe ${id} failed`, error.stack);
      throw error;
    }
  }

  async update(id: string, dto: UpdateAmphoeDto): Promise<Amphoe> {
    try {

      const founded = await this.amphoeRepository.findOne({
        where: { id: id },
      });
      this.logger.log(founded)
   
      const amphoe = await this.getAmphoeOrThrow(id);

      Object.assign(amphoe, {  name : dto.name });
      return await this.amphoeRepository.save(amphoe);
    } catch (error) {
      this.logger.error(`Update amphoe ${id} failed`, error.stack);
      throw error;
    }
  }

  async remove(id: string): Promise<{ message: string }> {
    try {
      const amphoe = await this.getAmphoeOrThrow(id);
      await this.amphoeRepository.remove(amphoe);
      return { message: `Amphoe ${amphoe.name} removed successfully` };
    } catch (error) {
      this.logger.error(`Remove amphoe ${id} failed`, error.stack);
      throw error;
    }
  }

  async softRemove(id: string): Promise<{ message: string }> {
    try {
      const amphoe = await this.getAmphoeOrThrow(id);
      await this.amphoeRepository.softRemove(amphoe);
      return { message: `Amphoe ${amphoe.name} soft removed successfully` };
    } catch (error) {
      this.logger.error(`Soft remove amphoe ${id} failed`, error.stack);
      throw error;
    }
  }

  async restore(id: string): Promise<{ message: string }> {
    try {
      const amphoe = await this.amphoeRepository.findOne({
        where: { id },
        withDeleted: true,
      });

      if (!amphoe) {
        throw new NotFoundException('Amphoe not found');
      }

      await this.amphoeRepository.restore(id);
      return { message: `Amphoe ${amphoe.name} restored successfully` };
    } catch (error) {
      this.logger.error(`Restore amphoe ${id} failed`, error.stack);
      throw error instanceof NotFoundException
        ? error
        : new BadRequestException('Failed to restore amphoe');
    }
  }

  /**
   * Reusable method: get amphoe or throw NotFoundException
   */
  private async getAmphoeOrThrow(id: string): Promise<Amphoe> {
    const amphoe = await this.amphoeRepository.findOne({
      where: { id, deletedAt: IsNull() },
      relations: ['localAdministrativeOrganization']
    });
    if (!amphoe) {
      throw new NotFoundException(`Amphoe with ID ${id} not found`);
    }
    return amphoe;
  }

}
