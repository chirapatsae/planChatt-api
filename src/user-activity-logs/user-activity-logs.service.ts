import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateUserActivityLogDto } from './dto/create-user-activity-log.dto';
import { UserActivityLog } from './entities/user-activity-log.entity';
import { handleException } from 'src/util/handleException';
import { User } from 'src/users/entities/user.entity';

@Injectable()
export class UserActivityLogsService {
  private readonly logger = new Logger(UserActivityLogsService.name);

  constructor(
    @InjectRepository(UserActivityLog)
    private readonly userActivityLogRepository: Repository<UserActivityLog>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  async create(dto: CreateUserActivityLogDto, userId: string): Promise<UserActivityLog> {
    try {
      const user = await this.userRepository.findOne({ where: { id: userId } });
      if (!user) {
        throw new NotFoundException(`User with ID ${userId} not found`);
      }
      const userActivityLog = this.userActivityLogRepository.create({
        ...dto,
        createdAt: new Date(),
        createdBy: user,
      });
      return await this.userActivityLogRepository.save(userActivityLog);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findAll(): Promise<UserActivityLog[]> {
    try {
      return await this.userActivityLogRepository.find();
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findOne(id: string): Promise<UserActivityLog> {
    try {
      const log = await this.userActivityLogRepository.findOne({ where: { id } });
      if (!log) {
        throw new NotFoundException(`UserActivityLog with ID ${id} not found`);
      }
      return log;
    } catch (error) {
      handleException(this.logger, error);
    }
  }


}
