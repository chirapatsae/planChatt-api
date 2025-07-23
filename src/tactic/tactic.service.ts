import {
  Injectable,
  Logger,
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Tactic } from './entities/tactic.entity';
import { handleException } from 'src/util/handleException';
import { CreateTacticDto } from './dto/create-tactic.dto';
import { UpdateTacticDto } from './dto/update-tactic.dto';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';

@Injectable()
export class TacticService {
  private readonly logger = new Logger(TacticService.name);

  constructor(
    @InjectRepository(Tactic)
    private readonly tacticRepo: Repository<Tactic>,
    @InjectRepository(WorkHistory)
    private readonly workHistoryRepository: Repository<WorkHistory>
  ) {}

  async create(dto: CreateTacticDto, userId: string): Promise<Tactic> {
    try {
      const workHistory = await this.workHistoryRepository.findOne({ where: { id: userId } });
      if (!workHistory) {
        throw new NotFoundException('Invalid user. Work history not found.');
      }
      const { id, name, strategyId } = dto;
      const tactic = this.tacticRepo.create({
        id,
        name,
        strategy: { id: strategyId },
        createdBy: workHistory,
      });
      return await this.tacticRepo.save(tactic);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findAll(): Promise<Tactic[]> {
    try {
      return await this.tacticRepo.find({
        where: { deletedAt: undefined },
        relations: ['strategy', 'createdBy', 'deletedBy',  'planTactics'],
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findOne(id: string): Promise<Tactic> {
    try {
      const tactic = await this.tacticRepo.findOne({
        where: { id },
        relations: ['strategy', 'createdBy', 'deletedBy', 'planTactics'],
      });
      if (!tactic) {
        throw new NotFoundException(`Tactic with ID ${id} not found`);
      }
      return tactic;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async update(id: string, dto: UpdateTacticDto): Promise<Tactic> {
    try {
      const tacticToUpdate = await this.tacticRepo.preload({
        id: id,
        ...dto,
        strategy: dto.strategyId ? { id: dto.strategyId } : undefined,
      });
      if (!tacticToUpdate) {
        throw new NotFoundException(`Tactic with ID ${id} not found`);
      }
      return await this.tacticRepo.save(tacticToUpdate);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async remove(id: string): Promise<{ message: string }> {
    try {
      const result = await this.tacticRepo.delete(id);
      if (result.affected === 0) {
        throw new NotFoundException(`Tactic with ID ${id} not found`);
      }
      return { message: `Tactic with ID ${id} has been permanently removed.` };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async softRemove(id: string, userId: string): Promise<{ message: string }> {
    try {
      const workHistory = await this.workHistoryRepository.findOne({ where: { id: userId } });
      if (!workHistory) {
        throw new NotFoundException('Invalid user. Work history not found.');
      }
      const tactic = await this.tacticRepo.findOne({ where: { id } });
      if (!tactic) {
        throw new NotFoundException(`Tactic with ID ${id} not found`);
      }
      tactic.deletedBy = workHistory;
      await this.tacticRepo.save(tactic);
      await this.tacticRepo.softRemove(tactic);
      return { message: `Tactic with ID ${id} has been soft-removed.` };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async restore(id: string): Promise<{ message: string }> {
    try {
      const result = await this.tacticRepo.restore(id);
      if (result.affected === 0) {
        throw new NotFoundException(`Tactic with ID ${id} not found or was not deleted.`);
      }
      return { message: `Tactic with ID ${id} has been restored.` };
    } catch (error) {
      handleException(this.logger, error);
    }
  }
}
