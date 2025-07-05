import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CreateLocalAdministrativeOrganizationDto } from './dto/create-local-administrative-organization.dto';
import { UpdateLocalAdministrativeOrganizationDto } from './dto/update-local-administrative-organization.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import { User } from 'src/users/entities/user.entity';
import { LocalAdministrativeOrganization } from './entities/local-administrative-organization.entity';

@Injectable()
export class LocalAdministrativeOrganizationsService {
  private readonly logger = new Logger(LocalAdministrativeOrganizationsService.name);

  constructor(
    @InjectRepository(LocalAdministrativeOrganization)
    private readonly laoRepository: Repository<LocalAdministrativeOrganization>,

    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  async create(dto: CreateLocalAdministrativeOrganizationDto): Promise<LocalAdministrativeOrganization> {
    try {
      const { code, name } = dto;

      const existingLao = await this.laoRepository.findOne({ where: { id : code } });
      if (existingLao) {
        throw new BadRequestException('Amphoe with this code already exists');
      }

      const lao = this.laoRepository.create({ id : code, name});
      return await this.laoRepository.save(lao);
    } catch (error) {
      this.logger.error('Failed to create LAO', error.stack);
      this.handleException(error);
    }
  }

  async findAll(): Promise<LocalAdministrativeOrganization[]> {
    try {
      return await this.laoRepository.find();
    } catch (error) {
      this.logger.error('Failed to fetch all LAOs', error.stack);
      this.handleException(error);
    }
  }

  async findOne(id: string): Promise<LocalAdministrativeOrganization> {
    try {
      const lao = await this.laoRepository.findOneBy({ id });
      if (!lao) {
        throw new NotFoundException('Local Administrative Organization not found');
      }
      return lao;
    } catch (error) {
      this.logger.error(`Failed to fetch LAO with id ${id}`, error.stack);
      this.handleException(error);
    }
  }

  async update(id: string, dto: UpdateLocalAdministrativeOrganizationDto): Promise<LocalAdministrativeOrganization> {
    try {

      const existingCode = await this.laoRepository.findOne({
        where: {  id: Not(id) },
      });
      if (existingCode) {
        throw new BadRequestException('Amphoe with this code already exists');
      }

      const lao = await this.laoRepository.findOne({ where: { id } });
      if (!lao) {
        throw new NotFoundException('Local Administrative Organization not found');
      }

      Object.assign(lao, dto);
      return await this.laoRepository.save(lao);
    } catch (error) {
      this.logger.error(`Failed to update LAO id ${id}`, error.stack);
      this.handleException(error);
    }
  }

  async remove(id: string): Promise<{ message: string }> {
    try {
      const lao = await this.laoRepository.findOne({ where: { id } });
      if (!lao) {
        throw new NotFoundException('Local Administrative Organization not found');
      }

      await this.laoRepository.remove(lao);
      this.logger.warn(`LAO with id ${id} has been permanently deleted`);
      return { message: `LAO with id ${id} has been permanently deleted` };
    } catch (error) {
      this.logger.error(`Failed to delete LAO id ${id}`, error.stack);
      this.handleException(error);
    }
  }

  async softRemove(id: string): Promise<{ message: string }> {
    try {
      const lao = await this.laoRepository.findOne({ where: { id } });
      if (!lao) {
        throw new NotFoundException('Local Administrative Organization not found');
      }

      await this.laoRepository.softRemove(lao);
      this.logger.warn(`LAO with id ${id} has been soft-deleted`);
      return { message: `LAO with id ${id} has been soft-deleted` };
    } catch (error) {
      this.logger.error(`Failed to soft-delete LAO id ${id}`, error.stack);
      this.handleException(error);
    }
  }

  async restore(id: string): Promise<{ message: string }> {
    try {
      const lao = await this.laoRepository.findOne({ where: { id }, withDeleted: true });
      if (!lao) {
        throw new NotFoundException('Local Administrative Organization not found');
      }
      await this.laoRepository.restore(id);
      this.logger.log(`LAO with id ${id} has been restored`);

      return { message: `LAO with id ${id} has been restored` };
    } catch (error) {
      this.logger.error(`Failed to restore LAO id ${id}`, error.stack);
      this.handleException(error);
    }
  }

  private handleException(error: any): never {
    if (error instanceof BadRequestException || error instanceof NotFoundException) {
      throw error;
    }

    throw new InternalServerErrorException('Unexpected server error');
  }
}
