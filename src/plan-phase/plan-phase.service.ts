import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PlanPhase, PhaseType } from './entities/plan-phase.entity';
import { CreatePlanPhaseDto } from './dto/create-plan-phase.dto';
import { UpdatePlanPhaseDto } from './dto/update-plan-phase.dto';
import { BudgetPlan } from 'src/budget_plan/entities/budget_plan.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { handleException } from 'src/util/handleException';

@Injectable()
export class PlanPhaseService {
  private readonly logger = new Logger(PlanPhaseService.name);

  constructor(
    @InjectRepository(PlanPhase)
    private readonly planPhaseRepository: Repository<PlanPhase>,
    @InjectRepository(BudgetPlan)
    private readonly budgetPlanRepository: Repository<BudgetPlan>,
    @InjectRepository(WorkHistory)
    private readonly workHistoryRepository: Repository<WorkHistory>,
  ) {}

  async create(
    createPlanPhaseDto: CreatePlanPhaseDto,
    userId: string,
  ): Promise<PlanPhase> {
    try {
      const { budgetPlanId, openDate, closeDate, phaseType, isMerged } =
        createPlanPhaseDto;

      // Validate date range
      const startDate = new Date(openDate);
      const endDate = new Date(closeDate);

      if (startDate >= endDate) {
        throw new BadRequestException(
          'วันที่เปิดต้องน้อยกว่าวันที่ปิด',
        );
      }

      // Validate budget plan exists
      const budgetPlan = await this.budgetPlanRepository.findOne({
        where: { id: budgetPlanId },
      });

      if (!budgetPlan) {
        throw new NotFoundException(
          `Budget Plan with ID ${budgetPlanId} not found`,
        );
      }

      // Get work history for the user
      const workHistory = await this.workHistoryRepository.findOne({
        where: { user: { id: userId } },
      });

      if (!workHistory) {
        throw new NotFoundException('Work history not found for this user');
      }

      // Check for overlapping phases of the same type for this budget plan
      const overlappingPhases = await this.planPhaseRepository.find({
        where: {
          budgetPlan: { id: budgetPlanId },
          phaseType: phaseType,
        },
      });

      const hasOverlap = overlappingPhases.some((phase) => {
        const phaseStart = new Date(phase.openDate);
        const phaseEnd = new Date(phase.closeDate);
        return (
          (startDate >= phaseStart && startDate <= phaseEnd) ||
          (endDate >= phaseStart && endDate <= phaseEnd) ||
          (startDate <= phaseStart && endDate >= phaseEnd)
        );
      });

      if (hasOverlap) {
        throw new BadRequestException(
          `ช่วงวันที่นี้ซ้อนกับ Phase ${phaseType} อื่นของ Budget Plan นี้`,
        );
      }

      const planPhase = this.planPhaseRepository.create({
        budgetPlan,
        openDate: startDate,
        closeDate: endDate,
        phaseType,
        isMerged: isMerged ?? false,
        createdBy: workHistory,
      });

      return await this.planPhaseRepository.save(planPhase);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findAll(budgetPlanId?: string): Promise<PlanPhase[]> {
    try {
      const where: any = {};
      if (budgetPlanId) {
        where.budgetPlan = { id: budgetPlanId };
      }

      return await this.planPhaseRepository.find({
        where,
        relations: ['budgetPlan', 'createdBy', 'createdBy.user'],
        order: { openDate: 'ASC' },
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findOne(id: string): Promise<PlanPhase> {
    try {
      const planPhase = await this.planPhaseRepository.findOne({
        where: { id },
        relations: ['budgetPlan', 'createdBy', 'createdBy.user'],
      });

      if (!planPhase) {
        throw new NotFoundException(`Plan Phase with ID ${id} not found`);
      }

      return planPhase;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async update(
    id: string,
    updatePlanPhaseDto: UpdatePlanPhaseDto,
  ): Promise<PlanPhase> {
    try {
      const planPhase = await this.planPhaseRepository.findOne({
        where: { id },
        relations: ['budgetPlan'],
      });

      if (!planPhase) {
        throw new NotFoundException(`Plan Phase with ID ${id} not found`);
      }

      // Validate date range if dates are being updated
      const openDate = updatePlanPhaseDto.openDate
        ? new Date(updatePlanPhaseDto.openDate)
        : planPhase.openDate;
      const closeDate = updatePlanPhaseDto.closeDate
        ? new Date(updatePlanPhaseDto.closeDate)
        : planPhase.closeDate;

      if (openDate >= closeDate) {
        throw new BadRequestException(
          'วันที่เปิดต้องน้อยกว่าวันที่ปิด',
        );
      }

      // Check for overlapping phases if dates or phaseType are being updated
      const phaseType = updatePlanPhaseDto.phaseType ?? planPhase.phaseType;
      const budgetPlanId = planPhase.budgetPlan.id;

      if (updatePlanPhaseDto.openDate || updatePlanPhaseDto.closeDate || updatePlanPhaseDto.phaseType) {
        const overlappingPhases = await this.planPhaseRepository.find({
          where: {
            budgetPlan: { id: budgetPlanId },
            phaseType: phaseType,
          },
        });

        const hasOverlap = overlappingPhases
          .filter((phase) => phase.id !== id)
          .some((phase) => {
            const phaseStart = new Date(phase.openDate);
            const phaseEnd = new Date(phase.closeDate);
            return (
              (openDate >= phaseStart && openDate <= phaseEnd) ||
              (closeDate >= phaseStart && closeDate <= phaseEnd) ||
              (openDate <= phaseStart && closeDate >= phaseEnd)
            );
          });

        if (hasOverlap) {
          throw new BadRequestException(
            `ช่วงวันที่นี้ซ้อนกับ Phase ${phaseType} อื่นของ Budget Plan นี้`,
          );
        }
      }

      // Update budget plan if budgetPlanId is provided
      if (updatePlanPhaseDto.budgetPlanId) {
        const budgetPlan = await this.budgetPlanRepository.findOne({
          where: { id: updatePlanPhaseDto.budgetPlanId },
        });

        if (!budgetPlan) {
          throw new NotFoundException(
            `Budget Plan with ID ${updatePlanPhaseDto.budgetPlanId} not found`,
          );
        }

        planPhase.budgetPlan = budgetPlan;
      }

      // Merge updates
      Object.assign(planPhase, {
        openDate: updatePlanPhaseDto.openDate
          ? new Date(updatePlanPhaseDto.openDate)
          : planPhase.openDate,
        closeDate: updatePlanPhaseDto.closeDate
          ? new Date(updatePlanPhaseDto.closeDate)
          : planPhase.closeDate,
        phaseType: updatePlanPhaseDto.phaseType ?? planPhase.phaseType,
        isMerged:
          updatePlanPhaseDto.isMerged !== undefined
            ? updatePlanPhaseDto.isMerged
            : planPhase.isMerged,
      });

      return await this.planPhaseRepository.save(planPhase);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async remove(id: string): Promise<{ message: string }> {
    try {
      const result = await this.planPhaseRepository.delete(id);
      if (result.affected === 0) {
        throw new NotFoundException(`Plan Phase with ID ${id} not found`);
      }
      return { message: `Plan Phase with ID ${id} has been permanently removed.` };
    } catch (error) {
      handleException(this.logger, error);
    }
  }
}