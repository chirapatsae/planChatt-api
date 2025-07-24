import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { CreateStatusDto } from './dto/create-status.dto';
import { UpdateStatusDto } from './dto/update-status.dto';
import { User } from 'src/users/entities/user.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Status } from './entities/status.entity';
import { IsNull, Not, Repository } from 'typeorm';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { handleException } from 'src/util/handleException';

@Injectable()
export class StatusService {
  private readonly logger = new Logger(StatusService.name);

  constructor(
    @InjectRepository(Status)
    private readonly statusRepository: Repository<Status>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(WorkHistory)
    private readonly workHistoryRepository: Repository<WorkHistory>,
  ) {}

  async create(
    createStatusDto: CreateStatusDto,
    userId: string,
  ): Promise<Status> {
    try {
      const exitName = await this.statusRepository.findOne({
        where: { name: createStatusDto.name },
      });
      if (exitName) {
        throw new BadRequestException('Status with this name already exists');
      }
      const workHistory = await this.workHistoryRepository.findOne({
        where: { id: userId },
      });
      if (!workHistory) {
        throw new UnauthorizedException(
          'Invalid user. Work history not found.',
        );
      }
      const status = this.statusRepository.create({
        ...createStatusDto,
        createdBy: workHistory,
      });
      return await this.statusRepository.save(status);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findAll(): Promise<Status[]> {
    try {
      return await this.statusRepository.find({
        relations: ['createdBy', 'deletedBy'],
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findOne(id: string): Promise<Status> {
    try {
      const status = await this.statusRepository.findOne({
        where: { id },
        relations: ['createdBy', 'deletedBy'],
      });
      if (!status) {
        throw new BadRequestException('Status not found');
      }
      return status;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async update(id: string, updateStatusDto: UpdateStatusDto) {
    try {
      const exitName = await this.statusRepository.findOne({
        where: { name: updateStatusDto.name, id: Not(id) },
      });
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
      handleException(this.logger, error);
    }
  }

  async softRemove(id: string, userId: string): Promise<{ message: string }> {
    try {
      const status = await this.statusRepository.findOne({ where: { id } });
      if (!status) {
        throw new BadRequestException('Status not found');
      }
      const workHistory = await this.workHistoryRepository.findOne({
        where: { id: userId },
      });
      if (!workHistory) {
        throw new UnauthorizedException(
          'Invalid user. Work history not found.',
        );
      }
      status.deletedBy = workHistory;
      await this.statusRepository.save(status);
      await this.statusRepository.softRemove(status);
      return { message: `Status ${status.name} soft removed successfully` };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async remove(id: string): Promise<{ message: string }> {
    try {
      const result = await this.statusRepository.delete(id);
      if (result.affected === 0) {
        throw new NotFoundException(`Status with ID ${id} not found`);
      }
      return { message: `Status with ID ${id} has been permanently removed.` };
    } catch (error) {
      this.logger.error(`Hard delete status ${id} failed`, error.stack);
      throw error;
    }
  }

  async restore(id: string): Promise<{ message: string }> {
    try {
      const status = await this.statusRepository.findOne({
        where: { id },
        withDeleted: true,
      });
      if (!status) {
        throw new BadRequestException('Status Id not found');
      }
      const result = await this.statusRepository.restore(id);
      if (result.affected === 0) {
        throw new BadRequestException('Status not found');
      }
      return { message: `Status with ID ${id} has been restored` };
    } catch (error) {
      handleException(this.logger, error);
    }
  }
}
