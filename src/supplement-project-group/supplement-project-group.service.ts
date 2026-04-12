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
import { ProjectClassificationValidator } from 'src/common/project-classification/project-classification.validator';
import { BookFormatResolver } from 'src/common/project-classification/book-format.resolver';
import { DevelopmentIssue } from 'src/development-issue/entities/development-issue.entity';
import { ReportFormat } from 'src/development-plan/types/report-format.enum';
import {
  ERROR_CODES,
  ERROR_MESSAGES,
} from 'src/common/project-classification/constants';

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
    private readonly classificationValidator: ProjectClassificationValidator,
    private readonly bookFormatResolver: BookFormatResolver,
  ) {}

  async create(
    dto: CreateSupplementProjectGroupDto,
    userId: string,
  ): Promise<SupplementProjectGroup> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        // CLAUDE.md §16.5 — resolve format from the supplement chain
        // BEFORE validating foreign keys so we know which classification
        // slots to require.
        const format = await this.bookFormatResolver.resolveBySupplement(
          dto.developmentPlanSupplementId,
          manager,
        );
        this.classificationValidator.validate(format, {
          strategyId: dto.strategyId,
          tacticId: dto.tacticId,
          planId: dto.planId,
          developmentIssueId: dto.developmentIssueId,
          indicator: dto.indicator,
        });

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

        // §16.6 — ISSUE_BASED: resolve + validate the issue belongs to
        // the parent plan.
        let developmentIssue: DevelopmentIssue | null = null;
        if (format === ReportFormat.ISSUE_BASED) {
          if (!dto.developmentIssueId) {
            // ProjectClassificationValidator already rejected this, but
            // keep a belt-and-braces guard for readers of this function.
            throw new BadRequestException(
              `${ERROR_CODES.PROJECT_CLASSIFICATION_SHAPE_MISMATCH}: ${ERROR_MESSAGES.ISSUE_BASED_REQUIRES_ISSUE}`,
            );
          }
          developmentIssue = await manager.findOne(DevelopmentIssue, {
            where: { id: dto.developmentIssueId },
            relations: ['developmentPlan'],
          });
          if (!developmentIssue) {
            throw new NotFoundException(
              `${ERROR_CODES.DEVELOPMENT_ISSUE_NOT_FOUND}: ${ERROR_MESSAGES.DEVELOPMENT_ISSUE_NOT_FOUND}`,
            );
          }
          if (developmentIssue.developmentPlan?.id !== developmentPlan.id) {
            throw new BadRequestException(
              `${ERROR_CODES.DEVELOPMENT_ISSUE_PLAN_MISMATCH}: ${ERROR_MESSAGES.DEVELOPMENT_ISSUE_PLAN_MISMATCH}`,
            );
          }
        }

        // §16.5 — mutually exclusive classification columns.
        const classificationColumns =
          format === ReportFormat.ISSUE_BASED
            ? {
                strategy: null,
                tactic: null,
                plan: null,
                indicator: null,
                developmentIssue,
              }
            : {
                strategy: strategy as any,
                tactic: tactic as any,
                plan: plan as any,
                indicator: dto.indicator,
                developmentIssue: null,
              };

        const supplementProjectGroup = manager.create(SupplementProjectGroup, {
          developmentPlanSupplement: developmentPlanSupplement as any,
          title: dto.title,
          objective: dto.objective,
          goal: dto.goal,
          startLat: dto.startLat,
          startLng: dto.startLng,
          endLat: dto.endLat,
          endLng: dto.endLng,
          expected: dto.expected,
          projectYear: dto.projectYear,
          isDraft: dto.isDraft ?? false,
          ...classificationColumns,
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
          relations: [
            'developmentPlanSupplement',
            'strategy',
            'tactic',
            'plan',
            'developmentIssue',
          ],
        });

        if (!existingProject) {
          throw new NotFoundException(
            `SupplementProjectGroup with ID ${id} not found`,
          );
        }

        // CLAUDE.md §16.5 — validate classification shape against the
        // parent plan resolved through the supplement chain.
        const format =
          await this.bookFormatResolver.resolveBySupplementProjectGroup(
            id,
            manager,
          );
        this.classificationValidator.validate(format, {
          strategyId: dto.strategyId ?? existingProject.strategy?.id ?? null,
          tacticId: dto.tacticId ?? existingProject.tactic?.id ?? null,
          planId: dto.planId ?? existingProject.plan?.id ?? null,
          developmentIssueId:
            dto.developmentIssueId ??
            existingProject.developmentIssue?.id ??
            null,
          indicator: dto.indicator ?? existingProject.indicator,
        });

        // Validate foreign keys if provided
        const [
          developmentPlanSupplement,
          strategy,
          tactic,
          plan,
          workHistory,
        ] = await this.validateForeignKeys(manager, dto, userId, existingProject);

        // Resolve developmentIssue FK if present on the update DTO.
        let updatedDevelopmentIssue: DevelopmentIssue | null | undefined;
        if (dto.developmentIssueId !== undefined) {
          if (dto.developmentIssueId === null) {
            updatedDevelopmentIssue = null;
          } else {
            updatedDevelopmentIssue = await manager.findOne(DevelopmentIssue, {
              where: { id: dto.developmentIssueId },
            });
            if (!updatedDevelopmentIssue) {
              throw new NotFoundException(
                `${ERROR_CODES.DEVELOPMENT_ISSUE_NOT_FOUND}: ${ERROR_MESSAGES.DEVELOPMENT_ISSUE_NOT_FOUND}`,
              );
            }
          }
        }

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

        if (format === ReportFormat.ISSUE_BASED) {
          // §16.5 — clear the classic tuple + indicator, keep the issue FK
          existingProject.strategy = null;
          existingProject.tactic = null;
          existingProject.plan = null;
          existingProject.indicator = null;
          if (updatedDevelopmentIssue !== undefined) {
            existingProject.developmentIssue = updatedDevelopmentIssue;
          }
        } else {
          if (strategy) existingProject.strategy = strategy;
          if (tactic) existingProject.tactic = tactic;
          if (plan) existingProject.plan = plan;
          existingProject.developmentIssue = null;
        }
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

