import {
  Injectable,
  NotFoundException,
  Logger,
  BadRequestException,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { Status } from 'src/status/entities/status.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { CreateRevisedProjectGroupDto } from './dto/create-revised-project-group.dto';
import { UpdateRevisedProjectGroupDto } from './dto/update-revised-project-group.dto';
import { RevisedProjectGroup } from './entities/revised-project-group.entity';
import { DevelopmentPlanRevision } from 'src/development-plan-revision/entities/development-plan-revision.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { Strategy } from 'src/strategy/entities/strategy.entity';
import { Tactic } from 'src/tactic/entities/tactic.entity';
import { Plan } from 'src/plan/entities/plan.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { Budget } from 'src/budget/entities/budget.entity';
import { handleException } from 'src/util/handleException';
import { TrackingStatus } from 'src/tracking-status/entities/tracking-status.entity';
import { Amphoe } from 'src/amphoes/entities/amphoe.entity';
import { LocalAdministrativeOrganization } from 'src/local-administrative-organizations/entities/local-administrative-organization.entity';
import { GovernmentAgency } from 'src/government-agencies/entities/government-agency.entity';
import { UnifiedProjectMapper, IUnifiedProjectDisplay } from 'src/project-groups/dto/unified-project-display.dto';
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
export class RevisedProjectGroupService {
  private readonly logger = new Logger(RevisedProjectGroupService.name);

  constructor(
    @InjectRepository(RevisedProjectGroup)
    private readonly revisedProjectGroupRepo: Repository<RevisedProjectGroup>,

    @InjectRepository(DevelopmentPlanRevision)
    private readonly developmentPlanRevisionRepo: Repository<DevelopmentPlanRevision>,

    @InjectRepository(ProjectGroup)
    private readonly projectGroupRepo: Repository<ProjectGroup>,

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
    private readonly lineageLockService: LineageLockService,
    private readonly classificationValidator: ProjectClassificationValidator,
    private readonly bookFormatResolver: BookFormatResolver,
  ) { }

  // ========================================
  // Lineage-lock batched helpers (CLAUDE.md §14)
  // ========================================

  /**
   * Given a list of ProjectGroup IDs, returns a Set containing the subset
   * that have at least one non-soft-deleted RevisedProjectGroup descendant
   * (prev_project_type = 'original'). Matches LineageLockService semantics.
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
   * Given a list of RevisedProjectGroup IDs, returns a Set containing the
   * subset that have at least one non-soft-deleted RevisedProjectGroup
   * descendant (prev_project_type = 'revised'). Matches LineageLockService
   * semantics.
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

  // ========================================
  // CRUD Operations (Basic)
  // ========================================

  /**
   * สร้าง RevisedProjectGroup ใหม่
   */
  async create(
    dto: CreateRevisedProjectGroupDto,
    userId: string,
  ): Promise<RevisedProjectGroup> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        // CLAUDE.md §16.5 — resolve format FIRST so validateForeignKeys
        // can branch on it. The revision's parent plan is the source
        // of truth (format cannot differ between a revision and its
        // plan per §16.3).
        const format = await this.bookFormatResolver.resolveByRevision(
          dto.developmentPlanRevisionId,
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
          developmentPlanRevision,
          projectGroup,
          strategy,
          tactic,
          plan,
          workHistory,
        ] = await this.validateForeignKeys(manager, dto, userId, format);

        // §16 — for ISSUE_BASED plans, resolve and validate the
        // DevelopmentIssue FK now. Belt-and-braces plan scope check:
        // the issue must belong to the same plan as the revision.
        let developmentIssue: DevelopmentIssue | null = null;
        if (format === ReportFormat.ISSUE_BASED && dto.developmentIssueId) {
          developmentIssue = await manager.findOne(DevelopmentIssue, {
            where: { id: dto.developmentIssueId },
            relations: ['developmentPlan'],
          });
          if (!developmentIssue) {
            throw new NotFoundException(
              `${ERROR_CODES.DEVELOPMENT_ISSUE_NOT_FOUND}: ${ERROR_MESSAGES.DEVELOPMENT_ISSUE_NOT_FOUND}`,
            );
          }
          const parentPlanId =
            developmentPlanRevision.developmentPlan?.id;
          if (
            !parentPlanId ||
            developmentIssue.developmentPlan?.id !== parentPlanId
          ) {
            throw new BadRequestException(
              `${ERROR_CODES.DEVELOPMENT_ISSUE_PLAN_MISMATCH}: ${ERROR_MESSAGES.DEVELOPMENT_ISSUE_PLAN_MISMATCH}`,
            );
          }
        }

        // Get developmentPlan if provided, otherwise use from developmentPlanRevision
        let developmentPlan: DevelopmentPlan | undefined;
        if (dto.developmentPlanId) {
          const foundPlan = await manager.findOne(DevelopmentPlan, {
            where: { id: dto.developmentPlanId },
          });
          if (!foundPlan) {
            throw new NotFoundException(
              `DevelopmentPlan ID not found: ${dto.developmentPlanId}`,
            );
          }
          developmentPlan = foundPlan;
        } else {
          developmentPlan = developmentPlanRevision.developmentPlan;
        }

        // Get amphoe if provided
        const amphoe = dto.amphoeId
          ? await manager.findOne(Amphoe, { where: { id: dto.amphoeId } })
          : null;
        if (dto.amphoeId && !amphoe) {
          throw new NotFoundException(`Amphoe ID not found: ${dto.amphoeId}`);
        }

        // Get localAdministrativeOrganization if provided
        const localAdministrativeOrganization = dto.localAdministrativeOrganizationId
          ? await manager.findOne(LocalAdministrativeOrganization, {
            where: { id: dto.localAdministrativeOrganizationId },
          })
          : null;
        if (dto.localAdministrativeOrganizationId && !localAdministrativeOrganization) {
          throw new NotFoundException(
            `LocalAdministrativeOrganization ID not found: ${dto.localAdministrativeOrganizationId}`,
          );
        }

        // Get originAgencyId if provided
        const originAgency = dto.originAgencyId
          ? await manager.findOne(LocalAdministrativeOrganization, {
            where: { id: dto.originAgencyId },
          })
          : null;
        if (dto.originAgencyId && !originAgency) {
          throw new NotFoundException(
            `OriginAgency (LocalAdministrativeOrganization) ID not found: ${dto.originAgencyId}`,
          );
        }

        // Get responsibleAgency if provided — nullable for LAO-origin projects (CLAUDE.md §5.2)
        // For agency-origin projects it is auto-assigned at creation; for LAO-origin it is assigned
        // later by staff. Throw only when an ID was explicitly provided but the entity is not found.
        const responsibleAgency = dto.responsibleAgency
          ? await manager.findOne(GovernmentAgency, {
            where: { id: dto.responsibleAgency },
          })
          : null;
        if (dto.responsibleAgency && !responsibleAgency) {
          throw new NotFoundException(
            `ResponsibleAgency (GovernmentAgency) ID not found: ${dto.responsibleAgency}`,
          );
        }

        // CLAUDE.md §16.5 / §16.6 — classification columns are
        // mutually exclusive. For ISSUE_BASED lineages the strategy /
        // tactic / plan / indicator tuple is NULL and the developmentIssue
        // FK is set (copy-on-fork).
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

        const revisedProjectGroup = manager.create(RevisedProjectGroup, {
          developmentPlanRevision,
          developmentPlan,
          projectGroup,
          title: dto.title,
          objective: dto.objective,
          goal: dto.goal,
          startLat: dto.startLat,
          startLng: dto.startLng,
          endLat: dto.endLat,
          endLng: dto.endLng,
          expected: dto.expected,
          projectYear: dto.projectYear,
          ...classificationColumns,
          createdBy: workHistory,
          originAgencyId: originAgency || undefined,
          responsibleAgency: responsibleAgency,
          amphoe: amphoe || undefined,
          localAdministrativeOrganization: localAdministrativeOrganization || undefined,
          additionalDetail: dto.additionalDetail,
          oldAdditionDetail: dto.oldAdditionDetail,
          isBooked: dto.isBooked ?? false,
          bookedAt: dto.bookedAt ?? null,
          prevProjectId: dto.prevProjectId,
          prevProjectType: dto.prevProjectType,
        });

        const savedProject = await manager.save(revisedProjectGroup);

        // Create tracking status for revision type "แก้ไข"
        if (developmentPlanRevision.revisionType.name === 'แก้ไข') {
          const trackingStatus = manager.create(TrackingStatus, {
            revisedProjectGroupId: savedProject,
            statusId: { id: '96be5646-cd55-4542-ae92-b82b2935167e' } as any,
            createdBy: workHistory,
            isLatest: true,
          });
          await manager.save(trackingStatus);
        }
        if (developmentPlanRevision.revisionType.name === 'เปลี่ยนแปลง') {
          const trackingStatus = manager.create(TrackingStatus, {
            revisedProjectGroupId: savedProject,
            statusId: { id: '96be5646-cd55-4542-ae92-b82b2935167e' } as any,
            createdBy: workHistory,
            isLatest: true,
          });
          await manager.save(trackingStatus);
        }

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
            const { projectGroupId, ...budgetData } = budgetDto;
            return manager.create(Budget, {
              ...budgetData,
              revisedProjectGroupId: savedProject,
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

  /**
   * ดึง RevisedProjectGroup ทั้งหมด
   */
  async findAll(): Promise<RevisedProjectGroup[]> {
    try {
      return await this.revisedProjectGroupRepo.find({
        relations: [
          'developmentPlanRevision',
          'projectGroup',
          // budgetPlan is derived via developmentPlanRevision
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

  /**
   * ดึง RevisedProjectGroup ตาม revision ID
   */
  async findByRevision(revisionId: string): Promise<RevisedProjectGroup[]> {
    try {
      return await this.revisedProjectGroupRepo.find({
        where: { developmentPlanRevision: { id: revisionId } },
        relations: [
          'developmentPlanRevision',
          'projectGroup',
          // budgetPlan is derived via developmentPlanRevision
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

  /**
   * ดึง RevisedProjectGroup ตาม ID (internal use)
   */
  private async findOneEntity(id: string): Promise<RevisedProjectGroup> {
    const revisedProject = await this.revisedProjectGroupRepo.findOne({
      where: { id },
      relations: [
        'developmentPlanRevision',
        'developmentPlan',
        'projectGroup',
        'strategy',
        'tactic',
        'plan',
        'developmentIssue',
        'createdBy',
        'budgets',
        'trackingStatus',
        'trackingStatus.statusId',
        'trackingStatus.createdBy',
        'trackingStatus.createdBy.user',
        'attachments',
      ],
    });

    if (!revisedProject) {
      this.logger.warn(`RevisedProjectGroup not found: ${id}`);
      throw new NotFoundException(
        `RevisedProjectGroup with id ${id} not found`,
      );
    }

    return revisedProject;
  }

  /**
   * ดึง RevisedProjectGroup ตาม ID (return unified format)
   */
  async findOne(id: string): Promise<IUnifiedProjectDisplay> {
    try {
      const revisedProject = await this.revisedProjectGroupRepo.findOne({
        where: { id },
        relations: [
          'developmentPlanRevision',
          'developmentPlan',
          'projectGroup',
          'strategy',
          'tactic',
          'plan',
          'createdBy',
          'createdBy.user',
          'createdBy.amphoe',
          'createdBy.localAdministrativeOrganization',
          'budgets',
          'trackingStatus',
          'trackingStatus.statusId',
          'trackingStatus.createdBy',
          'trackingStatus.createdBy.user',
          'attachments',
          'favorites',
          'favorites.userId',
          'amphoe',
          'localAdministrativeOrganization',
          'originAgencyId',
          'originAgencyId.amphoe',
          'responsibleAgency',
        ],
      });

      if (!revisedProject) {
        this.logger.warn(`RevisedProjectGroup not found: ${id}`);
        throw new NotFoundException(
          `RevisedProjectGroup with id ${id} not found`,
        );
      }

      const hasDescendant = await this.revisedProjectGroupRepo.exists({
        where: { prevProjectId: id },
      });

      return UnifiedProjectMapper.fromRevisedProjectGroup(revisedProject, hasDescendant);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async updateChangeDevelopmentPlanRevision(
    id: string,
    developmentPlanRevisionId: string,
  ): Promise<RevisedProjectGroup> {
    try {
      // 1. Validate if the project exists
      const projectExists = await this.revisedProjectGroupRepo.exist({ where: { id } });
      if (!projectExists) {
        throw new NotFoundException(`RevisedProjectGroup with id ${id} not found`);
      }

      // 2. Validate if the revision exists
      const revisionExists = await this.developmentPlanRevisionRepo.exist({ where: { id: developmentPlanRevisionId } });
      if (!revisionExists) {
        throw new NotFoundException(`DevelopmentPlanRevision not found: ${developmentPlanRevisionId}`);
      }

      // 3. Update the revision ID directly
      await this.revisedProjectGroupRepo.update(id, {
        developmentPlanRevision: { id: developmentPlanRevisionId } as any,
      });

      // 4. Return the updated project
      return this.findOneEntity(id);
    } catch (error) {
      handleException(this.logger, error);
    }
  }
  /**
   * อัพเดท RevisedProjectGroup
   */
  async update(
    id: string,
    dto: UpdateRevisedProjectGroupDto,
  ): Promise<RevisedProjectGroup> {
    try {
      const revisedProject = await this.findOneEntity(id);

      return await this.dataSource.transaction(async (manager) => {
        // CLAUDE.md §14 — Version Lineage Immutability. A RevisedProjectGroup
        // that already has a non-deleted child RevisedProjectGroup descendant
        // (prev_project_type = 'revised') is locked and cannot be mutated.
        // Guard MUST run BEFORE any repository write.
        await this.lineageLockService.assertEditable(id, 'revised', manager);

        // CLAUDE.md §16.5 — validate classification shape against the
        // parent plan (resolved through the revision chain). If the
        // caller passes ANY classification slot, the shape must match
        // the plan's reportFormat.
        const format = await this.bookFormatResolver.resolveByRevisedProjectGroup(
          id,
          manager,
        );
        this.classificationValidator.validate(format, {
          strategyId: dto.strategyId ?? (revisedProject.strategy?.id ?? null),
          tacticId: dto.tacticId ?? (revisedProject.tactic?.id ?? null),
          planId: dto.planId ?? (revisedProject.plan?.id ?? null),
          developmentIssueId:
            dto.developmentIssueId ??
            (revisedProject.developmentIssue?.id ?? null),
          indicator: dto.indicator ?? revisedProject.indicator,
        });

        // Update foreign keys if provided
        if (dto.developmentPlanRevisionId) {
          const revision = await manager.findOne(DevelopmentPlanRevision, {
            where: { id: dto.developmentPlanRevisionId },
            relations: [
              'developmentPlan',
            ],
          });
          if (!revision) {
            throw new NotFoundException(
              `DevelopmentPlanRevision not found: ${dto.developmentPlanRevisionId}`,
            );
          }
          revisedProject.developmentPlanRevision = revision;
        }

        if (dto.developmentIssueId !== undefined) {
          if (dto.developmentIssueId === null) {
            revisedProject.developmentIssue = null;
          } else {
            const issue = await manager.findOne(DevelopmentIssue, {
              where: { id: dto.developmentIssueId },
            });
            if (!issue) {
              throw new NotFoundException(
                `${ERROR_CODES.DEVELOPMENT_ISSUE_NOT_FOUND}: ${ERROR_MESSAGES.DEVELOPMENT_ISSUE_NOT_FOUND}`,
              );
            }
            revisedProject.developmentIssue = issue;
          }
        }

        // Update strategy, tactic, plan if provided
        if (dto.strategyId !== undefined) {
          const strategy = await manager.findOne(Strategy, {
            where: { id: dto.strategyId },
          });
          if (!strategy) {
            throw new NotFoundException(`Strategy ID not found: ${dto.strategyId}`);
          }
          revisedProject.strategy = strategy;
        }

        if (dto.tacticId !== undefined) {
          const tactic = await manager.findOne(Tactic, {
            where: { id: dto.tacticId },
          });
          if (!tactic) {
            throw new NotFoundException(`Tactic ID not found: ${dto.tacticId}`);
          }
          revisedProject.tactic = tactic;
        }

        if (dto.planId !== undefined) {
          const plan = await manager.findOne(Plan, {
            where: { id: dto.planId },
          });
          if (!plan) {
            throw new NotFoundException(`Plan ID not found: ${dto.planId}`);
          }
          revisedProject.plan = plan;
        }

        // Update other fields
        Object.assign(revisedProject, {
          title: dto.title ?? revisedProject.title,
          objective: dto.objective ?? revisedProject.objective,
          goal: dto.goal ?? revisedProject.goal,
          startLat: dto.startLat ?? revisedProject.startLat,
          startLng: dto.startLng ?? revisedProject.startLng,
          endLat: dto.endLat ?? revisedProject.endLat,
          endLng: dto.endLng ?? revisedProject.endLng,
          indicator: dto.indicator ?? revisedProject.indicator,
          expected: dto.expected ?? revisedProject.expected,
          projectYear: dto.projectYear ?? revisedProject.projectYear,
          additionalDetail: dto.additionalDetail ?? revisedProject.additionalDetail,
          oldAdditionDetail: dto.oldAdditionDetail ?? revisedProject.oldAdditionDetail,
          isBooked: dto.isBooked ?? revisedProject.isBooked,
          bookedAt: dto.bookedAt ?? revisedProject.bookedAt,
        });

        // Update budgets (replace all) if provided
        if (dto.budget) {
          const developmentPlan = revisedProject.developmentPlanRevision?.developmentPlan;

          for (const budgetItem of dto.budget) {
            if (
              budgetItem.year < developmentPlan?.startYear ||
              budgetItem.year > developmentPlan?.endYear
            ) {
              throw new BadRequestException(
                `ปีงบประมาณต้องอยู่ในช่วง พ.ศ. ${developmentPlan?.startYear} - ${developmentPlan?.endYear} (ปีที่ส่งมา: ${budgetItem.year})`,
              );
            }
          }

          if (dto.budget.length > 0) {
            for (const budgetDto of dto.budget) {
              const existingBudget = await manager.findOne(Budget, {
                where: {
                  revisedProjectGroupId: { id: revisedProject.id },
                  year: budgetDto.year,
                },
              });

              if (existingBudget) {
                // Update existing budget
                existingBudget.quantity = budgetDto.quantity;
                await manager.save(Budget, existingBudget);
              } else {
                // Create new budget if not found
                const newBudget = manager.create(Budget, {
                  year: budgetDto.year,
                  quantity: budgetDto.quantity,
                  revisedProjectGroupId: revisedProject,
                });
                await manager.save(Budget, newBudget);
              }
            }
          }
        }

        return await manager.save(revisedProject);
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * ลบ RevisedProjectGroup แบบถาวร (hard delete)
   */
  async remove(id: string): Promise<{ message: string }> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        // CLAUDE.md §14 — guard BEFORE the delete so cascade cannot destroy
        // child revised rows silently.
        await this.lineageLockService.assertDeletable(id, 'revised', manager);

        const result = await manager.delete(RevisedProjectGroup, id);
        if (result.affected === 0) {
          throw new NotFoundException(
            `RevisedProjectGroup with ID ${id} not found`,
          );
        }
        return {
          message: `RevisedProjectGroup with ID ${id} has been permanently removed.`,
        };
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * ลบ RevisedProjectGroup แบบ soft delete
   */
  async softRemove(id: string): Promise<{ message: string }> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        // CLAUDE.md §14 — guard BEFORE the soft-delete.
        await this.lineageLockService.assertDeletable(id, 'revised', manager);

        const result = await manager.softDelete(RevisedProjectGroup, id);
        if (result.affected === 0) {
          throw new NotFoundException(
            `RevisedProjectGroup with ID ${id} not found`,
          );
        }
        return {
          message: `RevisedProjectGroup with ID ${id} has been soft-removed.`,
        };
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * คืนค่า RevisedProjectGroup ที่ถูกลบแบบ soft delete
   */
  async restore(id: string): Promise<{ message: string }> {
    try {
      const result = await this.revisedProjectGroupRepo.restore(id);
      if (result.affected === 0) {
        throw new NotFoundException(
          `RevisedProjectGroup with ID ${id} not found or was not deleted.`,
        );
      }
      return {
        message: `RevisedProjectGroup with ID ${id} has been restored.`,
      };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  // ========================================
  // Query Operations (General)
  // ========================================

  /**
   * ดึงโครงการทั้งหมดจาก developmentPlanRevision ตัวล่าสุด (isLatest = true)
   * สำหรับหน้าติดตามโครงการที่ถูกขอแก้ไขหรือเปลี่ยนแปลง
   */
  async findLatestRevisionProjects(): Promise<RevisedProjectGroup[]> {
    try {
      return await this.revisedProjectGroupRepo
        .createQueryBuilder('rpg')
        .leftJoinAndSelect('rpg.developmentPlanRevision', 'dpr')
        .leftJoinAndSelect('dpr.revisionType', 'rt')
        .leftJoinAndSelect('dpr.developmentPlan', 'dp')
        .leftJoinAndSelect('rpg.projectGroup', 'pg')
        .leftJoinAndSelect('rpg.strategy', 'strategy')
        .leftJoinAndSelect('rpg.tactic', 'tactic')
        .leftJoinAndSelect('rpg.plan', 'plan')
        .leftJoinAndSelect('rpg.createdBy', 'createdBy')
        .leftJoinAndSelect('createdBy.user', 'createdByUser')
        .leftJoinAndSelect('rpg.budgets', 'budgets')
        .leftJoinAndSelect('rpg.trackingStatus', 'trackingStatus')
        .leftJoinAndSelect('trackingStatus.statusId', 'statusId')
        .leftJoinAndSelect('trackingStatus.createdBy', 'trackingStatusCreatedBy')
        .leftJoinAndSelect('trackingStatusCreatedBy.user', 'trackingStatusCreatedByUser')
        .leftJoinAndSelect('rpg.originAgencyId', 'originAgency')
        .leftJoinAndSelect('rpg.responsibleAgency', 'responsibleAgency')
        .where('dpr.is_latest = :isLatest', { isLatest: true })
        .orderBy('dpr.created_at', 'DESC')
        .getMany();
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  // ========================================
  // Tracking Operations - ประเภท "แก้ไข"
  // ========================================

  /**
   * ดึงโครงการประเภท "แก้ไข" ที่มีสถานะ "Pending"
   * @param developmentPlanId - ID ของ DevelopmentPlan (optional)
   * @param developmentPlanRevisionId - ID ของ DevelopmentPlanRevision (optional)
   * @param countOnly - ถ้าเป็น true จะ return จำนวนโครงการแทน array (optional)
   * @param userId - ID ของ User สำหรับ role-based filtering (optional)
   * @returns Array of RevisedProjectGroup หรือ number (count) ตามค่า countOnly
   */
  async findPendingRevisionProjects(
    developmentPlanId?: string,
    developmentPlanRevisionId?: string,
    countOnly?: boolean,
    userId?: string,
  ): Promise<RevisedProjectGroup[] | number> {
    try {
      const query = this.revisedProjectGroupRepo
        .createQueryBuilder('rpg')
        .leftJoinAndSelect('rpg.developmentPlanRevision', 'dpr')
        .leftJoinAndSelect('dpr.revisionType', 'rt')
        .leftJoinAndSelect('dpr.developmentPlan', 'dp')
        .leftJoinAndSelect('rpg.projectGroup', 'pg')
        .leftJoinAndSelect('rpg.strategy', 'strategy')
        .leftJoinAndSelect('rpg.tactic', 'tactic')
        .leftJoinAndSelect('rpg.plan', 'plan')
        .leftJoinAndSelect('rpg.developmentPlan', 'developmentPlan')
        .leftJoinAndSelect('rpg.createdBy', 'createdBy')
        .leftJoinAndSelect('createdBy.user', 'createdByUser')
        .leftJoinAndSelect('createdBy.amphoe', 'amphoeCreatedBy')
        .leftJoinAndSelect('createdBy.localAdministrativeOrganization', 'localAdministrativeOrganizationCreatedBy')
        .leftJoinAndSelect('createdBy.governmentAgencies', 'agencyCreatedBy')
        .leftJoinAndSelect('rpg.amphoe', 'amphoe')
        .leftJoinAndSelect('rpg.localAdministrativeOrganization', 'localAdministrativeOrganization')
        .leftJoinAndSelect('rpg.originAgencyId', 'originAgency')
        .leftJoinAndSelect('rpg.responsibleAgency', 'responsibleAgency')
        .leftJoinAndSelect('rpg.budgets', 'budgets')
        .leftJoinAndSelect('rpg.trackingStatus', 'trackingStatus')
        .leftJoinAndSelect('rpg.attachments', 'attachments')
        .leftJoinAndSelect('trackingStatus.statusId', 'status')
        .leftJoinAndSelect('trackingStatus.createdBy', 'trackingStatusCreatedBy')
        .leftJoinAndSelect('trackingStatusCreatedBy.user', 'trackingStatusCreatedByUser')
        .where('rt.name = :revisionTypeName', { revisionTypeName: 'แก้ไข' })
        .andWhere('trackingStatus.isLatest = :isLatest', { isLatest: true })
        .andWhere('status.name = :statusName', { statusName: 'Pending' })
        .andWhere('dpr.isLatest = :isLatestRevision', { isLatestRevision: true })
        .andWhere('dpr.isBooked = :isBooked', { isBooked: false });

      // Filter by developmentPlanId if provided
      if (developmentPlanId) {
        query.andWhere('dp.id = :developmentPlanId', { developmentPlanId });
      }
      // Filter by developmentPlanRevisionId if provided
      if (developmentPlanRevisionId) {
        query.andWhere('dpr.id = :developmentPlanRevisionId', {
          developmentPlanRevisionId,
        });
      }

      // Role-based filtering
      if (userId) {
        const workHistory = await this.workHistoryRepo.findOne({
          where: { user: { id: userId }, isCurrent: true },
          relations: [
            'user',
            'role',
            'workStatus',
            'workHistoryResponsibleGovernmentAgency',
            'workHistoryResponsibleGovernmentAgency.governmentAgency',
          ],
        });

        if (workHistory) {
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
          } else if (userRole === 'user') {
            query.andWhere(
              '(agencyCreatedBy.id = responsibleAgency.id OR createdByUser.id = :userId)',
              { userId: workHistory.user.id },
            );
          }

          else {
            query.andWhere('1 = 0'); // Always false condition
          }
        }
      }

      if (countOnly) {
        const count = await query.getCount();
        return count;
      }

      const results = await query.orderBy('rpg.created_at', 'DESC').getMany();

      // Batch descendant check (avoid N+1)
      if (results.length > 0) {
        const ids = results.map((r) => r.id);
        const rows = await this.revisedProjectGroupRepo
          .createQueryBuilder('rpg')
          .select('rpg.prevProjectId', 'parentId')
          .where('rpg.prevProjectId IN (:...ids)', { ids })
          .getRawMany();
        const descendantSet = new Set(rows.map((r) => r.parentId));
        return results.map((r) => Object.assign(r, { hasDescendant: descendantSet.has(r.id) }));
      }

      return results;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * ดึงโครงการประเภท "แก้ไข" ที่มีสถานะ "Verified"
   * @param developmentPlanId - ID ของ DevelopmentPlan (optional)
   * @param developmentPlanRevisionId - ID ของ DevelopmentPlanRevision (optional)
   * @param countOnly - ถ้าเป็น true จะ return จำนวนโครงการแทน array (optional)
   * @returns Array of RevisedProjectGroup หรือ number (count) ตามค่า countOnly
   */
  async findVerifyRevisionProjects(
    developmentPlanId?: string,
    developmentPlanRevisionId?: string,
    countOnly?: boolean,
  ): Promise<RevisedProjectGroup[] | number> {
    try {
      const query = this.revisedProjectGroupRepo
        .createQueryBuilder('rpg')
        .leftJoinAndSelect('rpg.developmentPlanRevision', 'dpr')
        .leftJoinAndSelect('dpr.revisionType', 'rt')
        .leftJoinAndSelect('dpr.developmentPlan', 'dp')
        .leftJoinAndSelect('rpg.projectGroup', 'pg')
        .leftJoinAndSelect('rpg.strategy', 'strategy')
        .leftJoinAndSelect('rpg.tactic', 'tactic')
        .leftJoinAndSelect('rpg.plan', 'plan')
        .leftJoinAndSelect('rpg.developmentPlan', 'developmentPlan')
        .leftJoinAndSelect('rpg.createdBy', 'createdBy')
        .leftJoinAndSelect('createdBy.user', 'createdByUser')
        .leftJoinAndSelect('rpg.amphoe', 'amphoe')
        .leftJoinAndSelect('rpg.localAdministrativeOrganization', 'localAdministrativeOrganization')
        .leftJoinAndSelect('rpg.originAgencyId', 'originAgency')
        .leftJoinAndSelect('rpg.responsibleAgency', 'responsibleAgency')
        .leftJoinAndSelect('rpg.budgets', 'budgets')
        .leftJoinAndSelect('rpg.attachments', 'attachments')
        .innerJoin('rpg.trackingStatus', 'latestTrackingStatus', 'latestTrackingStatus.isLatest = :isLatest', { isLatest: true })
        .innerJoin('latestTrackingStatus.statusId', 'latestStatus', 'latestStatus.name = :statusName', { statusName: 'Verified' })
        .leftJoinAndSelect('rpg.trackingStatus', 'trackingStatus')
        .leftJoinAndSelect('trackingStatus.statusId', 'status')
        .leftJoinAndSelect('trackingStatus.createdBy', 'trackingStatusCreatedBy')
        .leftJoinAndSelect('trackingStatusCreatedBy.user', 'trackingStatusCreatedByUser')
        .where('rt.name = :revisionTypeName', { revisionTypeName: 'แก้ไข' })
        .andWhere('dpr.isLatest = :isLatestRevision', { isLatestRevision: true })
        .andWhere('dpr.isBooked = :isBooked', { isBooked: false });


      // Filter by developmentPlanId if provided
      if (developmentPlanId) {
        query.andWhere('dp.id = :developmentPlanId', { developmentPlanId });
      }

      // Filter by developmentPlanRevisionId if provided
      if (developmentPlanRevisionId) {
        query.andWhere('dpr.id = :developmentPlanRevisionId', {
          developmentPlanRevisionId,
        });
      }

      if (countOnly) {
        const count = await query.getCount();
        return count;
      }

      const results = await query.orderBy('rpg.created_at', 'DESC').getMany();

      // Batch descendant check (avoid N+1)
      if (results.length > 0) {
        const ids = results.map((r) => r.id);
        const rows = await this.revisedProjectGroupRepo
          .createQueryBuilder('rpg')
          .select('rpg.prevProjectId', 'parentId')
          .where('rpg.prevProjectId IN (:...ids)', { ids })
          .getRawMany();
        const descendantSet = new Set(rows.map((r) => r.parentId));
        return results.map((r) => Object.assign(r, { hasDescendant: descendantSet.has(r.id) }));
      }

      return results;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * ดึงโครงการประเภท "แก้ไข" ที่มีสถานะ "Verified"
   * @param developmentPlanId - ID ของ DevelopmentPlan (optional)
   * @param developmentPlanRevisionId - ID ของ DevelopmentPlanRevision (optional)
   * @param countOnly - ถ้าเป็น true จะ return จำนวนโครงการแทน array (optional)
   * @returns Array of RevisedProjectGroup หรือ number (count) ตามค่า countOnly
   */
  async findRevisionProjects(
    developmentPlanId?: string,
    developmentPlanRevisionId?: string,
    countOnly?: boolean,
    userId?: string,
  ): Promise<RevisedProjectGroup[] | number> {
    try {
      const workHistory = await this.workHistoryRepo.findOne({
        where: { user: { id: userId }, isCurrent: true },
        relations: [
          'user',
          'role',
          'workStatus',
          'localAdministrativeOrganization',
          'governmentAgencies',
        ],
      });
      if (!workHistory) throw new NotFoundException('ไม่พบข้อมูลผู้ใช้งาน');
      const userRole = workHistory.role.name;
      if (userRole !== 'user' && userRole !== 'staff' && userRole !== 'admin' && userRole !== 'super-admin' && userRole !== 'c-level') {
        throw new UnauthorizedException('คุณไม่มีสิทธิในการเข้าถึงข้อมูล');
      }
      if (workHistory.localAdministrativeOrganization?.id !== '3001027') return []

      const query = this.revisedProjectGroupRepo
        .createQueryBuilder('rpg')
        .leftJoinAndSelect('rpg.developmentPlanRevision', 'dpr')
        .leftJoinAndSelect('dpr.revisionType', 'rt')
        .leftJoinAndSelect('dpr.developmentPlan', 'dp')
        .leftJoinAndSelect('rpg.projectGroup', 'pg')
        .leftJoinAndSelect('rpg.strategy', 'strategy')
        .leftJoinAndSelect('rpg.tactic', 'tactic')
        .leftJoinAndSelect('rpg.plan', 'plan')
        .leftJoinAndSelect('rpg.developmentPlan', 'developmentPlan')
        .leftJoinAndSelect('rpg.createdBy', 'createdBy')
        .leftJoinAndSelect('createdBy.user', 'createdByUser')
        .leftJoinAndSelect('rpg.amphoe', 'amphoe')
        .leftJoinAndSelect('rpg.localAdministrativeOrganization', 'localAdministrativeOrganization')
        .leftJoinAndSelect('rpg.originAgencyId', 'originAgency')
        .leftJoinAndSelect('rpg.responsibleAgency', 'responsibleAgency')
        .leftJoinAndSelect('rpg.budgets', 'budgets')
        .leftJoinAndSelect('rpg.trackingStatus', 'trackingStatus')
        .leftJoinAndSelect('rpg.attachments', 'attachments')
        .leftJoinAndSelect('trackingStatus.statusId', 'status')
        .leftJoinAndSelect('trackingStatus.createdBy', 'trackingStatusCreatedBy')
        .leftJoinAndSelect('trackingStatusCreatedBy.amphoe', 'trackingStatusCreatedByAmphoe')
        .leftJoinAndSelect('trackingStatusCreatedBy.localAdministrativeOrganization', 'trackingStatusCreatedByLocalAdministrativeOrganization')
        .leftJoinAndSelect('trackingStatusCreatedBy.user', 'trackingStatusCreatedByUser')
        .andWhere('trackingStatus.isLatest = :isLatest', { isLatest: true })
        .andWhere('status.name = :statusName', { statusName: 'Revision' })
        .andWhere('dpr.isLatest = :isLatestRevision', { isLatestRevision: true })
        .andWhere('dpr.isBooked = :isBooked', { isBooked: false });

      // Filter by developmentPlanId if provided
      if (developmentPlanId) {
        query.andWhere('dp.id = :developmentPlanId', { developmentPlanId });
      }

      // Filter by developmentPlanRevisionId if provided
      if (developmentPlanRevisionId) {
        query.andWhere('dpr.id = :developmentPlanRevisionId', {
          developmentPlanRevisionId,
        });
      }

      if (userRole === 'user') {
        const agencyId = workHistory.governmentAgencies?.id;
        if (!agencyId) return countOnly ? 0 : [];
        query.andWhere('responsibleAgency.id = :agencyId', { agencyId });
      }

      if (countOnly) {
        const count = await query.getCount();
        return count;
      }

      const results = await query.orderBy('rpg.created_at', 'DESC').getMany();

      // Batch descendant check (avoid N+1)
      if (results.length > 0) {
        const ids = results.map((r) => r.id);
        const rows = await this.revisedProjectGroupRepo
          .createQueryBuilder('rpg')
          .select('rpg.prevProjectId', 'parentId')
          .where('rpg.prevProjectId IN (:...ids)', { ids })
          .getRawMany();
        const descendantSet = new Set(rows.map((r) => r.parentId));
        return results.map((r) => Object.assign(r, { hasDescendant: descendantSet.has(r.id) }));
      }

      return results;
    } catch (error) {
      handleException(this.logger, error);
    }
  }
  /**
   * ดึงโครงการประเภท "แก้ไข" ที่มีสถานะ "Pending Approval"
   * @param developmentPlanId - ID ของ DevelopmentPlan (optional)
   * @param developmentPlanRevisionId - ID ของ DevelopmentPlanRevision (optional)
   * @param countOnly - ถ้าเป็น true จะ return จำนวนโครงการแทน array (optional)
   * @returns Array of RevisedProjectGroup หรือ number (count) ตามค่า countOnly
   */
  async findVerifyPendingApprovalProjects(
    developmentPlanId?: string,
    developmentPlanRevisionId?: string,
    countOnly?: boolean,
  ): Promise<RevisedProjectGroup[] | number> {
    try {
      const query = this.revisedProjectGroupRepo
        .createQueryBuilder('rpg')
        .leftJoinAndSelect('rpg.developmentPlanRevision', 'dpr')
        .leftJoinAndSelect('dpr.revisionType', 'rt')
        .leftJoinAndSelect('dpr.developmentPlan', 'dp')
        .leftJoinAndSelect('rpg.projectGroup', 'pg')
        .leftJoinAndSelect('rpg.strategy', 'strategy')
        .leftJoinAndSelect('rpg.tactic', 'tactic')
        .leftJoinAndSelect('rpg.plan', 'plan')
        .leftJoinAndSelect('rpg.developmentPlan', 'developmentPlan')
        .leftJoinAndSelect('rpg.createdBy', 'createdBy')
        .leftJoinAndSelect('createdBy.user', 'createdByUser')
        .leftJoinAndSelect('rpg.amphoe', 'amphoe')
        .leftJoinAndSelect('rpg.localAdministrativeOrganization', 'localAdministrativeOrganization')
        .leftJoinAndSelect('rpg.originAgencyId', 'originAgency')
        .leftJoinAndSelect('rpg.responsibleAgency', 'responsibleAgency')
        .leftJoinAndSelect('rpg.budgets', 'budgets')
        .leftJoinAndSelect('rpg.attachments', 'attachments')
        .innerJoin('rpg.trackingStatus', 'latestTrackingStatus', 'latestTrackingStatus.isLatest = :isLatest', { isLatest: true })
        .innerJoin('latestTrackingStatus.statusId', 'latestStatus', 'latestStatus.name = :statusName', { statusName: 'Pending_Approval' })
        .leftJoinAndSelect('rpg.trackingStatus', 'trackingStatus')
        .leftJoinAndSelect('trackingStatus.statusId', 'status')
        .leftJoinAndSelect('trackingStatus.createdBy', 'trackingStatusCreatedBy')
        .leftJoinAndSelect('trackingStatusCreatedBy.user', 'trackingStatusCreatedByUser')
        .where('rt.name = :revisionTypeName', { revisionTypeName: 'แก้ไข' })
        .andWhere('dpr.isLatest = :isLatestRevision', { isLatestRevision: true })
        .andWhere('dpr.isBooked = :isBooked', { isBooked: false });

      // Filter by developmentPlanId if provided
      if (developmentPlanId) {
        query.andWhere('dp.id = :developmentPlanId', { developmentPlanId });
      }

      // Filter by developmentPlanRevisionId if provided
      if (developmentPlanRevisionId) {
        query.andWhere('dpr.id = :developmentPlanRevisionId', {
          developmentPlanRevisionId,
        });
      }

      if (countOnly) {
        const count = await query.getCount();
        return count;
      }

      const results = await query.orderBy('rpg.created_at', 'DESC').getMany();

      // Batch descendant check (avoid N+1)
      if (results.length > 0) {
        const ids = results.map((r) => r.id);
        const rows = await this.revisedProjectGroupRepo
          .createQueryBuilder('rpg')
          .select('rpg.prevProjectId', 'parentId')
          .where('rpg.prevProjectId IN (:...ids)', { ids })
          .getRawMany();
        const descendantSet = new Set(rows.map((r) => r.parentId));
        return results.map((r) => Object.assign(r, { hasDescendant: descendantSet.has(r.id) }));
      }

      return results;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * ดึงโครงการประเภท "แก้ไข" ที่มีสถานะ "Approved"
   * @param developmentPlanId - ID ของ DevelopmentPlan (optional)
   * @param developmentPlanRevisionId - ID ของ DevelopmentPlanRevision (optional)
   * @param countOnly - ถ้าเป็น true จะ return จำนวนโครงการแทน array (optional)
   * @returns Array of RevisedProjectGroup หรือ number (count) ตามค่า countOnly
   */
  async findApprovedProjects(
    developmentPlanId?: string,
    developmentPlanRevisionId?: string,
    countOnly?: boolean,
  ): Promise<RevisedProjectGroup[] | number> {
    try {
      const query = this.revisedProjectGroupRepo
        .createQueryBuilder('rpg')
        .leftJoinAndSelect('rpg.developmentPlanRevision', 'dpr')
        .leftJoinAndSelect('dpr.revisionType', 'rt')
        .leftJoinAndSelect('dpr.developmentPlan', 'dp')
        .leftJoinAndSelect('rpg.projectGroup', 'pg')
        .leftJoinAndSelect('rpg.strategy', 'strategy')
        .leftJoinAndSelect('rpg.tactic', 'tactic')
        .leftJoinAndSelect('rpg.plan', 'plan')
        .leftJoinAndSelect('rpg.developmentPlan', 'developmentPlan')
        .leftJoinAndSelect('rpg.createdBy', 'createdBy')
        .leftJoinAndSelect('createdBy.user', 'createdByUser')
        .leftJoinAndSelect('rpg.amphoe', 'amphoe')
        .leftJoinAndSelect('rpg.localAdministrativeOrganization', 'localAdministrativeOrganization')
        .leftJoinAndSelect('rpg.originAgencyId', 'originAgency')
        .leftJoinAndSelect('rpg.responsibleAgency', 'responsibleAgency')
        .leftJoinAndSelect('rpg.budgets', 'budgets')
        .innerJoin('rpg.trackingStatus', 'latestTrackingStatus', 'latestTrackingStatus.isLatest = :isLatest', { isLatest: true })
        .innerJoin('latestTrackingStatus.statusId', 'latestStatus', 'latestStatus.name = :statusName', { statusName: 'Approved' })
        .leftJoinAndSelect('rpg.trackingStatus', 'trackingStatus')
        .leftJoinAndSelect('trackingStatus.statusId', 'status')
        .leftJoinAndSelect('rpg.attachments', 'attachments')
        .leftJoinAndSelect('trackingStatus.createdBy', 'trackingStatusCreatedBy')
        .leftJoinAndSelect('trackingStatusCreatedBy.user', 'trackingStatusCreatedByUser')
        .where('rt.name = :revisionTypeName', { revisionTypeName: 'แก้ไข' })
        .andWhere('dpr.isLatest = :isLatestRevision', { isLatestRevision: true })
        .andWhere('dpr.isBooked = :isBooked', { isBooked: false });

      // Filter by developmentPlanId if provided
      if (developmentPlanId) {
        query.andWhere('dp.id = :developmentPlanId', { developmentPlanId });
      }

      // Filter by developmentPlanRevisionId if provided
      if (developmentPlanRevisionId) {
        query.andWhere('dpr.id = :developmentPlanRevisionId', {
          developmentPlanRevisionId,
        });
      }

      if (countOnly) {
        const count = await query.getCount();
        return count;
      }

      const results = await query.orderBy('rpg.created_at', 'DESC').getMany();

      // Batch descendant check (avoid N+1)
      if (results.length > 0) {
        const ids = results.map((r) => r.id);
        const rows = await this.revisedProjectGroupRepo
          .createQueryBuilder('rpg')
          .select('rpg.prevProjectId', 'parentId')
          .where('rpg.prevProjectId IN (:...ids)', { ids })
          .getRawMany();
        const descendantSet = new Set(rows.map((r) => r.parentId));
        return results.map((r) => Object.assign(r, { hasDescendant: descendantSet.has(r.id) }));
      }

      return results;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  // ========================================
  // Tracking Operations - ประเภท "เปลี่ยนแปลง"
  // ========================================

  /**
   * ดึงโครงการประเภท "เปลี่ยนแปลง" ที่มีสถานะ "Pending"
   * @param developmentPlanId - ID ของ DevelopmentPlan (optional)
   * @param developmentPlanRevisionId - ID ของ DevelopmentPlanRevision (optional)
   * @param countOnly - ถ้าเป็น true จะ return จำนวนโครงการแทน array (optional)
   * @returns Array of RevisedProjectGroup หรือ number (count) ตามค่า countOnly
   */
  async findPendingSupplementProjects(
    developmentPlanId?: string,
    developmentPlanRevisionId?: string,
    countOnly?: boolean,
  ): Promise<RevisedProjectGroup[] | number> {
    try {
      const query = this.revisedProjectGroupRepo
        .createQueryBuilder('rpg')
        .leftJoinAndSelect('rpg.developmentPlanRevision', 'dpr')
        .leftJoinAndSelect('dpr.revisionType', 'rt')
        .leftJoinAndSelect('dpr.developmentPlan', 'dp')
        .leftJoinAndSelect('rpg.projectGroup', 'pg')
        .leftJoinAndSelect('rpg.strategy', 'strategy')
        .leftJoinAndSelect('rpg.tactic', 'tactic')
        .leftJoinAndSelect('rpg.plan', 'plan')
        .leftJoinAndSelect('rpg.developmentPlan', 'developmentPlan')
        .leftJoinAndSelect('rpg.createdBy', 'createdBy')
        .leftJoinAndSelect('createdBy.user', 'createdByUser')
        .leftJoinAndSelect('rpg.amphoe', 'amphoe')
        .leftJoinAndSelect('rpg.localAdministrativeOrganization', 'localAdministrativeOrganization')
        .leftJoinAndSelect('rpg.originAgencyId', 'originAgency')
        .leftJoinAndSelect('rpg.responsibleAgency', 'responsibleAgency')
        .leftJoinAndSelect('rpg.budgets', 'budgets')
        .leftJoinAndSelect('rpg.trackingStatus', 'trackingStatus')
        .leftJoinAndSelect('rpg.attachments', 'attachments')
        .leftJoinAndSelect('trackingStatus.statusId', 'status')
        .leftJoinAndSelect('trackingStatus.createdBy', 'trackingStatusCreatedBy')
        .leftJoinAndSelect('trackingStatusCreatedBy.user', 'trackingStatusCreatedByUser')
        .where('rt.name = :revisionTypeName', { revisionTypeName: 'เปลี่ยนแปลง' })
        .andWhere('trackingStatus.isLatest = :isLatest', { isLatest: true })
        .andWhere('status.name = :statusName', { statusName: 'Pending' })
        .andWhere('dpr.isLatest = :isLatestRevision', { isLatestRevision: true })
        .andWhere('dpr.isBooked = :isBooked', { isBooked: false });

      // Filter by developmentPlanId if provided
      if (developmentPlanId) {
        query.andWhere('dp.id = :developmentPlanId', { developmentPlanId });
      }

      // Filter by developmentPlanRevisionId if provided
      if (developmentPlanRevisionId) {
        query.andWhere('dpr.id = :developmentPlanRevisionId', {
          developmentPlanRevisionId,
        });
      }

      if (countOnly) {
        const count = await query.getCount();
        return count;
      }

      const results = await query.orderBy('rpg.created_at', 'DESC').getMany();

      // Batch descendant check (avoid N+1)
      if (results.length > 0) {
        const ids = results.map((r) => r.id);
        const rows = await this.revisedProjectGroupRepo
          .createQueryBuilder('rpg')
          .select('rpg.prevProjectId', 'parentId')
          .where('rpg.prevProjectId IN (:...ids)', { ids })
          .getRawMany();
        const descendantSet = new Set(rows.map((r) => r.parentId));
        return results.map((r) => Object.assign(r, { hasDescendant: descendantSet.has(r.id) }));
      }

      return results;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * ดึงโครงการประเภท "เปลี่ยนแปลง" ที่มีสถานะ "Verified"
   * @param developmentPlanId - ID ของ DevelopmentPlan (optional)
   * @param developmentPlanRevisionId - ID ของ DevelopmentPlanRevision (optional)
   * @param countOnly - ถ้าเป็น true จะ return จำนวนโครงการแทน array (optional)
   * @returns Array of RevisedProjectGroup หรือ number (count) ตามค่า countOnly
   */
  async findVerifySupplementProjects(
    developmentPlanId?: string,
    developmentPlanRevisionId?: string,
    countOnly?: boolean,
  ): Promise<RevisedProjectGroup[] | number> {
    try {
      const query = this.revisedProjectGroupRepo
        .createQueryBuilder('rpg')
        .leftJoinAndSelect('rpg.developmentPlanRevision', 'dpr')
        .leftJoinAndSelect('dpr.revisionType', 'rt')
        .leftJoinAndSelect('dpr.developmentPlan', 'dp')
        .leftJoinAndSelect('rpg.projectGroup', 'pg')
        .leftJoinAndSelect('rpg.strategy', 'strategy')
        .leftJoinAndSelect('rpg.tactic', 'tactic')
        .leftJoinAndSelect('rpg.plan', 'plan')
        .leftJoinAndSelect('rpg.developmentPlan', 'developmentPlan')
        .leftJoinAndSelect('rpg.createdBy', 'createdBy')
        .leftJoinAndSelect('createdBy.user', 'createdByUser')
        .leftJoinAndSelect('rpg.amphoe', 'amphoe')
        .leftJoinAndSelect('rpg.localAdministrativeOrganization', 'localAdministrativeOrganization')
        .leftJoinAndSelect('rpg.originAgencyId', 'originAgency')
        .leftJoinAndSelect('rpg.responsibleAgency', 'responsibleAgency')
        .leftJoinAndSelect('rpg.budgets', 'budgets')
        .leftJoinAndSelect('rpg.attachments', 'attachments')
        .innerJoin('rpg.trackingStatus', 'latestTrackingStatus', 'latestTrackingStatus.isLatest = :isLatest', { isLatest: true })
        .innerJoin('latestTrackingStatus.statusId', 'latestStatus', 'latestStatus.name = :statusName', { statusName: 'Verified' })
        .leftJoinAndSelect('rpg.trackingStatus', 'trackingStatus')
        .leftJoinAndSelect('trackingStatus.statusId', 'status')
        .leftJoinAndSelect('trackingStatus.createdBy', 'trackingStatusCreatedBy')
        .leftJoinAndSelect('trackingStatusCreatedBy.user', 'trackingStatusCreatedByUser')
        .where('rt.name = :revisionTypeName', { revisionTypeName: 'เปลี่ยนแปลง' })
        .andWhere('dpr.isLatest = :isLatestRevision', { isLatestRevision: true })
        .andWhere('dpr.isBooked = :isBooked', { isBooked: false });

      // Filter by developmentPlanId if provided
      if (developmentPlanId) {
        query.andWhere('dp.id = :developmentPlanId', { developmentPlanId });
      }

      // Filter by developmentPlanRevisionId if provided
      if (developmentPlanRevisionId) {
        query.andWhere('dpr.id = :developmentPlanRevisionId', {
          developmentPlanRevisionId,
        });
      }

      if (countOnly) {
        const count = await query.getCount();
        return count;
      }

      const results = await query.orderBy('rpg.created_at', 'DESC').getMany();

      // Batch descendant check (avoid N+1)
      if (results.length > 0) {
        const ids = results.map((r) => r.id);
        const rows = await this.revisedProjectGroupRepo
          .createQueryBuilder('rpg')
          .select('rpg.prevProjectId', 'parentId')
          .where('rpg.prevProjectId IN (:...ids)', { ids })
          .getRawMany();
        const descendantSet = new Set(rows.map((r) => r.parentId));
        return results.map((r) => Object.assign(r, { hasDescendant: descendantSet.has(r.id) }));
      }

      return results;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * ดึงโครงการประเภท "เปลี่ยนแปลง" ที่มีสถานะ "Pending Approval"
   * @param developmentPlanId - ID ของ DevelopmentPlan (optional)
   * @param developmentPlanRevisionId - ID ของ DevelopmentPlanRevision (optional)
   * @param countOnly - ถ้าเป็น true จะ return จำนวนโครงการแทน array (optional)
   * @returns Array of RevisedProjectGroup หรือ number (count) ตามค่า countOnly
   */
  async findVerifyPendingApprovalSupplementProjects(
    developmentPlanId?: string,
    developmentPlanRevisionId?: string,
    countOnly?: boolean,
  ): Promise<RevisedProjectGroup[] | number> {
    try {
      const query = this.revisedProjectGroupRepo
        .createQueryBuilder('rpg')
        .leftJoinAndSelect('rpg.developmentPlanRevision', 'dpr')
        .leftJoinAndSelect('dpr.revisionType', 'rt')
        .leftJoinAndSelect('dpr.developmentPlan', 'dp')
        .leftJoinAndSelect('rpg.projectGroup', 'pg')
        .leftJoinAndSelect('rpg.strategy', 'strategy')
        .leftJoinAndSelect('rpg.tactic', 'tactic')
        .leftJoinAndSelect('rpg.plan', 'plan')
        .leftJoinAndSelect('rpg.developmentPlan', 'developmentPlan')
        .leftJoinAndSelect('rpg.createdBy', 'createdBy')
        .leftJoinAndSelect('createdBy.user', 'createdByUser')
        .leftJoinAndSelect('rpg.amphoe', 'amphoe')
        .leftJoinAndSelect('rpg.localAdministrativeOrganization', 'localAdministrativeOrganization')
        .leftJoinAndSelect('rpg.originAgencyId', 'originAgency')
        .leftJoinAndSelect('rpg.responsibleAgency', 'responsibleAgency')
        .leftJoinAndSelect('rpg.budgets', 'budgets')
        .leftJoinAndSelect('rpg.attachments', 'attachments')
        .innerJoin('rpg.trackingStatus', 'latestTrackingStatus', 'latestTrackingStatus.isLatest = :isLatest', { isLatest: true })
        .innerJoin('latestTrackingStatus.statusId', 'latestStatus', 'latestStatus.name = :statusName', { statusName: 'Pending_Approval' })
        .leftJoinAndSelect('rpg.trackingStatus', 'trackingStatus')
        .leftJoinAndSelect('trackingStatus.statusId', 'status')
        .leftJoinAndSelect('trackingStatus.createdBy', 'trackingStatusCreatedBy')
        .leftJoinAndSelect('trackingStatusCreatedBy.user', 'trackingStatusCreatedByUser')
        .where('rt.name = :revisionTypeName', { revisionTypeName: 'เปลี่ยนแปลง' })
        .andWhere('dpr.isLatest = :isLatestRevision', { isLatestRevision: true })
        .andWhere('dpr.isBooked = :isBooked', { isBooked: false });

      // Filter by developmentPlanId if provided
      if (developmentPlanId) {
        query.andWhere('dp.id = :developmentPlanId', { developmentPlanId });
      }

      // Filter by developmentPlanRevisionId if provided
      if (developmentPlanRevisionId) {
        query.andWhere('dpr.id = :developmentPlanRevisionId', {
          developmentPlanRevisionId,
        });
      }

      if (countOnly) {
        const count = await query.getCount();
        return count;
      }

      const results = await query.orderBy('rpg.created_at', 'DESC').getMany();

      // Batch descendant check (avoid N+1)
      if (results.length > 0) {
        const ids = results.map((r) => r.id);
        const rows = await this.revisedProjectGroupRepo
          .createQueryBuilder('rpg')
          .select('rpg.prevProjectId', 'parentId')
          .where('rpg.prevProjectId IN (:...ids)', { ids })
          .getRawMany();
        const descendantSet = new Set(rows.map((r) => r.parentId));
        return results.map((r) => Object.assign(r, { hasDescendant: descendantSet.has(r.id) }));
      }

      return results;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * ดึงโครงการประเภท "เปลี่ยนแปลง" ที่มีสถานะ "Approved"
   * @param developmentPlanId - ID ของ DevelopmentPlan (optional)
   * @param developmentPlanRevisionId - ID ของ DevelopmentPlanRevision (optional)
   * @param countOnly - ถ้าเป็น true จะ return จำนวนโครงการแทน array (optional)
   * @returns Array of RevisedProjectGroup หรือ number (count) ตามค่า countOnly
   */
  async findApprovedSupplementProjects(
    developmentPlanId?: string,
    developmentPlanRevisionId?: string,
    countOnly?: boolean,
  ): Promise<RevisedProjectGroup[] | number> {
    try {
      const query = this.revisedProjectGroupRepo
        .createQueryBuilder('rpg')
        .leftJoinAndSelect('rpg.developmentPlanRevision', 'dpr')
        .leftJoinAndSelect('dpr.revisionType', 'rt')
        .leftJoinAndSelect('dpr.developmentPlan', 'dp')
        .leftJoinAndSelect('rpg.projectGroup', 'pg')
        .leftJoinAndSelect('rpg.strategy', 'strategy')
        .leftJoinAndSelect('rpg.tactic', 'tactic')
        .leftJoinAndSelect('rpg.plan', 'plan')
        .leftJoinAndSelect('rpg.developmentPlan', 'developmentPlan')
        .leftJoinAndSelect('rpg.createdBy', 'createdBy')
        .leftJoinAndSelect('createdBy.user', 'createdByUser')
        .leftJoinAndSelect('rpg.amphoe', 'amphoe')
        .leftJoinAndSelect('rpg.localAdministrativeOrganization', 'localAdministrativeOrganization')
        .leftJoinAndSelect('rpg.originAgencyId', 'originAgency')
        .leftJoinAndSelect('rpg.responsibleAgency', 'responsibleAgency')
        .leftJoinAndSelect('rpg.budgets', 'budgets')
        .leftJoinAndSelect('rpg.attachments', 'attachments')
        .innerJoin('rpg.trackingStatus', 'latestTrackingStatus', 'latestTrackingStatus.isLatest = :isLatest', { isLatest: true })
        .innerJoin('latestTrackingStatus.statusId', 'latestStatus', 'latestStatus.name = :statusName', { statusName: 'Approved' })
        .leftJoinAndSelect('rpg.trackingStatus', 'trackingStatus')
        .leftJoinAndSelect('trackingStatus.statusId', 'status')
        .leftJoinAndSelect('trackingStatus.createdBy', 'trackingStatusCreatedBy')
        .leftJoinAndSelect('trackingStatusCreatedBy.user', 'trackingStatusCreatedByUser')
        .where('rt.name = :revisionTypeName', { revisionTypeName: 'เปลี่ยนแปลง' })
        .andWhere('dpr.isLatest = :isLatestRevision', { isLatestRevision: true })
        .andWhere('dpr.isBooked = :isBooked', { isBooked: false });

      // Filter by developmentPlanId if provided
      if (developmentPlanId) {
        query.andWhere('dp.id = :developmentPlanId', { developmentPlanId });
      }

      // Filter by developmentPlanRevisionId if provided
      if (developmentPlanRevisionId) {
        query.andWhere('dpr.id = :developmentPlanRevisionId', {
          developmentPlanRevisionId,
        });
      }

      if (countOnly) {
        const count = await query.getCount();
        return count;
      }

      const results = await query.orderBy('rpg.created_at', 'DESC').getMany();

      // Batch descendant check (avoid N+1)
      if (results.length > 0) {
        const ids = results.map((r) => r.id);
        const rows = await this.revisedProjectGroupRepo
          .createQueryBuilder('rpg')
          .select('rpg.prevProjectId', 'parentId')
          .where('rpg.prevProjectId IN (:...ids)', { ids })
          .getRawMany();
        const descendantSet = new Set(rows.map((r) => r.parentId));
        return results.map((r) => Object.assign(r, { hasDescendant: descendantSet.has(r.id) }));
      }

      return results;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  // ========================================
  // Comparison Operations
  // ========================================

  async findProjectComparison(id: string): Promise<{
    current: RevisedProjectGroup;
    previous: ProjectGroup | RevisedProjectGroup | null;
  }> {
    try {
      // ดึงข้อมูลโครงการปัจจุบัน
      const current = await this.revisedProjectGroupRepo.findOne({
        where: { id },
        relations: [
          'developmentPlanRevision',
          'developmentPlanRevision.revisionType',
          'developmentPlanRevision.developmentPlan',
          'developmentPlan',
          'projectGroup',
          'strategy',
          'tactic',
          'plan',
          'createdBy',
          'createdBy.user',
          'createdBy.amphoe',
          'createdBy.localAdministrativeOrganization',
          'budgets',
          'trackingStatus',
          'trackingStatus.statusId',
          'trackingStatus.createdBy',
          'trackingStatus.createdBy.user',
          'originAgencyId',
          'responsibleAgency',
          'attachments'
        ],
      });

      if (!current) {
        throw new NotFoundException(
          `RevisedProjectGroup with id ${id} not found`,
        );
      }

      let previous: ProjectGroup | RevisedProjectGroup | null = null;
      if (current.prevProjectType === "original") {
        previous = await this.projectGroupRepo.findOne({
          where: {
            id: current.prevProjectId
          },
          relations: [
            'developmentPlan',
            'strategy',
            'tactic',
            'plan',
            'createdBy',
            'createdBy.user',
            'budgets',
            'trackingStatus',
            'trackingStatus.statusId',
            'trackingStatus.createdBy',
            'trackingStatus.createdBy.user',
            'originAgencyId',
            'responsibleAgency',

          ]
        })
      } else if (current.prevProjectType === "revised") {
        previous = await this.revisedProjectGroupRepo.findOne({
          where: {
            id: current.prevProjectId
          },
          relations: [
            'developmentPlanRevision',
            'developmentPlanRevision.revisionType',
            'developmentPlanRevision.developmentPlan',
            'developmentPlan',
            'projectGroup',
            'strategy',
            'tactic',
            'plan',
            'createdBy',
            'createdBy.user',
            'budgets',
            'trackingStatus',
            'trackingStatus.statusId',
            'trackingStatus.createdBy',
            'trackingStatus.createdBy.user',
            'originAgencyId',
            'responsibleAgency',
          ]
        })
      } else {
        throw new NotFoundException(
          `Previous project type not found: ${current.prevProjectType}`,
        );
      }

      return {
        current,
        previous,
      };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * ดึง RevisedProjectGroup ที่เป็น revision ล่าสุดของแต่ละ ProjectGroup
   * แสดงเฉพาะจากตาราง revised-project-group (ไม่รวม original projects)
   */
  async findLatestRevisedProjectsOnly(options: {
    userId: string;
    countOnly?: boolean;
    developmentPlanId?: string;
    revisionId?: string;
  }): Promise<RevisedProjectGroup[] | number> {
    try {
      const { userId, countOnly, developmentPlanId, revisionId } = options;

      // Validate user permissions
      const workHistory = await this.workHistoryRepo.findOne({
        where: { user: { id: userId }, isCurrent: true },
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

      // SubQuery: หา revisionNumber สูงสุด ของแต่ละ Project Group ID ภายใต้แผนนี้
      const maxRevisionSubQuery = this.revisedProjectGroupRepo
        .createQueryBuilder('rp_sub')
        .select('rp_sub.project_group_id', 'projectGroupId')
        .addSelect('MAX(dpr_sub.revisionNumber)', 'maxRevision')
        .leftJoin('rp_sub.developmentPlanRevision', 'dpr_sub')
        .where('rp_sub.development_plan_id = :planId', { planId: developmentPlanId })
        .groupBy('rp_sub.project_group_id');

      // Main Query: ดึง revised projects ที่เป็น revision ล่าสุด
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
        .leftJoinAndSelect('trackingStatus.createdBy', 'workHistory')
        .leftJoinAndSelect('workHistory.user', 'user')
        .leftJoinAndSelect('workHistory.localAdministrativeOrganization', 'localAdministrativeOrganizationWorkHistory')
        .leftJoinAndSelect('workHistory.governmentAgencies', 'governmentAgencies')
        .leftJoinAndSelect('workHistory.workStatus', 'workStatus')
        .leftJoinAndSelect('revisedProject.responsibleAgency', 'responsibleAgency')
        .leftJoinAndSelect('revisedProject.originAgencyId', 'originAgencyId')
        .leftJoinAndSelect('originAgencyId.amphoe', 'originAgencyAmphoe')
        .innerJoin(
          '(' + maxRevisionSubQuery.getQuery() + ')',
          'max_rev_table',
          '"revisedProject"."project_group_id" = max_rev_table."projectGroupId" AND "developmentPlanRevision"."revision_number" = max_rev_table."maxRevision"'
        )
        .setParameters(maxRevisionSubQuery.getParameters())
        .andWhere('revisedProject.development_plan_id = :developmentPlanId', { developmentPlanId })
        .andWhere('trackingStatus.isLatest = :isLatest', { isLatest: true });

      // Filter by revisionId if provided
      if (revisionId) {
        query.andWhere('developmentPlanRevision.id = :revisionId', { revisionId });
      }

      // Role-based filtering
      if (workHistory.role.name === 'user') {
        if (workHistory.governmentAgencies) {
          query.andWhere('responsibleAgency.id = :agencyId', {
            agencyId: workHistory.governmentAgencies.id,
          });
        }
        //  else {
        //   query.andWhere('originAgencyId.id = :agencyId', {
        //     agencyId: workHistory.localAdministrativeOrganization.id,
        //   });
        // }
      }

      if (countOnly) {
        const count = await query.getCount();
        return count;
      }

      const projects = await query
        .orderBy('revisedProject.createdAt', 'DESC')
        .getMany();

      // Batch descendant check (avoid N+1)
      if (projects.length > 0) {
        const ids = projects.map((r) => r.id);
        const rows = await this.revisedProjectGroupRepo
          .createQueryBuilder('rpg')
          .select('rpg.prevProjectId', 'parentId')
          .where('rpg.prevProjectId IN (:...ids)', { ids })
          .getRawMany();
        const descendantSet = new Set(rows.map((r) => r.parentId));
        return projects.map((r) => Object.assign(r, { hasDescendant: descendantSet.has(r.id) }));
      }

      return projects;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  // ========================================
  // Private Helper Methods
  // ========================================

  /**
   * Validate และดึง foreign key entities
   */
  private async validateForeignKeys(
    manager,
    dto: CreateRevisedProjectGroupDto,
    userId: string,
    format?: ReportFormat,
  ): Promise<
    [
      DevelopmentPlanRevision,
      ProjectGroup | null,
      Strategy | null,
      Tactic | null,
      Plan | null,
      WorkHistory,
    ]
  > {
    const [developmentPlanRevision, projectGroup] = await Promise.all([
      manager.findOne(DevelopmentPlanRevision, {
        where: { id: dto.developmentPlanRevisionId },
        relations: ['developmentPlan', 'revisionType'],
      }),
      dto.projectGroupId
        ? manager.findOne(ProjectGroup, { where: { id: dto.projectGroupId } })
        : null,
    ]);

    if (!developmentPlanRevision) {
      throw new NotFoundException(
        `DevelopmentPlanRevision ID not found: ${dto.developmentPlanRevisionId}`,
      );
    }
    if (dto.projectGroupId && !projectGroup) {
      throw new NotFoundException(
        `ProjectGroup ID not found: ${dto.projectGroupId}`,
      );
    }

    // CLAUDE.md §16.5 — Strategy/Tactic/Plan are required ONLY for
    // STRATEGY_BASED plans. For ISSUE_BASED plans they MUST be absent.
    let strategy: Strategy | null = null;
    let tactic: Tactic | null = null;
    let plan: Plan | null = null;
    if (format !== ReportFormat.ISSUE_BASED) {
      [strategy, tactic, plan] = await Promise.all([
        dto.strategyId
          ? manager.findOne(Strategy, { where: { id: dto.strategyId } })
          : null,
        dto.tacticId
          ? manager.findOne(Tactic, { where: { id: dto.tacticId } })
          : null,
        dto.planId
          ? manager.findOne(Plan, { where: { id: dto.planId } })
          : null,
      ]);
      if (!strategy) {
        throw new NotFoundException(
          `Strategy ID is required and not found: ${dto.strategyId}`,
        );
      }
      if (!tactic) {
        throw new NotFoundException(
          `Tactic ID is required and not found: ${dto.tacticId}`,
        );
      }
      if (!plan) {
        throw new NotFoundException(
          `Plan ID is required and not found: ${dto.planId}`,
        );
      }
    }

    // 1-3. WorkHistory with isCurrent=true + workStatus (CLAUDE.md validation order)
    const workHistory = await manager.findOne(WorkHistory, {
      where: { user: { id: userId }, isCurrent: true },
      relations: ['role', 'workStatus', 'localAdministrativeOrganization', 'amphoe', 'governmentAgencies'],
    });
    if (!workHistory) {
      throw new NotFoundException('Work history not found for this user');
    }
    if (workHistory.workStatus?.name !== 'approved') {
      throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิ์ในการดำเนินการ (workStatus ต้องเป็น approved)');
    }

    // 4. User classification: ONLY agency users may revise/change (CLAUDE.md §3, workflow-revision §Actors)
    const isAgency =
      workHistory.amphoe?.id === '3001' &&
      workHistory.localAdministrativeOrganization?.id === '3001027';
    if (!isAgency) {
      throw new ForbiddenException('เฉพาะผู้ใช้ประเภท Agency เท่านั้นที่สามารถยื่นขอแก้ไขหรือเปลี่ยนแปลงโครงการได้');
    }

    // 7. Revision scope: DevelopmentPlanRevision must be OPEN
    if (!developmentPlanRevision.isOpen) {
      throw new BadRequestException('รอบการแก้ไข/เปลี่ยนแปลงยังไม่เปิด หรือปิดแล้ว');
    }

    // 7. Revision type must be a valid workflow type
    const validRevisionTypes = ['แก้ไข', 'เปลี่ยนแปลง'];
    if (!validRevisionTypes.includes(developmentPlanRevision.revisionType?.name)) {
      throw new BadRequestException('ประเภทการแก้ไขไม่ถูกต้อง');
    }

    // 5. Source project must exist and be in Approved status
    if (dto.projectGroupId && projectGroup) {
      const latestTracking = await manager.findOne(TrackingStatus, {
        where: { projectGroupId: { id: dto.projectGroupId }, isLatest: true },
        relations: ['statusId'],
      });
      if (!latestTracking || latestTracking.statusId?.name !== 'Approved') {
        throw new BadRequestException('โครงการต้นฉบับต้องมีสถานะ Approved เท่านั้นจึงจะสามารถยื่นขอแก้ไขหรือเปลี่ยนแปลงได้');
      }
    }

    return [
      developmentPlanRevision,
      projectGroup,
      strategy,
      tactic,
      plan,
      workHistory,
    ];
  }


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

    let currentProject: IUnifiedProjectDisplay | null = null;
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
      currentProject = UnifiedProjectMapper.fromProjectGroup(originalProject);
    } else {
      // 2) ถ้าไม่เจอ ลองหาเป็น revised project
      const requestedRevisedProject = await this.revisedProjectGroupRepo.findOne({
        where: { id: projectId },
        relations: [
          'projectGroup',
          'developmentPlanRevision',
          'developmentPlanRevision.developmentPlan',
          'developmentPlanRevision.revisionType',
          'createdBy',
          'createdBy.user',
          'strategy',
          'tactic',
          'plan',
          'budgets',
          'trackingStatus',
          'trackingStatus.statusId',
          'responsibleAgency',
          'originAgencyId',
          'attachments',
        ],
      });

      if (!requestedRevisedProject) {
        throw new NotFoundException('ไม่พบโครงการ');
      }

      currentProject = UnifiedProjectMapper.fromRevisedProjectGroup(requestedRevisedProject);
      rootProjectGroupId = requestedRevisedProject.projectGroup?.id || null;

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

    // CLAUDE.md §14 — batched lineage-lock lookups for the version chain.
    // The original PG is locked iff it has any active descendant (when this
    // method is reached via a revised project lookup, that's guaranteed
    // true, but for a direct-original lookup allRevisions may be empty).
    // Each revision is also independently checked to flag tip-of-chain
    // locks (e.g., an intermediate revision that itself has a child).
    const revisionIds = allRevisions.map((r) => r.id);
    const [lockedPgIds, lockedRpgIds] = await Promise.all([
      originalProject
        ? this.findProjectGroupIdsWithDescendants([originalProject.id])
        : Promise.resolve(new Set<string>()),
      this.findRevisedProjectGroupIdsWithDescendants(revisionIds),
    ]);

    const unifiedOriginal = originalProject
      ? UnifiedProjectMapper.fromProjectGroup(
          originalProject,
          lockedPgIds.has(originalProject.id),
        )
      : null;

    const unifiedRevisions = allRevisions.map((revision) =>
      UnifiedProjectMapper.fromRevisedProjectGroup(
        revision,
        lockedRpgIds.has(revision.id),
      ),
    );

    // Set currentProject from the list
    if (currentProject?.projectType === 'revised') {
      const found = unifiedRevisions.find((r) => r.id === projectId);
      if (found) currentProject = found;
    } else if (currentProject?.projectType === 'original') {
      currentProject = unifiedOriginal;
    }

    return {
      original: unifiedOriginal,
      current: currentProject,
      currentId: projectId,
      revisions: unifiedRevisions,
    };
  }
}
