import {
  BadRequestException,
  Injectable,
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
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) { }

  async create(dto: CreateAmphoeDto): Promise<Amphoe> {
    try {
      const { code, name } = dto;

      const existing = await this.amphoeRepository.findOne({ where: { id: code } });
      if (existing) {
        throw new BadRequestException('Amphoe with this code already exists');
      }

      const amphoe = this.amphoeRepository.create({ id: code, name, });
      return await this.amphoeRepository.save(amphoe);
    } catch (error) {
      this.logger.error('Create amphoe failed', error.stack);
      throw error;
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
      const { code } = dto;

      const duplicate = await this.amphoeRepository.findOne({
        where: { id: Not(id) },
      });
      if (duplicate) {
        throw new BadRequestException('Amphoe with this code already exists');
      }

      const amphoe = await this.getAmphoeOrThrow(id);


      Object.assign(amphoe, { id: code, ...dto });
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

  /**
   * Reusable method: get user or throw
   */
  private async getUserOrThrow(id: string): Promise<User> {
    const user = await this.userRepository.findOne({ where: { id } });
    if (!user) {
      throw new BadRequestException('User not found');
    }
    return user;
  }
}
