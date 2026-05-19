import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Plan } from './entities/plan.entity';
import { Tactic } from 'src/tactic/entities/tactic.entity';
import { PlanTactic } from './entities/plan-tactic.entity';
import { handleException } from 'src/util/handleException';
import { CreatePlanDto } from './dto/create-plan.dto';
import { UpdatePlanDto } from './dto/update-plan.dto';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';

@Injectable()
export class PlanService {
  private readonly logger = new Logger(PlanService.name);

  constructor(
    @InjectRepository(Plan)
    private readonly planRepo: Repository<Plan>,



    @InjectRepository(WorkHistory)
    private readonly workHistoryRepository: Repository<WorkHistory>,
  ) {}

  async findAll(): Promise<Plan[]> {
    try {
      return await this.planRepo.find({
        relations: [
          'planTactics',
          'planTactics.tactic',
          'planTactics.tactic.strategy',
        ],
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findOne(id: string): Promise<Plan> {
    try {
      const plan = await this.planRepo.findOne({
        where: { id },
        relations: [
          'planTactics',
          'planTactics.tactic',
          'planTactics.tactic.strategy',
        ],
      });

      if (!plan) throw new NotFoundException(`Plan with ID ${id} not found`);
      return plan;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async create(dto: CreatePlanDto, userId: string): Promise<Plan> {
    try {
      // userId is the JWT subject (= users.id). work_history is owned
      // by a user; the CURRENT row (isCurrent=true) is the operator's
      // organisational context per CLAUDE.md §1.
      const workHistory = await this.workHistoryRepository.findOne({
        where: { user: { id: userId }, isCurrent: true },
      });
      if (!workHistory) {
        throw new NotFoundException('Invalid user. Work history not found.');
      }
      const { id, name } = dto;
      const plan = this.planRepo.create({ id, name, createdBy: workHistory });
      return await this.planRepo.save(plan);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async update(id: string, dto: UpdatePlanDto): Promise<Plan> {
    try {
      const planToUpdate = await this.planRepo.preload({
        id: id,
        ...dto,
      });
      if (!planToUpdate) {
        throw new NotFoundException(`Plan with ID ${id} not found`);
      }
      return await this.planRepo.save(planToUpdate);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async remove(id: string): Promise<{ message: string }> {
    try {
      const result = await this.planRepo.delete(id);
      if (result.affected === 0) {
        throw new NotFoundException(`Plan with ID ${id} not found`);
      }
      return { message: `Plan with ID ${id} has been permanently removed.` };
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
        throw new NotFoundException('Invalid user. Work history not found.');
      }
      const plan = await this.planRepo.findOne({ where: { id } });
      if (!plan) {
        throw new NotFoundException(`Plan with ID ${id} not found`);
      }
      plan.deletedBy = workHistory;
      await this.planRepo.save(plan);
      await this.planRepo.softRemove(plan);
      return { message: `Plan with ID ${id} has been soft-removed.` };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async restore(id: string): Promise<{ message: string }> {
    try {
      const result = await this.planRepo.restore(id);
      if (result.affected === 0) {
        throw new NotFoundException(
          `Plan with ID ${id} not found or was not deleted.`,
        );
      }
      return { message: `Plan with ID ${id} has been restored.` };
    } catch (error) {
      handleException(this.logger, error);
    }
  }
}
