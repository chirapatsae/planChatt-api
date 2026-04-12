import { WorkHistory } from './../work-history/entities/work-history.entity';
import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
  ConflictException,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, DeepPartial, EntityManager, IsNull, Not, Repository } from 'typeorm';
import { ProjectGroup } from './entities/project-group.entity';
import { CreateDraftProjectGroupDto, CreateProjectGroupDto } from './dto/create-project-group.dto';
import { BulkAssignAgencyDto, UpdateProjectGroupDto } from './dto/update-project-group.dto';
import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { TrackingStatus } from 'src/tracking-status/entities/tracking-status.entity';
import { Budget } from 'src/budget/entities/budget.entity';
import { Tactic } from 'src/tactic/entities/tactic.entity';
import { Plan } from 'src/plan/entities/plan.entity';
import { Strategy } from 'src/strategy/entities/strategy.entity';
import { Cron, CronExpression } from '@nestjs/schedule';
import { handleException } from 'src/util/handleException';
import { GovernmentAgency } from 'src/government-agencies/entities/government-agency.entity';
import { User } from 'src/users/entities/user.entity';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';
import { DevelopmentPlanRevision } from 'src/development-plan-revision/entities/development-plan-revision.entity';
import { Amphoe } from 'src/amphoes/entities/amphoe.entity';
import { LocalAdministrativeOrganization } from 'src/local-administrative-organizations/entities/local-administrative-organization.entity';
import {
  IUnifiedProjectDisplay,
  UnifiedProjectMapper,
} from './dto/unified-project-display.dto';
import { IProjectVersionsResponse } from './dto/project-versions.dto';
import { PdfOutAuthorityDocument } from 'src/pdf/entities/pdf-out-authority-document.entity';
import { PlanPhase, PhaseType } from 'src/plan-phase/entities/plan-phase.entity';
import { GeoBoundaryService } from 'src/ai/geo-boundary.service';
import { LineageLockService } from 'src/common/lineage-lock/lineage-lock.service';
import { ProjectClassificationValidator } from 'src/common/project-classification/project-classification.validator';
import { BookFormatResolver } from 'src/common/project-classification/book-format.resolver';
import { DevelopmentIssue } from 'src/development-issue/entities/development-issue.entity';
import { ReportFormat } from 'src/development-plan/types/report-format.enum';
import {
  ERROR_CODES,
  ERROR_MESSAGES,
} from 'src/common/project-classification/constants';

@Injectable()
export class ProjectGroupsService {
  private readonly logger = new Logger(ProjectGroupsService.name);

  constructor(
    @InjectRepository(ProjectGroup)
    private readonly projectGroupRepo: Repository<ProjectGroup>,

    @InjectRepository(WorkHistory)
    private readonly workHistoryRepo: Repository<WorkHistory>,

    @InjectRepository(DevelopmentPlan)
    private readonly developmentPlanRepo: Repository<DevelopmentPlan>,

    @InjectRepository(TrackingStatus)
    private readonly trackingStatusRepo: Repository<TrackingStatus>,

    @InjectRepository(Strategy)
    private readonly strategyRepo: Repository<Strategy>,

    @InjectRepository(Tactic)
    private readonly tacticRepo: Repository<Tactic>,

    @InjectRepository(Plan)
    private readonly planRepo: Repository<Plan>,

    @InjectRepository(Budget)
    private readonly budgetRepo: Repository<Budget>,

    @InjectRepository(User)
    private readonly userRepo: Repository<User>,

    @InjectRepository(RevisedProjectGroup)
    private readonly revisedProjectGroupRepo: Repository<RevisedProjectGroup>,

    @InjectRepository(DevelopmentPlanRevision)
    private readonly developmentPlanRevisionRepo: Repository<DevelopmentPlanRevision>,

    @InjectRepository(Amphoe)
    private readonly amphoeRepo: Repository<Amphoe>,

    @InjectRepository(LocalAdministrativeOrganization)
    private readonly localAdministrativeOrgRepo: Repository<LocalAdministrativeOrganization>,

    @InjectRepository(PdfOutAuthorityDocument)
    private readonly pdfOutAuthorityRepo: Repository<PdfOutAuthorityDocument>,

    private readonly dataSource: DataSource,
    private readonly geoBoundaryService: GeoBoundaryService,
    private readonly lineageLockService: LineageLockService,
    private readonly classificationValidator: ProjectClassificationValidator,
    private readonly bookFormatResolver: BookFormatResolver,
  ) { }

  /**
   * CLAUDE.md §16.5 — invokes the shared ProjectClassificationValidator
   * for the supplied plan id + DTO. Additionally enforces the
   * service-layer "issue belongs to the same plan" guard that the
   * standalone validator intentionally leaves out (see §16 note on
   * plan-awareness).
   *
   * MUST be called from every create/update/publishDraft path BEFORE
   * any repository write.
   */
  private async validateClassificationShape(
    manager: EntityManager,
    planId: string,
    dto: {
      strategyId?: string | null;
      tacticId?: string | null;
      planId?: string | null;
      developmentIssueId?: string | null;
      indicator?: string | null;
    },
  ): Promise<ReportFormat> {
    const format = await this.bookFormatResolver.resolveByPlan(planId, manager);
    this.classificationValidator.validate(format, {
      strategyId: dto.strategyId,
      tacticId: dto.tacticId,
      planId: dto.planId,
      developmentIssueId: dto.developmentIssueId,
      indicator: dto.indicator,
    });

    if (format === ReportFormat.ISSUE_BASED && dto.developmentIssueId) {
      // Issue-belongs-to-plan check (plan-aware guard, §16 note).
      const issue = await manager.findOne(DevelopmentIssue, {
        where: { id: dto.developmentIssueId },
        relations: ['developmentPlan'],
      });
      if (!issue) {
        throw new NotFoundException(
          `${ERROR_CODES.DEVELOPMENT_ISSUE_NOT_FOUND}: ${ERROR_MESSAGES.DEVELOPMENT_ISSUE_NOT_FOUND}`,
        );
      }
      if (issue.developmentPlan?.id !== planId) {
        throw new BadRequestException(
          `${ERROR_CODES.DEVELOPMENT_ISSUE_PLAN_MISMATCH}: ${ERROR_MESSAGES.DEVELOPMENT_ISSUE_PLAN_MISMATCH}`,
        );
      }
    }

    return format;
  }

