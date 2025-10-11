import { Budget } from './../budget/entities/budget.entity';
import {
  Injectable,
  NotFoundException,
  InternalServerErrorException,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Not, Repository } from 'typeorm';
import { BudgetPlan } from './entities/budget_plan.entity';
import { CreateBudgetPlanDto } from './dto/create-budget_plan.dto';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { handleException } from 'src/util/handleException';
import { UpdateBudgetPlanDto } from './dto/update-budget_plan.dto';

@Injectable()
export class BudgetPlanService {
  private readonly logger = new Logger(BudgetPlanService.name);

  constructor(
    @InjectRepository(BudgetPlan)
    private readonly budgetPlanRepository: Repository<BudgetPlan>,

    @InjectRepository(WorkHistory)
    private readonly workHistoryRepository: Repository<WorkHistory>,
    private readonly dataSource: DataSource,
  ) {}

  async create(dto: CreateBudgetPlanDto, userId: string): Promise<BudgetPlan> {
    try {
      const { name, startYear, endYear, startDate, endDate } = dto;

      // Validate date range if provided
      if (startDate && endDate) {
        const start = new Date(startDate);
        const end = new Date(endDate);
        
        if (start >= end) {
          throw new BadRequestException(
            'วันที่เปิดต้องน้อยกว่าวันที่ปิด',
          );
        }
      }

      const workHistory = await this.workHistoryRepository.findOne({
        where: { user: { id: userId }, workStatus: { name: 'approved' } },
      });
      if (!workHistory)
        throw new NotFoundException('Work history not found for this user');

      if (startYear >= endYear) {
        throw new BadRequestException('Start year must be less than end year');
      }

      return await this.dataSource.transaction(async (manager) => {
        const existingPlans = await manager.find(BudgetPlan);

        const isExactDuplicate = existingPlans.some(
          (plan) => plan.startYear === startYear && plan.endYear === endYear,
        );
        if (isExactDuplicate) {
          throw new BadRequestException('งบประมาณช่วงปีนี้มีอยู่แล้ว');
        }

        const isOverlapping = existingPlans.some((plan) => {
          return (
            (startYear >= plan.startYear && startYear <= plan.endYear) ||
            (endYear >= plan.startYear && endYear <= plan.endYear) ||
            (startYear <= plan.startYear && endYear >= plan.endYear)
          );
        });
        if (isOverlapping) {
          throw new BadRequestException(
            'ช่วงปีนี้ซ้อนกับแผนงบประมาณที่มีอยู่แล้ว',
          );
        }

        await manager.update(
          BudgetPlan,
          { isLatest: true },
          { isLatest: false },
        );

        const newBudgetPlan = manager.create(BudgetPlan, {
          name,
          startYear,
          endYear,
          isLatest: true,
          startDate: startDate ? new Date(startDate) : null,
          endDate: endDate ? new Date(endDate) : null,
          createdBy: { id: workHistory.id },
        });

        return await manager.save(newBudgetPlan);
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findAll(): Promise<BudgetPlan[]> {
    try {
      return await this.budgetPlanRepository.find({
        relations: ['createdBy'],
        order: { createAt: 'DESC' },
        where: { isLatest: true },
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findOne(id: string): Promise<BudgetPlan> {
    try {
      const budgetPlan = await this.budgetPlanRepository.findOne({
        where: { id  , isLatest: true},
        relations: ['projectGroup', 'workHistory'],
      });

      if (!budgetPlan) {
        this.logger.warn(`BudgetPlan not found: ${id}`);
        throw new NotFoundException(`BudgetPlan with id ${id} not found`);
      }

      return budgetPlan;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async update(id: string, dto: UpdateBudgetPlanDto): Promise<BudgetPlan> {
    try {
      const budgetPlan = await this.budgetPlanRepository.findOneBy({ id });

      if (!budgetPlan) {
        throw new NotFoundException(`Budget Plan with ID ${id} not found`);
      }

      if (!budgetPlan.isLatest) {
        throw new BadRequestException(
          `Only the latest budget plan can be updated`,
        );
      }

      const startYear = dto.startYear ?? budgetPlan.startYear;
      const endYear = dto.endYear ?? budgetPlan.endYear;

      if (startYear >= endYear) {
        throw new BadRequestException('startYear ต้องน้อยกว่า endYear');
      }

      // Validate date range if provided
      const startDate = dto.startDate ? new Date(dto.startDate) : budgetPlan.startDate;
      const endDate = dto.endDate ? new Date(dto.endDate) : budgetPlan.endDate;
      
      if (startDate && endDate && startDate >= endDate) {
        throw new BadRequestException(
          'วันที่เปิดต้องน้อยกว่าวันที่ปิด',
        );
      }

      const otherPlans = await this.budgetPlanRepository.find({
        where: { id: Not(id) },
      });

      const isExactDuplicate = otherPlans.some(
        (plan) => plan.startYear === startYear && plan.endYear === endYear,
      );

      if (isExactDuplicate) {
        throw new BadRequestException('ช่วงปีซ้ำกับแผนงบประมาณอื่น');
      }

      const isOverlapping = otherPlans.some((plan) => {
        return (
          (startYear >= plan.startYear && startYear <= plan.endYear) ||
          (endYear >= plan.startYear && endYear <= plan.endYear) ||
          (startYear <= plan.startYear && endYear >= plan.endYear)
        );
      });

      if (isOverlapping) {
        throw new BadRequestException('ช่วงปีซ้อนกับแผนงบประมาณอื่น');
      }

      const updated = this.budgetPlanRepository.merge(budgetPlan, {
        ...dto,
        startDate: dto.startDate ? new Date(dto.startDate) : budgetPlan.startDate,
        endDate: dto.endDate ? new Date(dto.endDate) : budgetPlan.endDate,
      });

      return await this.budgetPlanRepository.save(updated);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async remove(id: string): Promise<{ message: string }> {
    try {
      const result = await this.budgetPlanRepository.delete(id);
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
      const result = await this.budgetPlanRepository.softDelete(id);
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
      const result = await this.budgetPlanRepository.restore(id);
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
