import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { CreateStatusDto } from './dto/create-status.dto';
import { UpdateStatusDto } from './dto/update-status.dto';
import { User } from 'src/users/entities/user.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Status } from './entities/status.entity';
import { IsNull, Not, Repository } from 'typeorm';

@Injectable()
export class StatusService {
  private readonly logger = new Logger(StatusService.name);

  constructor(
    @InjectRepository(Status)
    private readonly statusRepository: Repository<Status>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) { }

  async create(createStatusDto: CreateStatusDto): Promise<Status> {
    try {
      this.logger.log(`Creating status: ${createStatusDto.name}`);
      const { level, name } = createStatusDto
      //check user 

      const exitLevel = await this.statusRepository.findOne({ where: { level: level } });
      if (exitLevel) {
        throw new BadRequestException('Status with this level already exists');
      }
      const exitName = await this.statusRepository.findOne({ where: { name: name } });
      if (exitName) {
        throw new BadRequestException('Status with this name already exists');
      }

      const status = this.statusRepository.create({
        ...createStatusDto,
      });
      return await this.statusRepository.save(status);
    } catch (error) {
      this.logger.error('Create status failed', error.stack);
      throw new BadRequestException('Failed to create status');
    }
  }

  async findAll(): Promise<Status[]> {
    try {
      return await this.statusRepository.find({
        where: { deleteAt: IsNull() },
      });
    } catch (error) {
      this.logger.error('Find all status failed', error.stack);
      throw new BadRequestException('Failed to fetch status');
    }
  }

  async findOne(id: string): Promise<Status> {
    try {
      const status = await this.statusRepository.findOne({ where: { id }, relations: ['user'] });
      if (!status) {
        throw new BadRequestException('Status not found');
      }
      return status;
    } catch (error) {
      this.logger.error(`Find status ${id} failed`, error.stack);
      throw new BadRequestException('Failed to fetch status');
    }
  }

  async update(id: string, updateStatusDto: UpdateStatusDto) {
    try {
      const { level, name } = updateStatusDto;

      const exitLevel = await this.statusRepository.findOne({ where: { level: level, id: Not(id) } });
      if (exitLevel) {
        throw new BadRequestException('Status with this level already exists');
      }
      const exitName = await this.statusRepository.findOne({ where: { name: name, id: Not(id) } });
      if (exitName) {
        throw new BadRequestException('Status with this name already exists');
      }
      const status = await this.statusRepository.findOne({ where: { id } });
      if (!status) {
        throw new BadRequestException('Status not found');
      }
      Object.assign(status, updateStatusDto);
      return await this.statusRepository.save(status);

    } catch (error) {
      this.logger.error(`Update status ${id} failed`, error.stack);
      throw new BadRequestException('Failed to update status');
    }
  }

  async softRemove(id: string): Promise<{ message: string }> {
    try {
      const status = await this.statusRepository.findOne({ where: { id } });
      if (!status) {
        throw new BadRequestException('Status not found');
      }
      if (status) {
        await this.statusRepository.softRemove(status);
      }
      return { message: `Status ${status.name} soft removed successfully` };
    } catch (error) {
      this.logger.error(`Delete status ${id} failed`, error.stack);
      throw new BadRequestException('Failed to delete status');
    }
  }

  async restore(id: string): Promise<{ message: string }> {
    try {
      const status = await this.statusRepository.findOne({ where: { id } , withDeleted : true })
      if (!status) {
        throw new BadRequestException('Status Id not found')
      }
      const result = await this.statusRepository.restore(id);
      if (result.affected === 0) {
        throw new BadRequestException('Status not found');
      }
      return { message: `Status with ID ${id} has been restored` };
    } catch (error) {
      this.logger.error(`Restore status ${id} failed`, error.stack);
      throw new BadRequestException('Failed to restore status');
    }
  }

  private async getUserOrThrow(id: string): Promise<User> {
    const user = await this.userRepository.findOne({ where: { id } });
    if (!user) {
      throw new BadRequestException('User not found');
    }
    return user;
  }
}