  async create(dto: CreateProjectGroupDto, userId: string) {
    try {
      return await this.dataSource.transaction(async (manager) => {
        const workHistory = await this.getWorkHistory(manager, userId);
        this.assertWorkStatusApproved(workHistory);
        await this.ensureNoDuplicateTitle(manager, dto.title, workHistory.id, undefined);

        // CLAUDE.md §16.5 — validate classification shape BEFORE the
        // repository write and BEFORE any format-specific FK lookup so
        // a mismatched DTO never consumes a strategy/tactic/plan
        // lookup slot that would otherwise NotFound-fail confusingly.
        const format = await this.validateClassificationShape(
          manager,
          dto.developmentPlanId,
          dto,
        );

        const [developmentPlan, strategy, tactic, plan] =
          await this.validateForeignKeys(manager, dto, format);
        await this.validatePlanPhase(manager, developmentPlan as DevelopmentPlan, workHistory);
        const agencyData = this.getAgencyData(workHistory);

        // §16.5 — for ISSUE_BASED plans we clear the strategy/tactic/plan
        // tuple and the indicator, and attach the issue FK. For
        // STRATEGY_BASED plans we clear the issue FK (defensive — the
        // validator already rejected it).
        const classificationColumns =
          format === ReportFormat.ISSUE_BASED
            ? {
                strategy: null,
                tactic: null,
                plan: null,
                indicator: null,
                developmentIssue: { id: dto.developmentIssueId } as DevelopmentIssue,
              }
            : {
                strategy,
                tactic,
                plan,
                indicator: dto.indicator,
                developmentIssue: null,
              };

        const group = manager.create(ProjectGroup, {
          title: dto.title,
          objective: dto.objective,
          goal: dto.goal,
          startLat: dto.startLat,
          startLng: dto.startLng,
          endLat: dto.endLat,
          endLng: dto.endLng,
          expected: dto.expected,
          projectYear: dto.projectYear,
          isBooked: dto.isBooked ?? false,
          ...classificationColumns,
          developmentPlan,
          createdBy: workHistory,
          originAgencyId: workHistory.localAdministrativeOrganization.id === '3001027' ? null : { id: workHistory.localAdministrativeOrganization.id },
          amphoe: { id: workHistory.amphoe.id },
          localAdministrativeOrganization: { id: workHistory.localAdministrativeOrganization.id },
          ...agencyData,
        } as DeepPartial<ProjectGroup>);

        const savedGroup = await manager.save(group);

        const trackingStatus = manager.create(TrackingStatus, {
          projectGroupId: savedGroup,
          statusId: { id: '8219cd82-fa61-4292-bd0d-fa58b08507e1' }, //รอนำส่ง
          createdBy: workHistory,
          isLatest: true,
        });
        await manager.save(trackingStatus);

        if (!Array.isArray(dto.budget) || dto.budget.length === 0) {
          throw new BadRequestException('งบประมาณไม่ถูกต้องหรือไม่มีข้อมูล');
        }

        // ปีงบประมาณปัจจุบัน (รูปแบบ พ.ศ.)
        const projectYear =
          new Date().getMonth() + 1 >= 10
            ? new Date().getFullYear() + 544
            : new Date().getFullYear() + 543;

        // เลือกบันทึกเฉพาะงบประมาณที่อยู่ในกรอบปีของแผนพัฒนาฯ และไม่ต่ำกว่าปีงบประมาณปัจจุบัน
        const validBudgets = dto.budget.filter((budgetItem) => {
          const year = budgetItem.year;
          const dp = developmentPlan as DevelopmentPlan;
          return (
            year >= dp.startYear &&
            year <= dp.endYear &&
            year >= projectYear
          );
        });

        const budgets = validBudgets.map((item) =>
          manager.create(Budget, {
            projectGroupId: { id: savedGroup.id },
            year: item.year,
            quantity: item.quantity,
          })
        );
        await manager.save(budgets);


        return savedGroup;
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }



  async createDraft(dto: CreateDraftProjectGroupDto, userId: string) {
    try {
      const { id: savedDraftId, geoWarning } = await this.dataSource.transaction(async (manager) => {
        const workHistory = await this.getWorkHistory(manager, userId);
        this.assertWorkStatusApproved(workHistory);
        await this.ensureNoDuplicateTitle(manager, dto.title, workHistory.id, undefined);

        // CLAUDE.md §16.5 — draft classification shape validation.
        // Drafts are allowed to omit classification entirely (both slots
        // empty); but if EITHER slot has data, it must satisfy the shape
        // invariant for the resolved plan format. When the draft has no
        // developmentPlanId yet we skip shape validation — the publish
        // step will enforce it.
        if (dto.developmentPlanId) {
          const format = await this.bookFormatResolver.resolveByPlan(
            dto.developmentPlanId,
            manager,
          );
          // Drafts MAY be partial, so we only enforce when ANY
          // classification slot is populated.
          const hasAnyClassification =
            !!dto.strategyId ||
            !!dto.tacticId ||
            !!dto.planId ||
            !!dto.developmentIssueId ||
            (typeof dto.indicator === 'string' && dto.indicator.trim() !== '');
          if (hasAnyClassification) {
            this.classificationValidator.validate(format, {
              strategyId: dto.strategyId,
              tacticId: dto.tacticId,
              planId: dto.planId,
              developmentIssueId: dto.developmentIssueId,
              indicator: dto.indicator,
            });
          }
        }

        // Validate only strategy, tactic, plan for draft (skip developmentPlan validation)
        const [strategy, tactic, plan, developmentIssue] = await Promise.all([
          dto.strategyId ? manager.findOne(Strategy, { where: { id: dto.strategyId } }) : null,
          dto.tacticId ? manager.findOne(Tactic, { where: { id: dto.tacticId } }) : null,
          dto.planId ? manager.findOne(Plan, { where: { id: dto.planId } }) : null,
          dto.developmentIssueId
            ? manager.findOne(DevelopmentIssue, { where: { id: dto.developmentIssueId } })
            : null,
        ]);

        if (dto.strategyId && !strategy) throw new NotFoundException(`Strategy ID not found: ${dto.strategyId}`);
        if (dto.tacticId && !tactic) throw new NotFoundException(`Tactic ID not found: ${dto.tacticId}`);
        if (dto.planId && !plan) throw new NotFoundException(`Plan ID not found: ${dto.planId}`);
        if (dto.developmentIssueId && !developmentIssue)
          throw new NotFoundException(
            `${ERROR_CODES.DEVELOPMENT_ISSUE_NOT_FOUND}: ${ERROR_MESSAGES.DEVELOPMENT_ISSUE_NOT_FOUND}`,
          );

        const agencyData = this.getAgencyData(workHistory);

        let projectGroupData: any = {
          title: dto.title,
          projectYear: dto.projectYear,
          createdBy: workHistory,
          isDraft: true,
          isBooked: dto.isBooked ?? false,
          objective: dto.objective || '',
          goal: dto.goal || '',
          startLat: dto.startLat ?? null,
          startLng: dto.startLng ?? null,
          endLat: dto.endLat ?? null,
          endLng: dto.endLng ?? null,
          // CLAUDE.md §16.5 — indicator is nullable for ISSUE_BASED.
          // An empty string here is coerced to null so the CHECK
          // constraint `indicator <> ''` doesn't reject the insert.
          indicator:
            dto.indicator && dto.indicator.trim() !== ''
              ? dto.indicator
              : null,
          expected: dto.expected || '',
          ...agencyData,
        }

        if (strategy) projectGroupData.strategy = strategy;
        if (tactic) projectGroupData.tactic = tactic;
        if (plan) projectGroupData.plan = plan;
        if (developmentIssue) projectGroupData.developmentIssue = developmentIssue;

        const group = manager.create(
          ProjectGroup,
          projectGroupData,
        );
        const savedGroupResult = await manager.save(group);

        if (Array.isArray(dto.budget) && dto.budget.length > 0) {
          const projectYear = new Date().getMonth() + 1 >= 10 ? new Date().getFullYear() + 544 : new Date().getFullYear() + 543;

          for (const budgetItem of dto.budget) {
            if (budgetItem.year < projectYear) {
              throw new BadRequestException(
                `ปีงบประมาณต้องไม่น้อยกว่าปีปัจจุบัน พ.ศ. ${projectYear} (ปีที่ส่งมา: ${budgetItem.year})`
              );
            }
          }

          const budgets = dto.budget.map((item) =>
            manager.create(Budget, {
              projectGroupId: { id: savedGroupResult.id },
              year: item.year,
              quantity: item.quantity,
            })
          );
          await manager.save(budgets);
        }

        return {
          id: savedGroupResult.id,
          geoWarning: this.checkGeoWarning(workHistory, dto),
        };
      });

      return { message: 'Create draft success', id: savedDraftId, ...(geoWarning ? { geoWarning } : {}) };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async publishDraft(id: string, dto: CreateProjectGroupDto, userId: string) {
    try {
      await this.dataSource.transaction(async (manager) => {
        // 1-3. WorkHistory + workStatus
        const workHistory = await this.getWorkHistory(manager, userId);
        this.assertWorkStatusApproved(workHistory);

        // 4. Load project
        const existingDraft = await manager.findOne(ProjectGroup, {
          where: { id, isDraft: true },
          relations: ['createdBy'],
        });
        if (!existingDraft) {
          throw new NotFoundException('Draft not found');
        }

        // 5. Ownership: createdBy.id === workHistory.id (CLAUDE.md §4)
        if (existingDraft.createdBy?.id !== workHistory.id) {
          throw new ForbiddenException('คุณไม่มีสิทธิ์ดำเนินการกับโครงการนี้');
        }

        await this.ensureNoDuplicateTitle(manager, dto.title, workHistory.id, id);

        // CLAUDE.md §16.5 — publish path: shape is now required.
        const format = await this.validateClassificationShape(
          manager,
          dto.developmentPlanId,
          dto,
        );

        const [developmentPlan, strategy, tactic, plan] =
          await this.validateForeignKeys(manager, dto, format);

        // 6-7. PlanPhase scope
        await this.validatePlanPhase(manager, developmentPlan as DevelopmentPlan, workHistory);

        const agencyData = this.getAgencyData(workHistory);

        const classificationColumns =
          format === ReportFormat.ISSUE_BASED
            ? {
                strategy: null,
                tactic: null,
                plan: null,
                indicator: null,
                developmentIssue: {
                  id: dto.developmentIssueId,
                } as DevelopmentIssue,
              }
            : {
                strategy,
                tactic,
                plan,
                indicator: dto.indicator,
                developmentIssue: null,
              };

        // อัพเดท project group data
        const projectGroupData: any = {
          title: dto.title,
          objective: dto.objective,
          goal: dto.goal,
          startLat: dto.startLat,
          startLng: dto.startLng,
          endLat: dto.endLat,
          endLng: dto.endLng,
          expected: dto.expected,
          projectYear: dto.projectYear,
          isBooked: dto.isBooked ?? false,
          ...classificationColumns,
          developmentPlan,
          amphoe: { id: workHistory.amphoe.id },
          localAdministrativeOrganization: { id: workHistory.localAdministrativeOrganization.id },
          isDraft: false,
          ...agencyData,
        };

        // อัพเดท project group
        await manager.update(ProjectGroup, id, projectGroupData);

        await manager.update(TrackingStatus, { projectGroupId: { id } }, { isLatest: false });
        const trackingStatus = manager.create(TrackingStatus, {
          projectGroupId: { id },
          statusId: { id: '8219cd82-fa61-4292-bd0d-fa58b08507e1' },
          createdBy: workHistory,
          isLatest: true,
        });
        await manager.save(trackingStatus);

        // Delete existing budgets
        await manager.delete(Budget, { projectGroupId: { id } });

        // Create new budgets if provided
        if (dto.budget && dto.budget.length > 0) {
          // Validate budget year is within budget plan range
          for (const budgetItem of dto.budget) {
            if (budgetItem.year < (developmentPlan as DevelopmentPlan).startYear || budgetItem.year > (developmentPlan as DevelopmentPlan).endYear) {
              throw new BadRequestException(
                `ปีงบประมาณต้องอยู่ในช่วง พ.ศ. ${(developmentPlan as DevelopmentPlan).startYear} - ${(developmentPlan as DevelopmentPlan).endYear} (ปีที่ส่งมา: ${budgetItem.year})`
              );
            }
          }

          const budgets = dto.budget.map((item) =>
            manager.create(Budget, {
              projectGroupId: { id },
              year: item.year,
              quantity: item.quantity,
            })
          );
          await manager.save(budgets);
        }
      });

      return { message: 'Publish draft success' };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async updateDraft(id: string, dto: CreateDraftProjectGroupDto, userId: string) {
    try {
      const geoWarning = await this.dataSource.transaction(async (manager) => {
        // 1-3. WorkHistory + workStatus
        const workHistory = await this.getWorkHistory(manager, userId);
        this.assertWorkStatusApproved(workHistory);

        // 4. Load project
        const existingDraft = await manager.findOne(ProjectGroup, {
          where: { id, isDraft: true },
          relations: ['createdBy'],
        });
        if (!existingDraft) {
          throw new NotFoundException('Draft not found or you do not have permission to update it');
        }

        // 5. Ownership: createdBy.id === workHistory.id (CLAUDE.md §4)
        if (existingDraft.createdBy?.id !== workHistory.id) {
          throw new ForbiddenException('คุณไม่มีสิทธิ์ดำเนินการกับโครงการนี้');
        }

        await this.ensureNoDuplicateTitle(manager, dto.title, workHistory.id, id);

        // CLAUDE.md §16.5 — same soft rule as createDraft: if ANY
        // classification slot is populated AND the draft has a
        // developmentPlanId, validate the shape.
        if (dto.developmentPlanId) {
          const format = await this.bookFormatResolver.resolveByPlan(
            dto.developmentPlanId,
            manager,
          );
          const hasAnyClassification =
            !!dto.strategyId ||
            !!dto.tacticId ||
            !!dto.planId ||
            !!dto.developmentIssueId ||
            (typeof dto.indicator === 'string' && dto.indicator.trim() !== '');
          if (hasAnyClassification) {
            this.classificationValidator.validate(format, {
              strategyId: dto.strategyId,
              tacticId: dto.tacticId,
              planId: dto.planId,
              developmentIssueId: dto.developmentIssueId,
              indicator: dto.indicator,
            });
          }
        }

        // Validate only strategy, tactic, plan for draft (skip developmentPlan validation)
        const [strategy, tactic, plan, developmentIssue] = await Promise.all([
          dto.strategyId ? manager.findOne(Strategy, { where: { id: dto.strategyId } }) : null,
          dto.tacticId ? manager.findOne(Tactic, { where: { id: dto.tacticId } }) : null,
          dto.planId ? manager.findOne(Plan, { where: { id: dto.planId } }) : null,
          dto.developmentIssueId
            ? manager.findOne(DevelopmentIssue, { where: { id: dto.developmentIssueId } })
            : null,
        ]);

        if (dto.strategyId && !strategy) throw new NotFoundException(`Strategy ID not found: ${dto.strategyId}`);
        if (dto.tacticId && !tactic) throw new NotFoundException(`Tactic ID not found: ${dto.tacticId}`);
        if (dto.planId && !plan) throw new NotFoundException(`Plan ID not found: ${dto.planId}`);
        if (dto.developmentIssueId && !developmentIssue)
          throw new NotFoundException(
            `${ERROR_CODES.DEVELOPMENT_ISSUE_NOT_FOUND}: ${ERROR_MESSAGES.DEVELOPMENT_ISSUE_NOT_FOUND}`,
          );

        // อัพเดท project group data
        const projectGroupData: any = {
          title: dto.title,
          objective: dto.objective || '',
          goal: dto.goal || '',
          startLat: dto.startLat ?? null,
          startLng: dto.startLng ?? null,
          endLat: dto.endLat ?? null,
          endLng: dto.endLng ?? null,
          // §16.5 — empty-string indicator coerced to null so the
          // CHECK constraint accepts ISSUE_BASED drafts cleanly.
          indicator:
            dto.indicator && dto.indicator.trim() !== ''
              ? dto.indicator
              : null,
          expected: dto.expected || '',
          projectYear: dto.projectYear,
          isBooked: dto.isBooked ?? false,
          strategy,
          tactic,
          plan,
          developmentIssue: developmentIssue ?? null,
          isDraft: true,
        };

        await manager.update(ProjectGroup, id, projectGroupData);

        // Delete existing budgets
        await manager.delete(Budget, { projectGroupId: { id } });

        // Create new budgets if provided
        if (Array.isArray(dto.budget) && dto.budget.length > 0) {
          const projectYear = new Date().getMonth() + 1 >= 10 ? new Date().getFullYear() + 544 : new Date().getFullYear() + 543;

          for (const budgetItem of dto.budget) {
            if (budgetItem.year < projectYear) {
              throw new BadRequestException(
                `ปีงบประมาณต้องไม่น้อยกว่าปีปัจจุบัน พ.ศ. ${projectYear} (ปีที่ส่งมา: ${budgetItem.year})`
              );
            }
          }

          const budgets = dto.budget.map((item) =>
            manager.create(Budget, {
              projectGroupId: { id },
              year: item.year,
              quantity: item.quantity,
            })
          );
          await manager.save(budgets);
        }

        return this.checkGeoWarning(workHistory, dto);
      });
      return { message: 'Update draft success', ...(geoWarning ? { geoWarning } : {}) };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async simplePublish(id: string, userId: string) {
    try {
      await this.dataSource.transaction(async (manager) => {
        // 1-3. WorkHistory + workStatus
        const workHistory = await this.getWorkHistory(manager, userId);
        this.assertWorkStatusApproved(workHistory);

        // 4. Load project with developmentPlan
        const existingDraft = await manager.findOne(ProjectGroup, {
          where: { id, isDraft: true },
          relations: ['createdBy', 'developmentPlan'],
        });
        if (!existingDraft) {
          throw new NotFoundException(`Draft with ID ${id} not found or already published`);
        }

        // 5. Ownership: createdBy.id === workHistory.id (CLAUDE.md §4)
        if (existingDraft.createdBy?.id !== workHistory.id) {
          throw new ForbiddenException('คุณไม่มีสิทธิ์ดำเนินการกับโครงการนี้');
        }

        // 6-7. Plan scope + PlanPhase
        const dp = existingDraft.developmentPlan;
        if (!dp) throw new BadRequestException('โครงการ Draft ต้องระบุแผนพัฒนาฯ ก่อนเผยแพร่');
        if (!dp.isLatest) throw new BadRequestException('แผนพัฒนาฯ ที่ระบุไม่ใช่แผนปัจจุบัน');
        if (dp.isBooked) throw new BadRequestException('แผนพัฒนาฯ ถูกรวมเล่มแล้ว ไม่สามารถดำเนินการได้');
        await this.validatePlanPhase(manager, dp, workHistory);

        await manager.update(ProjectGroup, { id }, { isDraft: false });

        await manager.update(TrackingStatus, { projectGroupId: { id } }, { isLatest: false });
        const trackingStatus = manager.create(TrackingStatus, {
          projectGroupId: { id },
          statusId: { id: '8219cd82-fa61-4292-bd0d-fa58b08507e1' },
          createdBy: workHistory,
          isLatest: true,
        });
        await manager.save(trackingStatus);
      });

      return { message: 'Draft published successfully' };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findProjectsByStatus(options: {
    userId: string;
    countOnly?: boolean;
    type?: 'draft' | 'ready' | 'pending' | 'edit' | 'verified' | 'approved' | 'rejected' | 'draft-development-plan' | 'provincial-committee' | 'pull_back';
  }) {
    const { userId, countOnly, type } = options;

    const workHistory = await this.workHistoryRepo.findOne({
      where: { user: { id: userId }, isCurrent: true },
      relations: [
        'user',
        'role',
        'localAdministrativeOrganization',
        'governmentAgencies',
        'workStatus',
        'workHistoryResponsibleAmphoe',
        'workHistoryResponsibleAmphoe.amphoe',
      ],
    });
    if (!workHistory) return countOnly ? 0 : [];
    if (workHistory.workStatus.name !== "approved")
      throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิในการเข้าถึงข้อมูล');

    const query = this.projectGroupRepo
      .createQueryBuilder('projectGroup')
      .leftJoinAndSelect('projectGroup.createdBy', 'createdBy')
      .leftJoinAndSelect('createdBy.user', 'createdByUser')
      .leftJoinAndSelect('createdBy.amphoe', 'amphoe')
      .leftJoinAndSelect('createdBy.localAdministrativeOrganization', 'localAdministrativeOrganization')
      .leftJoinAndSelect('projectGroup.strategy', 'strategy')
      .leftJoinAndSelect('projectGroup.tactic', 'tactic')
      .leftJoinAndSelect('projectGroup.plan', 'plan')
      .leftJoinAndSelect('projectGroup.developmentIssue', 'developmentIssue')
      .leftJoinAndSelect('projectGroup.developmentPlan', 'developmentPlan')
      .leftJoinAndSelect('projectGroup.budgets', 'budgets')
      .leftJoinAndSelect('projectGroup.trackingStatus', 'trackingStatus')
      .leftJoinAndSelect('trackingStatus.statusId', 'status')
      .leftJoinAndSelect('trackingStatus.comments', 'comments')
      .leftJoinAndSelect('trackingStatus.createdBy', 'workHistory')
      .leftJoinAndSelect('workHistory.user', 'user')
      .leftJoinAndSelect('workHistory.localAdministrativeOrganization', 'localAdministrativeOrganizationWorkHistory')
      .leftJoinAndSelect('workHistory.governmentAgencies', 'governmentAgencies')
      .leftJoinAndSelect('workHistory.workStatus', 'workStatus')
      .leftJoinAndSelect('projectGroup.responsibleAgency', 'responsibleAgency')
      .leftJoinAndSelect('projectGroup.originAgencyId', 'originAgencyId')
      .leftJoinAndSelect('originAgencyId.amphoe', 'originAgencyAmphoe')
      .leftJoinAndSelect('projectGroup.favorites', 'favorites')
      .leftJoinAndSelect('favorites.userId', 'userId')
      .leftJoinAndSelect('projectGroup.attachments', 'attachments', 'attachments.deletedAt IS NULL')
      .andWhere('projectGroup.isDraft = :isDraft', { isDraft: false });



    // Add conditions based on type
    if (type) {
      switch (type) {
        case 'draft':
          query.andWhere('projectGroup.isDraft = :isDraft', { isDraft: true })
            .andWhere('projectGroup.createdBy.id = :workHistoryId', { workHistoryId: workHistory.id });
          break;
        case 'ready':
          query.andWhere('projectGroup.isDraft = :isDraft', { isDraft: false })
            .innerJoin('projectGroup.trackingStatus', 'latestTrackingStatus', 'latestTrackingStatus.isLatest = :isLatest', { isLatest: true })
            .innerJoin('latestTrackingStatus.statusId', 'latestStatus', 'latestStatus.name = :statusName', { statusName: 'Ready' })
            .andWhere('localAdministrativeOrganization.id = :localAdministrativeOrganizationId', { localAdministrativeOrganizationId: workHistory.localAdministrativeOrganization.id });
          break;
        case 'pending':
          query.andWhere('projectGroup.isDraft = :isDraft', { isDraft: false })
            .innerJoin('projectGroup.trackingStatus', 'latestTrackingStatus', 'latestTrackingStatus.isLatest = :isLatest', { isLatest: true })
            .innerJoin('latestTrackingStatus.statusId', 'latestStatus', 'latestStatus.name = :statusName', { statusName: 'Pending' })
            .andWhere('developmentPlan.isLatest = :developmentPlanIsLatest', { developmentPlanIsLatest: true })
            .andWhere('developmentPlan.isBooked = :isBooked', { isBooked: false })
          break;
        case 'edit':
          query.andWhere('projectGroup.isDraft = :isDraft', { isDraft: false })
            .innerJoin('projectGroup.trackingStatus', 'latestTrackingStatus', 'latestTrackingStatus.isLatest = :isLatest', { isLatest: true })
            .innerJoin('latestTrackingStatus.statusId', 'latestStatus', 'latestStatus.name = :statusName', { statusName: 'Revision' })
            .andWhere('projectGroup.createdBy.id = :workHistoryId', { workHistoryId: workHistory.id })
            .andWhere('developmentPlan.isLatest = :developmentPlanIsLatest', { developmentPlanIsLatest: true })
            .andWhere('developmentPlan.isBooked = :isBooked', { isBooked: false })
          break;
        case 'pull_back':
          query.andWhere('projectGroup.isDraft = :isDraft', { isDraft: false })
            .innerJoin('projectGroup.trackingStatus', 'latestTrackingStatus', 'latestTrackingStatus.isLatest = :isLatest', { isLatest: true })
            .innerJoin('latestTrackingStatus.statusId', 'latestStatus', 'latestStatus.name = :statusName', { statusName: 'Pull_Back' })
            .andWhere('developmentPlan.isLatest = :developmentPlanIsLatest', { developmentPlanIsLatest: true })
            .andWhere('developmentPlan.isBooked = :isBooked', { isBooked: false })
          break;
        case 'verified':
          query.andWhere('projectGroup.isDraft = :isDraft', { isDraft: false })
            .innerJoin('projectGroup.trackingStatus', 'latestTrackingStatus', 'latestTrackingStatus.isLatest = :isLatest', { isLatest: true })
            .innerJoin('latestTrackingStatus.statusId', 'latestStatus', 'latestStatus.name = :statusName', { statusName: 'Verified' })
            .andWhere('developmentPlan.isLatest = :developmentPlanIsLatest', { developmentPlanIsLatest: true })
            .andWhere('developmentPlan.isBooked = :isBooked', { isBooked: false })
          break;
      }
    }

    //Role conditions
    if (workHistory.role.name === 'user') {
      if (workHistory.governmentAgencies) {
        query.andWhere('responsibleAgency.id = :agencyId', { agencyId: workHistory.governmentAgencies.id });
      } else {
        query.andWhere('originAgencyId.id = :agencyId', { agencyId: workHistory.localAdministrativeOrganization.id });

      }
    }

    if (countOnly) {
      const count = await query.getCount();
      return count;
    }


    const projects = await query
      .orderBy('projectGroup.createdAt', 'DESC')
      .getMany();

    // CLAUDE.md §14 — decorate raw PG entities with `hasDescendant` so the
    // FE lock UI (draft / ready / edit / pending / verified / pull_back list
    // pages) can disable edit/delete actions. Single batched query.
    if (projects.length > 0) {
      const lockedPgIds = await this.findProjectGroupIdsWithDescendants(
        projects.map((p) => p.id),
      );
      projects.forEach((p) => {
        (p as any).hasDescendant = lockedPgIds.has(p.id);
      });
    }

    return projects;
  }
  async bulkAssignAgency(dto: BulkAssignAgencyDto[], userId: string) {
    try {
      this.logger.log(`Starting bulk assign agency for user: ${userId}, items count: ${dto.length}`);
      this.logger.log(`Received DTO: ${JSON.stringify(dto, null, 2)}`);

      const workHistory = await this.workHistoryRepo.findOne({
        where: { user: { id: userId } },
      });

      if (!workHistory) {
        this.logger.error(`WorkHistory not found for user: ${userId}`);
        throw new NotFoundException(`WorkHistory for user ${userId} not found`);
      }

      this.logger.log(`WorkHistory found: ${workHistory.id}`);

      const results = await this.dataSource.transaction(async (manager) => {
        const updateResults: Array<{
          projectId: string;
          success: boolean;
          error?: string;
          affected?: number;
        }> = [];

        for (const item of dto) {
          this.logger.log(`Processing item: ${JSON.stringify(item)}`);
          this.logger.log(`Updating project: ${item.projectId} with agency: ${item.responsibleAgencyId}`);

          // Validate required fields
          if (!item.projectId) {
            this.logger.error(`Missing projectId in item: ${JSON.stringify(item)}`);
            updateResults.push({
              projectId: 'unknown',
              success: false,
              error: 'Missing projectIds'
            });
            continue;
          }

          if (!item.responsibleAgencyId) {
            this.logger.error(`Missing responsibleAgencyId in item: ${JSON.stringify(item)}`);
            updateResults.push({
              projectId: item.projectId,
              success: false,
              error: 'Missing responsibleAgencyId'
            });
            continue;
          }

          // Check if project exists before updating
          const existingProject = await manager.findOne(ProjectGroup, {
            where: { id: item.projectId }
          });

          if (!existingProject) {
            this.logger.warn(`Project not found: ${item.projectId}`);
            updateResults.push({
              projectId: item.projectId,
              success: false,
              error: 'Project not found'
            });
            continue;
          }

          // Check if agency exists
          const existingAgency = await manager.findOne(GovernmentAgency, {
            where: { id: item.responsibleAgencyId }
          });

          if (!existingAgency) {
            this.logger.warn(`Agency not found: ${item.responsibleAgencyId}`);
            updateResults.push({
              projectId: item.projectId,
              success: false,
              error: 'Agency not found'
            });
            continue;
          }

          const updateResult = await manager.update(
            ProjectGroup,
            { id: item.projectId },
            { responsibleAgency: { id: item.responsibleAgencyId } }
          );

          this.logger.log(`Update result for project ${item.projectId}: affected ${updateResult.affected || 0} rows`);

          updateResults.push({
            projectId: item.projectId,
            success: (updateResult.affected || 0) > 0,
            affected: updateResult.affected || 0
          });
        }

        return updateResults;
      });

      const successCount = results.filter(r => r.success).length;
      const failCount = results.filter(r => !r.success).length;

      this.logger.log(`Bulk assign completed: ${successCount} success, ${failCount} failed`);

      return {
        message: 'Bulk assign agency completed',
        total: dto.length,
        success: successCount,
        failed: failCount,
        details: results
      };
    } catch (error) {
      this.logger.error(`Bulk assign agency failed for user ${userId}:`, error.stack);
      handleException(this.logger, error);
    }
  }

  async findByStatusPendingCoordinate(options: {
    userId: string;
    countOnly?: boolean;
    developmentPlanId?: string;
  }) {
    const { userId, countOnly, developmentPlanId } = options;

    const developmentPlan = await this.developmentPlanRepo.findOne({
      where: { id: developmentPlanId }
    });
    if (!developmentPlan) throw new NotFoundException('Development plan not found');

    const workHistory = await this.workHistoryRepo.findOne({
      where: { user: { id: userId }, isCurrent: true },
      relations: [
        'user',
        'role',
        'localAdministrativeOrganization',
        'governmentAgencies',
        'workStatus',
        'workHistoryResponsibleAmphoe',
        'workHistoryResponsibleAmphoe.amphoe',
      ],
    });
    if (!workHistory) return countOnly ? 0 : [];
    if (workHistory.workStatus.name !== "approved")
      throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิในการเข้าถึงข้อมูล');

    const query = this.projectGroupRepo
      .createQueryBuilder('projectGroup')
      .leftJoinAndSelect('projectGroup.createdBy', 'createdBy')
      .leftJoinAndSelect('createdBy.user', 'createdByUser')
      .leftJoinAndSelect('createdBy.amphoe', 'amphoe')
      .leftJoinAndSelect('createdBy.localAdministrativeOrganization', 'localAdministrativeOrganization')
      .leftJoinAndSelect('projectGroup.strategy', 'strategy')
      .leftJoinAndSelect('projectGroup.tactic', 'tactic')
      .leftJoinAndSelect('projectGroup.plan', 'plan')
      .leftJoinAndSelect('projectGroup.developmentPlan', 'developmentPlan')
      .leftJoinAndSelect('projectGroup.budgets', 'budgets')
      .leftJoinAndSelect('projectGroup.trackingStatus', 'trackingStatus')
      .leftJoinAndSelect('trackingStatus.statusId', 'status')
      .leftJoinAndSelect('trackingStatus.comments', 'comments')
      .leftJoinAndSelect('trackingStatus.createdBy', 'workHistory')
      .leftJoinAndSelect('workHistory.user', 'user')
      .leftJoinAndSelect('workHistory.localAdministrativeOrganization', 'localAdministrativeOrganizationWorkHistory')
      .leftJoinAndSelect('workHistory.governmentAgencies', 'governmentAgencies')
      .leftJoinAndSelect('workHistory.workStatus', 'workStatus')
      .leftJoinAndSelect('projectGroup.responsibleAgency', 'responsibleAgency')
      .leftJoinAndSelect('projectGroup.originAgencyId', 'originAgencyId')
      .leftJoinAndSelect('projectGroup.amphoe', 'projectAmphoe')
      .leftJoinAndSelect('projectGroup.localAdministrativeOrganization', 'localAdministrativeOrganizationProject')
      .leftJoinAndSelect('projectGroup.favorites', 'favorites')
      .leftJoinAndSelect('projectGroup.attachments', 'attachments')
      .leftJoinAndSelect('favorites.userId', 'userId')
      .andWhere('projectGroup.isDraft = :isDraft', { isDraft: false })
      .andWhere('trackingStatus.isLatest = :isLatest', { isLatest: true })
      .andWhere('projectGroup.isBooked = :isBooked', { isBooked: false })
      .andWhere('status.name = :statusName', { statusName: 'Pending' })
      .andWhere('projectGroup.originAgencyId IS NOT NULL')
      .andWhere('projectGroup.responsibleAgency IS NULL')
      .andWhere('developmentPlan.id = :developmentPlanId', { developmentPlanId: developmentPlan.id })
      .andWhere('developmentPlan.isBooked = :isBooked', { isBooked: false });
    // Role-based filtering
    const userRole = workHistory.role.name;

    if (userRole === 'admin' || userRole === 'super-admin' || userRole === 'c-level') {
      // Admin/Super-admin/C-level: เห็นทุกโครงการ
      // ไม่เพิ่มเงื่อนไขกรองเพิ่มเติม
    } else if (userRole === 'staff') {
      // Staff: เห็นเฉพาะโครงการในอำเภอที่รับผิดชอบ
      const responsibleAmphoeIds = workHistory.workHistoryResponsibleAmphoe.map(
        (resp) => resp.amphoe.id
      );
      if (responsibleAmphoeIds.length > 0) {
        query.andWhere('amphoe.id IN (:...responsibleAmphoeIds)', {
          responsibleAmphoeIds
        });
      } else {
        // ถ้าไม่ได้รับผิดชอบอำเภอใดเลย ให้ไม่เห็นโครงการใด
        query.andWhere('1 = 0'); // Always false condition
      }
    } else {
      // ถ้าไม่มีหน่วยงาน ให้ไม่เห็นโครงการใด
      query.andWhere('1 = 0'); // Always false condition
    }


    if (countOnly) {
      const count = await query.getCount();
      return count;
    }

    const projects = await query
      .orderBy('projectGroup.createdAt', 'DESC')
      .getMany();

    return projects;
  }

  async findByStatusPendingAgency(options: {
    userId: string;
    countOnly?: boolean;
    developmentPlanId?: string;
  }) {
    const { userId, countOnly, developmentPlanId } = options;
    const developmentPlan = await this.developmentPlanRepo.findOne({
      where: { id: developmentPlanId }
    });
    if (!developmentPlan) throw new NotFoundException('Development plan not found');
    const workHistory = await this.workHistoryRepo.findOne({
      where: { user: { id: userId }, isCurrent: true },
      relations: [
        'user',
        'role',
        'localAdministrativeOrganization',
        'governmentAgencies',
        'workStatus',
        'workHistoryResponsibleGovernmentAgency',
        'workHistoryResponsibleGovernmentAgency.governmentAgency',
      ],
    });
    if (!workHistory) return countOnly ? 0 : [];
    if (workHistory.workStatus.name !== "approved")
      throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิในการเข้าถึงข้อมูล');

    const query = this.projectGroupRepo
      .createQueryBuilder('projectGroup')
      .leftJoinAndSelect('projectGroup.createdBy', 'createdBy')
      .leftJoinAndSelect('createdBy.user', 'createdByUser')
      .leftJoinAndSelect('createdBy.amphoe', 'amphoe')
      .leftJoinAndSelect('createdBy.localAdministrativeOrganization', 'localAdministrativeOrganization')
      .leftJoinAndSelect('projectGroup.strategy', 'strategy')
      .leftJoinAndSelect('projectGroup.tactic', 'tactic')
      .leftJoinAndSelect('projectGroup.plan', 'plan')
      .leftJoinAndSelect('projectGroup.developmentPlan', 'developmentPlan')
      .leftJoinAndSelect('projectGroup.budgets', 'budgets')
      .leftJoinAndSelect('projectGroup.trackingStatus', 'trackingStatus')
      .leftJoinAndSelect('trackingStatus.statusId', 'status')
      .leftJoinAndSelect('trackingStatus.comments', 'comments')
      .leftJoinAndSelect('trackingStatus.createdBy', 'workHistory')
      .leftJoinAndSelect('workHistory.user', 'user')
      .leftJoinAndSelect('workHistory.localAdministrativeOrganization', 'localAdministrativeOrganizationWorkHistory')
      .leftJoinAndSelect('workHistory.governmentAgencies', 'governmentAgencies')
      .leftJoinAndSelect('workHistory.workStatus', 'workStatus')
      .leftJoinAndSelect('projectGroup.responsibleAgency', 'responsibleAgency')
      .leftJoinAndSelect('projectGroup.originAgencyId', 'originAgencyId')
      .leftJoinAndSelect('originAgencyId.amphoe', 'originAgencyAmphoe')
      .leftJoinAndSelect('projectGroup.amphoe', 'projectAmphoe')
      .leftJoinAndSelect('projectGroup.localAdministrativeOrganization', 'projectLAO')
      .leftJoinAndSelect('projectGroup.favorites', 'favorites')
      .leftJoinAndSelect('favorites.userId', 'userId')
      .leftJoinAndSelect('projectGroup.attachments', 'attachments')
      .andWhere('projectGroup.isDraft = :isDraft', { isDraft: false })
      .andWhere('trackingStatus.isLatest = :isLatest', { isLatest: true })
      .andWhere('status.name = :statusName', { statusName: 'Pending' })
      .andWhere('projectGroup.originAgencyId IS NULL')
      .andWhere('projectGroup.responsibleAgency IS NOT NULL')
      .andWhere('developmentPlan.id = :developmentPlanId', { developmentPlanId: developmentPlan.id })
      .andWhere('developmentPlan.isBooked = :isBooked', { isBooked: false });

    // Role-based filtering
    const userRole = workHistory.role.name;

    if (userRole === 'admin' || userRole === 'super-admin' || userRole === 'c-level') {
      // Admin/Super-admin/C-level: เห็นทุกโครงการ
      // ไม่เพิ่มเงื่อนไขกรองเพิ่มเติม
    } else if (userRole === 'staff') {
      // Staff: เห็นเฉพาะโครงการในอำเภอที่รับผิดชอบ
      const responsibleGovernmentAgencyIds = workHistory.workHistoryResponsibleGovernmentAgency.map(
        (resp) => resp.governmentAgency.id
      );

      if (responsibleGovernmentAgencyIds.length > 0) {
        query.andWhere('responsibleAgency.id IN (:...responsibleGovernmentAgencyIds)', {
          responsibleGovernmentAgencyIds
        });
      } else {
        // ถ้าไม่ได้รับผิดชอบอำเภอใดเลย ให้ไม่เห็นโครงการใด
        query.andWhere('1 = 0'); // Always false condition
      }
    } else {
      query.andWhere('1 = 0'); // Always false condition
    }

    if (countOnly) {
      const count = await query.getCount();
      return count || 0;
    }

    const projects = await query
      .orderBy('projectGroup.createdAt', 'DESC')
      .getMany();

    return projects;
  }
  async findByStatusProvincialCommittee(options: {
    userId: string;
    countOnly?: boolean;
    developmentPlanId?: string;
  }) {
    const { userId, countOnly, developmentPlanId } = options;

    const developmentPlan = await this.developmentPlanRepo.findOne({
      where: { id: developmentPlanId }
    });
    if (!developmentPlan) throw new NotFoundException('Development plan not found');
    const workHistory = await this.workHistoryRepo.findOne({
      where: { user: { id: userId }, isCurrent: true },
      relations: [
        'user',
        'role',
        'localAdministrativeOrganization',
        'governmentAgencies',
        'workStatus',
        'workHistoryResponsibleAmphoe',
        'workHistoryResponsibleAmphoe.amphoe',
      ],
    });
    if (!workHistory) return countOnly ? 0 : [];
    if (workHistory.workStatus.name !== "approved")
      throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิในการเข้าถึงข้อมูล');

    const query = this.projectGroupRepo
      .createQueryBuilder('projectGroup')
      .leftJoinAndSelect('projectGroup.createdBy', 'createdBy')
      .leftJoinAndSelect('createdBy.user', 'createdByUser')
      .leftJoinAndSelect('createdBy.amphoe', 'amphoe')
      .leftJoinAndSelect('createdBy.localAdministrativeOrganization', 'localAdministrativeOrganization')
      .leftJoinAndSelect('projectGroup.strategy', 'strategy')
      .leftJoinAndSelect('projectGroup.tactic', 'tactic')
      .leftJoinAndSelect('projectGroup.plan', 'plan')
      .leftJoinAndSelect('projectGroup.developmentPlan', 'developmentPlan')
      .leftJoinAndSelect('projectGroup.budgets', 'budgets')
      .innerJoin('projectGroup.trackingStatus', 'latestTrackingStatus', 'latestTrackingStatus.isLatest = :isLatest', { isLatest: true })
      .innerJoin('latestTrackingStatus.statusId', 'latestStatus', 'latestStatus.name = :statusName', { statusName: 'Pending_Approval' })
      .leftJoinAndSelect('projectGroup.trackingStatus', 'trackingStatus')
      .leftJoinAndSelect('trackingStatus.statusId', 'status')
      .leftJoinAndSelect('trackingStatus.comments', 'comments')
      .leftJoinAndSelect('trackingStatus.createdBy', 'workHistory')
      .leftJoinAndSelect('workHistory.user', 'user')
      .leftJoinAndSelect('workHistory.localAdministrativeOrganization', 'localAdministrativeOrganizationWorkHistory')
      .leftJoinAndSelect('workHistory.governmentAgencies', 'governmentAgencies')
      .leftJoinAndSelect('workHistory.workStatus', 'workStatus')
      .leftJoinAndSelect('projectGroup.responsibleAgency', 'responsibleAgency')
      .leftJoinAndSelect('projectGroup.originAgencyId', 'originAgencyId')
      .leftJoinAndSelect('originAgencyId.amphoe', 'originAgencyAmphoe')
      .leftJoinAndSelect('projectGroup.amphoe', 'projectGroupAmphoe')
      .leftJoinAndSelect('projectGroup.attachments', 'attachments')
      .leftJoinAndSelect('projectGroup.favorites', 'favorites')
      .leftJoinAndSelect('favorites.userId', 'userId')
      .andWhere('projectGroup.isDraft = :isDraft', { isDraft: false })
      .andWhere('projectGroup.originAgencyId IS NOT NULL')
      .andWhere('projectGroup.isBooked = :isBooked', { isBooked: false })
      .andWhere('developmentPlan.id = :developmentPlanId', { developmentPlanId: developmentPlan.id })
      .andWhere('developmentPlan.isBooked = :isBooked', { isBooked: false });
    if (countOnly) {
      const count = await query.getCount();
      return count;
    }

    const projects = await query
      .orderBy('projectGroup.createdAt', 'DESC')
      .getMany();

    return projects;
  }
  async findByStatusPlanCommittee(options: {
    userId: string;
    countOnly?: boolean;
    developmentPlanId?: string;
  }) {
    const { userId, countOnly, developmentPlanId } = options;
    const developmentPlan = await this.developmentPlanRepo.findOne({
      where: { id: developmentPlanId }
    });
    if (!developmentPlan) throw new NotFoundException('Development plan not found');
    const workHistory = await this.workHistoryRepo.findOne({
      where: { user: { id: userId }, isCurrent: true },
      relations: [
        'user',
        'role',
        'localAdministrativeOrganization',
        'governmentAgencies',
        'workStatus',
        'workHistoryResponsibleAmphoe',
        'workHistoryResponsibleAmphoe.amphoe',
      ],
    });
    if (!workHistory) return countOnly ? 0 : [];
    if (workHistory.workStatus.name !== "approved")
      throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิในการเข้าถึงข้อมูล');

    const query = this.projectGroupRepo
      .createQueryBuilder('projectGroup')
      .leftJoinAndSelect('projectGroup.createdBy', 'createdBy')
      .leftJoinAndSelect('createdBy.user', 'createdByUser')
      .leftJoinAndSelect('createdBy.amphoe', 'amphoe')
      .leftJoinAndSelect('createdBy.localAdministrativeOrganization', 'localAdministrativeOrganization')
      .leftJoinAndSelect('projectGroup.strategy', 'strategy')
      .leftJoinAndSelect('projectGroup.tactic', 'tactic')
      .leftJoinAndSelect('projectGroup.plan', 'plan')
      .leftJoinAndSelect('projectGroup.developmentPlan', 'developmentPlan')
      .leftJoinAndSelect('projectGroup.budgets', 'budgets')
      .innerJoin('projectGroup.trackingStatus', 'latestTrackingStatus', 'latestTrackingStatus.isLatest = :isLatest', { isLatest: true })
      .innerJoin('latestTrackingStatus.statusId', 'latestStatus', 'latestStatus.name = :statusName', { statusName: 'Pending_Approval' })
      .leftJoinAndSelect('projectGroup.trackingStatus', 'trackingStatus')
      .leftJoinAndSelect('trackingStatus.statusId', 'status')
      .leftJoinAndSelect('trackingStatus.comments', 'comments')
      .leftJoinAndSelect('trackingStatus.createdBy', 'workHistory')
      .leftJoinAndSelect('workHistory.user', 'user')
      .leftJoinAndSelect('workHistory.localAdministrativeOrganization', 'localAdministrativeOrganizationWorkHistory')
      .leftJoinAndSelect('workHistory.governmentAgencies', 'governmentAgencies')
      .leftJoinAndSelect('workHistory.workStatus', 'workStatus')
      .leftJoinAndSelect('projectGroup.responsibleAgency', 'responsibleAgency')
      .leftJoinAndSelect('projectGroup.originAgencyId', 'originAgencyId')
      .leftJoinAndSelect('originAgencyId.amphoe', 'originAgencyAmphoe')
      .leftJoinAndSelect('projectGroup.favorites', 'favorites')
      .leftJoinAndSelect('projectGroup.attachments', 'attachments')
      .leftJoinAndSelect('projectGroup.amphoe', 'projectGroupAmphoe')
      .leftJoinAndSelect('favorites.userId', 'userId')
      .andWhere('projectGroup.isDraft = :isDraft', { isDraft: false })
      .andWhere('projectGroup.isBooked = :isBooked', { isBooked: false })
      .andWhere('projectGroup.originAgencyId IS  NULL')
      .andWhere('projectGroup.responsibleAgency IS NOT NULL')
      .andWhere('developmentPlan.id = :developmentPlanId', { developmentPlanId: developmentPlan.id })
      .andWhere('developmentPlan.isBooked = :isBooked', { isBooked: false });
    if (countOnly) {
      const count = await query.getCount();
      return count;
    }

    const projects = await query
      .orderBy('projectGroup.createdAt', 'DESC')
      .getMany();

    return projects;
  }
  async findByStatusVerifiedAgency(options: {
    userId: string;
    countOnly?: boolean;
    developmentPlanId?: string;
  }) {
    const { userId, countOnly, developmentPlanId } = options;
    const developmentPlan = await this.developmentPlanRepo.findOne({
      where: { id: developmentPlanId }
    });
    if (!developmentPlan) throw new NotFoundException('Development plan not found');
    const workHistory = await this.workHistoryRepo.findOne({
      where: { user: { id: userId }, isCurrent: true },
      relations: [
        'user',
        'role',
        'localAdministrativeOrganization',
        'governmentAgencies',
        'workStatus',
        'workHistoryResponsibleAmphoe',
        'workHistoryResponsibleAmphoe.amphoe',
      ],
    });
    if (!workHistory) return countOnly ? 0 : [];
    if (workHistory.workStatus.name !== "approved")
      throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิในการเข้าถึงข้อมูล');

    const query = this.projectGroupRepo
      .createQueryBuilder('projectGroup')
      .leftJoinAndSelect('projectGroup.createdBy', 'createdBy')
      .leftJoinAndSelect('createdBy.user', 'createdByUser')
      .leftJoinAndSelect('createdBy.amphoe', 'amphoe')
      .leftJoinAndSelect('createdBy.localAdministrativeOrganization', 'localAdministrativeOrganization')
      .leftJoinAndSelect('projectGroup.strategy', 'strategy')
      .leftJoinAndSelect('projectGroup.tactic', 'tactic')
      .leftJoinAndSelect('projectGroup.plan', 'plan')
      .leftJoinAndSelect('projectGroup.developmentPlan', 'developmentPlan')
      .leftJoinAndSelect('projectGroup.budgets', 'budgets')
      .innerJoin('projectGroup.trackingStatus', 'latestTrackingStatus', 'latestTrackingStatus.isLatest = :isLatest', { isLatest: true })
      .innerJoin('latestTrackingStatus.statusId', 'latestStatus', 'latestStatus.name = :statusName', { statusName: 'Verified' })
      .leftJoinAndSelect('projectGroup.trackingStatus', 'trackingStatus')
      .leftJoinAndSelect('trackingStatus.statusId', 'status')
      .leftJoinAndSelect('trackingStatus.comments', 'comments')
      .leftJoinAndSelect('trackingStatus.createdBy', 'workHistory')
      .leftJoinAndSelect('workHistory.user', 'user')
      .leftJoinAndSelect('workHistory.localAdministrativeOrganization', 'localAdministrativeOrganizationWorkHistory')
      .leftJoinAndSelect('workHistory.governmentAgencies', 'governmentAgencies')
      .leftJoinAndSelect('workHistory.workStatus', 'workStatus')
      .leftJoinAndSelect('projectGroup.responsibleAgency', 'responsibleAgency')
      .leftJoinAndSelect('projectGroup.originAgencyId', 'originAgencyId')
      .leftJoinAndSelect('originAgencyId.amphoe', 'originAgencyAmphoe')
      .leftJoinAndSelect('projectGroup.favorites', 'favorites')
      .leftJoinAndSelect('projectGroup.attachments', 'attachments')
      .leftJoinAndSelect('projectGroup.amphoe', 'projectGroupAmphoe')
      .leftJoinAndSelect('favorites.userId', 'userId')
      .andWhere('projectGroup.isDraft = :isDraft', { isDraft: false })
      .andWhere('projectGroup.originAgencyId IS  NULL')
      .andWhere('projectGroup.responsibleAgency IS NOT NULL')
      .andWhere('developmentPlan.id = :developmentPlanId', { developmentPlanId: developmentPlan.id })
      .andWhere('developmentPlan.isBooked = :isBooked', { isBooked: false });
    if (countOnly) {
      const count = await query.getCount();
      return count;
    }

    const projects = await query
      .orderBy('projectGroup.createdAt', 'DESC')
      .getMany();

    return projects;
  }
  async findProjectsByStatusInAuthority(options: {
    userId: string;
    countOnly?: boolean;
    developmentPlanId?: string;
  }) {
    const { userId, countOnly, developmentPlanId } = options;
    const developmentPlan = await this.developmentPlanRepo.findOne({
      where: { id: developmentPlanId }
    });
    if (!developmentPlan) throw new NotFoundException('Development plan not found');
    const workHistory = await this.workHistoryRepo.findOne({
      where: { user: { id: userId }, isCurrent: true },
      relations: [
        'user',
        'role',
        'localAdministrativeOrganization',
        'governmentAgencies',
        'workStatus',
        'workHistoryResponsibleAmphoe',
        'workHistoryResponsibleAmphoe.amphoe',
      ],
    });
    if (!workHistory) return countOnly ? 0 : [];
    if (workHistory.workStatus.name !== "approved")
      throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิในการเข้าถึงข้อมูล');

    const query = this.projectGroupRepo
      .createQueryBuilder('projectGroup')
      .leftJoinAndSelect('projectGroup.createdBy', 'createdBy')
      .leftJoinAndSelect('createdBy.user', 'createdByUser')
      .leftJoinAndSelect('createdBy.amphoe', 'amphoe')
      .leftJoinAndSelect('createdBy.localAdministrativeOrganization', 'localAdministrativeOrganization')
      .leftJoinAndSelect('projectGroup.strategy', 'strategy')
      .leftJoinAndSelect('projectGroup.tactic', 'tactic')
      .leftJoinAndSelect('projectGroup.plan', 'plan')
      .leftJoinAndSelect('projectGroup.developmentPlan', 'developmentPlan')
      .leftJoinAndSelect('projectGroup.budgets', 'budgets')
      .innerJoin('projectGroup.trackingStatus', 'latestTrackingStatus', 'latestTrackingStatus.isLatest = :isLatest', { isLatest: true })
      .innerJoin('latestTrackingStatus.statusId', 'latestStatus', 'latestStatus.name = :statusName', { statusName: 'Verified' })
      .leftJoinAndSelect('projectGroup.trackingStatus', 'trackingStatus')
      .leftJoinAndSelect('trackingStatus.statusId', 'status')
      .leftJoinAndSelect('trackingStatus.comments', 'comments')
      .leftJoinAndSelect('trackingStatus.createdBy', 'workHistory')
      .leftJoinAndSelect('workHistory.user', 'user')
      .leftJoinAndSelect('workHistory.localAdministrativeOrganization', 'localAdministrativeOrganizationWorkHistory')
      .leftJoinAndSelect('workHistory.governmentAgencies', 'governmentAgencies')
      .leftJoinAndSelect('workHistory.workStatus', 'workStatus')
      .leftJoinAndSelect('projectGroup.responsibleAgency', 'responsibleAgency')
      .leftJoinAndSelect('projectGroup.originAgencyId', 'originAgencyId')
      .leftJoinAndSelect('originAgencyId.amphoe', 'originAgencyAmphoe')
      .leftJoinAndSelect('projectGroup.amphoe', 'projectGroupAmphoe')
      .leftJoinAndSelect('projectGroup.attachments', 'attachments')
      .leftJoinAndSelect('projectGroup.favorites', 'favorites')
      .leftJoinAndSelect('favorites.userId', 'userId')
      .andWhere('projectGroup.isDraft = :isDraft', { isDraft: false })
      .andWhere('projectGroup.originAgencyId IS NOT NULL')
      .andWhere('developmentPlan.id = :developmentPlanId', { developmentPlanId: developmentPlan.id })
      .andWhere('developmentPlan.isBooked = :isBooked', { isBooked: false });
    if (countOnly) {
      const count = await query.getCount();
      return count || 0;
    }

    const projects = await query
      .orderBy('projectGroup.createdAt', 'DESC')
      .getMany();

    return projects;
  }
  async findProjectsByStatusInAuthorityOut(options: {
    userId: string;
    countOnly?: boolean;
    developmentPlanId?: string;
  }) {
    const { userId, countOnly, developmentPlanId } = options;
    const developmentPlan = await this.developmentPlanRepo.findOne({
      where: { id: developmentPlanId }
    });
    if (!developmentPlan) throw new NotFoundException('Development plan not found');
    const workHistory = await this.workHistoryRepo.findOne({
      where: { user: { id: userId }, isCurrent: true },
      relations: [
        'user',
        'role',
        'localAdministrativeOrganization',
        'governmentAgencies',
        'workStatus',
        'workHistoryResponsibleAmphoe',
        'workHistoryResponsibleAmphoe.amphoe',
      ],
    });
    if (!workHistory) return countOnly ? 0 : [];
    if (workHistory.workStatus.name !== "approved")
      throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิในการเข้าถึงข้อมูล');

    const query = this.projectGroupRepo
      .createQueryBuilder('projectGroup')
      .leftJoinAndSelect('projectGroup.createdBy', 'createdBy')
      .leftJoinAndSelect('createdBy.user', 'createdByUser')
      .leftJoinAndSelect('createdBy.amphoe', 'amphoe')
      .leftJoinAndSelect('createdBy.localAdministrativeOrganization', 'localAdministrativeOrganization')
      .leftJoinAndSelect('projectGroup.strategy', 'strategy')
      .leftJoinAndSelect('projectGroup.tactic', 'tactic')
      .leftJoinAndSelect('projectGroup.plan', 'plan')
      .leftJoinAndSelect('projectGroup.developmentPlan', 'developmentPlan')
      .leftJoinAndSelect('projectGroup.budgets', 'budgets')
      .leftJoinAndSelect('projectGroup.trackingStatus', 'trackingStatus')
      .leftJoinAndSelect('trackingStatus.statusId', 'status')
      .leftJoinAndSelect('trackingStatus.comments', 'comments')
      .leftJoinAndSelect('trackingStatus.createdBy', 'workHistory')
      .leftJoinAndSelect('workHistory.user', 'user')
      .leftJoinAndSelect('workHistory.localAdministrativeOrganization', 'localAdministrativeOrganizationWorkHistory')
      .leftJoinAndSelect('workHistory.governmentAgencies', 'governmentAgencies')
      .leftJoinAndSelect('workHistory.workStatus', 'workStatus')
      .leftJoinAndSelect('projectGroup.responsibleAgency', 'responsibleAgency')
      .leftJoinAndSelect('projectGroup.originAgencyId', 'originAgencyId')
      .leftJoinAndSelect('originAgencyId.amphoe', 'originAgencyAmphoe')
      .leftJoinAndSelect('projectGroup.favorites', 'favorites')
      .leftJoinAndSelect('projectGroup.attachments', 'attachments')
      .leftJoinAndSelect('projectGroup.amphoe', 'projectGroupAmphoe')
      .leftJoinAndSelect('favorites.userId', 'userId')
      .andWhere('projectGroup.isDraft = :isDraft', { isDraft: false })
      .andWhere('trackingStatus.isLatest = :isLatest', { isLatest: true })
      .andWhere('status.name = :statusName', { statusName: 'Rejected' })
      .andWhere('projectGroup.originAgencyId IS NOT NULL')
      .andWhere('projectGroup.responsibleAgency IS NULL')
      .andWhere('developmentPlan.isBooked = :isBooked', { isBooked: false })
      .andWhere('developmentPlan.id = :developmentPlanId', { developmentPlanId: developmentPlan.id });

    if (countOnly) {
      query.andWhere('projectGroup.isBooked = :isBooked', { isBooked: false })
      const count = await query.getCount();
      return count;
    }

    const projects = await query
      .orderBy('projectGroup.createdAt', 'DESC')
      .getMany();
    return projects;

  }

  async findByStatusApprovedCoordinate(option: {
    userId: string;
    countOnly?: boolean;
    developmentPlanId?: string;
  }) {
    const { userId, countOnly, developmentPlanId } = option;
    const developmentPlan = await this.developmentPlanRepo.findOne({
      where: { id: developmentPlanId }
    });
    if (!developmentPlan) throw new NotFoundException('Development plan not found');
    const workHistory = await this.workHistoryRepo.findOne({
      where: { user: { id: userId } },
      relations: ['workStatus'],
    });
    if (!workHistory) return countOnly ? 0 : [];
    if (workHistory.workStatus.name !== "approved")
      throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิในการเข้าถึงข้อมูล');
    const query = this.projectGroupRepo
      .createQueryBuilder('projectGroup')
      .leftJoinAndSelect('projectGroup.createdBy', 'createdBy')
      .leftJoinAndSelect('createdBy.user', 'createdByUser')
      .leftJoinAndSelect('createdBy.amphoe', 'amphoe')
      .leftJoinAndSelect('createdBy.localAdministrativeOrganization', 'localAdministrativeOrganization')
      .leftJoinAndSelect('projectGroup.strategy', 'strategy')
      .leftJoinAndSelect('projectGroup.tactic', 'tactic')
      .leftJoinAndSelect('projectGroup.plan', 'plan')
      .leftJoinAndSelect('projectGroup.developmentPlan', 'developmentPlan')
      .leftJoinAndSelect('projectGroup.budgets', 'budgets')
      .innerJoin('projectGroup.trackingStatus', 'latestTrackingStatus', 'latestTrackingStatus.isLatest = :isLatest', { isLatest: true })
      .innerJoin('latestTrackingStatus.statusId', 'latestStatus', 'latestStatus.name = :statusName', { statusName: 'Approved' })
      .leftJoinAndSelect('projectGroup.trackingStatus', 'trackingStatus')
      .leftJoinAndSelect('trackingStatus.statusId', 'status')
      .leftJoinAndSelect('trackingStatus.comments', 'comments')
      .leftJoinAndSelect('trackingStatus.createdBy', 'workHistory')
      .leftJoinAndSelect('workHistory.user', 'user')
      .leftJoinAndSelect('workHistory.localAdministrativeOrganization', 'localAdministrativeOrganizationWorkHistory')
      .leftJoinAndSelect('workHistory.governmentAgencies', 'governmentAgencies')
      .leftJoinAndSelect('workHistory.workStatus', 'workStatus')
      .leftJoinAndSelect('projectGroup.responsibleAgency', 'responsibleAgency')
      .leftJoinAndSelect('projectGroup.originAgencyId', 'originAgencyId')
      .leftJoinAndSelect('originAgencyId.amphoe', 'originAgencyAmphoe')
      .leftJoinAndSelect('projectGroup.amphoe', 'projectGroupAmphoe')
      .leftJoinAndSelect('projectGroup.attachments', 'attachments')
      .leftJoinAndSelect('projectGroup.favorites', 'favorites')
      .leftJoinAndSelect('favorites.userId', 'userId')
      .andWhere('projectGroup.isDraft = :isDraft', { isDraft: false })
      .andWhere('projectGroup.originAgencyId IS NOT NULL')
      .andWhere('projectGroup.responsibleAgency IS NOT NULL')
      .andWhere('projectGroup.isBooked = :isBooked', { isBooked: false })
      .andWhere('developmentPlan.id = :developmentPlanId', { developmentPlanId: developmentPlan.id });


    if (countOnly) {
      const count = await query.getCount();
      return count;
    }

    const projects = await query
      .orderBy('projectGroup.createdAt', 'DESC')
      .getMany();

    return projects;

  }
  async findByStatusApprovedAgency(option: {
    userId: string;
    countOnly?: boolean;
    developmentPlanId?: string;
  }) {
    const { userId, countOnly, developmentPlanId } = option;
    const developmentPlan = await this.developmentPlanRepo.findOne({
      where: { id: developmentPlanId }
    });
    if (!developmentPlan) throw new NotFoundException('Development plan not found');

    const workHistory = await this.workHistoryRepo.findOne({
      where: { user: { id: userId } },
      relations: ['workStatus'],
    });
    if (!workHistory) return countOnly ? 0 : [];

    if (workHistory.workStatus.name !== "approved")
      throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิในการเข้าถึงข้อมูล');
    const query = this.projectGroupRepo
      .createQueryBuilder('projectGroup')
      .leftJoinAndSelect('projectGroup.createdBy', 'createdBy')
      .leftJoinAndSelect('createdBy.user', 'createdByUser')
      .leftJoinAndSelect('createdBy.amphoe', 'amphoe')
      .leftJoinAndSelect('createdBy.localAdministrativeOrganization', 'localAdministrativeOrganization')
      .leftJoinAndSelect('projectGroup.strategy', 'strategy')
      .leftJoinAndSelect('projectGroup.tactic', 'tactic')
      .leftJoinAndSelect('projectGroup.plan', 'plan')
      .leftJoinAndSelect('projectGroup.developmentPlan', 'developmentPlan')
      .leftJoinAndSelect('projectGroup.budgets', 'budgets')
      .innerJoin('projectGroup.trackingStatus', 'latestTrackingStatus', 'latestTrackingStatus.isLatest = :isLatest', { isLatest: true })
      .innerJoin('latestTrackingStatus.statusId', 'latestStatus', 'latestStatus.name = :statusName', { statusName: 'Approved' })
      .leftJoinAndSelect('projectGroup.trackingStatus', 'trackingStatus')
      .leftJoinAndSelect('trackingStatus.statusId', 'status')
      .leftJoinAndSelect('trackingStatus.comments', 'comments')
      .leftJoinAndSelect('trackingStatus.createdBy', 'workHistory')
      .leftJoinAndSelect('workHistory.user', 'user')
      .leftJoinAndSelect('workHistory.localAdministrativeOrganization', 'localAdministrativeOrganizationWorkHistory')
      .leftJoinAndSelect('workHistory.governmentAgencies', 'governmentAgencies')
      .leftJoinAndSelect('workHistory.workStatus', 'workStatus')
      .leftJoinAndSelect('projectGroup.responsibleAgency', 'responsibleAgency')
      .leftJoinAndSelect('projectGroup.originAgencyId', 'originAgencyId')
      .leftJoinAndSelect('originAgencyId.amphoe', 'originAgencyAmphoe')
      .leftJoinAndSelect('projectGroup.favorites', 'favorites')
      .leftJoinAndSelect('projectGroup.attachments', 'attachments')
      .leftJoinAndSelect('projectGroup.amphoe', 'projectGroupAmphoe')
      .leftJoinAndSelect('favorites.userId', 'userId')
      .andWhere('projectGroup.isDraft = :isDraft', { isDraft: false })
      .andWhere('projectGroup.originAgencyId IS NULL')
      .andWhere('projectGroup.responsibleAgency IS NOT NULL')
      .andWhere('projectGroup.isBooked = :isBooked', { isBooked: false })
      .andWhere('developmentPlan.id = :developmentPlanId', { developmentPlanId: developmentPlan.id });
    if (countOnly) {
      const count = await query.getCount();
      return count;
    }

    const projects = await query
      .orderBy('projectGroup.createdAt', 'DESC')
      .getMany();

    return projects;

  }

  /**
   * CLAUDE.md §14 — Batched lineage-lock lookup for ProjectGroup rows.
   *
   * Given a list of ProjectGroup IDs, returns a Set containing the subset
   * that have at least one non-soft-deleted RevisedProjectGroup descendant
   * (prev_project_type = 'original'). Used by list endpoints to populate
   * the `hasDescendant` flag on unified DTOs without N+1 queries.
   *
   * Uses the partial index idx_rpg_prev_project_id
   * ON (prev_project_id) WHERE deleted_at IS NULL.
   */
  private async findProjectGroupIdsWithDescendants(
    projectGroupIds: string[],
  ): Promise<Set<string>> {
    if (!projectGroupIds || projectGroupIds.length === 0) return new Set();

    const rows = await this.revisedProjectGroupRepo
      .createQueryBuilder('r')
      .select('DISTINCT r.prev_project_id', 'parentId')
      .where('r.prev_project_id IN (:...ids)', { ids: projectGroupIds })
      .andWhere('r.prev_project_type = :t', { t: 'original' })
      .andWhere('r.deleted_at IS NULL')
      .getRawMany<{ parentId: string }>();

    return new Set(rows.map((r) => r.parentId));
  }

  /**
   * CLAUDE.md §14 — Batched lineage-lock lookup for RevisedProjectGroup rows.
   *
   * Given a list of RevisedProjectGroup IDs, returns a Set containing the
   * subset that have at least one non-soft-deleted RevisedProjectGroup
   * descendant (prev_project_type = 'revised'). Used by list endpoints that
   * mix PG and RPG rows to populate `hasDescendant` without N+1 queries.
   *
   * Matches LineageLockService.hasNonDeletedDescendant semantics exactly.
   */
  private async findRevisedProjectGroupIdsWithDescendants(
    revisedProjectGroupIds: string[],
  ): Promise<Set<string>> {
    if (!revisedProjectGroupIds || revisedProjectGroupIds.length === 0)
      return new Set();

    const rows = await this.revisedProjectGroupRepo
      .createQueryBuilder('r')
      .select('DISTINCT r.prev_project_id', 'parentId')
      .where('r.prev_project_id IN (:...ids)', { ids: revisedProjectGroupIds })
      .andWhere('r.prev_project_type = :t', { t: 'revised' })
      .andWhere('r.deleted_at IS NULL')
      .getRawMany<{ parentId: string }>();

    return new Set(rows.map((r) => r.parentId));
  }

  /**
   * Query original projects (ProjectGroup) ที่ไม่มี active revision และ status = Approved
   */
  private async findOriginalApprovedProjects(
    developmentPlanId: string,
    responsibleAgencyId?: string,
  ): Promise<ProjectGroup[]> {
    const query = this.projectGroupRepo
      .createQueryBuilder('projectGroup')
      .leftJoinAndSelect('projectGroup.createdBy', 'createdBy')
      .leftJoinAndSelect('createdBy.user', 'createdByUser')
      .leftJoinAndSelect('projectGroup.strategy', 'strategy')
      .leftJoinAndSelect('projectGroup.tactic', 'tactic')
      .leftJoinAndSelect('projectGroup.plan', 'plan')
      .leftJoinAndSelect('projectGroup.amphoe', 'projectGroupAmphoe')
      .leftJoinAndSelect('projectGroup.localAdministrativeOrganization', 'projectGroupLocalAdministrativeOrganization')
      .leftJoinAndSelect('projectGroup.developmentPlan', 'developmentPlan')
      .leftJoinAndSelect('projectGroup.budgets', 'budgets')
      .leftJoinAndSelect('projectGroup.trackingStatus', 'trackingStatus')
      .leftJoinAndSelect('trackingStatus.statusId', 'status')
      .leftJoinAndSelect('trackingStatus.comments', 'comments')
      .leftJoinAndSelect('trackingStatus.createdBy', 'workHistory')
      .leftJoinAndSelect('workHistory.user', 'user')
      .leftJoinAndSelect('workHistory.localAdministrativeOrganization', 'localAdministrativeOrganizationWorkHistory')
      .leftJoinAndSelect('workHistory.governmentAgencies', 'governmentAgencies')
      .leftJoinAndSelect('workHistory.workStatus', 'workStatus')
      .leftJoinAndSelect('projectGroup.responsibleAgency', 'responsibleAgency')
      .leftJoinAndSelect('projectGroup.originAgencyId', 'originAgencyId')
      .leftJoinAndSelect('originAgencyId.amphoe', 'originAgencyAmphoe')
      .leftJoinAndSelect('projectGroup.favorites', 'favorites')
      .leftJoinAndSelect('favorites.userId', 'userId')
      // Left join เพื่อหา revised projects
      .leftJoin(
        RevisedProjectGroup,
        'revisedProjects',
        'revisedProjects.projectGroup = projectGroup.id',
      )
      .leftJoin(
        DevelopmentPlanRevision,
        'activeRevision',
        'activeRevision.id = revisedProjects.developmentPlanRevision AND activeRevision.isLatest = true',
      )
      .andWhere('projectGroup.isDraft = :isDraft', { isDraft: false })
      .andWhere('trackingStatus.isLatest = :isLatest', { isLatest: true })
      .andWhere('status.name = :statusName', { statusName: 'Approved' })
      .andWhere('projectGroup.responsibleAgency IS NOT NULL')
      .andWhere('projectGroup.isBooked = :isBooked', { isBooked: true })
      .andWhere('developmentPlan.id = :developmentPlanId', { developmentPlanId })
      // ไม่มี active revision
      .andWhere('activeRevision.id IS NULL');

    // Filter by responsible agency if provided
    if (responsibleAgencyId) {
      query.andWhere('projectGroup.responsibleAgency.id = :responsibleAgencyId', { responsibleAgencyId });
    }

    return await query.getMany();
  }

  /**
   * Query revised projects (RevisedProjectGroup) ที่เป็น latest version และ status = Approved
   */
  private async findRevisedApprovedProjects(
    developmentPlanId: string,
    responsibleAgencyId?: string,
  ): Promise<RevisedProjectGroup[]> {
    const query = this.revisedProjectGroupRepo
      .createQueryBuilder('revisedProject')
      .leftJoinAndSelect('revisedProject.developmentPlanRevision', 'developmentPlanRevision')
      .leftJoinAndSelect('developmentPlanRevision.developmentPlan', 'developmentPlan')
      .leftJoinAndSelect('revisedProject.developmentPlan', 'revisedDevelopmentPlan')
      .leftJoinAndSelect('revisedProject.projectGroup', 'originalProject')
      .leftJoinAndSelect('revisedProject.createdBy', 'createdBy')
      .leftJoinAndSelect('createdBy.user', 'createdByUser')
      .leftJoinAndSelect('createdBy.amphoe', 'amphoe')
      .leftJoinAndSelect('createdBy.localAdministrativeOrganization', 'localAdministrativeOrganization')
      .leftJoinAndSelect('revisedProject.amphoe', 'revisedAmphoe')
      .leftJoinAndSelect('revisedProject.localAdministrativeOrganization', 'revisedLocalAdministrativeOrganization')
      .leftJoinAndSelect('revisedProject.strategy', 'strategy')
      .leftJoinAndSelect('revisedProject.tactic', 'tactic')
      .leftJoinAndSelect('revisedProject.plan', 'plan')
      .leftJoinAndSelect('revisedProject.budgets', 'budgets')
      .leftJoinAndSelect('revisedProject.trackingStatus', 'trackingStatus')
      .leftJoinAndSelect('trackingStatus.statusId', 'status')
      .leftJoinAndSelect('trackingStatus.comments', 'comments')
      .leftJoinAndSelect('trackingStatus.createdBy', 'workHistory')
      .leftJoinAndSelect('workHistory.user', 'user')
      .leftJoinAndSelect('workHistory.localAdministrativeOrganization', 'localAdministrativeOrganizationWorkHistory')
      .leftJoinAndSelect('workHistory.governmentAgencies', 'governmentAgencies')
      .leftJoinAndSelect('workHistory.workStatus', 'workStatus')
      .leftJoinAndSelect('revisedProject.responsibleAgency', 'responsibleAgency')
      .leftJoinAndSelect('revisedProject.originAgencyId', 'originAgencyId')
      .leftJoinAndSelect('originAgencyId.amphoe', 'originAgencyAmphoe')
      .andWhere('developmentPlanRevision.isLatest = :isLatest', { isLatest: true })
      .andWhere('trackingStatus.isLatest = :isLatest', { isLatest: true })
      .andWhere('status.name = :statusName', { statusName: 'Approved' })
      .andWhere('revisedProject.responsibleAgency IS NOT NULL')
      .andWhere('developmentPlan.id = :developmentPlanId', { developmentPlanId })
      // Revised Project จะสร้างได้ก็ต่อเมื่อ Original Project ผ่านการอนุมัติและเข้าเล่มแล้ว
      // ดังนั้นต้องตรวจสอบว่า original project มี isBooked = true
      // ถ้าไม่มี original project ก็อนุญาต (กรณี standalone revised project)
      .andWhere('(originalProject.id IS NULL OR originalProject.isBooked = :isBooked)', { isBooked: true });

    // Filter by responsible agency if provided
    if (responsibleAgencyId) {
      query.andWhere('revisedProject.responsibleAgency.id = :responsibleAgencyId', { responsibleAgencyId });
    }

    return await query.getMany();
  }


  /**
   * หาโครงการต้นฉบับ (ProjectGroup) ที่ไม่มี active revision
   * กรองเฉพาะ status = "Approved"
   */
  private async findOriginalLatestProjects(
    developmentPlanId: string,
    status?: string,
  ): Promise<ProjectGroup[]> {
    const query = this.projectGroupRepo
      .createQueryBuilder('projectGroup')
      .leftJoinAndSelect('projectGroup.createdBy', 'createdBy')
      .leftJoinAndSelect('createdBy.user', 'createdByUser')
      .leftJoinAndSelect('createdBy.amphoe', 'amphoe')
      .leftJoinAndSelect('createdBy.localAdministrativeOrganization', 'localAdministrativeOrganization')
      .leftJoinAndSelect('projectGroup.strategy', 'strategy')
      .leftJoinAndSelect('projectGroup.tactic', 'tactic')
      .leftJoinAndSelect('projectGroup.plan', 'plan')
      .leftJoinAndSelect('projectGroup.developmentIssue', 'developmentIssue')
      .leftJoinAndSelect('projectGroup.developmentPlan', 'developmentPlan')
      .leftJoinAndSelect('projectGroup.budgets', 'budgets')
      .leftJoinAndSelect('projectGroup.trackingStatus', 'trackingStatus')
      .leftJoinAndSelect('trackingStatus.statusId', 'status')
      .leftJoinAndSelect('trackingStatus.comments', 'comments')
      .leftJoinAndSelect('trackingStatus.createdBy', 'workHistory')
      .leftJoinAndSelect('workHistory.user', 'user')
      .leftJoinAndSelect('workHistory.localAdministrativeOrganization', 'localAdministrativeOrganizationWorkHistory')
      .leftJoinAndSelect('workHistory.governmentAgencies', 'governmentAgencies')
      .leftJoinAndSelect('workHistory.workStatus', 'workStatus')
      .leftJoinAndSelect('projectGroup.responsibleAgency', 'responsibleAgency')
      .leftJoinAndSelect('projectGroup.originAgencyId', 'originAgencyId')
      .leftJoinAndSelect('originAgencyId.amphoe', 'originAgencyAmphoe')
      .leftJoinAndSelect('projectGroup.amphoe', 'projectAmphoe')
      .leftJoinAndSelect('projectGroup.localAdministrativeOrganization', 'projectLocalAdministrativeOrganization')
      .leftJoinAndSelect('projectGroup.favorites', 'favorites')
      .leftJoinAndSelect('favorites.userId', 'userId')
      // Left join เพื่อหา revised projects
      .leftJoin(
        RevisedProjectGroup,
        'revisedProjects',
        'revisedProjects.projectGroup = projectGroup.id',
      )
      .leftJoin(
        DevelopmentPlanRevision,
        'activeRevision',
        'activeRevision.id = revisedProjects.developmentPlanRevision AND activeRevision.isLatest = true',
      )
      .andWhere('projectGroup.isDraft = :isDraft', { isDraft: false })
      .andWhere('trackingStatus.isLatest = :isLatest', { isLatest: true })
      .andWhere('developmentPlan.id = :developmentPlanId', { developmentPlanId });

    if (status) {
      query.andWhere('status.name = :statusName', { statusName: status });
    }

    query
      // ไม่มี active revision
      .andWhere('activeRevision.id IS NULL');

    return await query.getMany();
  }

  /**
   * หาโครงการฉบับแก้ไข (RevisedProjectGroup) ที่เป็น version ล่าสุด
   * ใช้ developmentPlanRevision.isLatest เพื่อหา latest revision
   * ไม่กรองสถานะ - แสดงทุกสถานะ
   */
  private async findRevisedLatestProjects(
    developmentPlanId: string,
    status?: string,
  ): Promise<RevisedProjectGroup[]> {
    const query = this.revisedProjectGroupRepo
      .createQueryBuilder('revisedProject')
      .leftJoinAndSelect('revisedProject.developmentPlanRevision', 'developmentPlanRevision')
      .leftJoinAndSelect('developmentPlanRevision.revisionType', 'revisionType')
      .leftJoinAndSelect('revisedProject.developmentPlan', 'developmentPlan')
      .leftJoinAndSelect('revisedProject.projectGroup', 'originalProject')
      .leftJoinAndSelect('revisedProject.createdBy', 'createdBy')
      .leftJoinAndSelect('createdBy.user', 'createdByUser')
      .leftJoinAndSelect('createdBy.amphoe', 'amphoe')
      .leftJoinAndSelect('createdBy.localAdministrativeOrganization', 'localAdministrativeOrganization')
      .leftJoinAndSelect('revisedProject.amphoe', 'revisedAmphoe')
      .leftJoinAndSelect('revisedProject.localAdministrativeOrganization', 'revisedLocalAdministrativeOrganization')
      .leftJoinAndSelect('revisedProject.strategy', 'strategy')
      .leftJoinAndSelect('revisedProject.tactic', 'tactic')
      .leftJoinAndSelect('revisedProject.plan', 'plan')
      .leftJoinAndSelect('revisedProject.developmentIssue', 'developmentIssue')
      .leftJoinAndSelect('revisedProject.budgets', 'budgets')
      .leftJoinAndSelect('revisedProject.trackingStatus', 'trackingStatus')
      .leftJoinAndSelect('trackingStatus.statusId', 'status')
      .leftJoinAndSelect('trackingStatus.comments', 'comments')
      .leftJoinAndSelect('trackingStatus.createdBy', 'workHistory')
      .leftJoinAndSelect('workHistory.user', 'user')
      .leftJoinAndSelect('workHistory.localAdministrativeOrganization', 'localAdministrativeOrganizationWorkHistory')
      .leftJoinAndSelect('workHistory.governmentAgencies', 'governmentAgencies')
      .leftJoinAndSelect('workHistory.workStatus', 'workStatus')
      .leftJoinAndSelect('revisedProject.responsibleAgency', 'responsibleAgency')
      .leftJoinAndSelect('revisedProject.originAgencyId', 'originAgencyId')
      .leftJoinAndSelect('originAgencyId.amphoe', 'originAgencyAmphoe')
      .andWhere('trackingStatus.isLatest = :isLatest', { isLatest: true })
      .andWhere('developmentPlan.id = :developmentPlanId', { developmentPlanId });

    if (status) {
      query.andWhere('status.name = :statusName', { statusName: status });
    }

    return await query.getMany();
  }

  /**
 * หาโครงการล่าสุดทั้งหมด (ไม่กรองสถานะ)
 * ถ้าโครงการมีลูก → เอาลูกล่าสุดมา
 * ถ้าโครงการไม่มีลูก → เอาแม่มา
 */
  async findLatestProjects(option: {
    userId: string;
    countOnly?: boolean;
    developmentPlanId?: string;
    status?: string;
  }): Promise<IUnifiedProjectDisplay[] | number> {
    const { userId, countOnly, developmentPlanId, status } = option;

    // Validate user permissions
    const workHistory = await this.workHistoryRepo.findOne({
      where: { user: { id: userId } },
      relations: ['workStatus', 'role', 'localAdministrativeOrganization', 'governmentAgencies'],
    });

    if (!workHistory) return countOnly ? 0 : [];
    if (workHistory.workStatus.name !== 'approved')
      throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิในการเข้าถึงข้อมูล');

    const allowedRoles = ['user', 'staff', 'admin', 'super-admin', 'c-level'];
    if (!allowedRoles.includes(workHistory.role.name))
      throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิในการเข้าถึงข้อมูล');

    // Validate development plan
    if (!developmentPlanId) {
      throw new BadRequestException('Development plan ID is required');
    }

    const developmentPlan = await this.developmentPlanRepo.findOne({
      where: { id: developmentPlanId },
    });
    if (!developmentPlan)
      throw new NotFoundException('Development plan not found');

    // ดึง revision ล่าสุดของแต่ละ ProjectGroup
    let latestRevised = await this.findLatestRevisedProjectsAllStatus(developmentPlanId);

    // ดึง original ที่ไม่เคยถูก revise
    let original = await this.findOriginalWithoutRevisionAllStatus(developmentPlanId);

    // จำกัดการมองเห็นตามบทบาท
    if (workHistory.role.name === 'user') {
      const laoId = workHistory.localAdministrativeOrganization?.id;

      if (!laoId) {
        throw new UnauthorizedException('ไม่พบหน่วยงานของผู้ใช้');
      }

      if (laoId === '3001027') {
        const agencyId = workHistory.governmentAgencies?.id;
        if (!agencyId) {
          throw new UnauthorizedException('ไม่พบหน่วยงานของผู้ใช้');
        }

        const filterByAgency = (project: { id?: string; responsibleAgency?: { id?: string } | null }) => {
          const projectAgencyId = project.responsibleAgency?.id;
          // Convert both to string for comparison to handle type mismatches
          const projectAgencyIdStr = String(projectAgencyId);
          const agencyIdStr = String(agencyId);
          const matches = projectAgencyIdStr === agencyIdStr;
          return matches;
        };

        latestRevised = latestRevised.filter(filterByAgency);
        original = original.filter(filterByAgency);

      } else {
        latestRevised = [];
        original = [];
      }
    }

    if (countOnly) return latestRevised.length + original.length;

    // CLAUDE.md §14 — batched lineage-lock lookups for both sides so the UI
    // can lock any row that already has a descendant version.
    const [lockedPgIds, lockedRpgIds] = await Promise.all([
      this.findProjectGroupIdsWithDescendants(original.map((p) => p.id)),
      this.findRevisedProjectGroupIdsWithDescendants(latestRevised.map((r) => r.id)),
    ]);

    const unified = [
      ...latestRevised.map((x) =>
        UnifiedProjectMapper.fromRevisedProjectGroup(x, lockedRpgIds.has(x.id))
      ),
      ...original.map((x) =>
        UnifiedProjectMapper.fromProjectGroup(x, lockedPgIds.has(x.id))
      ),
    ];

    return unified;
  }

  /**
   * หาโครงการล่าสุดทั้งหมด (ไม่กรองสถานะ)
   * ถ้าโครงการมีลูก → เอาลูกล่าสุดมา
   * ถ้าโครงการไม่มีลูก → เอาแม่มา
   */
  async findLatestAllProjects(option: {
    userId: string;
    countOnly?: boolean;
    developmentPlanId?: string;
    status?: string;
  }): Promise<IUnifiedProjectDisplay[] | number> {
    const { userId, countOnly, developmentPlanId, status } = option;

    // Validate user permissions
    const workHistory = await this.workHistoryRepo.findOne({
      where: { user: { id: userId } },
      relations: ['workStatus', 'role', 'localAdministrativeOrganization', 'governmentAgencies'],
    });

    if (!workHistory) return countOnly ? 0 : [];
    if (workHistory.workStatus.name !== 'approved')
      throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิในการเข้าถึงข้อมูล');

    const allowedRoles = ['user', 'staff', 'admin', 'super-admin', 'c-level'];
    if (!allowedRoles.includes(workHistory.role.name))
      throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิในการเข้าถึงข้อมูล');

    // Validate development plan
    if (!developmentPlanId) {
      throw new BadRequestException('Development plan ID is required');
    }

    const developmentPlan = await this.developmentPlanRepo.findOne({
      where: { id: developmentPlanId },
    });
    if (!developmentPlan)
      throw new NotFoundException('Development plan not found');

    // ดึง revision ล่าสุดของแต่ละ ProjectGroup
    let latestRevised = await this.findLatestRevisedProjects(developmentPlanId);

    // ดึง original ที่ไม่เคยถูก revise
    let original = await this.findOriginalWithoutRevision(developmentPlanId);

    // จำกัดการมองเห็นตามบทบาท
    if (workHistory.role.name === 'user') {
      const laoId = workHistory.localAdministrativeOrganization?.id;

      if (!laoId) {
        throw new UnauthorizedException('ไม่พบหน่วยงานของผู้ใช้');
      }

      if (laoId === '3001027') {
        const agencyId = workHistory.governmentAgencies?.id;
        if (!agencyId) {
          throw new UnauthorizedException('ไม่พบหน่วยงานของผู้ใช้');
        }

        const filterByAgency = (project: { id?: string; responsibleAgency?: { id?: string } | null }) => {
          const projectAgencyId = project.responsibleAgency?.id;
          // Convert both to string for comparison to handle type mismatches
          const projectAgencyIdStr = String(projectAgencyId);
          const agencyIdStr = String(agencyId);
          const matches = projectAgencyIdStr === agencyIdStr;
          return matches;
        };

        latestRevised = latestRevised.filter(filterByAgency);
        original = original.filter(filterByAgency);

      } else {
        latestRevised = [];
        original = [];
      }
    }

    if (countOnly) return latestRevised.length + original.length;

    // CLAUDE.md §14 — batched lineage-lock lookups for both sides.
    const [lockedPgIds, lockedRpgIds] = await Promise.all([
      this.findProjectGroupIdsWithDescendants(original.map((p) => p.id)),
      this.findRevisedProjectGroupIdsWithDescendants(latestRevised.map((r) => r.id)),
    ]);

    const unified = [
      ...latestRevised.map((x) =>
        UnifiedProjectMapper.fromRevisedProjectGroup(x, lockedRpgIds.has(x.id))
      ),
      ...original.map((x) =>
        UnifiedProjectMapper.fromProjectGroup(x, lockedPgIds.has(x.id))
      ),
    ];

    return unified;
  }



  /**
   * หาโครงการล่าสุดทั้งหมด (ทุกแผนพัฒนา) สำหรับ role "user" เท่านั้น
   * และแสดงเฉพาะโครงการตาม localAdministrativeOrganization หรือ governmentAgencies ของผู้ใช้
   */
  async findLatestAllProjectsByUserAllPlans(option: {
    userId: string;
    countOnly?: boolean;
    developmentPlanId?: string;
  }): Promise<IUnifiedProjectDisplay[] | number> {
    const { userId, countOnly, developmentPlanId } = option;

    // Validate user permissions
    const workHistory = await this.workHistoryRepo.findOne({
      where: { user: { id: userId } },
      relations: [
        'workStatus',
        'role',
        'localAdministrativeOrganization',
        'governmentAgencies',
      ],
    });

    if (!workHistory) return countOnly ? 0 : [];
    if (workHistory.workStatus.name !== 'approved')
      throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิในการเข้าถึงข้อมูล');

    // จำกัดเฉพาะ role user เท่านั้น
    // if (workHistory.role.name !== 'user')
    //   throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิในการเข้าถึงข้อมูล');

    // ถ้ามี developmentPlanId ให้ query เฉพาะแผนพัฒนานั้น
    // ถ้าไม่มี ให้ query ทุกแผนพัฒนา
    let developmentPlans;
    if (developmentPlanId) {
      const plan = await this.developmentPlanRepo.findOne({
        where: { id: developmentPlanId },
      });
      developmentPlans = plan ? [plan] : [];
    } else {
      developmentPlans = await this.developmentPlanRepo.find();
    }

    if (!developmentPlans || developmentPlans.length === 0) {
      return countOnly ? 0 : [];
    }

    // helper สำหรับกรองตามหน่วยงานของ user
    const filterByUserAgency = (project: ProjectGroup | RevisedProjectGroup) => {
      if (workHistory.governmentAgencies) {
        // ผู้ใช้สังกัดหน่วยงานส่วนราชการ -> ดูตาม responsibleAgency
        return project.responsibleAgency?.id === workHistory.governmentAgencies.id;
      }

      // ผู้ใช้สังกัดองค์กรปกครองส่วนท้องถิ่น -> ดูตาม originAgency/localAdministrativeOrganization
      const projectOriginId =
        (project as any).originAgencyId?.id ??
        (project as any).localAdministrativeOrganization?.id ??
        null;

      return (
        !!projectOriginId &&
        projectOriginId === workHistory.localAdministrativeOrganization.id
      );
    };

    let totalCount = 0;
    const allLatestRevised: RevisedProjectGroup[] = [];
    const allOriginal: ProjectGroup[] = [];

    for (const dp of developmentPlans) {
      const developmentPlanId = dp.id;

      // ดึง revision ล่าสุดของแต่ละ ProjectGroup ในแผนนี้ (ไม่กรอง status)
      const latestRevisedAll = await this.findLatestRevisedProjects(
        developmentPlanId,
      );
      const latestRevised = latestRevisedAll.filter(filterByUserAgency);

      // ดึง original ที่ไม่เคยถูก revise ในแผนนี้ (ใช้ findOriginal ที่ไม่มีเงื่อนไข isBooked และ status)
      const originalAll = await this.findOriginal(
        developmentPlanId,
      );
      const original = originalAll.filter(filterByUserAgency);

      if (countOnly) {
        totalCount += latestRevised.length + original.length;
      } else {
        allLatestRevised.push(...latestRevised);
        allOriginal.push(...original);
      }
    }

    if (countOnly) return totalCount;

    // CLAUDE.md §14 — batched lineage-lock lookups for both sides (aggregated
    // across all plans in one round-trip each).
    const [lockedPgIds, lockedRpgIds] = await Promise.all([
      this.findProjectGroupIdsWithDescendants(allOriginal.map((p) => p.id)),
      this.findRevisedProjectGroupIdsWithDescendants(allLatestRevised.map((r) => r.id)),
    ]);

    const unified = [
      ...allLatestRevised.map((x) =>
        UnifiedProjectMapper.fromRevisedProjectGroup(x, lockedRpgIds.has(x.id))
      ),
      ...allOriginal.map((x) =>
        UnifiedProjectMapper.fromProjectGroup(x, lockedPgIds.has(x.id))
      ),
    ];

    return unified;
  }
  /**
 * หาโครงการล่าสุดทั้งหมด (ไม่กรองสถานะ)
 * ถ้าโครงการมีลูก → เอาลูกล่าสุดมา
 * ถ้าโครงการไม่มีลูก → เอาแม่มา
 */
  async findLatestAllProjectsStatus(option: {
    userId: string;
    countOnly?: boolean;
    developmentPlanId?: string;
  }): Promise<IUnifiedProjectDisplay[] | number> {
    const { userId, countOnly, developmentPlanId } = option;

    // Validate user permissions
    const workHistory = await this.workHistoryRepo.findOne({
      where: { user: { id: userId } },
      relations: ['workStatus', 'role', 'localAdministrativeOrganization', 'governmentAgencies'],
    });

    if (!workHistory) return countOnly ? 0 : [];
    if (workHistory.workStatus.name !== 'approved')
      throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิในการเข้าถึงข้อมูล');

    const allowedRoles = ['user', 'staff', 'admin', 'super-admin', 'c-level'];
    if (!allowedRoles.includes(workHistory.role.name))
      throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิในการเข้าถึงข้อมูล');

    // Validate development plan
    if (!developmentPlanId) {
      throw new BadRequestException('Development plan ID is required');
    }

    const developmentPlan = await this.developmentPlanRepo.findOne({
      where: { id: developmentPlanId },
    });
    if (!developmentPlan)
      throw new NotFoundException('Development plan not found');
    // ดึง revision ล่าสุดของแต่ละ ProjectGroup
    const latestRevised = await this.findLatestRevisedProjects(developmentPlanId);

    // ดึง original ที่ไม่เคยถูก revise
    const original = await this.findOriginalWithAllRevision(developmentPlanId);

    if (countOnly) return latestRevised.length + original.length;

    // CLAUDE.md §14 — batched lineage-lock lookups for both sides.
    const [lockedPgIds, lockedRpgIds] = await Promise.all([
      this.findProjectGroupIdsWithDescendants(original.map((p) => p.id)),
      this.findRevisedProjectGroupIdsWithDescendants(latestRevised.map((r) => r.id)),
    ]);

    const unified = [
      ...latestRevised.map((x) =>
        UnifiedProjectMapper.fromRevisedProjectGroup(x, lockedRpgIds.has(x.id))
      ),
      ...original.map((x) =>
        UnifiedProjectMapper.fromProjectGroup(x, lockedPgIds.has(x.id))
      ),
    ];

    return unified;
  }

  async findLatestAllProjectsApproved(option: {
    userId: string;
    countOnly?: boolean;
    developmentPlanId?: string;
  }): Promise<IUnifiedProjectDisplay[] | number> {
    const { userId, countOnly, developmentPlanId } = option;

    // Validate user permissions
    const workHistory = await this.workHistoryRepo.findOne({
      where: { user: { id: userId } },
      relations: ['workStatus', 'role', 'localAdministrativeOrganization', 'governmentAgencies'],
    });

    if (!workHistory) return countOnly ? 0 : [];
    if (workHistory.workStatus.name !== 'approved')
      throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิในการเข้าถึงข้อมูล');

    const allowedRoles = ['user', 'staff', 'admin', 'super-admin', 'c-level'];
    if (!allowedRoles.includes(workHistory.role.name))
      throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิในการเข้าถึงข้อมูล');

    // Validate development plan
    if (!developmentPlanId) {
      throw new BadRequestException('Development plan ID is required');
    }

    const developmentPlan = await this.developmentPlanRepo.findOne({
      where: { id: developmentPlanId },
    });
    if (!developmentPlan)
      throw new NotFoundException('Development plan not found');
    // ดึง revision ล่าสุดของแต่ละ ProjectGroup
    let latestRevised = await this.findLatestRevisedProjects(developmentPlanId, 'Approved', true);

    // ดึง original ที่ไม่เคยถูก revise
    let original = await this.findOriginalWithoutRevision(developmentPlanId, 'Approved', true);

    // จำกัดการมองเห็นตามบทบาท
    if (workHistory.role.name === 'user') {
      const laoId = workHistory.localAdministrativeOrganization?.id;

      if (!laoId) {
        throw new UnauthorizedException('ไม่พบหน่วยงานของผู้ใช้');
      }

      if (laoId === '3001027') {
        const agencyId = workHistory.governmentAgencies?.id;
        if (!agencyId) {
          throw new UnauthorizedException('ไม่พบหน่วยงานของผู้ใช้');
        }

        const filterByAgency = (project: { id?: string; responsibleAgency?: { id?: string } | null }) => {
          const projectAgencyId = project.responsibleAgency?.id;
          // Convert both to string for comparison to handle type mismatches
          const projectAgencyIdStr = String(projectAgencyId);
          const agencyIdStr = String(agencyId);
          return projectAgencyIdStr === agencyIdStr;
        };

        latestRevised = latestRevised.filter(filterByAgency);
        original = original.filter(filterByAgency);
      } else {
        latestRevised = [];
        original = [];
      }
    }

    if (countOnly) return latestRevised.length + original.length;

    // CLAUDE.md §14 — batched lineage-lock lookups. This endpoint powers the
    // Revision picker; an approved PG that already has a descendant must
    // surface as locked so FE-LOCK-06 can disable fork actions.
    const [lockedPgIds, lockedRpgIds] = await Promise.all([
      this.findProjectGroupIdsWithDescendants(original.map((p) => p.id)),
      this.findRevisedProjectGroupIdsWithDescendants(latestRevised.map((r) => r.id)),
    ]);

    const unified = [
      ...latestRevised.map((x) =>
        UnifiedProjectMapper.fromRevisedProjectGroup(x, lockedRpgIds.has(x.id))
      ),
      ...original.map((x) =>
        UnifiedProjectMapper.fromProjectGroup(x, lockedPgIds.has(x.id))
      ),
    ];

    return unified;
  }

  async findOutAuthorityByPdf(options: { id: string, userId: string }): Promise<ProjectGroup[]> {
    const { id, userId } = options;

    // Find PDF document by id
    const pdf = await this.pdfOutAuthorityRepo.findOne({ where: { id } });
    if (!pdf) throw new NotFoundException('PDF document not found');

    // Get project IDs from snapshot
    const projectIds = pdf.projectIdsSnapshot || [];
    if (projectIds.length === 0) return [];

    // Validate user access
    const workHistory = await this.workHistoryRepo.findOne({
      where: { user: { id: userId }, isCurrent: true },
      relations: [
        'user',
        'role',
        'localAdministrativeOrganization',
        'governmentAgencies',
        'workStatus',
        'workHistoryResponsibleAmphoe',
        'workHistoryResponsibleAmphoe.amphoe',
      ],
    });
    if (!workHistory) throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิในการเข้าถึงข้อมูล');
    if (workHistory.workStatus.name !== "approved")
      throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิในการเข้าถึงข้อมูล');

    // Query projects by IDs from snapshot
    const projects = await this.projectGroupRepo
      .createQueryBuilder('projectGroup')
      .leftJoinAndSelect('projectGroup.createdBy', 'createdBy')
      .leftJoinAndSelect('createdBy.user', 'createdByUser')
      .leftJoinAndSelect('createdBy.amphoe', 'amphoe')
      .leftJoinAndSelect('createdBy.localAdministrativeOrganization', 'localAdministrativeOrganization')
      .leftJoinAndSelect('projectGroup.strategy', 'strategy')
      .leftJoinAndSelect('projectGroup.tactic', 'tactic')
      .leftJoinAndSelect('projectGroup.plan', 'plan')
      .leftJoinAndSelect('projectGroup.developmentPlan', 'developmentPlan')
      .leftJoinAndSelect('projectGroup.budgets', 'budgets')
      .leftJoinAndSelect('projectGroup.trackingStatus', 'trackingStatus')
      .leftJoinAndSelect('trackingStatus.statusId', 'status')
      .leftJoinAndSelect('trackingStatus.comments', 'comments')
      .leftJoinAndSelect('trackingStatus.createdBy', 'workHistory')
      .leftJoinAndSelect('workHistory.user', 'user')
      .leftJoinAndSelect('workHistory.localAdministrativeOrganization', 'localAdministrativeOrganizationWorkHistory')
      .leftJoinAndSelect('workHistory.governmentAgencies', 'governmentAgencies')
      .leftJoinAndSelect('workHistory.workStatus', 'workStatus')
      .leftJoinAndSelect('projectGroup.responsibleAgency', 'responsibleAgency')
      .leftJoinAndSelect('projectGroup.originAgencyId', 'originAgencyId')
      .leftJoinAndSelect('originAgencyId.amphoe', 'originAgencyAmphoe')
      .leftJoinAndSelect('projectGroup.favorites', 'favorites')
      .leftJoinAndSelect('favorites.userId', 'userId')
      .where('projectGroup.id IN (:...projectIds)', { projectIds })
      .orderBy('projectGroup.createdAt', 'DESC')
      .getMany();

    return projects;
  }
  private async findLatestRevisedProjectsAllStatus(
    developmentPlanId: string,
    status?: string,
    isBooked?: boolean,
  ): Promise<RevisedProjectGroup[]> {
    // subquery เลือก revision ล่าสุดของแต่ละ projectGroup
    // 1. SubQuery: หา revisionNumber สูงสุด ของแต่ละ Project Group ID ภายใต้แผนนี้
    const maxRevisionSubQuery = this.revisedProjectGroupRepo
      .createQueryBuilder('rp_sub')
      .select('rp_sub.project_group_id', 'projectGroupId')
      .addSelect('MAX(dpr_sub.revisionNumber)', 'maxRevision')
      .leftJoin('rp_sub.developmentPlanRevision', 'dpr_sub')
      .where('rp_sub.development_plan_id = :planId', { planId: developmentPlanId })
      .groupBy('rp_sub.project_group_id');

    // 2. Main Query
    const query = this.revisedProjectGroupRepo
      .createQueryBuilder('revisedProject')
      .leftJoinAndSelect('revisedProject.developmentPlanRevision', 'developmentPlanRevision')
      .leftJoinAndSelect('developmentPlanRevision.revisionType', 'revisionType')
      .leftJoinAndSelect('revisedProject.developmentPlan', 'developmentPlan')
      .leftJoinAndSelect('revisedProject.projectGroup', 'originalProject')
      .leftJoinAndSelect('revisedProject.createdBy', 'createdBy')
      .leftJoinAndSelect('createdBy.user', 'createdByUser')
      .leftJoinAndSelect('createdBy.amphoe', 'amphoe')
      .leftJoinAndSelect('createdBy.localAdministrativeOrganization', 'localAdministrativeOrganization')
      .leftJoinAndSelect('revisedProject.amphoe', 'revisedAmphoe')
      .leftJoinAndSelect('revisedProject.localAdministrativeOrganization', 'revisedLocalAdministrativeOrganization')
      .leftJoinAndSelect('revisedProject.strategy', 'strategy')
      .leftJoinAndSelect('revisedProject.tactic', 'tactic')
      .leftJoinAndSelect('revisedProject.plan', 'plan')
      .leftJoinAndSelect('revisedProject.budgets', 'budgets')
      .leftJoinAndSelect('revisedProject.trackingStatus', 'trackingStatus')
      .leftJoinAndSelect('trackingStatus.statusId', 'status')
      .leftJoinAndSelect('trackingStatus.comments', 'comments')
      .leftJoinAndSelect('trackingStatus.createdBy', 'workHistory')
      .leftJoinAndSelect('workHistory.user', 'user')
      .leftJoinAndSelect('workHistory.localAdministrativeOrganization', 'localAdministrativeOrganizationWorkHistory')
      .leftJoinAndSelect('workHistory.governmentAgencies', 'governmentAgencies')
      .leftJoinAndSelect('workHistory.workStatus', 'workStatus')
      .leftJoinAndSelect('revisedProject.responsibleAgency', 'responsibleAgency')
      .leftJoinAndSelect('revisedProject.originAgencyId', 'originAgencyId')
      .leftJoinAndSelect('originAgencyId.amphoe', 'originAgencyAmphoe')
      .leftJoinAndSelect('revisedProject.favorites', 'favorites')
      .leftJoinAndSelect('favorites.userId', 'userId')
      .leftJoinAndSelect('revisedProject.attachments', 'attachments')

      // ** KEY LOGIC: Inner Join กับ SubQuery เพื่อกรองเอาเฉพาะตัวล่าสุด **
      .innerJoin(
        '(' + maxRevisionSubQuery.getQuery() + ')',
        'max_rev_table',
        '"revisedProject"."project_group_id" = max_rev_table."projectGroupId" AND "developmentPlanRevision"."revision_number" = max_rev_table."maxRevision"'
      )
      .setParameters(maxRevisionSubQuery.getParameters())

      .andWhere('revisedProject.development_plan_id = :developmentPlanId', { developmentPlanId })
      .andWhere('trackingStatus.isLatest = :isLatest', { isLatest: true });

    if (status) {
      query.andWhere('status.name = :statusName', { statusName: status });
    }

    return await query.getMany();
  }

  private async findLatestRevisedProjects(
    developmentPlanId: string,
    status?: string,
    isBooked?: boolean,
  ): Promise<RevisedProjectGroup[]> {
    // subquery เลือก revision ล่าสุดของแต่ละ projectGroup
    // 1. SubQuery: หา revisionNumber สูงสุด ของแต่ละ Project Group ID ภายใต้แผนนี้
    const maxRevisionSubQuery = this.revisedProjectGroupRepo
      .createQueryBuilder('rp_sub')
      .select('rp_sub.project_group_id', 'projectGroupId')
      .addSelect('MAX(dpr_sub.revisionNumber)', 'maxRevision')
      .leftJoin('rp_sub.developmentPlanRevision', 'dpr_sub')
      .where('rp_sub.development_plan_id = :planId', { planId: developmentPlanId })
      .groupBy('rp_sub.project_group_id');

    // 2. Main Query
    const query = this.revisedProjectGroupRepo
      .createQueryBuilder('revisedProject')
      .leftJoinAndSelect('revisedProject.developmentPlanRevision', 'developmentPlanRevision')
      .leftJoinAndSelect('developmentPlanRevision.revisionType', 'revisionType')
      .leftJoinAndSelect('revisedProject.developmentPlan', 'developmentPlan')
      .leftJoinAndSelect('revisedProject.projectGroup', 'originalProject')
      .leftJoinAndSelect('revisedProject.createdBy', 'createdBy')
      .leftJoinAndSelect('createdBy.user', 'createdByUser')
      .leftJoinAndSelect('createdBy.amphoe', 'amphoe')
      .leftJoinAndSelect('createdBy.localAdministrativeOrganization', 'localAdministrativeOrganization')
      .leftJoinAndSelect('revisedProject.amphoe', 'revisedAmphoe')
      .leftJoinAndSelect('revisedProject.localAdministrativeOrganization', 'revisedLocalAdministrativeOrganization')
      .leftJoinAndSelect('revisedProject.strategy', 'strategy')
      .leftJoinAndSelect('revisedProject.tactic', 'tactic')
      .leftJoinAndSelect('revisedProject.plan', 'plan')
      .leftJoinAndSelect('revisedProject.budgets', 'budgets')
      .leftJoinAndSelect('revisedProject.trackingStatus', 'trackingStatus')
      .leftJoinAndSelect('trackingStatus.statusId', 'status')
      .leftJoinAndSelect('trackingStatus.comments', 'comments')
      .leftJoinAndSelect('trackingStatus.createdBy', 'workHistory')
      .leftJoinAndSelect('workHistory.user', 'user')
      .leftJoinAndSelect('workHistory.localAdministrativeOrganization', 'localAdministrativeOrganizationWorkHistory')
      .leftJoinAndSelect('workHistory.governmentAgencies', 'governmentAgencies')
      .leftJoinAndSelect('workHistory.workStatus', 'workStatus')
      .leftJoinAndSelect('revisedProject.responsibleAgency', 'responsibleAgency')
      .leftJoinAndSelect('revisedProject.originAgencyId', 'originAgencyId')
      .leftJoinAndSelect('originAgencyId.amphoe', 'originAgencyAmphoe')
      .leftJoinAndSelect('revisedProject.favorites', 'favorites')
      .leftJoinAndSelect('favorites.userId', 'userId')
      .leftJoinAndSelect('revisedProject.attachments', 'attachments')

      // ** KEY LOGIC: Inner Join กับ SubQuery เพื่อกรองเอาเฉพาะตัวล่าสุด **
      .innerJoin(
        '(' + maxRevisionSubQuery.getQuery() + ')',
        'max_rev_table',
        '"revisedProject"."project_group_id" = max_rev_table."projectGroupId" AND "developmentPlanRevision"."revision_number" = max_rev_table."maxRevision"'
      )
      .setParameters(maxRevisionSubQuery.getParameters())

      .andWhere('revisedProject.development_plan_id = :developmentPlanId', { developmentPlanId })
      .andWhere('trackingStatus.isLatest = :isLatest', { isLatest: true });

    if (status) {
      query.andWhere('status.name = :statusName', { statusName: status });
    }

    return await query.getMany();
  }

  private async findOriginalWithoutRevisionAllStatus(
    developmentPlanId: string,
    status?: string,
    isBooked?: boolean,
  ): Promise<ProjectGroup[]> {
    const queryBuilder = this.projectGroupRepo
      .createQueryBuilder('pg')
      .leftJoin(RevisedProjectGroup, 'rp', 'rp.project_group_id = pg.id')
      .leftJoin(DevelopmentPlanRevision, 'rev', 'rev.id = rp.development_plan_revision_id')
      .leftJoinAndSelect('pg.strategy', 'strategy')
      .leftJoinAndSelect('pg.tactic', 'tactic')
      .leftJoinAndSelect('pg.plan', 'plan')
      .leftJoinAndSelect('pg.developmentPlan', 'developmentPlan')
      .leftJoinAndSelect('pg.createdBy', 'createdBy')
      .leftJoinAndSelect('pg.originAgencyId', 'originAgencyId')
      .leftJoinAndSelect('originAgencyId.amphoe', 'originAgencyAmphoe')
      .leftJoinAndSelect('pg.responsibleAgency', 'responsibleAgency')
      .leftJoinAndSelect('pg.amphoe', 'amphoe')
      .leftJoinAndSelect('pg.localAdministrativeOrganization', 'localAdministrativeOrganization')
      .leftJoinAndSelect('pg.budgets', 'budgets')
      .leftJoinAndSelect('pg.favorites', 'favorites')
      .leftJoinAndSelect('pg.trackingStatus', 'trackingStatus')
      .leftJoinAndSelect('trackingStatus.statusId', 'status')
      .leftJoinAndSelect('pg.attachments', 'attachments')
      .where('pg.development_plan_id = :developmentPlanId', { developmentPlanId })
      .andWhere('rev.id IS NULL')   // ไม่มี revision
      .andWhere('pg.isDraft = false')
      .andWhere('trackingStatus.isLatest = :isLatest', { isLatest: true })
      .andWhere('status.name <> :statusName', { statusName: 'Ready' })
      .andWhere('status.name <> :statusName', { statusName: 'Revision' })
    // .andWhere('pg.isBooked = :isBooked', { isBooked: true });

    return await queryBuilder.getMany();
  }
  private async findOriginalWithoutRevision(
    developmentPlanId: string,
    status?: string,
    isBooked?: boolean,
  ): Promise<ProjectGroup[]> {
    const queryBuilder = this.projectGroupRepo
      .createQueryBuilder('pg')
      .leftJoin(RevisedProjectGroup, 'rp', 'rp.project_group_id = pg.id')
      .leftJoin(DevelopmentPlanRevision, 'rev', 'rev.id = rp.development_plan_revision_id')
      .leftJoinAndSelect('pg.strategy', 'strategy')
      .leftJoinAndSelect('pg.tactic', 'tactic')
      .leftJoinAndSelect('pg.plan', 'plan')
      .leftJoinAndSelect('pg.developmentPlan', 'developmentPlan')
      .leftJoinAndSelect('pg.createdBy', 'createdBy')
      .leftJoinAndSelect('pg.originAgencyId', 'originAgencyId')
      .leftJoinAndSelect('originAgencyId.amphoe', 'originAgencyAmphoe')
      .leftJoinAndSelect('pg.responsibleAgency', 'responsibleAgency')
      .leftJoinAndSelect('pg.amphoe', 'amphoe')
      .leftJoinAndSelect('pg.localAdministrativeOrganization', 'localAdministrativeOrganization')
      .leftJoinAndSelect('pg.budgets', 'budgets')
      .leftJoinAndSelect('pg.favorites', 'favorites')
      .leftJoinAndSelect('pg.trackingStatus', 'trackingStatus')
      .leftJoinAndSelect('trackingStatus.statusId', 'status')
      .where('pg.development_plan_id = :developmentPlanId', { developmentPlanId })
      .andWhere('rev.id IS NULL')   // ไม่มี revision
      .andWhere('pg.isDraft = false')
      .andWhere('trackingStatus.isLatest = :isLatest', { isLatest: true })
      .andWhere('status.name = :statusName', { statusName: 'Approved' })
      .andWhere('pg.isBooked = :isBooked', { isBooked: true });

    return await queryBuilder.getMany();
  }

  private async findOriginalWithAllRevision(
    developmentPlanId: string,
  ): Promise<ProjectGroup[]> {
    const queryBuilder = this.projectGroupRepo
      .createQueryBuilder('pg')
      .leftJoin(RevisedProjectGroup, 'rp', 'rp.project_group_id = pg.id')
      .leftJoin(DevelopmentPlanRevision, 'rev', 'rev.id = rp.development_plan_revision_id')
      .leftJoinAndSelect('pg.strategy', 'strategy')
      .leftJoinAndSelect('pg.tactic', 'tactic')
      .leftJoinAndSelect('pg.plan', 'plan')
      .leftJoinAndSelect('pg.developmentPlan', 'developmentPlan')
      .leftJoinAndSelect('pg.createdBy', 'createdBy')
      .leftJoinAndSelect('pg.originAgencyId', 'originAgencyId')
      .leftJoinAndSelect('originAgencyId.amphoe', 'originAgencyAmphoe')
      .leftJoinAndSelect('pg.responsibleAgency', 'responsibleAgency')
      .leftJoinAndSelect('pg.amphoe', 'amphoe')
      .leftJoinAndSelect('pg.localAdministrativeOrganization', 'localAdministrativeOrganization')
      .leftJoinAndSelect('pg.budgets', 'budgets')
      .leftJoinAndSelect('pg.favorites', 'favorites')
      .leftJoinAndSelect('pg.trackingStatus', 'trackingStatus')
      .leftJoinAndSelect('trackingStatus.statusId', 'status')
      .leftJoinAndSelect('pg.attachments', 'attachments')
      .where('pg.development_plan_id = :developmentPlanId', { developmentPlanId })
      .andWhere('rev.id IS NULL')
      .andWhere('pg.isDraft = false')
      .andWhere('trackingStatus.isLatest = :isLatest', { isLatest: true })
      .andWhere('pg.isBooked = :isBooked', { isBooked: true });

    return await queryBuilder.getMany();
  }

  /**
   * หา original projects ที่ไม่เคยถูก revise (ไม่มีเงื่อนไข isBooked)
   */
  private async findOriginal(
    developmentPlanId: string,
  ): Promise<ProjectGroup[]> {
    const queryBuilder = this.projectGroupRepo
      .createQueryBuilder('pg')
      .leftJoin(RevisedProjectGroup, 'rp', 'rp.project_group_id = pg.id')
      .leftJoin(DevelopmentPlanRevision, 'rev', 'rev.id = rp.development_plan_revision_id')
      .leftJoinAndSelect('pg.strategy', 'strategy')
      .leftJoinAndSelect('pg.tactic', 'tactic')
      .leftJoinAndSelect('pg.plan', 'plan')
      .leftJoinAndSelect('pg.developmentPlan', 'developmentPlan')
      .leftJoinAndSelect('pg.createdBy', 'createdBy')
      .leftJoinAndSelect('createdBy.user', 'createdByUser')
      .leftJoinAndSelect('createdBy.amphoe', 'createdByAmphoe')
      .leftJoinAndSelect('createdBy.localAdministrativeOrganization', 'createdByLocalAdministrativeOrganization')
      .leftJoinAndSelect('pg.originAgencyId', 'originAgencyId')
      .leftJoinAndSelect('originAgencyId.amphoe', 'originAgencyAmphoe')
      .leftJoinAndSelect('pg.responsibleAgency', 'responsibleAgency')
      .leftJoinAndSelect('pg.amphoe', 'amphoe')
      .leftJoinAndSelect('pg.localAdministrativeOrganization', 'localAdministrativeOrganization')
      .leftJoinAndSelect('pg.budgets', 'budgets')
      .leftJoinAndSelect('pg.favorites', 'favorites')
      .leftJoinAndSelect('favorites.userId', 'userId')
      .leftJoinAndSelect('pg.trackingStatus', 'trackingStatus')
      .leftJoinAndSelect('pg.attachments', 'attachments')
      .leftJoinAndSelect('trackingStatus.statusId', 'status')
      .leftJoinAndSelect('trackingStatus.createdBy', 'workHistory')
      .leftJoinAndSelect('workHistory.user', 'workHistoryUser')
      .leftJoinAndSelect('workHistory.localAdministrativeOrganization', 'workHistoryLocalAdministrativeOrganization')
      .leftJoinAndSelect('workHistory.governmentAgencies', 'workHistoryGovernmentAgencies')
      .leftJoinAndSelect('workHistory.workStatus', 'workStatus')

      .where('pg.development_plan_id = :developmentPlanId', { developmentPlanId })
      .andWhere('rev.id IS NULL')   // ไม่มี revision
      .andWhere('pg.isDraft = false')
      .andWhere('trackingStatus.isLatest = :isLatest', { isLatest: true });
    // ไม่มีเงื่อนไข isBooked และ status

    return await queryBuilder.getMany();
  }



  /**
 * หาโครงการล่าสุดทั้งหมด (กรองสถานะ = Approved)
 * ถ้าโครงการมีลูก → เอาลูกล่าสุดมา
 * ถ้าโครงการไม่มีลูก → เอาแม่มา
 */
  async findLatestAllApprovedProjects(option: {
    userId: string;
    countOnly?: boolean;
    developmentPlanId?: string;
    status?: string;
  }): Promise<any[] | number> {
    const { userId, countOnly, developmentPlanId, status = 'Approved' } = option;

    // Validate user permissions
    const workHistory = await this.workHistoryRepo.findOne({
      where: { user: { id: userId } },
      relations: ['workStatus', 'role'],
    });

    if (!workHistory) return countOnly ? 0 : [];
    if (workHistory.workStatus.name !== 'approved')
      throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิในการเข้าถึงข้อมูล');

    const allowedRoles = ['user', 'staff', 'admin', 'super-admin', 'c-level'];
    if (!allowedRoles.includes(workHistory.role.name))
      throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิในการเข้าถึงข้อมูล');

    // Validate development plan
    if (!developmentPlanId) {
      throw new BadRequestException('Development plan ID is required');
    }

    const developmentPlan = await this.developmentPlanRepo.findOne({
      where: { id: developmentPlanId },
    });
    if (!developmentPlan)
      throw new NotFoundException('Development plan not found');

    // Query both original and revised projects (with status filter)
    const [originalProjects, revisedProjects] = await Promise.all([
      this.findOriginalLatestProjects(developmentPlanId, status),
      this.findRevisedLatestProjects(developmentPlanId, status),
    ]);

    // If count only, return total count
    if (countOnly) {
      return originalProjects.length + revisedProjects.length;
    }

    // กรองตามคอนเซ็ปต์: ถ้าแม่มีลูก → เอาแค่ลูก, ถ้าแม่ไม่มีลูก → เอาแม่
    // กรอง revisedProjects ให้เหลือแค่ลูกล่าสุดของแต่ละแม่ (กรณีมีลูกหลายตัว)
    const latestRevisedByParent = new Map<string, RevisedProjectGroup>();
    revisedProjects.forEach((revised) => {
      if (!revised.projectGroup?.id) return;
      const parentId = revised.projectGroup.id;
      const existing = latestRevisedByParent.get(parentId);
      if (!existing || revised.createdAt > existing.createdAt) {
        latestRevisedByParent.set(parentId, revised);
      }
    });
    const latestRevisedProjects = Array.from(latestRevisedByParent.values());

    // สร้าง Set ของ projectGroup.id ที่มีลูก (revised projects)
    const parentIdsWithChildren = new Set(
      latestRevisedProjects.map((revised) => revised.projectGroup!.id),
    );

    // กรอง originalProjects ให้เหลือแค่แม่ที่ไม่มีลูก
    const parentsWithoutChildren = originalProjects.filter(
      (project) => !parentIdsWithChildren.has(project.id),
    );

    // CLAUDE.md §14 — batched lineage-lock lookups for both sides.
    const [lockedPgIds, lockedRpgIds] = await Promise.all([
      this.findProjectGroupIdsWithDescendants(parentsWithoutChildren.map((p) => p.id)),
      this.findRevisedProjectGroupIdsWithDescendants(latestRevisedProjects.map((r) => r.id)),
    ]);

    // Map to unified format
    const unifiedOriginals = parentsWithoutChildren.map((project) =>
      UnifiedProjectMapper.fromProjectGroup(project, lockedPgIds.has(project.id)),
    );
    const unifiedRevised = latestRevisedProjects.map((project) =>
      UnifiedProjectMapper.fromRevisedProjectGroup(project, lockedRpgIds.has(project.id)),
    );

    // Combine and sort by created date (newest first)
    const combined = [...unifiedOriginals, ...unifiedRevised];
    combined.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    return combined;
  }

  async findExecutiveDashboard(userId: string): Promise<any> {
    const workHistory = await this.workHistoryRepo.findOne({
      where: { user: { id: userId } },
      relations: ['workStatus', 'role'],
    });

    if (!workHistory) return [];
    if (workHistory.workStatus.name !== 'approved')
      throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิในการเข้าถึงข้อมูล');

    const allowedRoles = ['staff', 'admin', 'super-admin', 'c-level'];
    if (!allowedRoles.includes(workHistory.role.name))
      throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิในการเข้าถึงข้อมูล');

    const strategies = await this.strategyRepo.find({
      where: { deletedAt: IsNull() }
    });

    // Find development plan - ตรวจสอบทั้ง development plan และ development plan revision
    let developmentPlan = await this.developmentPlanRepo.findOne({
      where: { isLatest: true }
    });

    let isUsingMainPlan = true;
    if (!developmentPlan || developmentPlan.id === null) {
      const developmentPlanRevision = await this.developmentPlanRevisionRepo.findOne({
        where: { isLatest: true },
        relations: ['developmentPlan']
      });
      if (!developmentPlanRevision) {
        throw new NotFoundException('Development plan revision not found');
      }
      developmentPlan = developmentPlanRevision.developmentPlan;
      isUsingMainPlan = false;
    }

    // Query all projects
    const [originalProjects, revisedProjects] = await Promise.all([
      this.findOriginalLatestProjects(developmentPlan.id),
      this.findRevisedLatestProjects(developmentPlan.id),
    ]);
    const allProjects = [...originalProjects, ...revisedProjects];

    // Get statistics by strategy
    const strategyStats = await this.getStrategyStatistics(allProjects, strategies);

    // Get budget allocation by year
    const budgetByYear = await this.getBudgetByYear(allProjects, developmentPlan);

    // Get budget allocation by strategy (for treemap)
    const budgetByStrategy = await this.getBudgetByStrategy(allProjects, strategies);

    // Get budget allocation by government agencies
    const budgetByAgencies = await this.getBudgetByAgencies(allProjects);

    // Calculate project counts by standardized categories
    const projectCounts = allProjects.reduce((counts, project) => {
      let statusName = 'Unknown';

      if (project.trackingStatus && project.trackingStatus.length > 0) {
        const latestTrackingStatus = project.trackingStatus.find(ts => ts.isLatest) || project.trackingStatus[0];
        statusName = latestTrackingStatus?.statusId?.name || 'Unknown';
      }

      const category = this.mapStatusToCategory(statusName);
      counts[category] = (counts[category] || 0) + 1;

      return counts;
    }, {});

    // Ensure all status categories are always present with 0 if no projects
    const standardizedProjectCounts = {
      approved: projectCounts['approved'] || 0,
      pending: projectCounts['pending'] || 0,
      rejected: projectCounts['rejected'] || 0
    };

    // Calculate approval rate
    const totalProjects = allProjects.length;
    const approvedCount = standardizedProjectCounts.approved;
    const approvalRate = totalProjects > 0 ? (approvedCount / totalProjects) * 100 : 0;

    return {
      // Plan information
      planInfo: {
        developmentPlanId: developmentPlan.id,
        developmentPlanName: developmentPlan.name,
        startYear: developmentPlan.startYear,
        endYear: developmentPlan.endYear,
        reportFormat: developmentPlan.reportFormat,
        isUsingMainPlan,
        planType: isUsingMainPlan ? 'main' : 'revision'
      },

      // Project counts
      projectCounts: {
        approved: standardizedProjectCounts.approved,
        pending: standardizedProjectCounts.pending,
        rejected: standardizedProjectCounts.rejected,
        total: totalProjects
      },

      // Approval rate
      approvalRate: Math.round(approvalRate * 100) / 100,

      // Strategy statistics with projects
      strategyStatistics: strategyStats,

      // Issue statistics (populated for ISSUE_BASED plans)
      issueStatistics: developmentPlan.reportFormat === ReportFormat.ISSUE_BASED
        ? this.getIssueStatistics(allProjects)
        : [],

      // Budget allocation by year (for waterfall chart)
      budgetByYear: budgetByYear,

      // Budget allocation by strategy (for treemap)
      budgetByStrategy: budgetByStrategy,

      // Budget allocation by issue (populated for ISSUE_BASED plans)
      budgetByIssue: developmentPlan.reportFormat === ReportFormat.ISSUE_BASED
        ? this.getBudgetByIssue(allProjects)
        : [],

      // Budget allocation by government agencies
      budgetByAgencies: budgetByAgencies,

      // Trend analysis data
      trendAnalysis: await this.getTrendAnalysis(allProjects, developmentPlan),

      // All projects
      projects: allProjects,
      length: allProjects.length
    };
  }

  async findExecutiveMapDistrictData(userId: string): Promise<any> {
    const workHistory = await this.workHistoryRepo.findOne({
      where: { user: { id: userId } },
      relations: ['workStatus', 'role'],
    });

    if (!workHistory) return [];
    if (workHistory.workStatus.name !== 'approved')
      throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิในการเข้าถึงข้อมูล');

    const allowedRoles = ['staff', 'admin', 'super-admin', 'c-level'];
    if (!allowedRoles.includes(workHistory.role.name))
      throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิในการเข้าถึงข้อมูล');

    // Find development plan
    let developmentPlan = await this.developmentPlanRepo.findOne({
      where: { isLatest: true }
    });

    let isUsingMainPlan = true;
    if (!developmentPlan || developmentPlan.id === null) {
      const developmentPlanRevision = await this.developmentPlanRevisionRepo.findOne({
        where: { isLatest: true },
        relations: ['developmentPlan']
      });
      if (!developmentPlanRevision) {
        throw new NotFoundException('Development plan revision not found');
      }
      developmentPlan = developmentPlanRevision.developmentPlan;
      isUsingMainPlan = false;
    }

    // Get all amphoes
    const amphoes = await this.amphoeRepo.find({
      where: { deletedAt: IsNull() },
      relations: ['localAdministrativeOrganization'],
      order: { name: 'ASC' }
    });

    // Get all local administrative organizations
    const localOrgs = await this.localAdministrativeOrgRepo.find({
      where: { deleteAt: IsNull() },
      relations: ['amphoe'],
      order: { name: 'ASC' }
    });

    // Query all projects (original + revised) - ใช้เหมือนบรรทัด 1465-1470
    const [originalProjects, revisedProjects] = await Promise.all([
      this.findOriginalLatestProjects(developmentPlan.id),
      this.findRevisedLatestProjects(developmentPlan.id),
    ]);
    const allProjects = [...originalProjects, ...revisedProjects];

    // Transform to district structure: Amphoe > LAO > Projects
    const districtData = this.transformToDistrictStructure(amphoes, localOrgs, allProjects);

    // Calculate statistics
    const statistics = this.calculateDistrictStatistics(districtData);

    return {
      // Plan information
      planInfo: {
        developmentPlanId: developmentPlan.id,
        developmentPlanName: developmentPlan.name,
        startYear: developmentPlan.startYear,
        endYear: developmentPlan.endYear,
        reportFormat: developmentPlan.reportFormat,
        isUsingMainPlan,
        planType: isUsingMainPlan ? 'main' : 'revision'
      },

      // District structure: Amphoe > Local Organization > Projects
      districts: districtData,

      // Statistics
      statistics: statistics,

      // Total counts
      totalAmphoes: amphoes.length,
      totalLocalOrgs: localOrgs.length,
      totalProjects: allProjects.length
    };
  }

  async findExecutiveMapData(userId: string): Promise<any> {
    const workHistory = await this.workHistoryRepo.findOne({
      where: { user: { id: userId } },
      relations: ['workStatus', 'role'],
    });

    if (!workHistory) return [];
    if (workHistory.workStatus.name !== 'approved')
      throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิในการเข้าถึงข้อมูล');

    const allowedRoles = ['staff', 'admin', 'super-admin', 'c-level'];
    if (!allowedRoles.includes(workHistory.role.name))
      throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิในการเข้าถึงข้อมูล');

    // Find development plan
    let developmentPlan = await this.developmentPlanRepo.findOne({
      where: { isLatest: true }
    });

    let isUsingMainPlan = true;
    if (!developmentPlan || developmentPlan.id === null) {
      const developmentPlanRevision = await this.developmentPlanRevisionRepo.findOne({
        where: { isLatest: true },
        relations: ['developmentPlan']
      });
      if (!developmentPlanRevision) {
        throw new NotFoundException('Development plan revision not found');
      }
      developmentPlan = developmentPlanRevision.developmentPlan;
      isUsingMainPlan = false;
    }

    // Query all projects with location data
    const [originalProjects, revisedProjects] = await Promise.all([
      this.findOriginalLatestProjects(developmentPlan.id),
      this.findRevisedLatestProjects(developmentPlan.id),
    ]);
    const allProjects = [...originalProjects, ...revisedProjects];

    // Get strategies for marker customization
    const strategies = await this.strategyRepo.find({
      where: { deletedAt: IsNull() }
    });

    // Transform projects to map markers
    const markers = this.transformProjectsToMarkers(allProjects);

    // Group markers by amphoe
    const markersByAmphoe = this.groupMarkersByAmphoe(markers);

    // Get map statistics
    const mapStatistics = this.calculateMapStatistics(markers);

    return {
      // Plan information
      planInfo: {
        developmentPlanId: developmentPlan.id,
        developmentPlanName: developmentPlan.name,
        startYear: developmentPlan.startYear,
        endYear: developmentPlan.endYear,
        reportFormat: developmentPlan.reportFormat,
        isUsingMainPlan,
        planType: isUsingMainPlan ? 'main' : 'revision'
      },

      // Map center (Nakhon Ratchasima province center)
      mapCenter: {
        latitude: 14.9799,
        longitude: 102.0977,
        zoom: 9
      },

      // All markers for the map
      markers: markers,

      // Markers grouped by amphoe for clustering
      markersByAmphoe: markersByAmphoe,

      // Statistics
      statistics: mapStatistics,

      // Strategy colors for custom markers
      strategyColors: strategies.map(strategy => ({
        strategyId: strategy.id,
        strategyName: strategy.name,
        color: this.getStrategyColor(strategy.id)
      })),

      // Total counts
      totalProjects: allProjects.length,
      projectsWithLocation: markers.length,
      projectsWithoutLocation: allProjects.length - markers.length
    };
  }

  async findExecutivePlanAnalysis(userId: string): Promise<any> {
    const workHistory = await this.workHistoryRepo.findOne({
      where: { user: { id: userId } },
      relations: ['workStatus', 'role'],
    });

    if (!workHistory) return [];
    if (workHistory.workStatus.name !== 'approved')
      throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิในการเข้าถึงข้อมูล');

    const allowedRoles = ['staff', 'admin', 'super-admin', 'c-level'];
    if (!allowedRoles.includes(workHistory.role.name))
      throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิในการเข้าถึงข้อมูล');

    // Find development plan
    let developmentPlan = await this.developmentPlanRepo.findOne({
      where: { isLatest: true }
    });

    let isUsingMainPlan = true;
    if (!developmentPlan || developmentPlan.id === null) {
      const developmentPlanRevision = await this.developmentPlanRevisionRepo.findOne({
        where: { isLatest: true },
        relations: ['developmentPlan']
      });
      if (!developmentPlanRevision) {
        throw new NotFoundException('Development plan revision not found');
      }
      developmentPlan = developmentPlanRevision.developmentPlan;
      isUsingMainPlan = false;
    }

    // Get all plans, tactics, and strategies
    const [plans, tactics, strategies] = await Promise.all([
      this.planRepo.find({ where: { deletedAt: IsNull() } }),
      this.tacticRepo.find({ where: { deletedAt: IsNull() } }),
      this.strategyRepo.find({ where: { deletedAt: IsNull() } })
    ]);

    // Query all projects
    const [originalProjects, revisedProjects] = await Promise.all([
      this.findOriginalLatestProjects(developmentPlan.id),
      this.findRevisedLatestProjects(developmentPlan.id),
    ]);
    const allProjects = [...originalProjects, ...revisedProjects];

    // Get plan analysis data
    const planAnalysis = await this.getPlanAnalysis(allProjects, plans, tactics, strategies);

    // Get timeline analysis
    const timelineAnalysis = await this.getTimelineAnalysis(allProjects, developmentPlan);

    // Get plan comparison data
    const planComparison = await this.getPlanComparison(allProjects, plans);

    return {
      // Plan information
      planInfo: {
        developmentPlanId: developmentPlan.id,
        developmentPlanName: developmentPlan.name,
        startYear: developmentPlan.startYear,
        endYear: developmentPlan.endYear,
        reportFormat: developmentPlan.reportFormat,
        isUsingMainPlan,
        planType: isUsingMainPlan ? 'main' : 'revision'
      },

      // Plan hierarchy analysis (Sunburst Chart)
      planHierarchy: planAnalysis,

      // Timeline analysis
      timelineAnalysis: timelineAnalysis,

      // Plan comparison
      planComparison: planComparison,

      // §16 ISSUE_BASED aggregation
      issueStatistics: developmentPlan.reportFormat === ReportFormat.ISSUE_BASED
        ? this.getIssueStatistics(allProjects)
        : [],
      budgetByIssue: developmentPlan.reportFormat === ReportFormat.ISSUE_BASED
        ? this.getBudgetByIssue(allProjects)
        : [],

      // All projects for reference
      projects: allProjects,
      length: allProjects.length
    };
  }

  async findExecutiveStrategies(userId: string): Promise<any> {
    const workHistory = await this.workHistoryRepo.findOne({
      where: { user: { id: userId } },
      relations: ['workStatus', 'role'],
    });

    if (!workHistory) return [];
    if (workHistory.workStatus.name !== 'approved')
      throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิในการเข้าถึงข้อมูล');

    const allowedRoles = ['staff', 'admin', 'super-admin', 'c-level'];
    if (!allowedRoles.includes(workHistory.role.name))
      throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิในการเข้าถึงข้อมูล');

    const strategies = await this.strategyRepo.find({
      where: { deletedAt: IsNull() }
    });

    // Find development plan - ตรวจสอบทั้ง development plan และ development plan revision
    let developmentPlan = await this.developmentPlanRepo.findOne({
      where: { isLatest: true }
    });

    let isUsingMainPlan = true;
    if (!developmentPlan || developmentPlan.id === null) {
      const developmentPlanRevision = await this.developmentPlanRevisionRepo.findOne({
        where: { isLatest: true },
        relations: ['developmentPlan']
      });
      if (!developmentPlanRevision) {
        throw new NotFoundException('Development plan revision not found');
      }
      developmentPlan = developmentPlanRevision.developmentPlan;
      isUsingMainPlan = false;
    }

    // Query all projects
    const [originalProjects, revisedProjects] = await Promise.all([
      this.findOriginalLatestProjects(developmentPlan.id),
      this.findRevisedLatestProjects(developmentPlan.id),
    ]);
    const allProjects = [...originalProjects, ...revisedProjects];

    // Get statistics by strategy
    const strategyStats = await this.getStrategyStatistics(allProjects, strategies);

    // Calculate project counts by standardized categories
    const projectCounts = allProjects.reduce((counts, project) => {
      let statusName = 'Unknown';

      if (project.trackingStatus && project.trackingStatus.length > 0) {
        const latestTrackingStatus = project.trackingStatus.find(ts => ts.isLatest) || project.trackingStatus[0];
        statusName = latestTrackingStatus?.statusId?.name || 'Unknown';
      }

      const category = this.mapStatusToCategory(statusName);
      counts[category] = (counts[category] || 0) + 1;

      return counts;
    }, {});

    // Ensure all status categories are always present with 0 if no projects
    const standardizedProjectCounts = {
      approved: projectCounts['approved'] || 0,
      pending: projectCounts['pending'] || 0,
      rejected: projectCounts['rejected'] || 0
    };

    // Calculate approval rate
    const totalProjects = allProjects.length;
    const approvedCount = standardizedProjectCounts.approved;
    const approvalRate = totalProjects > 0 ? (approvedCount / totalProjects) * 100 : 0;

    return {
      // Plan information
      planInfo: {
        developmentPlanId: developmentPlan.id,
        developmentPlanName: developmentPlan.name,
        startYear: developmentPlan.startYear,
        endYear: developmentPlan.endYear,
        reportFormat: developmentPlan.reportFormat,
        isUsingMainPlan,
        planType: isUsingMainPlan ? 'main' : 'revision'
      },

      // Project counts
      projectCounts: {
        approved: standardizedProjectCounts.approved,
        pending: standardizedProjectCounts.pending,
        rejected: standardizedProjectCounts.rejected,
        total: totalProjects
      },

      // Approval rate
      approvalRate: Math.round(approvalRate * 100) / 100,

      // Strategy statistics
      strategyStatistics: strategyStats,

      // Issue statistics (populated for ISSUE_BASED plans)
      issueStatistics: developmentPlan.reportFormat === ReportFormat.ISSUE_BASED
        ? this.getIssueStatistics(allProjects)
        : [],

      // Budget allocation by issue (populated for ISSUE_BASED plans)
      budgetByIssue: developmentPlan.reportFormat === ReportFormat.ISSUE_BASED
        ? this.getBudgetByIssue(allProjects)
        : [],

      // All projects
      projects: allProjects,
      length: allProjects.length
    };
  }


  /**
   * Transform projects to map markers
   */
  private transformProjectsToMarkers(projects: any[]): any[] {
    return projects
      .filter(project => {
        // Filter projects that have location data
        const hasStartLocation = (project.startLat !== null && project.startLng !== null) ||
          (project.originalProject?.startLat !== null && project.originalProject?.startLng !== null);
        const hasEndLocation = (project.endLat !== null && project.endLng !== null) ||
          (project.originalProject?.endLat !== null && project.originalProject?.endLng !== null);
        return hasStartLocation || hasEndLocation;
      })
      .map(project => {
        // Get project details
        const startLat = project.startLat || project.originalProject?.startLat;
        const startLng = project.startLng || project.originalProject?.startLng;
        const endLat = project.endLat || project.originalProject?.endLat;
        const endLng = project.endLng || project.originalProject?.endLng;

        const strategy = project.strategy || project.originalProject?.strategy;
        const plan = project.plan || project.originalProject?.plan;
        const developmentIssue = project.developmentIssue || project.originalProject?.developmentIssue;
        const originAgency = project.originAgencyId || project.originalProject?.originAgencyId;
        const responsibleAgency = project.responsibleAgency || project.originalProject?.responsibleAgency;

        // Calculate total budget
        const budgets = project.budgets || project.originalProject?.budgets || [];
        const totalBudget = budgets.reduce((sum: number, budget: any) => {
          const quantity = typeof budget.quantity === 'string' ? parseFloat(budget.quantity) : (budget.quantity || 0);
          return sum + quantity;
        }, 0);

        // Get status
        let statusName = 'Unknown';
        let statusCategory = 'unknown';
        if (project.trackingStatus && project.trackingStatus.length > 0) {
          const latestTrackingStatus = project.trackingStatus.find(ts => ts.isLatest) || project.trackingStatus[0];
          statusName = latestTrackingStatus?.statusId?.name || 'Unknown';
          statusCategory = this.mapStatusToCategory(statusName);
        }

        const tactic = project.tactic || project.originalProject?.tactic;
        const goal = project.goal || project.originalProject?.goal;
        const indicator = project.indicator || project.originalProject?.indicator;
        const expected = project.expected || project.originalProject?.expected;

        // Get budget breakdown by year
        const budgetByYear = budgets.reduce((acc: any[], budget: any) => {
          const quantity = typeof budget.quantity === 'string' ? parseFloat(budget.quantity) : (budget.quantity || 0);
          const existing = acc.find(b => b.year === budget.year);
          if (existing) {
            existing.amount += quantity;
          } else {
            acc.push({
              year: budget.year,
              amount: quantity
            });
          }
          return acc;
        }, []).map(b => ({
          year: b.year,
          amount: Math.round(b.amount * 100) / 100
        }));

        return {
          projectId: project.id,
          title: project.title || project.originalProject?.title,
          objective: project.objective || project.originalProject?.objective,
          goal: goal,
          indicator: indicator,
          expected: expected,

          // Location data
          startLocation: startLat && startLng ? {
            latitude: parseFloat(startLat.toString()),
            longitude: parseFloat(startLng.toString()),
            type: 'start'
          } : null,

          endLocation: endLat && endLng ? {
            latitude: parseFloat(endLat.toString()),
            longitude: parseFloat(endLng.toString()),
            type: 'end'
          } : null,

          // Primary location (use start if available, otherwise end)
          location: startLat && startLng ? {
            latitude: parseFloat(startLat.toString()),
            longitude: parseFloat(startLng.toString())
          } : endLat && endLng ? {
            latitude: parseFloat(endLat.toString()),
            longitude: parseFloat(endLng.toString())
          } : null,

          // Project details
          budget: Math.round(totalBudget * 100) / 100,
          budgetByYear: budgetByYear,
          status: statusName,
          statusCategory: statusCategory,

          // Strategy, Tactic & Plan
          strategy: strategy ? {
            id: strategy.id,
            name: strategy.name,
            color: this.getStrategyColor(strategy.id)
          } : null,

          tactic: tactic ? {
            id: tactic.id,
            name: tactic.name
          } : null,

          plan: plan ? {
            id: plan.id,
            name: plan.name
          } : null,

          // Development Issue (ISSUE_BASED plans)
          developmentIssue: developmentIssue ? {
            id: developmentIssue.id,
            name: developmentIssue.name
          } : null,

          // Agency info
          originAgency: originAgency ? {
            id: originAgency.id,
            name: originAgency.name,
            type: originAgency.type,
            amphoe: originAgency.amphoe?.name || null
          } : null,

          responsibleAgency: responsibleAgency ? {
            id: responsibleAgency.id,
            name: responsibleAgency.name || responsibleAgency.th_name
          } : null,

          // Metadata
          isRevised: !!project.originalProject,
          isDraft: project.isDraft || project.originalProject?.isDraft || false,
          projectYear: project.projectYear || project.originalProject?.projectYear,
          createdAt: project.createdAt || project.originalProject?.createdAt
        };
      })
      .filter(marker => marker.location !== null); // Ensure we have at least one valid location
  }

  /**
   * Group markers by amphoe for clustering
   */
  private groupMarkersByAmphoe(markers: any[]): any[] {
    const amphoeMap = new Map();

    markers.forEach(marker => {
      const amphoeName = marker.originAgency?.amphoe || 'ไม่ระบุอำเภอ';

      if (!amphoeMap.has(amphoeName)) {
        amphoeMap.set(amphoeName, {
          amphoeName: amphoeName,
          projectCount: 0,
          totalBudget: 0,
          markers: [],
          center: { latitude: 0, longitude: 0 } // Will calculate later
        });
      }

      const amphoeData = amphoeMap.get(amphoeName);
      amphoeData.projectCount += 1;
      amphoeData.totalBudget += marker.budget;
      amphoeData.markers.push(marker);
    });

    // Calculate center point for each amphoe
    return Array.from(amphoeMap.values()).map(amphoe => {
      const latSum = amphoe.markers.reduce((sum: number, m: any) => sum + m.location.latitude, 0);
      const lngSum = amphoe.markers.reduce((sum: number, m: any) => sum + m.location.longitude, 0);

      return {
        amphoeName: amphoe.amphoeName,
        projectCount: amphoe.projectCount,
        totalBudget: Math.round(amphoe.totalBudget * 100) / 100,
        center: {
          latitude: latSum / amphoe.markers.length,
          longitude: lngSum / amphoe.markers.length
        },
        markers: amphoe.markers
      };
    }).sort((a, b) => b.projectCount - a.projectCount);
  }

  /**
   * Calculate map statistics
   */
  private calculateMapStatistics(markers: any[]): any {
    const statusBreakdown = markers.reduce((counts, marker) => {
      counts[marker.statusCategory] = (counts[marker.statusCategory] || 0) + 1;
      return counts;
    }, {});

    const strategyBreakdown = markers.reduce((counts, marker) => {
      const strategyName = marker.strategy?.name || 'ไม่ระบุยุทธศาสตร์';
      counts[strategyName] = (counts[strategyName] || 0) + 1;
      return counts;
    }, {});

    const totalBudget = markers.reduce((sum, marker) => sum + marker.budget, 0);

    return {
      totalBudget: Math.round(totalBudget * 100) / 100,
      averageBudget: markers.length > 0 ? Math.round((totalBudget / markers.length) * 100) / 100 : 0,
      statusBreakdown: {
        approved: statusBreakdown['approved'] || 0,
        pending: statusBreakdown['pending'] || 0,
        rejected: statusBreakdown['rejected'] || 0
      },
      strategyBreakdown: strategyBreakdown,
      projectsWithBothLocations: markers.filter(m => m.startLocation && m.endLocation).length,
      projectsWithStartOnly: markers.filter(m => m.startLocation && !m.endLocation).length,
      projectsWithEndOnly: markers.filter(m => !m.startLocation && m.endLocation).length
    };
  }

  /**
   * Get color for strategy (for custom marker icons)
   */
  private getStrategyColor(strategyId: string): string {
    // Hash strategy ID to generate consistent color
    const colors = [
      '#FF6B6B', // Red
      '#4ECDC4', // Teal
      '#45B7D1', // Blue
      '#FFA07A', // Light Salmon
      '#98D8C8', // Mint
      '#F7DC6F', // Yellow
      '#BB8FCE', // Purple
      '#85C1E2', // Sky Blue
      '#F8B739', // Orange
      '#52B788', // Green
    ];

    // Simple hash function
    let hash = 0;
    for (let i = 0; i < strategyId.length; i++) {
      hash = strategyId.charCodeAt(i) + ((hash << 5) - hash);
    }

    return colors[Math.abs(hash) % colors.length];
  }

  /**
   * Transform data to district structure (Amphoe > LAO > Projects)
   */
  private transformToDistrictStructure(amphoes: any[], localOrgs: any[], allProjects: any[]): any[] {
    // กรองเฉพาะโครงการที่สถานะตรงตามที่กำหนด: Pending_Approval, Pending, Rejected, Approved, Verified
    const allowedStatuses = ['Pending_Approval', 'Pending', 'Rejected', 'Approved', 'Verified'];
    const filteredProjects = allProjects.filter(project => {
      let statusName = 'Unknown';
      if (project.trackingStatus && project.trackingStatus.length > 0) {
        const latestTrackingStatus = project.trackingStatus.find(ts => ts.isLatest) || project.trackingStatus[0];
        statusName = latestTrackingStatus?.statusId?.name;
      }
      return allowedStatuses.includes(statusName);
    });

    // แสดงทุกอำเภอแม้ไม่มีโครงการ (array เปล่า) และ sort ตาม id
    const sortedAmphoes = [...amphoes].sort((a, b) => a.id.localeCompare(b.id));

    return sortedAmphoes.map(amphoe => {
      // Get LAOs for this amphoe (แสดงทุกอปทแม้ไม่มีโครงการ) และ sort ตาม id
      const amphoeLAOs = localOrgs
        .filter(lao => lao.amphoe?.id === amphoe.id)
        .sort((a, b) => a.id.localeCompare(b.id));

      // Transform LAOs with their projects (แสดงทุกอปทแม้ไม่มีโครงการ)
      const localOrganizations = amphoeLAOs.map(lao => {
        // Find projects for this LAO
        const laoProjects = filteredProjects.filter(project => {
          const originAgency = project.originAgencyId || project.originalProject?.originAgencyId;
          const responsibleAgency = project.responsibleAgency || project.originalProject?.responsibleAgency;

          // กรณีปกติ: มี originAgency
          if (originAgency && originAgency.id === lao.id) {
            return true;
          }

          // กรณีพิเศษ: ไม่มี originAgency แต่มี responsibleAgency ให้กำหนดเป็นอปท 3001027
          if (!originAgency && responsibleAgency && lao.id === '3001027') {
            return true;
          }

          return false;
        });

        // Transform projects to detailed format
        const transformedProjects = laoProjects.map(project => {
          const strategy = project.strategy || project.originalProject?.strategy;
          const tactic = project.tactic || project.originalProject?.tactic;
          const plan = project.plan || project.originalProject?.plan;
          const responsibleAgency = project.responsibleAgency || project.originalProject?.responsibleAgency;

          // Calculate total budget
          const budgets = project.budgets || project.originalProject?.budgets || [];
          const totalBudget = budgets.reduce((sum: number, budget: any) => {
            const quantity = typeof budget.quantity === 'string' ? parseFloat(budget.quantity) : (budget.quantity || 0);
            return sum + quantity;
          }, 0);

          // Get budget breakdown by year
          const budgetByYear = budgets.reduce((acc: any[], budget: any) => {
            const quantity = typeof budget.quantity === 'string' ? parseFloat(budget.quantity) : (budget.quantity || 0);
            const existing = acc.find(b => b.year === budget.year);
            if (existing) {
              existing.amount += quantity;
            } else {
              acc.push({
                year: budget.year,
                amount: quantity
              });
            }
            return acc;
          }, []).map(b => ({
            year: b.year,
            amount: Math.round(b.amount * 100) / 100
          }));

          // Get status
          let statusName = 'Unknown';
          let statusCategory = 'unknown';
          if (project.trackingStatus && project.trackingStatus.length > 0) {
            const latestTrackingStatus = project.trackingStatus.find(ts => ts.isLatest) || project.trackingStatus[0];
            statusName = latestTrackingStatus?.statusId?.name || 'Unknown';
            statusCategory = this.mapStatusToCategory(statusName);
          }

          const developmentIssue = project.developmentIssue || project.originalProject?.developmentIssue;

          return {
            projectId: project.id,
            title: project.title || project.originalProject?.title,
            objective: project.objective || project.originalProject?.objective,
            goal: project.goal || project.originalProject?.goal,
            indicator: project.indicator || project.originalProject?.indicator,
            expected: project.expected || project.originalProject?.expected,
            projectYear: project.projectYear || project.originalProject?.projectYear,

            // Budget
            budget: Math.round(totalBudget * 100) / 100,
            budgetByYear: budgetByYear,

            // Status
            status: statusName,
            statusCategory: statusCategory,

            // Strategy & Plan
            strategy: strategy ? {
              id: strategy.id,
              name: strategy.name,
              color: this.getStrategyColor(strategy.id)
            } : null,

            tactic: tactic ? {
              id: tactic.id,
              name: tactic.name
            } : null,

            plan: plan ? {
              id: plan.id,
              name: plan.name
            } : null,

            // Development Issue (ISSUE_BASED plans)
            developmentIssue: developmentIssue ? {
              id: developmentIssue.id,
              name: developmentIssue.name
            } : null,

            // Agency info
            originAgency: {
              id: lao.id,
              name: lao.name,
              type: lao.type,
              amphoe: amphoe.name
            },

            responsibleAgency: responsibleAgency ? {
              id: responsibleAgency.id,
              name: responsibleAgency.name || responsibleAgency.th_name
            } : null,

            // Metadata
            isRevised: !!project.originalProject,
            isDraft: project.isDraft || project.originalProject?.isDraft || false,
            createdAt: project.createdAt || project.originalProject?.createdAt
          };
        });

        // Calculate LAO statistics
        const laoProjectCount = transformedProjects.length;
        const laoTotalBudget = transformedProjects.reduce((sum, project) => sum + project.budget, 0);

        const laoStatusBreakdown = transformedProjects.reduce((counts, project) => {
          counts[project.statusCategory] = (counts[project.statusCategory] || 0) + 1;
          return counts;
        }, {});

        return {
          laoId: lao.id,
          laoName: lao.name,
          laoType: lao.type,
          projectCount: laoProjectCount,
          totalBudget: Math.round(laoTotalBudget * 100) / 100,
          statusBreakdown: {
            approved: laoStatusBreakdown['approved'] || 0,
            pending: laoStatusBreakdown['pending'] || 0,
            rejected: laoStatusBreakdown['rejected'] || 0
          },
          projects: transformedProjects
        };
      });

      // Add LAOs that have projects but no existing LAO record in the system
      // This handles edge cases where projects exist but LAO record is missing
      const projectsWithoutLAO = filteredProjects.filter(project => {
        const originAgency = project.originAgencyId || project.originalProject?.originAgencyId;
        const responsibleAgency = project.responsibleAgency || project.originalProject?.responsibleAgency;

        // กรณีปกติ: มี originAgency แต่ไม่มี LAO record
        if (originAgency &&
          originAgency.amphoe?.id === amphoe.id &&
          !amphoeLAOs.some(lao => lao.id === originAgency.id)) {
          return true;
        }

        // กรณีพิเศษ: ไม่มี originAgency แต่มี responsibleAgency (จะไปอยู่ในอปท 3001027)
        if (!originAgency && responsibleAgency) {
          return false; // ไม่ต้องเพิ่มในส่วนนี้ เพราะจะไปอยู่ในอปท 3001027 อยู่แล้ว
        }

        return false;
      });

      if (projectsWithoutLAO.length > 0) {
        // Group by origin agency
        const projectsByAgency = projectsWithoutLAO.reduce((groups: any, project: any) => {
          const originAgency = project.originAgencyId || project.originalProject?.originAgencyId;
          const responsibleAgency = project.responsibleAgency || project.originalProject?.responsibleAgency;

          // กรณีปกติ: มี originAgency
          if (originAgency) {
            const agencyId = originAgency.id;
            if (!groups[agencyId]) {
              groups[agencyId] = {
                agency: originAgency,
                projects: []
              };
            }
            groups[agencyId].projects.push(project);
          }
          // กรณีพิเศษ: ไม่มี originAgency แต่มี responsibleAgency ให้ไปอยู่ในอปท 3001027
          else if (responsibleAgency) {
            // ไม่ต้องเพิ่มในส่วนนี้ เพราะโครงการเหล่านี้จะไปอยู่ในอปท 3001027 อยู่แล้ว
            // ผ่านเงื่อนไขใน filter ด้านบน
          }

          return groups;
        }, {});

        // Transform each agency group
        Object.values(projectsByAgency).forEach((group: any) => {
          const agency = group.agency;
          const agencyProjects = group.projects;

          const transformedProjects = agencyProjects.map(project => {
            // Same transformation logic as above
            const strategy = project.strategy || project.originalProject?.strategy;
            const tactic = project.tactic || project.originalProject?.tactic;
            const plan = project.plan || project.originalProject?.plan;
            const responsibleAgency = project.responsibleAgency || project.originalProject?.responsibleAgency;
            const developmentIssue = project.developmentIssue || project.originalProject?.developmentIssue;

            const budgets = project.budgets || project.originalProject?.budgets || [];
            const totalBudget = budgets.reduce((sum: number, budget: any) => {
              const quantity = typeof budget.quantity === 'string' ? parseFloat(budget.quantity) : (budget.quantity || 0);
              return sum + quantity;
            }, 0);

            let statusName = 'Unknown';
            let statusCategory = 'unknown';
            if (project.trackingStatus && project.trackingStatus.length > 0) {
              const latestTrackingStatus = project.trackingStatus.find(ts => ts.isLatest) || project.trackingStatus[0];
              statusName = latestTrackingStatus?.statusId?.name || 'Unknown';
              statusCategory = this.mapStatusToCategory(statusName);
            }

            return {
              projectId: project.id,
              title: project.title || project.originalProject?.title,
              objective: project.objective || project.originalProject?.objective,
              goal: project.goal || project.originalProject?.goal,
              indicator: project.indicator || project.originalProject?.indicator,
              expected: project.expected || project.originalProject?.expected,
              projectYear: project.projectYear || project.originalProject?.projectYear,

              budget: Math.round(totalBudget * 100) / 100,
              status: statusName,
              statusCategory: statusCategory,

              strategy: strategy ? {
                id: strategy.id,
                name: strategy.name,
                color: this.getStrategyColor(strategy.id)
              } : null,

              tactic: tactic ? {
                id: tactic.id,
                name: tactic.name
              } : null,

              plan: plan ? {
                id: plan.id,
                name: plan.name
              } : null,

              // Development Issue (ISSUE_BASED plans)
              developmentIssue: developmentIssue ? {
                id: developmentIssue.id,
                name: developmentIssue.name
              } : null,

              originAgency: {
                id: agency.id,
                name: agency.name,
                type: agency.type,
                amphoe: amphoe.name
              },

              responsibleAgency: responsibleAgency ? {
                id: responsibleAgency.id,
                name: responsibleAgency.name || responsibleAgency.th_name
              } : null,

              isRevised: !!project.originalProject,
              isDraft: project.isDraft || project.originalProject?.isDraft || false,
              createdAt: project.createdAt || project.originalProject?.createdAt
            };
          });

          const laoProjectCount = transformedProjects.length;
          const laoTotalBudget = transformedProjects.reduce((sum, project) => sum + project.budget, 0);

          const laoStatusBreakdown = transformedProjects.reduce((counts, project) => {
            counts[project.statusCategory] = (counts[project.statusCategory] || 0) + 1;
            return counts;
          }, {});

          localOrganizations.push({
            laoId: agency.id,
            laoName: agency.name,
            laoType: agency.type,
            projectCount: laoProjectCount,
            totalBudget: Math.round(laoTotalBudget * 100) / 100,
            statusBreakdown: {
              approved: laoStatusBreakdown['approved'] || 0,
              pending: laoStatusBreakdown['pending'] || 0,
              rejected: laoStatusBreakdown['rejected'] || 0
            },
            projects: transformedProjects
          });
        });
      }

      // Sort LAOs by project count (descending)
      localOrganizations.sort((a: any, b: any) => b.projectCount - a.projectCount);

      // Calculate amphoe statistics
      const amphoeProjectCount = localOrganizations.reduce((sum, org) => sum + org.projectCount, 0);
      const amphoeTotalBudget = localOrganizations.reduce((sum, org) => sum + org.totalBudget, 0);

      const amphoeStatusBreakdown = localOrganizations.reduce((counts, org) => {
        counts.approved += org.statusBreakdown.approved;
        counts.pending += org.statusBreakdown.pending;
        counts.rejected += org.statusBreakdown.rejected;
        return counts;
      }, { approved: 0, pending: 0, rejected: 0 });

      return {
        amphoeId: amphoe.id,
        amphoeName: amphoe.name,
        localOrgCount: localOrganizations.length,
        projectCount: amphoeProjectCount,
        totalBudget: Math.round(amphoeTotalBudget * 100) / 100,
        statusBreakdown: amphoeStatusBreakdown,
        localOrganizations: localOrganizations
      };
    }).sort((a, b) => b.projectCount - a.projectCount); // Sort by project count (descending)
  }

  /**
   * Calculate district statistics
   */
  private calculateDistrictStatistics(districtData: any[]): any {
    const totalProjects = districtData.reduce((sum, district) => sum + district.projectCount, 0);
    const totalBudget = districtData.reduce((sum, district) => sum + district.totalBudget, 0);
    const totalLocalOrgs = districtData.reduce((sum, district) => sum + district.localOrgCount, 0);

    // Status breakdown across all districts
    const overallStatusBreakdown = districtData.reduce((counts, district) => {
      counts.approved += district.statusBreakdown.approved;
      counts.pending += district.statusBreakdown.pending;
      counts.rejected += district.statusBreakdown.rejected;
      return counts;
    }, { approved: 0, pending: 0, rejected: 0 });

    // Top performing districts
    const topDistrictsByProject = districtData.slice(0, 5).map(district => ({
      name: district.amphoeName,
      projectCount: district.projectCount,
      totalBudget: district.totalBudget
    }));

    const topDistrictsByBudget = districtData
      .sort((a, b) => b.totalBudget - a.totalBudget)
      .slice(0, 5)
      .map(district => ({
        name: district.amphoeName,
        projectCount: district.projectCount,
        totalBudget: district.totalBudget
      }));

    return {
      totalProjects,
      totalBudget: Math.round(totalBudget * 100) / 100,
      totalLocalOrgs,
      averageProjectsPerDistrict: districtData.length > 0 ? Math.round((totalProjects / districtData.length) * 100) / 100 : 0,
      averageBudgetPerDistrict: districtData.length > 0 ? Math.round((totalBudget / districtData.length) * 100) / 100 : 0,
      statusBreakdown: overallStatusBreakdown,
      topDistrictsByProject,
      topDistrictsByBudget,
      districtsWithProjects: districtData.filter(d => d.projectCount > 0).length,
      districtsWithoutProjects: districtData.filter(d => d.projectCount === 0).length
    };
  }

  /**
   * Map status name to standardized category
   */
  private mapStatusToCategory(statusName: string): string {
    const statusMap = {
      'Approved': 'approved',
      'Verified': 'approved',
      'Pending': 'pending',
      'Pending_Approval': 'pending',
      'Rejected': 'rejected'
    };

    return statusMap[statusName] || 'unknown';
  }

  /**
   * Get statistics grouped by strategy
   */
  private async getStrategyStatistics(allProjects: any[], strategies: any[]): Promise<any[]> {
    const strategyStats = strategies.map(strategy => {
      const projectsInStrategy = allProjects.filter(project => {
        // Handle both original and revised projects
        const projectStrategy = project.strategy || project.originalProject?.strategy;
        return projectStrategy && projectStrategy.id === strategy.id;
      });

      // Calculate total budget for this strategy
      const totalBudget = projectsInStrategy.reduce((sum, project) => {
        const budgets = project.budgets || project.originalProject?.budgets || [];
        const projectBudget = budgets.reduce((budgetSum: number, budget: any) => {
          // Convert to number and handle string values
          const quantity = typeof budget.quantity === 'string' ? parseFloat(budget.quantity) : (budget.quantity || 0);
          return budgetSum + quantity;
        }, 0);
        return sum + projectBudget;
      }, 0);

      // Count projects by status in this strategy
      const statusCounts = projectsInStrategy.reduce((counts, project) => {
        // Get the latest tracking status
        let statusName = 'Unknown';

        if (project.trackingStatus && project.trackingStatus.length > 0) {
          // Find the latest tracking status
          const latestTrackingStatus = project.trackingStatus.find(ts => ts.isLatest) || project.trackingStatus[0];
          statusName = latestTrackingStatus?.statusId?.name || 'Unknown';
        }

        // Map to standardized category
        const category = this.mapStatusToCategory(statusName);
        counts[category] = (counts[category] || 0) + 1;

        return counts;
      }, {});

      // Ensure all status categories are always present with 0 if no projects
      const standardizedStatusCounts = {
        approved: statusCounts['approved'] || 0,
        pending: statusCounts['pending'] || 0,
        rejected: statusCounts['rejected'] || 0
      };

      // Transform projects to include status and budget info
      const projectsWithDetails = projectsInStrategy.map(project => {
        // Get project budget
        const budgets = project.budgets || project.originalProject?.budgets || [];
        const projectBudget = budgets.reduce((sum: number, budget: any) => {
          const quantity = typeof budget.quantity === 'string' ? parseFloat(budget.quantity) : (budget.quantity || 0);
          return sum + quantity;
        }, 0);

        // Get project status
        let statusName = 'Unknown';
        let statusCategory = 'unknown';

        if (project.trackingStatus && project.trackingStatus.length > 0) {
          const latestTrackingStatus = project.trackingStatus.find(ts => ts.isLatest) || project.trackingStatus[0];
          statusName = latestTrackingStatus?.statusId?.name || 'Unknown';
          statusCategory = this.mapStatusToCategory(statusName);
        }

        return {
          id: project.id,
          title: project.title || project.originalProject?.title,
          objective: project.objective || project.originalProject?.objective,
          projectYear: project.projectYear || project.originalProject?.projectYear,
          budget: Math.round(projectBudget * 100) / 100,
          status: statusName,
          statusCategory: statusCategory,
          isRevised: !!project.originalProject, // true if this is a revised project
          createdAt: project.createdAt || project.originalProject?.createdAt
        };
      });

      return {
        strategyId: strategy.id,
        strategyName: strategy.name,
        totalProjects: projectsInStrategy.length,
        totalBudget: Math.round(totalBudget * 100) / 100, // Round to 2 decimal places
        approvedCount: standardizedStatusCounts.approved,
        pendingCount: standardizedStatusCounts.pending,
        rejectedCount: standardizedStatusCounts.rejected,
        projects: projectsWithDetails
      };
    });

    return strategyStats;
  }

  /**
   * Get budget allocation by year
   */
  private async getBudgetByYear(allProjects: any[], developmentPlan: any): Promise<any[]> {
    const budgetByYear: any[] = [];

    // Generate years from development plan
    for (let year = developmentPlan.startYear; year <= developmentPlan.endYear; year++) {
      const projectsInYear = allProjects.filter(project => {
        const budgets = project.budgets || project.originalProject?.budgets || [];
        return budgets.some(budget => budget.year === year);
      });

      const totalBudget = projectsInYear.reduce((sum, project) => {
        const budgets = project.budgets || project.originalProject?.budgets || [];
        const projectBudget = budgets
          .filter(budget => budget.year === year)
          .reduce((budgetSum: number, budget: any) => {
            const quantity = typeof budget.quantity === 'string' ? parseFloat(budget.quantity) : (budget.quantity || 0);
            return budgetSum + quantity;
          }, 0);
        return sum + projectBudget;
      }, 0);

      const projects = projectsInYear.map(project => {
        const budgets = project.budgets || project.originalProject?.budgets || [];
        const yearBudget = budgets
          .filter(budget => budget.year === year)
          .reduce((sum: number, budget: any) => {
            const quantity = typeof budget.quantity === 'string' ? parseFloat(budget.quantity) : (budget.quantity || 0);
            return sum + quantity;
          }, 0);

        let statusName = 'Unknown';
        if (project.trackingStatus && project.trackingStatus.length > 0) {
          const latestTrackingStatus = project.trackingStatus.find(ts => ts.isLatest) || project.trackingStatus[0];
          statusName = latestTrackingStatus?.statusId?.name || 'Unknown';
        }

        return {
          id: project.id,
          title: project.title || project.originalProject?.title,
          budget: Math.round(yearBudget * 100) / 100,
          status: statusName,
          statusCategory: this.mapStatusToCategory(statusName),
          isRevised: !!project.originalProject
        };
      });

      budgetByYear.push({
        year,
        totalBudget: Math.round(totalBudget * 100) / 100,
        projectCount: projectsInYear.length,
        projects
      });
    }

    return budgetByYear;
  }

  /**
   * Get budget allocation by strategy (for treemap)
   */
  private async getBudgetByStrategy(allProjects: any[], strategies: any[]): Promise<any[]> {
    return strategies.map(strategy => {
      const projectsInStrategy = allProjects.filter(project => {
        const projectStrategy = project.strategy || project.originalProject?.strategy;
        return projectStrategy && projectStrategy.id === strategy.id;
      });

      const totalBudget = projectsInStrategy.reduce((sum, project) => {
        const budgets = project.budgets || project.originalProject?.budgets || [];
        const projectBudget = budgets.reduce((budgetSum: number, budget: any) => {
          const quantity = typeof budget.quantity === 'string' ? parseFloat(budget.quantity) : (budget.quantity || 0);
          return budgetSum + quantity;
        }, 0);
        return sum + projectBudget;
      }, 0);

      // Calculate status breakdown
      const statusBreakdown = projectsInStrategy.reduce((counts, project) => {
        let statusName = 'Unknown';
        if (project.trackingStatus && project.trackingStatus.length > 0) {
          const latestTrackingStatus = project.trackingStatus.find(ts => ts.isLatest) || project.trackingStatus[0];
          statusName = latestTrackingStatus?.statusId?.name || 'Unknown';
        }
        const category = this.mapStatusToCategory(statusName);
        counts[category] = (counts[category] || 0) + 1;
        return counts;
      }, {});

      return {
        strategyId: strategy.id,
        strategyName: strategy.name,
        totalBudget: Math.round(totalBudget * 100) / 100,
        projectCount: projectsInStrategy.length,
        statusBreakdown: {
          approved: statusBreakdown['approved'] || 0,
          pending: statusBreakdown['pending'] || 0,
          rejected: statusBreakdown['rejected'] || 0
        },
        // For treemap visualization
        size: totalBudget, // Size based on budget
        children: projectsInStrategy.map(project => ({
          projectId: project.id,
          projectTitle: project.title || project.originalProject?.title,
          budget: Math.round((project.budgets || project.originalProject?.budgets || [])
            .reduce((sum: number, budget: any) => sum + (typeof budget.quantity === 'string' ? parseFloat(budget.quantity) : (budget.quantity || 0)), 0) * 100) / 100,
          status: project.trackingStatus?.find(ts => ts.isLatest)?.statusId?.name || 'Unknown',
          statusCategory: this.mapStatusToCategory(project.trackingStatus?.find(ts => ts.isLatest)?.statusId?.name || 'Unknown')
        }))
      };
    }).filter(strategy => strategy.totalBudget > 0); // Only include strategies with budget
  }

  /**
   * Get statistics grouped by DevelopmentIssue (for ISSUE_BASED plans).
   * Mirrors getStrategyStatistics but uses developmentIssue instead of strategy.
   */
  private getIssueStatistics(allProjects: any[]): any[] {
    const issueMap = new Map<string, {
      issueId: string;
      issueName: string;
      projects: any[];
    }>();

    allProjects.forEach(project => {
      const issue = project.developmentIssue || project.originalProject?.developmentIssue;
      if (!issue) return;

      if (!issueMap.has(issue.id)) {
        issueMap.set(issue.id, {
          issueId: issue.id,
          issueName: issue.name,
          projects: [],
        });
      }
      issueMap.get(issue.id)!.projects.push(project);
    });

    return Array.from(issueMap.values()).map(entry => {
      const totalBudget = entry.projects.reduce((sum, project) => {
        const budgets = project.budgets || project.originalProject?.budgets || [];
        return sum + budgets.reduce((budgetSum: number, budget: any) => {
          const quantity = typeof budget.quantity === 'string'
            ? parseFloat(budget.quantity)
            : (budget.quantity || 0);
          return budgetSum + quantity;
        }, 0);
      }, 0);

      const statusCounts = entry.projects.reduce((counts, project) => {
        let statusName = 'Unknown';
        if (project.trackingStatus && project.trackingStatus.length > 0) {
          const latestTrackingStatus =
            project.trackingStatus.find(ts => ts.isLatest) || project.trackingStatus[0];
          statusName = latestTrackingStatus?.statusId?.name || 'Unknown';
        }
        const category = this.mapStatusToCategory(statusName);
        counts[category] = (counts[category] || 0) + 1;
        return counts;
      }, {});

      const projectsWithDetails = entry.projects.map(project => {
        const budgets = project.budgets || project.originalProject?.budgets || [];
        const projectBudget = budgets.reduce((sum: number, budget: any) => {
          const quantity = typeof budget.quantity === 'string'
            ? parseFloat(budget.quantity)
            : (budget.quantity || 0);
          return sum + quantity;
        }, 0);

        let statusName = 'Unknown';
        let statusCategory = 'unknown';
        if (project.trackingStatus && project.trackingStatus.length > 0) {
          const latestTrackingStatus =
            project.trackingStatus.find(ts => ts.isLatest) || project.trackingStatus[0];
          statusName = latestTrackingStatus?.statusId?.name || 'Unknown';
          statusCategory = this.mapStatusToCategory(statusName);
        }

        return {
          id: project.id,
          title: project.title || project.originalProject?.title,
          objective: project.objective || project.originalProject?.objective,
          projectYear: project.projectYear || project.originalProject?.projectYear,
          budget: Math.round(projectBudget * 100) / 100,
          status: statusName,
          statusCategory,
          isRevised: !!project.originalProject,
          createdAt: project.createdAt || project.originalProject?.createdAt,
        };
      });

      return {
        issueId: entry.issueId,
        issueName: entry.issueName,
        totalProjects: entry.projects.length,
        totalBudget: Math.round(totalBudget * 100) / 100,
        approvedCount: statusCounts['approved'] || 0,
        pendingCount: statusCounts['pending'] || 0,
        rejectedCount: statusCounts['rejected'] || 0,
        projects: projectsWithDetails,
      };
    });
  }

  /**
   * Get budget allocation grouped by DevelopmentIssue (for ISSUE_BASED plans).
   * Mirrors getBudgetByStrategy but uses developmentIssue instead of strategy.
   */
  private getBudgetByIssue(allProjects: any[]): any[] {
    const issueMap = new Map<string, {
      issueId: string;
      issueName: string;
      projects: any[];
    }>();

    allProjects.forEach(project => {
      const issue = project.developmentIssue || project.originalProject?.developmentIssue;
      if (!issue) return;

      if (!issueMap.has(issue.id)) {
        issueMap.set(issue.id, {
          issueId: issue.id,
          issueName: issue.name,
          projects: [],
        });
      }
      issueMap.get(issue.id)!.projects.push(project);
    });

    return Array.from(issueMap.values()).map(entry => {
      const totalBudget = entry.projects.reduce((sum, project) => {
        const budgets = project.budgets || project.originalProject?.budgets || [];
        return sum + budgets.reduce((budgetSum: number, budget: any) => {
          const quantity = typeof budget.quantity === 'string'
            ? parseFloat(budget.quantity)
            : (budget.quantity || 0);
          return budgetSum + quantity;
        }, 0);
      }, 0);

      const statusBreakdown = entry.projects.reduce((counts, project) => {
        let statusName = 'Unknown';
        if (project.trackingStatus && project.trackingStatus.length > 0) {
          const latestTrackingStatus =
            project.trackingStatus.find(ts => ts.isLatest) || project.trackingStatus[0];
          statusName = latestTrackingStatus?.statusId?.name || 'Unknown';
        }
        const category = this.mapStatusToCategory(statusName);
        counts[category] = (counts[category] || 0) + 1;
        return counts;
      }, {});

      return {
        issueId: entry.issueId,
        issueName: entry.issueName,
        totalBudget: Math.round(totalBudget * 100) / 100,
        projectCount: entry.projects.length,
        statusBreakdown: {
          approved: statusBreakdown['approved'] || 0,
          pending: statusBreakdown['pending'] || 0,
          rejected: statusBreakdown['rejected'] || 0,
        },
        size: totalBudget,
        children: entry.projects.map(project => ({
          projectId: project.id,
          projectTitle: project.title || project.originalProject?.title,
          budget: Math.round(
            (project.budgets || project.originalProject?.budgets || []).reduce(
              (sum: number, budget: any) =>
                sum +
                (typeof budget.quantity === 'string'
                  ? parseFloat(budget.quantity)
                  : (budget.quantity || 0)),
              0,
            ) * 100,
          ) / 100,
          status:
            project.trackingStatus?.find(ts => ts.isLatest)?.statusId?.name || 'Unknown',
          statusCategory: this.mapStatusToCategory(
            project.trackingStatus?.find(ts => ts.isLatest)?.statusId?.name || 'Unknown',
          ),
        })),
      };
    }).filter(entry => entry.totalBudget > 0);
  }

  /**
   * Get budget allocation by government agencies
   */
  private async getBudgetByAgencies(allProjects: any[]): Promise<any[]> {
    // Group projects by responsible agency
    const agencyMap = new Map();

    allProjects.forEach(project => {
      const responsibleAgency = project.responsibleAgency || project.originalProject?.responsibleAgency;
      const originAgency = project.originAgencyId || project.originalProject?.originAgencyId;

      // Use responsible agency if available, otherwise use origin agency
      const agency = responsibleAgency || originAgency;

      if (agency) {
        const agencyId = agency.id;

        if (!agencyMap.has(agencyId)) {
          agencyMap.set(agencyId, {
            agencyId: agency.id,
            agencyName: agency.name || agency.th_name || 'ไม่ระบุชื่อ',
            agencyType: responsibleAgency ? 'responsible' : 'origin',
            totalBudget: 0,
            projectCount: 0,
            projects: [],
            statusBreakdown: { approved: 0, pending: 0, rejected: 0 }
          });
        }

        const agencyData = agencyMap.get(agencyId);

        // Calculate project budget
        const budgets = project.budgets || project.originalProject?.budgets || [];
        const projectBudget = budgets.reduce((sum: number, budget: any) => {
          const quantity = typeof budget.quantity === 'string' ? parseFloat(budget.quantity) : (budget.quantity || 0);
          return sum + quantity;
        }, 0);

        // Get project status
        let statusName = 'Unknown';
        let statusCategory = 'unknown';

        if (project.trackingStatus && project.trackingStatus.length > 0) {
          const latestTrackingStatus = project.trackingStatus.find(ts => ts.isLatest) || project.trackingStatus[0];
          statusName = latestTrackingStatus?.statusId?.name || 'Unknown';
          statusCategory = this.mapStatusToCategory(statusName);
        }

        // Update agency totals
        agencyData.totalBudget += projectBudget;
        agencyData.projectCount += 1;
        agencyData.statusBreakdown[statusCategory] += 1;

        // Add project details
        agencyData.projects.push({
          id: project.id,
          title: project.title || project.originalProject?.title,
          budget: Math.round(projectBudget * 100) / 100,
          status: statusName,
          statusCategory: statusCategory,
          isRevised: !!project.originalProject,
          createdAt: project.createdAt || project.originalProject?.createdAt,
          strategy: project.strategy || project.originalProject?.strategy
        });
      }
    });

    // Convert map to array and format
    const result = Array.from(agencyMap.values()).map(agency => ({
      agencyId: agency.agencyId,
      agencyName: agency.agencyName,
      agencyType: agency.agencyType,
      totalBudget: Math.round(agency.totalBudget * 100) / 100,
      projectCount: agency.projectCount,
      statusBreakdown: {
        approved: agency.statusBreakdown.approved,
        pending: agency.statusBreakdown.pending,
        rejected: agency.statusBreakdown.rejected
      },
      // For treemap visualization
      size: agency.totalBudget,
      children: agency.projects.map(project => ({
        projectId: project.id,
        projectTitle: project.title,
        budget: project.budget,
        status: project.status,
        statusCategory: project.statusCategory,
        strategy: project.strategy?.name || 'ไม่ระบุยุทธศาสตร์',
        isRevised: project.isRevised
      })),
      projects: agency.projects
    }));

    // Sort by total budget (descending)
    return result.sort((a, b) => b.totalBudget - a.totalBudget);
  }

  /**
   * Get plan analysis for Sunburst Chart (Plan → Tactic → Strategy)
   */
  private async getPlanAnalysis(allProjects: any[], plans: any[], tactics: any[], strategies: any[]): Promise<any> {
    const planMap = new Map();

    // Initialize plans
    plans.forEach(plan => {
      planMap.set(plan.id, {
        planId: plan.id,
        planName: plan.name,
        totalBudget: 0,
        projectCount: 0,
        tactics: new Map()
      });
    });

    // Process projects and group by plan → tactic → strategy
    allProjects.forEach(project => {
      const projectPlan = project.plan || project.originalProject?.plan;
      const projectTactic = project.tactic || project.originalProject?.tactic;
      const projectStrategy = project.strategy || project.originalProject?.strategy;

      if (projectPlan) {
        const planData = planMap.get(projectPlan.id);
        if (planData) {
          // Calculate project budget
          const budgets = project.budgets || project.originalProject?.budgets || [];
          const projectBudget = budgets.reduce((sum: number, budget: any) => {
            const quantity = typeof budget.quantity === 'string' ? parseFloat(budget.quantity) : (budget.quantity || 0);
            return sum + quantity;
          }, 0);

          planData.totalBudget += projectBudget;
          planData.projectCount += 1;

          // Group by tactic
          if (projectTactic) {
            if (!planData.tactics.has(projectTactic.id)) {
              planData.tactics.set(projectTactic.id, {
                tacticId: projectTactic.id,
                tacticName: projectTactic.name,
                totalBudget: 0,
                projectCount: 0,
                strategies: new Map()
              });
            }

            const tacticData = planData.tactics.get(projectTactic.id);
            tacticData.totalBudget += projectBudget;
            tacticData.projectCount += 1;

            // Group by strategy
            if (projectStrategy) {
              if (!tacticData.strategies.has(projectStrategy.id)) {
                tacticData.strategies.set(projectStrategy.id, {
                  strategyId: projectStrategy.id,
                  strategyName: projectStrategy.name,
                  totalBudget: 0,
                  projectCount: 0,
                  projects: []
                });
              }

              const strategyData = tacticData.strategies.get(projectStrategy.id);
              strategyData.totalBudget += projectBudget;
              strategyData.projectCount += 1;

              // Add project details
              strategyData.projects.push({
                id: project.id,
                title: project.title || project.originalProject?.title,
                budget: Math.round(projectBudget * 100) / 100,
                status: project.trackingStatus?.find(ts => ts.isLatest)?.statusId?.name || 'Unknown',
                statusCategory: this.mapStatusToCategory(project.trackingStatus?.find(ts => ts.isLatest)?.statusId?.name || 'Unknown'),
                isRevised: !!project.originalProject
              });
            }
          }
        }
      }
    });

    // Convert to Sunburst Chart format - แสดงทุกแผนงานแม้ไม่มีข้อมูล
    const result = Array.from(planMap.values()).map(plan => ({
      planId: plan.planId,
      planName: plan.planName,
      totalBudget: Math.round(plan.totalBudget * 100) / 100,
      projectCount: plan.projectCount,
      // For Sunburst Chart
      size: plan.totalBudget,
      children: Array.from(plan.tactics.values()).map((tactic: any) => ({
        tacticId: tactic.tacticId,
        tacticName: tactic.tacticName,
        totalBudget: Math.round(tactic.totalBudget * 100) / 100,
        projectCount: tactic.projectCount,
        size: tactic.totalBudget,
        children: Array.from(tactic.strategies.values()).map((strategy: any) => ({
          strategyId: strategy.strategyId,
          strategyName: strategy.strategyName,
          totalBudget: Math.round(strategy.totalBudget * 100) / 100,
          projectCount: strategy.projectCount,
          size: strategy.totalBudget,
          projects: strategy.projects
        }))
      }))
    }));

    // Sort by total budget (descending), but keep plans with 0 budget at the end
    return result.sort((a, b) => {
      if (a.totalBudget === 0 && b.totalBudget === 0) return 0;
      if (a.totalBudget === 0) return 1;
      if (b.totalBudget === 0) return -1;
      return b.totalBudget - a.totalBudget;
    });
  }

  /**
   * Get timeline analysis for projects
   */
  private async getTimelineAnalysis(allProjects: any[], developmentPlan: any): Promise<any> {
    const timeline: any[] = [];

    // Create timeline entries for each year in development plan
    for (let year = developmentPlan.startYear; year <= developmentPlan.endYear; year++) {
      const yearProjects = allProjects.filter(project => {
        const projectYear = project.projectYear || project.originalProject?.projectYear;
        return projectYear === year;
      });

      const yearBudget = yearProjects.reduce((sum, project) => {
        const budgets = project.budgets || project.originalProject?.budgets || [];
        return sum + budgets.reduce((budgetSum: number, budget: any) => {
          const quantity = typeof budget.quantity === 'string' ? parseFloat(budget.quantity) : (budget.quantity || 0);
          return budgetSum + quantity;
        }, 0);
      }, 0);

      // Group by plan
      const planBreakdown = new Map();
      yearProjects.forEach(project => {
        const projectPlan = project.plan || project.originalProject?.plan;
        if (projectPlan) {
          if (!planBreakdown.has(projectPlan.id)) {
            planBreakdown.set(projectPlan.id, {
              planName: projectPlan.name,
              projectCount: 0,
              budget: 0
            });
          }
          const planData = planBreakdown.get(projectPlan.id);
          planData.projectCount += 1;

          const projectBudget = (project.budgets || project.originalProject?.budgets || []).reduce((sum: number, budget: any) => {
            const quantity = typeof budget.quantity === 'string' ? parseFloat(budget.quantity) : (budget.quantity || 0);
            return sum + quantity;
          }, 0);
          planData.budget += projectBudget;
        }
      });

      timeline.push({
        year,
        totalBudget: Math.round(yearBudget * 100) / 100,
        projectCount: yearProjects.length,
        planBreakdown: Array.from(planBreakdown.values()).map(plan => ({
          planName: plan.planName,
          projectCount: plan.projectCount,
          budget: Math.round(plan.budget * 100) / 100
        }))
      });
    }

    return timeline;
  }

  /**
   * Get plan comparison data
   */
  private async getPlanComparison(allProjects: any[], plans: any[]): Promise<any> {
    return plans.map(plan => {
      const planProjects = allProjects.filter(project => {
        const projectPlan = project.plan || project.originalProject?.plan;
        return projectPlan && projectPlan.id === plan.id;
      });

      const totalBudget = planProjects.reduce((sum, project) => {
        const budgets = project.budgets || project.originalProject?.budgets || [];
        return sum + budgets.reduce((budgetSum: number, budget: any) => {
          const quantity = typeof budget.quantity === 'string' ? parseFloat(budget.quantity) : (budget.quantity || 0);
          return budgetSum + quantity;
        }, 0);
      }, 0);

      // Calculate status breakdown
      const statusBreakdown = planProjects.reduce((counts, project) => {
        let statusName = 'Unknown';
        if (project.trackingStatus && project.trackingStatus.length > 0) {
          const latestTrackingStatus = project.trackingStatus.find(ts => ts.isLatest) || project.trackingStatus[0];
          statusName = latestTrackingStatus?.statusId?.name || 'Unknown';
        }
        const category = this.mapStatusToCategory(statusName);
        counts[category] = (counts[category] || 0) + 1;
        return counts;
      }, {});

      // Calculate average budget per project
      const averageBudgetPerProject = planProjects.length > 0 ? totalBudget / planProjects.length : 0;

      // Calculate completion rate (approved projects / total projects)
      const approvedProjects = statusBreakdown['approved'] || 0;
      const completionRate = planProjects.length > 0 ? (approvedProjects / planProjects.length) * 100 : 0;

      return {
        planId: plan.id,
        planName: plan.name,
        totalBudget: Math.round(totalBudget * 100) / 100,
        projectCount: planProjects.length,
        averageBudgetPerProject: Math.round(averageBudgetPerProject * 100) / 100,
        completionRate: Math.round(completionRate * 100) / 100,
        statusBreakdown: {
          approved: statusBreakdown['approved'] || 0,
          pending: statusBreakdown['pending'] || 0,
          rejected: statusBreakdown['rejected'] || 0
        },
        // Key metrics for comparison
        budgetEfficiency: completionRate, // Higher completion rate = better efficiency
        projectScale: planProjects.length > 10 ? 'large' : planProjects.length > 5 ? 'medium' : planProjects.length > 0 ? 'small' : 'none'
      };
    }).sort((a, b) => {
      // Sort by total budget (descending), but keep plans with 0 budget at the end
      if (a.totalBudget === 0 && b.totalBudget === 0) return 0;
      if (a.totalBudget === 0) return 1;
      if (b.totalBudget === 0) return -1;
      return b.totalBudget - a.totalBudget;
    });
  }

  /**
   * Get trend analysis data
   */
  private async getTrendAnalysis(allProjects: any[], developmentPlan: any): Promise<any> {
    const yearlyTrend: any[] = [];
    const monthlyTrend: any[] = [];

    // Yearly trend
    for (let year = developmentPlan.startYear; year <= developmentPlan.endYear; year++) {
      const projectsInYear = allProjects.filter(project => {
        const budgets = project.budgets || project.originalProject?.budgets || [];
        return budgets.some(budget => budget.year === year);
      });

      const totalBudget = projectsInYear.reduce((sum, project) => {
        const budgets = project.budgets || project.originalProject?.budgets || [];
        return sum + budgets
          .filter(budget => budget.year === year)
          .reduce((budgetSum: number, budget: any) => {
            const quantity = typeof budget.quantity === 'string' ? parseFloat(budget.quantity) : (budget.quantity || 0);
            return budgetSum + quantity;
          }, 0);
      }, 0);

      const approvedProjects = projectsInYear.filter(project => {
        let statusName = 'Unknown';
        if (project.trackingStatus && project.trackingStatus.length > 0) {
          const latestTrackingStatus = project.trackingStatus.find(ts => ts.isLatest) || project.trackingStatus[0];
          statusName = latestTrackingStatus?.statusId?.name || 'Unknown';
        }
        return this.mapStatusToCategory(statusName) === 'approved';
      }).length;

      yearlyTrend.push({
        year,
        totalBudget: Math.round(totalBudget * 100) / 100,
        projectCount: projectsInYear.length,
        approvedProjects,
        approvalRate: projectsInYear.length > 0 ? Math.round((approvedProjects / projectsInYear.length) * 100 * 100) / 100 : 0
      });
    }

    // Monthly trend (last 12 months)
    const currentDate = new Date();
    for (let i = 11; i >= 0; i--) {
      const date = new Date(currentDate.getFullYear(), currentDate.getMonth() - i, 1);
      const year = date.getFullYear();
      const month = date.getMonth() + 1;

      const projectsInMonth = allProjects.filter(project => {
        const createdDate = new Date(project.createdAt || project.originalProject?.createdAt);
        return createdDate.getFullYear() === year && createdDate.getMonth() + 1 === month;
      });

      monthlyTrend.push({
        year,
        month,
        monthName: date.toLocaleString('th-TH', { month: 'long' }),
        newProjects: projectsInMonth.length
      });
    }

    // Calculate growth rates
    const budgetGrowth: any[] = [];
    const projectGrowth: any[] = [];

    for (let i = 1; i < yearlyTrend.length; i++) {
      const prevBudget = yearlyTrend[i - 1].totalBudget;
      const currentBudget = yearlyTrend[i].totalBudget;
      const prevProjects = yearlyTrend[i - 1].projectCount;
      const currentProjects = yearlyTrend[i].projectCount;

      budgetGrowth.push({
        year: yearlyTrend[i].year,
        growthRate: prevBudget > 0 ? Math.round(((currentBudget - prevBudget) / prevBudget) * 100 * 100) / 100 : 0
      });

      projectGrowth.push({
        year: yearlyTrend[i].year,
        growthRate: prevProjects > 0 ? Math.round(((currentProjects - prevProjects) / prevProjects) * 100 * 100) / 100 : 0
      });
    }

    return {
      yearlyTrend,
      monthlyTrend,
      budgetGrowth,
      projectGrowth,
      summary: {
        totalBudget: Math.round(yearlyTrend.reduce((sum, year) => sum + year.totalBudget, 0) * 100) / 100,
        averageYearlyBudget: yearlyTrend.length > 0 ? Math.round((yearlyTrend.reduce((sum, year) => sum + year.totalBudget, 0) / yearlyTrend.length) * 100) / 100 : 0,
        totalProjects: yearlyTrend.reduce((sum, year) => sum + year.projectCount, 0),
        averageApprovalRate: yearlyTrend.length > 0 ? Math.round((yearlyTrend.reduce((sum, year) => sum + year.approvalRate, 0) / yearlyTrend.length) * 100) / 100 : 0
      }
    };
  }


  async findByStatusApproved(option: {
    userId: string;
    countOnly?: boolean;
    developmentPlanId?: string;
    filterByResponsibleAgency?: boolean;
  }): Promise<IUnifiedProjectDisplay[] | number> {
    const { userId, countOnly, developmentPlanId, filterByResponsibleAgency } = option;

    // Validate user permissions
    const workHistory = await this.workHistoryRepo.findOne({
      where: { user: { id: userId } },
      relations: ['workStatus', 'role', 'governmentAgencies'],
    });
    if (!workHistory) return countOnly ? 0 : [];
    if (workHistory.workStatus.name !== 'approved')
      throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิในการเข้าถึงข้อมูล');

    const allowedRoles = ['user', 'staff', 'admin', 'super-admin', 'c-level'];
    if (!allowedRoles.includes(workHistory.role.name))
      throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิในการเข้าถึงข้อมูล');

    // Validate development plan
    if (!developmentPlanId) {
      throw new BadRequestException('Development plan ID is required');
    }

    const developmentPlan = await this.developmentPlanRepo.findOne({
      where: { id: developmentPlanId },
    });
    if (!developmentPlan)
      throw new NotFoundException('Development plan not found');

    // Query both original and revised projects
    const responsibleAgencyId = filterByResponsibleAgency ? workHistory.governmentAgencies?.id : "";
    const [originalProjects, revisedProjects] = await Promise.all([
      this.findOriginalApprovedProjects(developmentPlanId, responsibleAgencyId),
      this.findRevisedApprovedProjects(developmentPlanId, responsibleAgencyId),
    ]);

    // If count only, return total count
    if (countOnly) {
      return originalProjects.length + revisedProjects.length;
    }

    // CLAUDE.md §14 — Batched lineage-lock lookup for the main-plan PG rows.
    // Approved PGs in this list MAY have existing RevisedProjectGroup
    // descendants (revision/change workflow starts here). FE-01 relies on
    // `hasDescendant` to disable edit/delete buttons.
    const lockedPgIds = await this.findProjectGroupIdsWithDescendants(
      originalProjects.map((p) => p.id),
    );

    // Map to unified format
    const unifiedOriginals = originalProjects.map((project) =>
      UnifiedProjectMapper.fromProjectGroup(project, lockedPgIds.has(project.id)),
    );
    const unifiedRevised = revisedProjects.map((project) =>
      UnifiedProjectMapper.fromRevisedProjectGroup(project),
    );

    // Combine and sort by created date
    const combined = [...unifiedOriginals, ...unifiedRevised];
    combined.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    return combined;
  }

  /**
   * Helper method: คำนวณ field ที่เปลี่ยนแปลงระหว่าง 2 version
   */
  private calculateChangedFields(
    current: IUnifiedProjectDisplay,
    previous: IUnifiedProjectDisplay | null,
  ): string[] {
    if (!previous) return [];

    const changedFields: string[] = [];
    const fieldsToCompare = [
      'title',
      'objective',
      'goal',
      'indicator',
      'expected',
      'projectYear',
      'additionalDetail',
      'startLat',
      'startLng',
      'endLat',
      'endLng',
    ];

    // Compare basic fields
    for (const field of fieldsToCompare) {
      if (current[field] !== previous[field]) {
        changedFields.push(field);
      }
    }

    // Compare strategy
    if (current.strategy?.id !== previous.strategy?.id) {
      changedFields.push('strategy');
    }

    // Compare tactic
    if (current.tactic?.id !== previous.tactic?.id) {
      changedFields.push('tactic');
    }

    // Compare plan
    if (current.plan?.id !== previous.plan?.id) {
      changedFields.push('plan');
    }

    // Compare budgets (simple check: different count or total quantity)
    const currentBudgetTotal = current.budgets?.reduce((sum, b) => sum + Number(b.quantity), 0) || 0;
    const previousBudgetTotal = previous.budgets?.reduce((sum, b) => sum + Number(b.quantity), 0) || 0;
    const currentBudgetCount = current.budgets?.length || 0;
    const previousBudgetCount = previous.budgets?.length || 0;

    if (currentBudgetTotal !== previousBudgetTotal || currentBudgetCount !== previousBudgetCount) {
      changedFields.push('budgets');
    }

    return changedFields;
  }

  /**
   * หาประวัติทุก version ของโครงการ
   * - แสดงโครงการแม่ (ถ้ามี)
   * - แสดงทุก revision (เรียงตาม revisionNumber)
   * - แต่ละ revision เอาสถานะล่าสุด (trackingStatus.isLatest = true)
   */
  // async findAllVersions(
  //   projectId: string,
  //   userId: string,
  // ): Promise<any> {
  //   // Validate user permissions
  //   const workHistory = await this.workHistoryRepo.findOne({
  //     where: { user: { id: userId } },
  //     relations: ['workStatus', 'role'],
  //   });

  //   if (!workHistory)
  //     throw new UnauthorizedException('User not found');
  //   if (workHistory.workStatus.name !== 'approved')
  //     throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิในการเข้าถึงข้อมูล');

  //   const allowedRoles = ['user', 'staff', 'admin', 'super-admin', 'c-level'];
  //   if (!allowedRoles.includes(workHistory.role.name))
  //     throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิในการเข้าถึงข้อมูล');

  //   // Try to find as ProjectGroup first
  //   let originalProject = await this.projectGroupRepo.findOne({
  //     where: { id: projectId },
  //     relations: [
  //       'createdBy',
  //       'createdBy.user',
  //       'createdBy.amphoe',
  //       'createdBy.localAdministrativeOrganization',
  //       'strategy',
  //       'tactic',
  //       'plan',
  //       'developmentPlan',
  //       'budgets',
  //       'trackingStatus',
  //       'trackingStatus.statusId',
  //       'trackingStatus.comments',
  //       'trackingStatus.createdBy',
  //       'trackingStatus.createdBy.user',
  //       'responsibleAgency',
  //       'originAgencyId',
  //       'favorites',
  //       'favorites.userId',
  //       'attachments',
  //     ],
  //   });

  //   const allRevisions = await this.revisedProjectGroupRepo.find({
  //     where: {
  //       projectGroup: { id: originalProject?.id },
  //       trackingStatus: { isLatest: true },
  //     },
  //     relations: [
  //       'developmentPlanRevision',
  //       'developmentPlanRevision.developmentPlan',
  //       'developmentPlanRevision.revisionType',
  //       'projectGroup',
  //       'createdBy',
  //       'createdBy.user',
  //       'createdBy.amphoe',
  //       'createdBy.localAdministrativeOrganization',
  //       'strategy',
  //       'tactic',
  //       'plan',
  //       'budgets',
  //       'trackingStatus',
  //       'trackingStatus.statusId',
  //       'trackingStatus.comments',
  //       'trackingStatus.createdBy',
  //       'trackingStatus.createdBy.user',
  //       'responsibleAgency',
  //       'originAgencyId',
  //       'attachments',
  //     ],
  //     order: {
  //       developmentPlanRevision: {
  //         revisionNumber: 'ASC',
  //       },
  //     },
  //   });

  //   // Map to unified format
  //   const unifiedOriginal = originalProject
  //     ? UnifiedProjectMapper.fromProjectGroup(originalProject)
  //     : null;

  //   const unifiedRevisions = allRevisions.map((revision) =>
  //     UnifiedProjectMapper.fromRevisedProjectGroup(revision),
  //   );


  //   // Add comparison data to each revision
  //   for (let i = 0; i < unifiedRevisions.length; i++) {
  //     const current = unifiedRevisions[i];
  //     let previous: IUnifiedProjectDisplay | null = null;
  //     let comparedWith: 'original' | 'revised' | null = null;

  //     if (i === 0) {
  //       // First revision: compare with original project
  //       previous = unifiedOriginal;
  //       comparedWith = previous ? 'original' : null;
  //     } else {
  //       // Subsequent revisions: compare with previous revision
  //       previous = unifiedRevisions[i - 1];
  //       comparedWith = 'revised';
  //     }

  //     // Calculate changed fields
  //     const changedFields = this.calculateChangedFields(current, previous);

  //     // Add changes to the current revision
  //     current.changes = {
  //       comparedWith,
  //       changedFields,
  //     };
  //   }

  //   // Calculate total versions
  //   const totalVersions =
  //     (originalProject ? 1 : 0) + unifiedRevisions.length;

  //   // Find latest version
  //   let latestVersion: IProjectVersionsResponse['latestVersion'] = null;
  //   if (unifiedRevisions.length > 0) {
  //     const latest = unifiedRevisions[unifiedRevisions.length - 1];
  //     latestVersion = {
  //       id: latest.id,
  //       revisionNumber: latest.developmentPlanRevision?.revisionNumber,
  //       isOriginal: false,
  //     };
  //   } else if (originalProject) {
  //     latestVersion = {
  //       id: originalProject.id,
  //       isOriginal: true,
  //     };
  //   }

  //   return {
  //     originalProject: unifiedOriginal,
  //     revisions: unifiedRevisions,
  //     totalVersions,
  //     latestVersion,

  //   };
  // }

  async findAllVersions(
    projectId: string,
    userId: string,
  ): Promise<any> {
    // Validate user permissions
    const workHistory = await this.workHistoryRepo.findOne({
      where: { user: { id: userId }, isCurrent: true },
      relations: ['workStatus', 'role'],
    });

    if (!workHistory) {
      throw new UnauthorizedException('User not found');
    }

    if (workHistory.workStatus.name !== 'approved') {
      throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิในการเข้าถึงข้อมูล');
    }

    const allowedRoles = ['user', 'staff', 'admin', 'super-admin', 'c-level'];
    if (!allowedRoles.includes(workHistory.role.name)) {
      throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิในการเข้าถึงข้อมูล');
    }

    let originalProject: any = null;
    let rootProjectGroupId: string | null = null;

    // 1) ลองหาเป็น project group ก่อน
    originalProject = await this.projectGroupRepo.findOne({
      where: { id: projectId },
      relations: [
        'createdBy',
        'createdBy.user',
        'createdBy.amphoe',
        'createdBy.localAdministrativeOrganization',
        'strategy',
        'tactic',
        'plan',
        'developmentPlan',
        'budgets',
        'trackingStatus',
        'trackingStatus.statusId',
        'trackingStatus.comments',
        'trackingStatus.createdBy',
        'trackingStatus.createdBy.user',
        'responsibleAgency',
        'originAgencyId',
        'favorites',
        'favorites.userId',
        'attachments',
      ],
    });

    if (originalProject) {
      rootProjectGroupId = originalProject.id;
    } else {
      // 2) ถ้าไม่เจอ ลองหาเป็น revised project
      const revisedProject = await this.revisedProjectGroupRepo.findOne({
        where: { id: projectId },
        relations: [
          'projectGroup',
        ],
      });

      if (!revisedProject) {
        throw new NotFoundException('ไม่พบโครงการ');
      }

      rootProjectGroupId = revisedProject.projectGroup?.id || null;

      if (!rootProjectGroupId) {
        throw new NotFoundException('ไม่พบโครงการต้นฉบับของรายการแก้ไขนี้');
      }

      // 3) ใช้ root project group id ไปดึง original project
      originalProject = await this.projectGroupRepo.findOne({
        where: { id: rootProjectGroupId },
        relations: [
          'createdBy',
          'createdBy.user',
          'createdBy.amphoe',
          'createdBy.localAdministrativeOrganization',
          'strategy',
          'tactic',
          'plan',
          'developmentPlan',
          'budgets',
          'trackingStatus',
          'trackingStatus.statusId',
          'trackingStatus.comments',
          'trackingStatus.createdBy',
          'trackingStatus.createdBy.user',
          'responsibleAgency',
          'originAgencyId',
          'favorites',
          'favorites.userId',
          'attachments',
        ],
      });
    }

    // 4) ดึง revisions ทั้งหมดของ project group นั้น
    const allRevisions = await this.revisedProjectGroupRepo.find({
      where: {
        projectGroup: { id: rootProjectGroupId as string },
        trackingStatus: { isLatest: true },
      },
      relations: [
        'developmentPlanRevision',
        'developmentPlanRevision.developmentPlan',
        'developmentPlanRevision.revisionType',
        'projectGroup',
        'createdBy',
        'createdBy.user',
        'createdBy.amphoe',
        'createdBy.localAdministrativeOrganization',
        'strategy',
        'tactic',
        'plan',
        'developmentPlan',
        'budgets',
        'trackingStatus',
        'trackingStatus.statusId',
        'trackingStatus.comments',
        'trackingStatus.createdBy',
        'trackingStatus.createdBy.user',
        'responsibleAgency',
        'originAgencyId',
        'attachments',
      ],
      order: {
        developmentPlanRevision: {
          revisionNumber: 'ASC',
        },
      },
    });

    // CLAUDE.md §14 — In the version chain view, the original PG is locked
    // iff any revision exists for it (allRevisions.length > 0). The chain is
    // already loaded, so we can derive `hasDescendant` without another query.
    const unifiedOriginal = originalProject
      ? UnifiedProjectMapper.fromProjectGroup(originalProject, allRevisions.length > 0)
      : null;

    const unifiedRevisions = allRevisions.map((revision) =>
      UnifiedProjectMapper.fromRevisedProjectGroup(revision),
    );

    // Add comparison data
    for (let i = 0; i < unifiedRevisions.length; i++) {
      const current = unifiedRevisions[i];
      let previous: IUnifiedProjectDisplay | null = null;
      let comparedWith: 'original' | 'revised' | null = null;

      if (i === 0) {
        previous = unifiedOriginal;
        comparedWith = previous ? 'original' : null;
      } else {
        previous = unifiedRevisions[i - 1];
        comparedWith = 'revised';
      }

      const changedFields = this.calculateChangedFields(current, previous);

      current.changes = {
        comparedWith,
        changedFields,
      };
    }

    const totalVersions = (unifiedOriginal ? 1 : 0) + unifiedRevisions.length;

    let latestVersion: IProjectVersionsResponse['latestVersion'] = null;

    if (unifiedRevisions.length > 0) {
      const latest = unifiedRevisions[unifiedRevisions.length - 1];
      latestVersion = {
        id: latest.id,
        revisionNumber: latest.developmentPlanRevision?.revisionNumber,
        isOriginal: false,
      };
    } else if (unifiedOriginal) {
      latestVersion = {
        id: unifiedOriginal.id,
        isOriginal: true,
      };
    }

    return {
      originalProject: unifiedOriginal,
      revisions: unifiedRevisions,
      totalVersions,
      latestVersion,
    };
  }

  async findDelete(userId: string): Promise<any> {
    try {
      // Get the active work history for the user
      const workHistory = await this.workHistoryRepo.findOne({
        where: {
          user: { id: userId },
        },
        relations: ['user'],
      });

      if (!workHistory) {
        return 0;
      }
      const result = await this.projectGroupRepo.find({
        where: {
          createdBy: { id: workHistory.id },
          deletedAt: Not(IsNull()),
        },
        withDeleted: true,
        relations: ['createdBy'],
      });
      return result;
    } catch (error) {
      this.logger.error('Failed to count deleted projects', error.stack);
      throw new InternalServerErrorException(
        'Unable to count deleted projects',
      );
    }
  }

  async findOne(id: string, userId: string): Promise<ProjectGroup> {
    try {

      const workHistory = await this.workHistoryRepo.findOne({
        where: { user: { id: userId }, isCurrent: true },
        relations: [
          'user',
          'role',
          'localAdministrativeOrganization',
          'governmentAgencies',
          'workStatus',
          'workHistoryResponsibleAmphoe',
          'workHistoryResponsibleAmphoe.amphoe',
        ],
      });
      if (!workHistory) throw new NotFoundException('Work history ID not found');
      if (workHistory.workStatus.name !== "approved") throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิในการเข้าถึงข้อมูล');
      const role = workHistory.role.name;
      const projectGroup = await this.projectGroupRepo.findOne({
        where: { id },
        relations: [
          'createdBy',
          'createdBy.user',
          'createdBy.amphoe',
          'createdBy.localAdministrativeOrganization',
          'strategy',
          'tactic',
          'plan',
          'developmentPlan',
          'budgets',
          'trackingStatus',
          'trackingStatus.comments',
          'trackingStatus.statusId',
          'trackingStatus.createdBy',
          'trackingStatus.createdBy.user',
          'trackingStatus.createdBy.localAdministrativeOrganization',
          'trackingStatus.createdBy.governmentAgencies',
          'trackingStatus.createdBy.workStatus',
          'trackingStatus.createdBy.workStatus',
          'responsibleAgency',
          'originAgencyId',
          'localAdministrativeOrganization',
          'attachments',
          'amphoe'
        ],
      });

      if (role === 'user') {
        // Allow access if user is the creator (owner) or belongs to the same organization

        const isOwner = projectGroup?.createdBy?.id === workHistory.id;
        if (!isOwner) {
          const sameAgency =
            String(projectGroup?.responsibleAgency?.id) ===
            String(workHistory?.governmentAgencies?.id);

          const sameLao =
            String(projectGroup?.localAdministrativeOrganization?.id) ===
            String(workHistory?.localAdministrativeOrganization?.id);

          if (!sameAgency && !sameLao) {
            throw new UnauthorizedException(
              'คุณไม่มีสิทธิ์ในการเข้าถึงข้อมูลโครงการนี้'
            );
          }
        }
      } else if (role === 'staff' || role === 'admin' || role === 'super-admin' || role === 'c-level') {
        // These roles can see all project details - no restriction needed
      } else {
        throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิในการเข้าถึงข้อมูล');
      }

      if (!projectGroup) {
        throw new NotFoundException(`ไม่พบข้อมูลของโครงการ ID ${id}`);
      }

      // CLAUDE.md §14 — expose lineage-lock state for FE-01 so the detail
      // view can disable edit/delete buttons consistently with list views.
      const lockedSet = await this.findProjectGroupIdsWithDescendants([projectGroup.id]);
      (projectGroup as any).hasDescendant = lockedSet.has(projectGroup.id);

      return projectGroup;
    } catch (error) {
      handleException(this.logger, error);
    }
  }


  async update(
    id: string,
    dto: UpdateProjectGroupDto,
    userId: string,
  ): Promise<ProjectGroup> {
    return await this.dataSource.transaction(async (manager) => {
      // CLAUDE.md §14 — Version Lineage Immutability.
      // A ProjectGroup that already has a non-deleted RevisedProjectGroup
      // descendant (prev_project_type = 'original') is locked and cannot be
      // mutated. This guard MUST run BEFORE any repository write so that the
      // ON DELETE CASCADE on revised_project_groups.prev_project_id cannot
      // silently destroy descendant rows.
      await this.lineageLockService.assertEditable(id, 'original', manager);

      // 1. ตรวจสอบ workHistory
      const workHistory = await manager.findOne(WorkHistory, {
        where: { user: { id: userId } },
        relations: [
          'localAdministrativeOrganization',
          'governmentAgencies',
          'workStatus',
        ],
      });
      if (
        !workHistory ||
        workHistory.workStatus.name.toLocaleLowerCase() !== 'approved'
      )
        throw new NotFoundException('Work history ID not found');

      // 2. ตรวจสอบ duplicate title (ยกเว้นตัวเอง)
      const duplicateTitle = await manager.findOne(
        ProjectGroup,
        {
          where: {
            title: dto.title,
            createdBy: { id: workHistory.id },
            id: Not(id),
          },
        },
      );
      if (duplicateTitle)
        throw new ConflictException(
          'Project group with this title already exists',
        );

      // 5. ดึง group เดิม
      const group = await manager.findOne(ProjectGroup, {
        where: { id },
        relations: [
          'strategy',
          'tactic',
          'plan',
          'developmentPlan',
          'developmentIssue',
        ],
      });
      if (!group) throw new NotFoundException(`Project group ${id} not found`);
      if (!group.developmentPlan) {
        throw new BadRequestException(
          'โครงการนี้ไม่มีแผนพัฒนาต้นทาง ไม่สามารถแก้ไขได้',
        );
      }

      // CLAUDE.md §16.5 — validate classification shape against the
      // plan the project already belongs to. The plan is immutable via
      // §14, so we resolve the format from the loaded row and reject
      // any cross-shape update attempt.
      const format = await this.validateClassificationShape(
        manager,
        group.developmentPlan.id,
        dto,
      );

      // 3. ตรวจสอบ foreign key (format-aware)
      let strategy: Strategy | null = null;
      let tactic: Tactic | null = null;
      let plan: Plan | null = null;
      let developmentIssue: DevelopmentIssue | null = null;
      if (format === ReportFormat.STRATEGY_BASED) {
        [strategy, tactic, plan] = await Promise.all([
          manager.findOne(Strategy, { where: { id: dto.strategyId } }),
          manager.findOne(Tactic, { where: { id: dto.tacticId } }),
          manager.findOne(Plan, { where: { id: dto.planId } }),
        ]);
        if (!strategy)
          throw new NotFoundException(
            `Strategy ID not found: ${dto.strategyId}`,
          );
        if (!tactic)
          throw new NotFoundException(`Tactic ID not found: ${dto.tacticId}`);
        if (!plan)
          throw new NotFoundException(`Plan ID not found: ${dto.planId}`);
      } else {
        developmentIssue = await manager.findOne(DevelopmentIssue, {
          where: { id: dto.developmentIssueId },
        });
        if (!developmentIssue)
          throw new NotFoundException(
            `${ERROR_CODES.DEVELOPMENT_ISSUE_NOT_FOUND}: ${ERROR_MESSAGES.DEVELOPMENT_ISSUE_NOT_FOUND}`,
          );
      }

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
              strategy,
              tactic,
              plan,
              indicator: dto.indicator,
              developmentIssue: null,
            };

      // 6. อัปเดตข้อมูลหลัก
      Object.assign(group, {
        title: dto.title,
        objective: dto.objective,
        goal: dto.goal,
        startLat: dto.startLat,
        startLng: dto.startLng,
        endLat: dto.endLat ?? null,
        endLng: dto.endLng ?? null,
        expected: dto.expected,
        isBooked: dto.isBooked,
        ...classificationColumns,
      });
      await manager.save(group);

      // 7. จัดการ budget (ถ้ามีการส่งมา)
      if (dto.budget !== undefined) {
        // ลบ budget เก่าทั้งหมด
        await manager.delete(Budget, { projectGroupId: { id } });

        // สร้าง budget ใหม่ถ้ามีการส่งมา
        if (Array.isArray(dto.budget) && dto.budget.length > 0) {
          const projectYear = new Date().getMonth() + 1 >= 10 ? new Date().getFullYear() + 544 : new Date().getFullYear() + 543;

          // Validate budget year is within development plan range
          if (group.developmentPlan) {
            for (const budgetItem of dto.budget) {
              if (
                budgetItem.year < group.developmentPlan.startYear ||
                budgetItem.year > group.developmentPlan.endYear ||
                budgetItem.year < projectYear
              ) {
                throw new BadRequestException(
                  `ปีงบประมาณต้องอยู่ในช่วง พ.ศ. ${group.developmentPlan.startYear} - ${group.developmentPlan.endYear} (ปีที่ส่งมา: ${budgetItem.year})`
                );
              }
            }
          } else {
            // ถ้าไม่มี development plan ให้ validate เฉพาะ projectYear
            for (const budgetItem of dto.budget) {
              if (budgetItem.year < projectYear) {
                throw new BadRequestException(
                  `ปีงบประมาณต้องไม่น้อยกว่าปีปัจจุบัน พ.ศ. ${projectYear} (ปีที่ส่งมา: ${budgetItem.year})`
                );
              }
            }
          }

          const budgets = dto.budget.map((item) =>
            manager.create(Budget, {
              projectGroupId: { id },
              year: item.year,
              quantity: item.quantity,
            })
          );
          await manager.save(budgets);
        }
      }

      return group;
    });
  }

  async remove(id: string): Promise<{ message: string }> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        // CLAUDE.md §14 — guard BEFORE the delete so cascade cannot destroy
        // descendants silently.
        await this.lineageLockService.assertDeletable(id, 'original', manager);

        const result = await manager.delete(ProjectGroup, id);
        if (result.affected === 0) {
          throw new NotFoundException(`projectGroup with ID ${id} not found`);
        }
        return {
          message: `projectGroup with ID ${id} has been permanently removed.`,
        };
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async softRemove(id: string): Promise<{ message: string }> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        // CLAUDE.md §14 — guard BEFORE the soft-delete.
        await this.lineageLockService.assertDeletable(id, 'original', manager);

        const result = await manager.softDelete(ProjectGroup, id);
        if (result.affected === 0) {
          throw new NotFoundException(`projectGroup with ID ${id} not found`);
        }
        return { message: `projectGroup with ID ${id} has been soft-removed.` };
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async restore(id: string): Promise<{ message: string }> {
    try {
      const result = await this.projectGroupRepo.restore(id);
      if (result.affected === 0) {
        throw new NotFoundException(
          `projectGroup with ID ${id} not found or was not deleted.`,
        );
      }
      return { message: `projectGroup with ID ${id} has been restored.` };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  // ───────────────────── Helpers ─────────────────────
  private async getWorkHistory(manager: EntityManager, userId: string) {
    const workHistory = await manager.findOne(WorkHistory, {
      where: { user: { id: userId }, isCurrent: true },
      relations: ['user', 'localAdministrativeOrganization', 'governmentAgencies', 'amphoe', 'workStatus', 'role'],
    });
    if (!workHistory) {
      throw new NotFoundException('Work history ID not found');
    }
    return workHistory;
  }

  private assertWorkStatusApproved(workHistory: WorkHistory): void {
    if (workHistory.workStatus?.name !== 'approved') {
      throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิ์ในการดำเนินการ (workStatus ต้องเป็น approved)');
    }
  }

  /**
   * CLAUDE.md §13 — Advisory geo validation for LAO users only.
   * Returns a Thai warning string when any supplied coordinate falls outside the
   * user's amphoe boundary, or null when no warning is needed.
   * This check is NEVER blocking — callers must treat the result as advisory only.
   */
  private checkGeoWarning(
    workHistory: WorkHistory,
    coords: { startLat?: number | null; startLng?: number | null; endLat?: number | null; endLng?: number | null },
  ): string | null {
    // Agency users are exempt from this rule (CLAUDE.md §13)
    const isAgency =
      workHistory.amphoe?.id === '3001' &&
      workHistory.localAdministrativeOrganization?.id === '3001027';
    if (isAgency) return null;

    const amphoeId = workHistory.amphoe?.id;
    if (!amphoeId) return null;

    const warnings: string[] = [];

    if (coords.startLat != null && coords.startLng != null) {
      const inside = this.geoBoundaryService.isPointInsideAmphoe(
        Number(coords.startLat),
        Number(coords.startLng),
        amphoeId,
      );
      if (inside === false) {
        warnings.push('พิกัดจุดเริ่มต้นอยู่นอกเขตอำเภอของคุณ');
      }
    }

    if (coords.endLat != null && coords.endLng != null) {
      const inside = this.geoBoundaryService.isPointInsideAmphoe(
        Number(coords.endLat),
        Number(coords.endLng),
        amphoeId,
      );
      if (inside === false) {
        warnings.push('พิกัดจุดสิ้นสุดอยู่นอกเขตอำเภอของคุณ');
      }
    }

    return warnings.length > 0 ? warnings.join(' และ ') : null;
  }

  private async validatePlanPhase(manager: EntityManager, developmentPlan: DevelopmentPlan, workHistory: WorkHistory): Promise<void> {
    const isAgency =
      workHistory.amphoe?.id === '3001' &&
      workHistory.localAdministrativeOrganization?.id === '3001027';
    const requiredPhaseType = isAgency ? PhaseType.AGENCY : PhaseType.LAO;
    const openPhase = await manager.findOne(PlanPhase, {
      where: {
        developmentPlan: { id: developmentPlan.id },
        phaseType: requiredPhaseType,
        isOpen: true,
      },
    });
    if (!openPhase) {
      const typeLabel = isAgency ? 'ส่วนราชการ (AGENCY)' : 'อปท. (LAO)';
      throw new BadRequestException(`ระยะเวลายื่นโครงการสำหรับ ${typeLabel} ยังไม่เปิด หรือปิดแล้ว`);
    }
  }

  private async ensureNoDuplicateTitle(manager: EntityManager, title: string, workHistoryId: string, id?: string) {
    const whereCondition: any = {
      title,
      createdBy: { id: workHistoryId },
      isDraft: false
    };

    if (id) {
      whereCondition.id = Not(id);
    }

    const existing = await manager.findOne(ProjectGroup, {
      where: whereCondition,
    });
    if (existing) {
      throw new ConflictException('ชื่อโครงการดังกล่าวมีผูการใช้แล้ว');
    }
  }

  private async validateForeignKeys(
    manager: EntityManager,
    dto: CreateProjectGroupDto,
    format?: ReportFormat,
  ) {
    const developmentPlan = await manager.findOne(DevelopmentPlan, {
      where: { id: dto.developmentPlanId },
    });

    if (!developmentPlan)
      throw new NotFoundException(
        `Development Plan ID not found: ${dto.developmentPlanId}`,
      );
    if (!(developmentPlan as DevelopmentPlan).isLatest)
      throw new BadRequestException('แผนพัฒนาฯ ที่ระบุไม่ใช่แผนปัจจุบัน');
    if ((developmentPlan as DevelopmentPlan).isBooked)
      throw new BadRequestException(
        'แผนพัฒนาฯ ถูกรวมเล่มแล้ว ไม่สามารถดำเนินการได้',
      );

    // CLAUDE.md §16.5 — only STRATEGY_BASED plans resolve the
    // Strategy/Tactic/Plan triple. ISSUE_BASED plans use the issue FK
    // and we return null placeholders.
    const resolvedFormat = format ?? developmentPlan.reportFormat;
    if (resolvedFormat === ReportFormat.ISSUE_BASED) {
      return [developmentPlan, null, null, null] as const;
    }

    const [strategy, tactic, plan] = await Promise.all([
      manager.findOne(Strategy, { where: { id: dto.strategyId } }),
      manager.findOne(Tactic, { where: { id: dto.tacticId } }),
      manager.findOne(Plan, { where: { id: dto.planId } }),
    ]);

    if (!strategy)
      throw new NotFoundException(`Strategy ID not found: ${dto.strategyId}`);
    if (!tactic)
      throw new NotFoundException(`Tactic ID not found: ${dto.tacticId}`);
    if (!plan) throw new NotFoundException(`Plan ID not found: ${dto.planId}`);

    return [developmentPlan, strategy, tactic, plan] as const;
  }

  private getAgencyData(workHistory: WorkHistory): Partial<ProjectGroup> {
    // Agency: amphoe.id = 3001 AND lao.id = 3001027 (CLAUDE.md §1)
    if (
      workHistory.amphoe?.id === '3001' &&
      workHistory.governmentAgencies &&
      workHistory.localAdministrativeOrganization?.id === '3001027'
    ) {
      return {
        responsibleAgency: { id: workHistory.governmentAgencies.id } as any,
      };
    }

    // LAO: all others with a valid localAdministrativeOrganization
    if (workHistory.localAdministrativeOrganization && workHistory.localAdministrativeOrganization.id !== '3001027') {
      return {
        originAgencyId: { id: workHistory.localAdministrativeOrganization.id } as any,
      };
    }

    throw new BadRequestException('ไม่พบข้อมูลหน่วยงานที่รับผิดชอบหรือหน่วยงานต้นสังกัด');
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleProjectCleanUp() {
    try {
      const oldDeletedProjects = await this.projectGroupRepo
        .createQueryBuilder('group')
        .withDeleted()
        .where('group.deletedAt IS NOT NULL')
        .andWhere("group.deletedAt < NOW() - INTERVAL '15 days'")
        .getMany();

      const idsToDelete = oldDeletedProjects.map((p) => p.id);

      if (idsToDelete.length > 0) {
        await this.projectGroupRepo.delete(idsToDelete);
        this.logger.log(`Purged ${idsToDelete.length} old deleted projects`);
      } else {
        this.logger.log('No old deleted projects to purge');
      }
    } catch (error) {
      this.logger.error('Error purging old deleted projects', error.stack);
    }
  }


}
