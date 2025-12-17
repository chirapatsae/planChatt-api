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
import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { handleException } from 'src/util/handleException';

@Injectable()
export class PlanPhaseService {
  private readonly logger = new Logger(PlanPhaseService.name);

  constructor(
    @InjectRepository(PlanPhase)
    private readonly planPhaseRepository: Repository<PlanPhase>,
    @InjectRepository(DevelopmentPlan)
    private readonly developmentPlanRepository: Repository<DevelopmentPlan>,
    @InjectRepository(WorkHistory)
    private readonly workHistoryRepository: Repository<WorkHistory>,
  ) {}

  async create(
    createPlanPhaseDto: CreatePlanPhaseDto,
    userId: string,
  ): Promise<PlanPhase> {
    try {
      const { developmentPlanId, openDate, closeDate, phaseType, isMerged } =
        createPlanPhaseDto;

      // Validate date range
      const startDate = new Date(openDate);
      const endDate = new Date(closeDate);

      if (startDate >= endDate) {
        throw new BadRequestException(
          'วันที่เปิดต้องน้อยกว่าวันที่ปิด',
        );
      }

      // Validate development plan exists
      const developmentPlan = await this.developmentPlanRepository.findOne({
        where: { id: developmentPlanId },
      });

      if (!developmentPlan) {
        throw new NotFoundException(
          `Development Plan with ID ${developmentPlanId} not found`,
        );
      }

      // Get work history for the user
      const workHistory = await this.workHistoryRepository.findOne({
        where: { user: { id: userId } },
      });

      if (!workHistory) {
        throw new NotFoundException('Work history not found for this user');
      }

      // Check for overlapping phases of the same type for this development plan
      const overlappingPhases = await this.planPhaseRepository.find({
        where: {
          developmentPlan: { id: developmentPlanId },
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
          `ช่วงวันที่นี้ซ้อนกับ Phase ${phaseType} อื่นของ Development Plan นี้`,
        );
      }

      if (createPlanPhaseDto.isOpen) {
        await this.planPhaseRepository.update(
          {
            developmentPlan: { id: developmentPlanId },
            phaseType,
            isOpen: true,
          },
          { isOpen: false },
        );
      }

      const planPhase = this.planPhaseRepository.create({
        developmentPlan,
        openDate: startDate,
        closeDate: endDate,
        phaseType,
        isMerged: isMerged ?? false,
        isOpen: createPlanPhaseDto.isOpen ?? true,
        createdBy: workHistory,
      });

      return await this.planPhaseRepository.save(planPhase);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findAll(developmentPlanId?: string): Promise<PlanPhase[]> {
    try {
      const where: any = {};
      if (developmentPlanId) {
        where.developmentPlan = { id: developmentPlanId };
      }

      return await this.planPhaseRepository.find({
        where,
        relations: ['developmentPlan', 'createdBy', 'createdBy.user'],
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
        relations: ['developmentPlan', 'createdBy', 'createdBy.user'],
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
        relations: ['developmentPlan'],
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
      const developmentPlanId = planPhase.developmentPlan.id;

      if (updatePlanPhaseDto.openDate || updatePlanPhaseDto.closeDate || updatePlanPhaseDto.phaseType) {
        const overlappingPhases = await this.planPhaseRepository.find({
          where: {
            developmentPlan: { id: developmentPlanId },
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
            `ช่วงวันที่นี้ซ้อนกับ Phase ${phaseType} อื่นของ Development Plan นี้`,
          );
        }
      }

      // Update development plan if developmentPlanId is provided
      if (updatePlanPhaseDto.developmentPlanId) {
        const developmentPlan = await this.developmentPlanRepository.findOne({
          where: { id: updatePlanPhaseDto.developmentPlanId },
        });

        if (!developmentPlan) {
          throw new NotFoundException(
            `Development Plan with ID ${updatePlanPhaseDto.developmentPlanId} not found`,
          );
        }

        planPhase.developmentPlan = developmentPlan;
      }

      const targetDevelopmentPlanId = planPhase.developmentPlan.id;
      const targetPhaseType = updatePlanPhaseDto.phaseType ?? planPhase.phaseType;

      if (updatePlanPhaseDto.isOpen === true && !planPhase.isOpen) {
        await this.planPhaseRepository.update(
          {
            developmentPlan: { id: targetDevelopmentPlanId },
            phaseType: targetPhaseType,
            isOpen: true,
          },
          { isOpen: false },
        );
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
        isOpen:
          updatePlanPhaseDto.isOpen !== undefined
            ? updatePlanPhaseDto.isOpen
            : planPhase.isOpen,
      });

      return await this.planPhaseRepository.save(planPhase);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async updateOpenState(id: string, isOpen: boolean): Promise<PlanPhase> {
    try {
      const planPhase = await this.planPhaseRepository.findOne({
        where: { id },
        relations: ['developmentPlan'],
      });

      if (!planPhase) {
        throw new NotFoundException(`Plan Phase with ID ${id} not found`);
      }

      if (isOpen && !planPhase.isOpen) {
        await this.planPhaseRepository.update(
          {
            developmentPlan: { id: planPhase.developmentPlan.id },
            phaseType: planPhase.phaseType,
            isOpen: true,
          },
          { isOpen: false },
        );
      }

      planPhase.isOpen = isOpen;
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