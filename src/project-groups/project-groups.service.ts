import { WorkHistory } from './../work-history/entities/work-history.entity';
import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull, Not, Repository } from 'typeorm';
import { ProjectGroup } from './entities/project-group.entity';
import { CreateProjectGroupDto } from './dto/create-project-group.dto';
import { BulkAssignAgencyDto, UpdateProjectGroupDto } from './dto/update-project-group.dto';
import { BudgetPlan } from 'src/budget_plan/entities/budget_plan.entity';
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
import {
  IUnifiedProjectDisplay,
  UnifiedProjectMapper,
} from './dto/unified-project-display.dto';
import { IProjectVersionsResponse } from './dto/project-versions.dto';

@Injectable()
export class ProjectGroupsService {
  private readonly logger = new Logger(ProjectGroupsService.name);

  constructor(
    @InjectRepository(ProjectGroup)
    private readonly projectGroupRepo: Repository<ProjectGroup>,

    @InjectRepository(WorkHistory)
    private readonly workHistoryRepo: Repository<WorkHistory>,

    @InjectRepository(BudgetPlan)
    private readonly budgetPlanRepo: Repository<BudgetPlan>,

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

    private readonly dataSource: DataSource,
  ) { }

  async create(dto: CreateProjectGroupDto, userId: string) {
    try {
      return await this.dataSource.transaction(async (manager) => {
        const workHistory = await this.getWorkHistory(manager, userId);
        await this.ensureNoDuplicateTitle(manager, dto.title, workHistory.id, undefined);
        const [budgetPlan, strategy, tactic, plan] = await this.validateForeignKeys(manager, dto);
        const agencyData = this.getAgencyData(workHistory);

        const group = manager.create(ProjectGroup, {
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
          strategy,
          tactic,
          plan,
          budgetPlan,
          createdBy: workHistory,
          ...agencyData,
        });

        const savedGroup = await manager.save(group);

        const trackingStatus = manager.create(TrackingStatus, {
          projectGroupId: savedGroup,
          statusId: { id: '8219cd82-fa61-4292-bd0d-fa58b08507e1' },
          createdBy: workHistory,
        });
        await manager.save(trackingStatus);

        if (!Array.isArray(dto.budget) || dto.budget.length === 0) {
          throw new BadRequestException('งบประมาณไม่ถูกต้องหรือไม่มีข้อมูล');
        }
        // Validate budget year is within budget plan range
        for (const budgetItem of dto.budget) {
          if (budgetItem.year < (budgetPlan as BudgetPlan).startYear || budgetItem.year > (budgetPlan as BudgetPlan).endYear) {
            throw new BadRequestException(
              `ปีงบประมาณต้องอยู่ในช่วง พ.ศ. ${(budgetPlan as BudgetPlan).startYear} - ${(budgetPlan as BudgetPlan).endYear} (ปีที่ส่งมา: ${budgetItem.year})`
            );
          }
        }

        const budgets = dto.budget.map((item) =>
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



  async createDraft(dto: CreateProjectGroupDto, userId: string) {
    try {
      const savedDraft = await this.dataSource.transaction(async (manager) => {
        const workHistory = await this.getWorkHistory(manager, userId);
        await this.ensureNoDuplicateTitle(manager, dto.title, workHistory.id, undefined);
        const [budgetPlan, strategy, tactic, plan] = await this.validateForeignKeys(manager, dto);
        const agencyData = this.getAgencyData(workHistory);

        const projectGroupData: any = {
          title: dto.title,
          projectYear: dto.projectYear,
          budgetPlan,
          createdBy: workHistory,
          isDraft: true,
          objective: dto.objective || '',
          goal: dto.goal || '',
          startLat: dto.startLat ?? null,
          startLng: dto.startLng ?? null,
          endLat: dto.endLat ?? null,
          endLng: dto.endLng ?? null,
          indicator: dto.indicator || '',
          expected: dto.expected || '',
          ...agencyData,
        };

        if (strategy) projectGroupData.strategy = strategy;
        if (tactic) projectGroupData.tactic = tactic;
        if (plan) projectGroupData.plan = plan;

        const group = manager.create(
          ProjectGroup,
          projectGroupData,
        );
        const savedGroupResult = await manager.save(group);
        if (dto.budget && dto.budget.length > 0) {
          // Validate budget year is within budget plan range
          for (const budgetItem of dto.budget) {
            if (budgetItem.year < (budgetPlan as BudgetPlan).startYear || budgetItem.year > (budgetPlan as BudgetPlan).endYear) {
              throw new BadRequestException(
                `ปีงบประมาณต้องอยู่ในช่วง พ.ศ. ${(budgetPlan as BudgetPlan).startYear} - ${(budgetPlan as BudgetPlan).endYear} (ปีที่ส่งมา: ${budgetItem.year})`
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

        return savedGroupResult;
      });

      return { message: 'Create draft success', id: savedDraft.id };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async publishDraft(id: string, dto: CreateProjectGroupDto, userId: string) {
    try {
      await this.dataSource.transaction(async (manager) => {
        // ตรวจสอบว่า draft มีอยู่จริงและเป็นของ user นี้
        const existingDraft = await manager.findOne(ProjectGroup, {
          where: {
            id,
            isDraft: true,
            createdBy: { user: { id: userId } }
          },
          relations: ['createdBy', 'createdBy.user'],
        });

        if (!existingDraft) {
          throw new NotFoundException('Draft not found or you do not have permission to publish it');
        }

        const workHistory = await this.getWorkHistory(manager, userId);
        await this.ensureNoDuplicateTitle(manager, dto.title, workHistory.id, id);
        const [budgetPlan, strategy, tactic, plan] = await this.validateForeignKeys(manager, dto);
        const agencyData = this.getAgencyData(workHistory);

        // อัพเดท project group data
        const projectGroupData: any = {
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
          strategy,
          tactic,
          plan,
          budgetPlan,
          isDraft: false,
          ...agencyData,
        };

        // อัพเดท project group
        await manager.update(ProjectGroup, id, projectGroupData);

        const trackingStatus = manager.create(TrackingStatus, {
          projectGroupId: { id },
          statusId: { id: '8219cd82-fa61-4292-bd0d-fa58b08507e1' },
          createdBy: workHistory,
        });
        await manager.save(trackingStatus);

        // Delete existing budgets
        await manager.delete(Budget, { projectGroupId: { id } });

        // Create new budgets if provided
        if (dto.budget && dto.budget.length > 0) {
          // Validate budget year is within budget plan range
          for (const budgetItem of dto.budget) {
            if (budgetItem.year < (budgetPlan as BudgetPlan).startYear || budgetItem.year > (budgetPlan as BudgetPlan).endYear) {
              throw new BadRequestException(
                `ปีงบประมาณต้องอยู่ในช่วง พ.ศ. ${(budgetPlan as BudgetPlan).startYear} - ${(budgetPlan as BudgetPlan).endYear} (ปีที่ส่งมา: ${budgetItem.year})`
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

  async updateDraft(id: string, dto: CreateProjectGroupDto, userId: string) {
    try {
      await this.dataSource.transaction(async (manager) => {
        // ตรวจสอบว่า draft มีอยู่จริงและเป็นของ user นี้
        const existingDraft = await manager.findOne(ProjectGroup, {
          where: {
            id,
            isDraft: true,
            createdBy: { user: { id: userId } }
          },
          relations: ['createdBy', 'createdBy.user'],
        });

        if (!existingDraft) {
          throw new NotFoundException('Draft not found or you do not have permission to update it');
        }

        const workHistory = await this.getWorkHistory(manager, userId);
        await this.ensureNoDuplicateTitle(manager, dto.title, workHistory.id, id);
        const [budgetPlan, strategy, tactic, plan] = await this.validateForeignKeys(manager, dto);

        // อัพเดท project group data
        const projectGroupData: any = {
          title: dto.title,
          objective: dto.objective || '',
          goal: dto.goal || '',
          startLat: dto.startLat ?? null,
          startLng: dto.startLng ?? null,
          endLat: dto.endLat ?? null,
          endLng: dto.endLng ?? null,
          indicator: dto.indicator || '',
          expected: dto.expected || '',
          projectYear: dto.projectYear,
          strategy,
          tactic,
          plan,
          budgetPlan,
          isDraft: true,
        };

        await manager.update(ProjectGroup, id, projectGroupData);

        // Delete existing budgets
        await manager.delete(Budget, { projectGroupId: { id } });

        // Create new budgets if provided
        if (dto.budget && dto.budget.length > 0) {
          // Validate budget year is within budget plan range
          for (const budgetItem of dto.budget) {
            if (budgetItem.year < (budgetPlan as BudgetPlan).startYear || budgetItem.year > (budgetPlan as BudgetPlan).endYear) {
              throw new BadRequestException(
                `ปีงบประมาณต้องอยู่ในช่วง พ.ศ. ${(budgetPlan as BudgetPlan).startYear} - ${(budgetPlan as BudgetPlan).endYear} (ปีที่ส่งมา: ${budgetItem.year})`
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
      return { message: 'Update draft success' };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async simplePublish(id: string, userId: string) {
    try {
      await this.dataSource.transaction(async (manager) => {
        // 1. ตรวจสอบว่ามี draft จริง และเป็นของ user นี้
        const existingDraft = await manager.findOne(ProjectGroup, {
          where: {
            id,
            isDraft: true,
            createdBy: { user: { id: userId } }
          },
          relations: ['createdBy', 'createdBy.user'],
        });

        if (!existingDraft) {
          throw new NotFoundException(`Draft with ID ${id} not found or already published`);
        }

        // 2. อัปเดต isDraft เป็น false
        await manager.update(ProjectGroup, { id }, { isDraft: false });

        // 3. ดึง workHistory ของผู้ใช้
        const workHistory = await this.getWorkHistory(manager, userId);

        // 4. บันทึกสถานะใหม่ (tracking)
        const trackingStatus = manager.create(TrackingStatus, {
          projectGroupId: { id },
          statusId: { id: '8219cd82-fa61-4292-bd0d-fa58b08507e1' }, // เปลี่ยนตาม status จริงถ้ามี
          createdBy: workHistory,
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
    type?: 'draft' | 'ready' | 'pending' | 'edit' | 'verified' | 'approved' | 'rejected' | 'draft-development-plan' | 'provincial-committee';
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
        'workHistoryResponsibleAdmins',
        'workHistoryResponsibleAdmins.amphoe',
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
      .leftJoinAndSelect('projectGroup.budgetPlan', 'budgetPlan')
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
            .andWhere('trackingStatus.isLatest = :isLatest', { isLatest: true })
            .andWhere('status.name = :statusName', { statusName: 'Ready' })
            .andWhere('localAdministrativeOrganization.id = :localAdministrativeOrganizationId', { localAdministrativeOrganizationId: workHistory.localAdministrativeOrganization.id });
          break;
        case 'pending':
          query.andWhere('projectGroup.isDraft = :isDraft', { isDraft: false })
            .andWhere('trackingStatus.isLatest = :isLatest', { isLatest: true })
            .andWhere('status.name = :statusName', { statusName: 'Pending' })
            .andWhere('budgetPlan.isLatest = :budgetPlanIsLatest', { budgetPlanIsLatest: true })
          break;
        case 'edit':
          query.andWhere('projectGroup.isDraft = :isDraft', { isDraft: false })
            .andWhere('trackingStatus.isLatest = :isLatest', { isLatest: true })
            .andWhere('status.name = :statusName', { statusName: 'Revision' })
            .andWhere('projectGroup.createdBy.id = :workHistoryId', { workHistoryId: workHistory.id })
            .andWhere('budgetPlan.isLatest = :budgetPlanIsLatest', { budgetPlanIsLatest: true });
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
  }) {
    const { userId, countOnly } = options;
    const workHistory = await this.workHistoryRepo.findOne({
      where: { user: { id: userId }, isCurrent: true },
      relations: [
        'user',
        'role',
        'localAdministrativeOrganization',
        'governmentAgencies',
        'workStatus',
        'workHistoryResponsibleAdmins',
        'workHistoryResponsibleAdmins.amphoe',
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
      .leftJoinAndSelect('projectGroup.budgetPlan', 'budgetPlan')
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
      .andWhere('projectGroup.isDraft = :isDraft', { isDraft: false })
      .andWhere('trackingStatus.isLatest = :isLatest', { isLatest: true })
      .andWhere('status.name = :statusName', { statusName: 'Pending' })
      .andWhere('projectGroup.originAgencyId IS NOT NULL')
      .andWhere('projectGroup.responsibleAgency IS NULL')
      .andWhere('budgetPlan.isLatest = :budgetPlanIsLatest', { budgetPlanIsLatest: true });

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
  }) {
    const { userId, countOnly } = options;
    const workHistory = await this.workHistoryRepo.findOne({
      where: { user: { id: userId }, isCurrent: true },
      relations: [
        'user',
        'role',
        'localAdministrativeOrganization',
        'governmentAgencies',
        'workStatus',
        'workHistoryResponsibleAdmins',
        'workHistoryResponsibleAdmins.amphoe',
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
      .leftJoinAndSelect('projectGroup.budgetPlan', 'budgetPlan')
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
      .andWhere('projectGroup.isDraft = :isDraft', { isDraft: false })
      .andWhere('trackingStatus.isLatest = :isLatest', { isLatest: true })
      .andWhere('status.name = :statusName', { statusName: 'Pending' })
      .andWhere('projectGroup.originAgencyId IS NULL')
      .andWhere('projectGroup.responsibleAgency IS NOT NULL')
      .andWhere('budgetPlan.isLatest = :budgetPlanIsLatest', { budgetPlanIsLatest: true });

    if (countOnly) {
      const count = await query.getCount();
      return count;
    }

    const projects = await query
      .orderBy('projectGroup.createdAt', 'DESC')
      .getMany();

    return projects;
  }
  async findByStatusProvincialCommittee(options: {
    userId: string;
    countOnly?: boolean;
  }) {
    const { userId, countOnly } = options;
    const workHistory = await this.workHistoryRepo.findOne({
      where: { user: { id: userId }, isCurrent: true },
      relations: [
        'user',
        'role',
        'localAdministrativeOrganization',
        'governmentAgencies',
        'workStatus',
        'workHistoryResponsibleAdmins',
        'workHistoryResponsibleAdmins.amphoe',
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
      .leftJoinAndSelect('projectGroup.budgetPlan', 'budgetPlan')
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
      .andWhere('projectGroup.isDraft = :isDraft', { isDraft: false })
      .andWhere('trackingStatus.isLatest = :isLatest', { isLatest: true })
      .andWhere('status.name = :statusName', { statusName: 'Provincial Committee' })
      .andWhere('projectGroup.originAgencyId IS NOT NULL')
      .andWhere('budgetPlan.isLatest = :budgetPlanIsLatest', { budgetPlanIsLatest: true });

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
  }) {
    const { userId, countOnly } = options;
    const workHistory = await this.workHistoryRepo.findOne({
      where: { user: { id: userId }, isCurrent: true },
      relations: [
        'user',
        'role',
        'localAdministrativeOrganization',
        'governmentAgencies',
        'workStatus',
        'workHistoryResponsibleAdmins',
        'workHistoryResponsibleAdmins.amphoe',
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
      .leftJoinAndSelect('projectGroup.budgetPlan', 'budgetPlan')
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
      .andWhere('projectGroup.isDraft = :isDraft', { isDraft: false })
      .andWhere('trackingStatus.isLatest = :isLatest', { isLatest: true })
      .andWhere('status.name = :statusName', { statusName: 'Plan Committee' })
      .andWhere('projectGroup.originAgencyId IS  NULL')
      .andWhere('projectGroup.responsibleAgency IS NOT NULL')
      .andWhere('budgetPlan.isLatest = :budgetPlanIsLatest', { budgetPlanIsLatest: true });

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
  }) {
    const { userId, countOnly } = options;
    const workHistory = await this.workHistoryRepo.findOne({
      where: { user: { id: userId }, isCurrent: true },
      relations: [
        'user',
        'role',
        'localAdministrativeOrganization',
        'governmentAgencies',
        'workStatus',
        'workHistoryResponsibleAdmins',
        'workHistoryResponsibleAdmins.amphoe',
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
      .leftJoinAndSelect('projectGroup.budgetPlan', 'budgetPlan')
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
      .andWhere('projectGroup.isDraft = :isDraft', { isDraft: false })
      .andWhere('trackingStatus.isLatest = :isLatest', { isLatest: true })
      .andWhere('status.name = :statusName', { statusName: 'Verified' })
      .andWhere('projectGroup.originAgencyId IS  NULL')
      .andWhere('projectGroup.responsibleAgency IS NOT NULL')
      .andWhere('budgetPlan.isLatest = :budgetPlanIsLatest', { budgetPlanIsLatest: true });

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
  }) {
    const { userId, countOnly } = options;
    const workHistory = await this.workHistoryRepo.findOne({
      where: { user: { id: userId }, isCurrent: true },
      relations: [
        'user',
        'role',
        'localAdministrativeOrganization',
        'governmentAgencies',
        'workStatus',
        'workHistoryResponsibleAdmins',
        'workHistoryResponsibleAdmins.amphoe',
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
      .leftJoinAndSelect('projectGroup.budgetPlan', 'budgetPlan')
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
      .andWhere('projectGroup.isDraft = :isDraft', { isDraft: false })
      .andWhere('trackingStatus.isLatest = :isLatest', { isLatest: true })
      .andWhere('status.name = :statusName', { statusName: 'Verified' })
      .andWhere('projectGroup.originAgencyId IS NOT NULL')
      .andWhere('projectGroup.responsibleAgency IS NULL')
      .andWhere('budgetPlan.isLatest = :budgetPlanIsLatest', { budgetPlanIsLatest: true });



    if (countOnly) {
      const count = await query.getCount();
      return count;
    }

    const projects = await query
      .orderBy('projectGroup.createdAt', 'DESC')
      .getMany();

    return projects;
  }
  async findProjectsByStatusInAuthorityOut(options: {
    userId: string;
    countOnly?: boolean;
  }) {
    const { userId, countOnly } = options;
    const workHistory = await this.workHistoryRepo.findOne({
      where: { user: { id: userId }, isCurrent: true },
      relations: [
        'user',
        'role',
        'localAdministrativeOrganization',
        'governmentAgencies',
        'workStatus',
        'workHistoryResponsibleAdmins',
        'workHistoryResponsibleAdmins.amphoe',
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
      .leftJoinAndSelect('projectGroup.budgetPlan', 'budgetPlan')
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
      .andWhere('projectGroup.isDraft = :isDraft', { isDraft: false })
      .andWhere('trackingStatus.isLatest = :isLatest', { isLatest: true })
      .andWhere('status.name = :statusName', { statusName: 'Rejected' })
      .andWhere('projectGroup.originAgencyId IS NOT NULL')
      .andWhere('projectGroup.responsibleAgency IS NULL')
      .andWhere('budgetPlan.isLatest = :budgetPlanIsLatest', { budgetPlanIsLatest: true });



    if (countOnly) {
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
  }) {
    const { userId, countOnly } = option;
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
      .leftJoinAndSelect('projectGroup.budgetPlan', 'budgetPlan')
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
      .andWhere('projectGroup.isDraft = :isDraft', { isDraft: false })
      .andWhere('trackingStatus.isLatest = :isLatest', { isLatest: true })
      .andWhere('status.name = :statusName', { statusName: 'Approved' })
      .andWhere('projectGroup.originAgencyId IS NOT NULL')
      .andWhere('projectGroup.responsibleAgency IS NOT NULL')
      .andWhere('budgetPlan.isLatest = :budgetPlanIsLatest', { budgetPlanIsLatest: true });

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
  }) {
    const { userId, countOnly } = option;
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
      .leftJoinAndSelect('projectGroup.budgetPlan', 'budgetPlan')
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
      .andWhere('projectGroup.isDraft = :isDraft', { isDraft: false })
      .andWhere('trackingStatus.isLatest = :isLatest', { isLatest: true })
      .andWhere('status.name = :statusName', { statusName: 'Approved' })
      .andWhere('projectGroup.originAgencyId IS NULL')
      .andWhere('projectGroup.responsibleAgency IS NOT NULL')
      .andWhere('budgetPlan.isLatest = :budgetPlanIsLatest', { budgetPlanIsLatest: true });

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
   * Query original projects (ProjectGroup) ที่ไม่มี active revision และ status = Approved
   */
  private async findOriginalApprovedProjects(
    budgetPlanId: string,
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
      .leftJoinAndSelect('projectGroup.budgetPlan', 'budgetPlan')
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
      // .andWhere('projectGroup.originAgencyId IS NULL')
      // .andWhere('projectGroup.responsibleAgency IS NOT NULL')
      .andWhere('budgetPlan.id = :budgetPlanId', { budgetPlanId })
      // ไม่มี active revision
      .andWhere('activeRevision.id IS NULL');

    return await query.getMany();
  }

  /**
   * Query revised projects (RevisedProjectGroup) ที่เป็น latest version และ status = Approved
   */
  private async findRevisedApprovedProjects(
    budgetPlanId: string,
  ): Promise<RevisedProjectGroup[]> {
    const query = this.revisedProjectGroupRepo
      .createQueryBuilder('revisedProject')
      .leftJoinAndSelect('revisedProject.developmentPlanRevision', 'developmentPlanRevision')
      .leftJoinAndSelect('developmentPlanRevision.budgetPlan', 'budgetPlan')
      .leftJoinAndSelect('revisedProject.projectGroup', 'originalProject')
      .leftJoinAndSelect('revisedProject.createdBy', 'createdBy')
      .leftJoinAndSelect('createdBy.user', 'createdByUser')
      .leftJoinAndSelect('createdBy.amphoe', 'amphoe')
      .leftJoinAndSelect('createdBy.localAdministrativeOrganization', 'localAdministrativeOrganization')
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
      .andWhere('revisedProject.isDraft = :isDraft', { isDraft: false })
      .andWhere('developmentPlanRevision.isLatest = :isLatest', { isLatest: true })
      .andWhere('trackingStatus.isLatest = :isLatest', { isLatest: true })
      .andWhere('status.name = :statusName', { statusName: 'Approved' })
      .andWhere('budgetPlan.id = :budgetPlanId', { budgetPlanId });

    return await query.getMany();
  }

  /**
   * หาโครงการต้นฉบับ (ProjectGroup) ที่ไม่มี active revision
   * กรองเฉพาะ status = "Approved"
   */
  private async findOriginalLatestProjects(
    budgetPlanId: string,
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
      .leftJoinAndSelect('projectGroup.budgetPlan', 'budgetPlan')
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
      .andWhere('budgetPlan.id = :budgetPlanId', { budgetPlanId })
      // ไม่มี active revision
      .andWhere('activeRevision.id IS NULL');

    return await query.getMany();
  }

  /**
   * หาโครงการฉบับแก้ไข (RevisedProjectGroup) ที่เป็น version ล่าสุด
   * ใช้ revisedProject.isLatest แทน developmentPlanRevision.isLatest
   * ไม่กรองสถานะ - แสดงทุกสถานะ
   */
  private async findRevisedLatestProjects(
    budgetPlanId: string,
  ): Promise<RevisedProjectGroup[]> {
    const query = this.revisedProjectGroupRepo
      .createQueryBuilder('revisedProject')
      .leftJoinAndSelect('revisedProject.developmentPlanRevision', 'developmentPlanRevision')
      .leftJoinAndSelect('developmentPlanRevision.budgetPlan', 'budgetPlan')
      .leftJoinAndSelect('developmentPlanRevision.revisionType', 'revisionType')
      .leftJoinAndSelect('revisedProject.projectGroup', 'originalProject')
      .leftJoinAndSelect('revisedProject.createdBy', 'createdBy')
      .leftJoinAndSelect('createdBy.user', 'createdByUser')
      .leftJoinAndSelect('createdBy.amphoe', 'amphoe')
      .leftJoinAndSelect('createdBy.localAdministrativeOrganization', 'localAdministrativeOrganization')
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
      .andWhere('revisedProject.isDraft = :isDraft', { isDraft: false })
      .andWhere('revisedProject.isLatest = :isLatest', { isLatest: true })
      .andWhere('trackingStatus.isLatest = :isLatest', { isLatest: true })
      // ไม่กรองสถานะ - เอาทุกสถานะ
      .andWhere('budgetPlan.id = :budgetPlanId', { budgetPlanId });

    return await query.getMany();
  }

  /**
   * หาโครงการล่าสุดทั้งหมด (ไม่กรองสถานะ)
   * ถ้าโครงการมีลูก → เอาลูกล่าสุดมา
   * ถ้าโครงการไม่มีลูก → เอาแม่มา
   */
  async findLatestAllProjects(option: {
    userId: string;
    countOnly?: boolean;
    budgetPlanId?: string;
  }): Promise<IUnifiedProjectDisplay[] | number> {
    const { userId, countOnly, budgetPlanId } = option;

    // Validate user permissions
    const workHistory = await this.workHistoryRepo.findOne({
      where: { user: { id: userId } },
      relations: ['workStatus', 'role'],
    });

    if (!workHistory) return countOnly ? 0 : [];
    if (workHistory.workStatus.name !== 'approved')
      throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิในการเข้าถึงข้อมูล');

    const allowedRoles = ['staff', 'admin', 'super-admin', 'c-level'];
    if (!allowedRoles.includes(workHistory.role.name))
      throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิในการเข้าถึงข้อมูล');

    // Validate budget plan
    if (!budgetPlanId) {
      throw new BadRequestException('Budget plan ID is required');
    }

    const budgetPlan = await this.budgetPlanRepo.findOne({
      where: { id: budgetPlanId },
    });
    if (!budgetPlan)
      throw new NotFoundException('Budget plan not found');

    // Query both original and revised projects (without status filter)
    const [originalProjects, revisedProjects] = await Promise.all([
      this.findOriginalLatestProjects(budgetPlanId),
      this.findRevisedLatestProjects(budgetPlanId),
    ]);

    // If count only, return total count
    if (countOnly) {
      return originalProjects.length + revisedProjects.length;
    }

    // Map to unified format
    const unifiedOriginals = originalProjects.map((project) =>
      UnifiedProjectMapper.fromProjectGroup(project),
    );
    const unifiedRevised = revisedProjects.map((project) =>
      UnifiedProjectMapper.fromRevisedProjectGroup(project),
    );

    // Combine and sort by created date (newest first)
    const combined = [...unifiedOriginals, ...unifiedRevised];
    combined.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    return combined;
  }

  async findByStatusApproved(option: {
    userId: string;
    countOnly?: boolean;
    budgetPlanId?: string;
  }): Promise<IUnifiedProjectDisplay[] | number> {
    const { userId, countOnly, budgetPlanId } = option;
    
    // Validate user permissions
    const workHistory = await this.workHistoryRepo.findOne({
      where: { user: { id: userId } },
      relations: ['workStatus', 'role'],
    });

    if (!workHistory) return countOnly ? 0 : [];
    if (workHistory.workStatus.name !== 'approved')
      throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิในการเข้าถึงข้อมูล');

    const allowedRoles = ['staff', 'admin', 'super-admin', 'c-level'];
    if (!allowedRoles.includes(workHistory.role.name))
      throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิในการเข้าถึงข้อมูล');

    // Validate budget plan
    if (!budgetPlanId) {
      throw new BadRequestException('Budget plan ID is required');
    }

    const budgetPlan = await this.budgetPlanRepo.findOne({
      where: { id: budgetPlanId },
    });
    if (!budgetPlan)
      throw new NotFoundException('Budget plan not found');

    // Query both original and revised projects
    const [originalProjects, revisedProjects] = await Promise.all([
      this.findOriginalApprovedProjects(budgetPlanId),
      this.findRevisedApprovedProjects(budgetPlanId),
    ]);

    // If count only, return total count
    if (countOnly) {
      return originalProjects.length + revisedProjects.length;
    }

    // Map to unified format
    const unifiedOriginals = originalProjects.map((project) =>
      UnifiedProjectMapper.fromProjectGroup(project),
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
  async findAllVersions(
    projectId: string,
    userId: string,
  ): Promise<IProjectVersionsResponse> {
    // Validate user permissions
    const workHistory = await this.workHistoryRepo.findOne({
      where: { user: { id: userId } },
      relations: ['workStatus', 'role'],
    });

    if (!workHistory)
      throw new UnauthorizedException('User not found');
    if (workHistory.workStatus.name !== 'approved')
      throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิในการเข้าถึงข้อมูล');

    const allowedRoles = ['staff', 'admin', 'super-admin', 'c-level'];
    if (!allowedRoles.includes(workHistory.role.name))
      throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิในการเข้าถึงข้อมูล');

    // Try to find as ProjectGroup first
    let originalProject = await this.projectGroupRepo.findOne({
      where: { id: projectId },
      relations: [
        'createdBy',
        'createdBy.user',
        'createdBy.amphoe',
        'createdBy.localAdministrativeOrganization',
        'strategy',
        'tactic',
        'plan',
        'budgetPlan',
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
      ],
    });

    let projectGroupId = projectId;

    // If not found as ProjectGroup, try to find as RevisedProjectGroup
    if (!originalProject) {
      const revisedProject = await this.revisedProjectGroupRepo.findOne({
        where: { id: projectId },
        relations: ['projectGroup'],
      });

      if (!revisedProject) {
        throw new NotFoundException(`Project with ID ${projectId} not found`);
      }

      // If this revised project has a parent, use the parent's ID
      if (revisedProject.projectGroup) {
        projectGroupId = revisedProject.projectGroup.id;
        originalProject = await this.projectGroupRepo.findOne({
          where: { id: projectGroupId },
          relations: [
            'createdBy',
            'createdBy.user',
            'createdBy.amphoe',
            'createdBy.localAdministrativeOrganization',
            'strategy',
            'tactic',
            'plan',
            'budgetPlan',
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
          ],
        });
      }
      // If no parent (new project), originalProject stays null
    }

    // Find all revisions of this project (all versions, not just latest)
    const whereCondition = originalProject
      ? { projectGroup: { id: projectGroupId } }
      : { projectGroup: IsNull() };

    const allRevisions = await this.revisedProjectGroupRepo.find({
      where: whereCondition,
      relations: [
        'developmentPlanRevision',
        'developmentPlanRevision.budgetPlan',
        'developmentPlanRevision.revisionType',
        'projectGroup',
        'createdBy',
        'createdBy.user',
        'createdBy.amphoe',
        'createdBy.localAdministrativeOrganization',
        'strategy',
        'tactic',
        'plan',
        'budgets',
        'trackingStatus',
        'trackingStatus.statusId',
        'trackingStatus.comments',
        'trackingStatus.createdBy',
        'trackingStatus.createdBy.user',
        'responsibleAgency',
        'originAgencyId',
      ],
      order: {
        developmentPlanRevision: {
          revisionNumber: 'ASC',
        },
      },
    });

    // Filter to get only latest tracking status for each revision
    const revisionsWithLatestStatus = allRevisions.map((revision) => {
      return {
        ...revision,
        trackingStatus: revision.trackingStatus?.filter((ts) => ts.isLatest),
      };
    });

    // Map to unified format
    const unifiedOriginal = originalProject
      ? UnifiedProjectMapper.fromProjectGroup(originalProject)
      : null;

    const unifiedRevisions = revisionsWithLatestStatus.map((revision) =>
      UnifiedProjectMapper.fromRevisedProjectGroup(revision),
    );

    // Sort revisions by revisionNumber
    unifiedRevisions.sort((a, b) => {
      const aNum = a.revisionNumber ?? 0;
      const bNum = b.revisionNumber ?? 0;
      return aNum - bNum;
    });

    // Add comparison data to each revision
    for (let i = 0; i < unifiedRevisions.length; i++) {
      const current = unifiedRevisions[i];
      let previous: IUnifiedProjectDisplay | null = null;
      let comparedWith: 'original' | 'previous-revision' | null = null;

      if (i === 0) {
        // First revision: compare with original project
        previous = unifiedOriginal;
        comparedWith = previous ? 'original' : null;
      } else {
        // Subsequent revisions: compare with previous revision
        previous = unifiedRevisions[i - 1];
        comparedWith = 'previous-revision';
      }

      // Calculate changed fields
      const changedFields = this.calculateChangedFields(current, previous);

      // Add changes to the current revision
      current.changes = {
        comparedWith,
        changedFields,
      };
    }

    // Calculate total versions
    const totalVersions =
      (originalProject ? 1 : 0) + unifiedRevisions.length;

    // Find latest version
    let latestVersion: IProjectVersionsResponse['latestVersion'] = null;
    if (unifiedRevisions.length > 0) {
      const latest = unifiedRevisions[unifiedRevisions.length - 1];
      latestVersion = {
        id: latest.id,
        revisionNumber: latest.revisionNumber,
        isOriginal: false,
      };
    } else if (originalProject) {
      latestVersion = {
        id: originalProject.id,
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

  async findOne(id: string): Promise<ProjectGroup> {
    try {
      const projectGroup = await this.projectGroupRepo.findOne({
        where: { id },
        relations: ['createdBy', 'createdBy.user', 'createdBy.amphoe', 'createdBy.localAdministrativeOrganization', 'strategy', 'tactic', 'plan', 'budgetPlan', 'budgets', 'trackingStatus', 'trackingStatus.comments', 'trackingStatus.statusId', 'trackingStatus.createdBy', 'trackingStatus.createdBy.user', 'trackingStatus.createdBy.localAdministrativeOrganization', 'trackingStatus.createdBy.governmentAgencies', 'trackingStatus.createdBy.workStatus', 'trackingStatus.createdBy.workStatus', 'responsibleAgency', 'originAgencyId'],
      });

      if (!projectGroup) {
        throw new NotFoundException(`Amphoe with ID ${id} not found`);
      }
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

      // 3. ตรวจสอบ foreign key
      const [strategy, tactic, plan] = await Promise.all([
        manager.findOne(Strategy, {
          where: { id: dto.strategyId },
        }),
        manager.findOne(Tactic, {
          where: { id: dto.tacticId },
        }),
        manager.findOne(Plan, { where: { id: dto.planId } }),
      ]);
      if (!strategy)
        throw new NotFoundException(`Strategy ID not found: ${dto.strategyId}`);
      if (!tactic)
        throw new NotFoundException(`Tactic ID not found: ${dto.tacticId}`);
      if (!plan)
        throw new NotFoundException(`Plan ID not found: ${dto.planId}`);

      // 5. ดึง group เดิม
      const group = await manager.findOne(ProjectGroup, {
        where: { id },
        relations: ['strategy', 'tactic', 'plan'],
      });
      if (!group) throw new NotFoundException(`Project group ${id} not found`);

      // 6. อัปเดตข้อมูลหลัก
      Object.assign(group, {
        title: dto.title,
        objective: dto.objective,
        goal: dto.goal,
        startLat: dto.startLat,
        startLng: dto.startLng,
        endLat: dto.endLat ?? null,
        endLng: dto.endLng ?? null,
        indicator: dto.indicator,
        expected: dto.expected,
        strategy,
        tactic,
        plan,
      });
      await manager.save(group);

      return group;
    });
  }

  async remove(id: string): Promise<{ message: string }> {
    try {
      const result = await this.projectGroupRepo.delete(id);
      if (result.affected === 0) {
        throw new NotFoundException(`projectGroup with ID ${id} not found`);
      }
      return {
        message: `projectGroup with ID ${id} has been permanently removed.`,
      };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async softRemove(id: string): Promise<{ message: string }> {
    try {
      const result = await this.projectGroupRepo.softDelete(id);
      if (result.affected === 0) {
        throw new NotFoundException(`projectGroup with ID ${id} not found`);
      }
      return { message: `projectGroup with ID ${id} has been soft-removed.` };
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
      where: { user: { id: userId } },
      relations: ['user', 'localAdministrativeOrganization', 'governmentAgencies'],
    });
    if (!workHistory) {
      throw new NotFoundException('Work history ID not found');
    }
    return workHistory;
  }

  private async ensureNoDuplicateTitle(manager: EntityManager, title: string, workHistoryId: string, id?: string) {
    const whereCondition: any = {
      title,
      createdBy: { id: workHistoryId }
    };

    if (id) {
      whereCondition.id = Not(id);
    }

    const existing = await manager.findOne(ProjectGroup, {
      where: whereCondition,
    });
    if (existing) {
      throw new ConflictException('Project group with this title already exists');
    }
  }

  private async validateForeignKeys(manager: EntityManager, dto: CreateProjectGroupDto) {
    const [budgetPlan, strategy, tactic, plan] = await Promise.all([
      manager.findOne(BudgetPlan, { where: { id: dto.budgetPlanId } }),
      manager.findOne(Strategy, { where: { id: dto.strategyId } }),
      manager.findOne(Tactic, { where: { id: dto.tacticId } }),
      manager.findOne(Plan, { where: { id: dto.planId } }),
    ]);

    if (!budgetPlan) throw new NotFoundException(`Budget Plan ID not found: ${dto.budgetPlanId}`);
    if (!strategy) throw new NotFoundException(`Strategy ID not found: ${dto.strategyId}`);
    if (!tactic) throw new NotFoundException(`Tactic ID not found: ${dto.tacticId}`);
    if (!plan) throw new NotFoundException(`Plan ID not found: ${dto.planId}`);

    return [budgetPlan, strategy, tactic, plan];
  }

  private getAgencyData(workHistory: any) {
    if (workHistory.governmentAgencies) {
      return { responsibleAgency: { id: workHistory.governmentAgencies.id } };
    }
    if (workHistory.localAdministrativeOrganization) {
      return { originAgencyId: { id: workHistory.localAdministrativeOrganization.id } };
    }
    throw new BadRequestException('ไม่พบหน่วยงานของผู้ใช้');
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
