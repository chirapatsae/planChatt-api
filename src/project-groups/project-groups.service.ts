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
import { UpdateProjectGroupDto } from './dto/update-project-group.dto';
import { BudgetPlan } from 'src/budget_plan/entities/budget_plan.entity';
import { TrackingStatus } from 'src/tracking-status/entities/tracking-status.entity';
import { Budget } from 'src/budget/entities/budget.entity';
import { Tactic } from 'src/tactic/entities/tactic.entity';
import { Plan } from 'src/plan/entities/plan.entity';
import { Strategy } from 'src/strategy/entities/strategy.entity';
import { Cron, CronExpression } from '@nestjs/schedule';
import { sendEmail } from 'src/util/emailService';
import { handleException } from 'src/util/handleException';

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
    type?: 'draft' | 'ready' | 'pending' | 'edit' | 'approved' | 'rejected';
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
      ],
    });
    if (!workHistory) return countOnly ? 0 : [];
    if (workHistory.workStatus.id !== process.env.APPROVED_WORK_STATUS)
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
      .leftJoinAndSelect('projectGroup.favorites', 'favorites')
      .leftJoinAndSelect('favorites.userId', 'userId');


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
            .andWhere('status.name = :statusName', { statusName: 'Ready' });
          break;
        case 'pending':
          query.andWhere('projectGroup.isDraft = :isDraft', { isDraft: false })
            .andWhere('trackingStatus.isLatest = :isLatest', { isLatest: true })
            .andWhere('status.name = :statusName', { statusName: 'Pending' });
          break;
        case 'edit':
          query.andWhere('projectGroup.isDraft = :isDraft', { isDraft: false })
            .andWhere('trackingStatus.isLatest = :isLatest', { isLatest: true })
            .andWhere('status.name = :statusName', { statusName: 'Revision' });
          break;
        case 'approved':
          query.andWhere('projectGroup.isDraft = :isDraft', { isDraft: false })
            .andWhere('trackingStatus.isLatest = :isLatest', { isLatest: true })
            .andWhere('status.name = :statusName', { statusName: 'Approved' });
          break;
        case 'rejected':
          query.andWhere('projectGroup.isDraft = :isDraft', { isDraft: false })
            .andWhere('trackingStatus.isLatest = :isLatest', { isLatest: true })
            .andWhere('status.name = :statusName', { statusName: 'Rejected' });
          break;
        // no default
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
      relations: ['localAdministrativeOrganization', 'governmentAgencies'],
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
