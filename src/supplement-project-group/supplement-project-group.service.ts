import {
  Injectable,
  NotFoundException,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { CreateSupplementProjectGroupDto } from './dto/create-supplement-project-group.dto';
import { UpdateSupplementProjectGroupDto } from './dto/update-supplement-project-group.dto';
import { SupplementProjectGroup } from './entities/supplement-project-group.entity';
import { DevelopmentPlanSupplement } from 'src/development-plan-supplement/entities/development-plan-supplement.entity';
import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { Strategy } from 'src/strategy/entities/strategy.entity';
import { Tactic } from 'src/tactic/entities/tactic.entity';
import { Plan } from 'src/plan/entities/plan.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { Budget } from 'src/budget/entities/budget.entity';
import { handleException } from 'src/util/handleException';
import { TrackingStatus } from 'src/tracking-status/entities/tracking-status.entity';

@Injectable()
export class SupplementProjectGroupService {
  private readonly logger = new Logger(SupplementProjectGroupService.name);

  constructor(
    @InjectRepository(SupplementProjectGroup)
    private readonly supplementProjectGroupRepo: Repository<SupplementProjectGroup>,

    @InjectRepository(DevelopmentPlanSupplement)
    private readonly developmentPlanSupplementRepo: Repository<DevelopmentPlanSupplement>,

    @InjectRepository(DevelopmentPlan)
    private readonly developmentPlanRepo: Repository<DevelopmentPlan>,

    @InjectRepository(Strategy)
    private readonly strategyRepo: Repository<Strategy>,

    @InjectRepository(Tactic)
    private readonly tacticRepo: Repository<Tactic>,

    @InjectRepository(Plan)
    private readonly planRepo: Repository<Plan>,

    @InjectRepository(WorkHistory)
    private readonly workHistoryRepo: Repository<WorkHistory>,

    @InjectRepository(Budget)
    private readonly budgetRepo: Repository<Budget>,

    private readonly dataSource: DataSource,
  ) {}

  async create(
    dto: CreateSupplementProjectGroupDto,
    userId: string,
  ): Promise<SupplementProjectGroup> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        // Validate foreign keys
        const [
          developmentPlanSupplement,
          strategy,
          tactic,
          plan,
          workHistory,
        ] = await this.validateForeignKeys(manager, dto, userId);

        if (!developmentPlanSupplement) {
          throw new NotFoundException(
            `DevelopmentPlanSupplement with ID ${dto.developmentPlanSupplementId} is required`,
          );
        }

        const developmentPlan = developmentPlanSupplement.developmentPlan;

        const supplementProjectGroup = manager.create(SupplementProjectGroup, {
          developmentPlanSupplement: developmentPlanSupplement as any,
          title: dto.title,
          objective: dto.objective,
          goal: dto.goal,
          startLat: dto.startLat,
          startLng: dto.startLng,
          endLat: dto.endLat,
          endLng: dto.endLng,
          indicator: dto.indicator,
          expected: dto.expected,
          projectYear: dto.projectYear,
          isDraft: dto.isDraft ?? false,
          strategy: strategy as any,
          tactic: tactic as any,
          plan: plan as any,
          createdBy: workHistory,
          originAgencyId: dto.originAgencyId ? { id: dto.originAgencyId } as any : null,
          responsibleAgency: dto.responsibleAgency ? { id: dto.responsibleAgency } as any : null,
          additionalDetail: dto.additionalDetail,
          isLatest: true, // Set as latest version
        });

        const savedProject = await manager.save(supplementProjectGroup);

        // Create initial tracking status
        const trackingStatus = manager.create(TrackingStatus, {
          supplementProjectGroupId: savedProject,
          statusId: { id: '96be5646-cd55-4542-ae92-b82b2935167e' } as any, // Assuming this is a default status ID
          createdBy: workHistory,
        });
        await manager.save(trackingStatus);

        // Create budgets if provided
        if (dto.budget && dto.budget.length > 0) {
          // Validate budget year is within development plan range
          for (const budgetItem of dto.budget) {
            if (
              budgetItem.year < developmentPlan.startYear ||
              budgetItem.year > developmentPlan.endYear
            ) {
              throw new BadRequestException(
                `ปีงบประมาณต้องอยู่ในช่วง พ.ศ. ${developmentPlan.startYear} - ${developmentPlan.endYear} (ปีที่ส่งมา: ${budgetItem.year})`,
              );
            }
          }

          const budgets = dto.budget.map((budgetDto) => {
            const { projectGroupId, revisedProjectGroupId, ...budgetData } = budgetDto;
            return manager.create(Budget, {
              ...budgetData,
              supplementProjectGroupId: savedProject,
            });
          });

          await manager.save(budgets);
        }

        return savedProject;
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findAll(): Promise<SupplementProjectGroup[]> {
    try {
      return await this.supplementProjectGroupRepo.find({
        relations: [
          'developmentPlanSupplement',
          'strategy',
          'tactic',
          'plan',
          'createdBy',
          'budgets',
        ],
        order: { createdAt: 'DESC' },
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findBySupplement(supplementId: string): Promise<SupplementProjectGroup[]> {
    try {
      return await this.supplementProjectGroupRepo.find({
        where: { developmentPlanSupplement: { id: supplementId } },
        relations: [
          'developmentPlanSupplement',
          'strategy',
          'tactic',
          'plan',
          'createdBy',
          'budgets',
        ],
        order: { createdAt: 'DESC' },
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findOne(id: string): Promise<SupplementProjectGroup> {
    try {
      const supplementProject = await this.supplementProjectGroupRepo.findOne({
        where: { id },
        relations: [
          'developmentPlanSupplement',
          'strategy',
          'tactic',
          'plan',
          'createdBy',
          'budgets',
          'trackingStatus',
        ],
      });

      if (!supplementProject) {
        throw new NotFoundException(
          `SupplementProjectGroup with ID ${id} not found`,
        );
      }

      return supplementProject;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async update(
    id: string,
    dto: UpdateSupplementProjectGroupDto,
    userId: string,
  ): Promise<SupplementProjectGroup> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        const existingProject = await manager.findOne(SupplementProjectGroup, {
          where: { id },
          relations: ['developmentPlanSupplement'],
        });

        if (!existingProject) {
          throw new NotFoundException(
            `SupplementProjectGroup with ID ${id} not found`,
          );
        }

        // Validate foreign keys if provided
        const [
          developmentPlanSupplement,
          strategy,
          tactic,
          plan,
          workHistory,
        ] = await this.validateForeignKeys(manager, dto, userId, existingProject);

        // Update fields
        if (developmentPlanSupplement) {
          existingProject.developmentPlanSupplement = developmentPlanSupplement;
        }
        if (dto.title !== undefined) existingProject.title = dto.title;
        if (dto.objective !== undefined) existingProject.objective = dto.objective;
        if (dto.goal !== undefined) existingProject.goal = dto.goal;
        if (dto.startLat !== undefined) existingProject.startLat = dto.startLat;
        if (dto.startLng !== undefined) existingProject.startLng = dto.startLng;
        if (dto.endLat !== undefined) existingProject.endLat = dto.endLat;
        if (dto.endLng !== undefined) existingProject.endLng = dto.endLng;
        if (dto.indicator !== undefined) existingProject.indicator = dto.indicator;
        if (dto.expected !== undefined) existingProject.expected = dto.expected;
        if (dto.projectYear !== undefined) existingProject.projectYear = dto.projectYear;
        if (dto.isDraft !== undefined) existingProject.isDraft = dto.isDraft;
        if (strategy) existingProject.strategy = strategy;
        if (tactic) existingProject.tactic = tactic;
        if (plan) existingProject.plan = plan;
        if (dto.originAgencyId !== undefined) {
          existingProject.originAgencyId = dto.originAgencyId ? { id: dto.originAgencyId } as any : null;
        }
        if (dto.responsibleAgency !== undefined) {
          existingProject.responsibleAgency = dto.responsibleAgency ? { id: dto.responsibleAgency } as any : null;
        }
        if (dto.additionalDetail !== undefined) {
          existingProject.additionalDetail = dto.additionalDetail;
        }

        const developmentPlan = existingProject.developmentPlanSupplement.developmentPlan;

        // Update budgets if provided
        if (dto.budget && dto.budget.length > 0) {
          // Validate budget year is within development plan range
          for (const budgetItem of dto.budget) {
            if (
              budgetItem.year < developmentPlan.startYear ||
              budgetItem.year > developmentPlan.endYear
            ) {
              throw new BadRequestException(
                `ปีงบประมาณต้องอยู่ในช่วง พ.ศ. ${developmentPlan.startYear} - ${developmentPlan.endYear} (ปีที่ส่งมา: ${budgetItem.year})`,
              );
            }
          }

          // Delete existing budgets
          await manager.delete(Budget, {
            supplementProjectGroupId: { id: existingProject.id } as any,
          });

          // Create new budgets
          const budgets = dto.budget.map((budgetDto) => {
            const { projectGroupId, revisedProjectGroupId, ...budgetData } = budgetDto;
            return manager.create(Budget, {
              ...budgetData,
              supplementProjectGroupId: existingProject,
            });
          });

          await manager.save(budgets);
        }

        return await manager.save(existingProject);
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async remove(id: string): Promise<{ message: string }> {
    try {
      const result = await this.supplementProjectGroupRepo.delete(id);
      if (result.affected === 0) {
        throw new NotFoundException(
          `SupplementProjectGroup with ID ${id} not found`,
        );
      }
      return {
        message: `SupplementProjectGroup with ID ${id} has been permanently removed.`,
      };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  private async validateForeignKeys(
    manager,
    dto: CreateSupplementProjectGroupDto | UpdateSupplementProjectGroupDto,
    userId: string,
    existingProject?: SupplementProjectGroup,
  ): Promise<
    [
      DevelopmentPlanSupplement | null,
      Strategy | null,
      Tactic | null,
      Plan | null,
      WorkHistory,
    ]
  > {
    const isCreate = 'developmentPlanSupplementId' in dto && dto.developmentPlanSupplementId !== undefined;
    const supplementId = isCreate
      ? dto.developmentPlanSupplementId
      : existingProject?.developmentPlanSupplement?.id;

    const [
      developmentPlanSupplement,
      strategy,
      tactic,
      plan,
      workHistory,
    ] = await Promise.all([
      supplementId
        ? manager.findOne(DevelopmentPlanSupplement, {
            where: { id: supplementId },
            relations: ['developmentPlan'],
          })
        : null,
      dto.strategyId
        ? manager.findOne(Strategy, { where: { id: dto.strategyId } })
        : null,
      dto.tacticId
        ? manager.findOne(Tactic, { where: { id: dto.tacticId } })
        : null,
      dto.planId
        ? manager.findOne(Plan, { where: { id: dto.planId } })
        : null,
      this.workHistoryRepo.findOne({
        where: { user: { id: userId } },
      }),
    ]);

    if (isCreate && !developmentPlanSupplement) {
      throw new NotFoundException(
        `DevelopmentPlanSupplement with ID ${supplementId} not found`,
      );
    }

    if (dto.strategyId && !strategy) {
      throw new NotFoundException(`Strategy with ID ${dto.strategyId} not found`);
    }

    if (dto.tacticId && !tactic) {
      throw new NotFoundException(`Tactic with ID ${dto.tacticId} not found`);
    }

    if (dto.planId && !plan) {
      throw new NotFoundException(`Plan with ID ${dto.planId} not found`);
    }

    if (!workHistory) {
      throw new NotFoundException('Work history not found for this user');
    }

    return [developmentPlanSupplement, strategy, tactic, plan, workHistory];
  }
}

