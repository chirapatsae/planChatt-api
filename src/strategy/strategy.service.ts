import {
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { CreateStrategyDto } from './dto/create-strategy.dto';
import { UpdateStrategyDto } from './dto/update-strategy.dto';
import { Strategy } from './entities/strategy.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { handleException } from 'src/util/handleException';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';

@Injectable()
export class StrategyService {
  private readonly logger = new Logger(StrategyService.name);

  constructor(
    @InjectRepository(Strategy)
    private readonly strategyRepository: Repository<Strategy>,

    @InjectRepository(WorkHistory)
    private readonly workHistoryRepository: Repository<WorkHistory>,
  ) {}

  async create(dto: CreateStrategyDto, userId: string): Promise<Strategy> {
    try {
      const workHistory = await this.workHistoryRepository.findOne({
        where: { user: { id: userId }, isCurrent: true },
      });
      if (!workHistory) {
        throw new UnauthorizedException(
          'Invalid user. Work history not found.',
        );
      }

      const { stratId, name } = dto;
      const strategy = this.strategyRepository.create({
        id: stratId,
        name,
        createdBy: workHistory, // ใส่ object เต็ม
      });

      return await this.strategyRepository.save(strategy);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findAll(): Promise<Strategy[]> {
    this.logger.log('Fetching all strategies');
    try {
      return await this.strategyRepository.find({
        where: { deletedAt: undefined },
        relations: ['tactic', 'createdBy', 'deletedBy'],
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findOne(id: string): Promise<Strategy> {
    this.logger.log(`Fetching strategy with ID: ${id}`);
    try {
      const strategy = await this.strategyRepository.findOne({
        where: { id },
        relations: ['tactic', 'createdBy', 'deletedBy'],
      });
      if (!strategy) {
        throw new NotFoundException(`Strategy with ID ${id} not found`);
      }
      return strategy;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async update(
    id: string,
    updateStrategyDto: UpdateStrategyDto,
  ): Promise<Strategy> {
    try {
      const strategyToUpdate = await this.strategyRepository.preload({
        id: id,
        ...updateStrategyDto,
      });
      if (!strategyToUpdate) {
        throw new NotFoundException(`Strategy with ID ${id} not found`);
      }
      return await this.strategyRepository.save(strategyToUpdate);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async remove(id: string): Promise<{ message: string }> {
    try {
      const result = await this.strategyRepository.delete(id);
      if (result.affected === 0) {
        throw new NotFoundException(`Strategy with ID ${id} not found`);
      }
      return {
        message: `Strategy with ID ${id} has been permanently removed.`,
      };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async softRemove(id: string, userId: string): Promise<{ message: string }> {
    try {
      const workHistory = await this.workHistoryRepository.findOne({
        where: { user: { id: userId }, isCurrent: true },
      });
      if (!workHistory) {
        throw new UnauthorizedException(
          'Invalid user. Work history not found.',
        );
      }

      const strategy = await this.strategyRepository.findOne({ where: { id } });
      if (!strategy) {
        throw new NotFoundException(`Strategy with ID ${id} not found`);
      }

      strategy.deletedBy = workHistory;
      await this.strategyRepository.save(strategy);
      await this.strategyRepository.softRemove(strategy);

      return { message: `Strategy with ID ${id} has been soft-removed.` };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async restore(id: string): Promise<{ message: string }> {
    try {
      const result = await this.strategyRepository.restore(id);
      if (result.affected === 0) {
        throw new NotFoundException(
          `Strategy with ID ${id} not found or was not deleted.`,
        );
      }
      return { message: `Strategy with ID ${id} has been restored.` };
    } catch (error) {
      handleException(this.logger, error);
    }
  }
}
