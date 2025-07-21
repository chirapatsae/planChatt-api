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
import { DataSource, IsNull, Not, Repository } from 'typeorm';
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

    private readonly dataSource: DataSource // 👈 Inject ตรงนี้
  ) { }

  async create(dto: CreateProjectGroupDto, userId: string) {
    try {
      const savedGroup = await this.dataSource.transaction(async (manager) => {
        const workHistory = await manager.findOne(this.workHistoryRepo.target, {
          where: { user: { id: userId } },
          relations: ['localAdministrativeOrganization', 'governmentAgencies'],
        });
        if (!workHistory) {
          throw new NotFoundException('Work history ID not found');
        }

        const duplicateTitle = await manager.findOne(this.projectGroupRepo.target, {
          where: { title: dto.title, createdBy: { id: workHistory.id } },
        });
        if (duplicateTitle) {
          throw new ConflictException('Project group with this title already exists');
        }

        // 2. ใช้ Promise.all เพื่อตรวจสอบ Foreign Keys ทั้งหมดพร้อมกัน เพิ่มประสิทธิภาพ
        const [budgetPlan, strategy, tactic, plan] = await Promise.all([
          manager.findOne(this.budgetPlanRepo.target, { where: { id: dto.budgetPlanId } }),
          manager.findOne(this.strategyRepo.target, { where: { id: dto.strategyId } }),
          manager.findOne(this.tacticRepo.target, { where: { id: dto.tacticId } }),
          manager.findOne(this.planRepo.target, { where: { id: dto.planId } }),
        ]);

        // 3. ให้ Error Message ที่ชัดเจนเมื่อไม่พบ ID
        if (!budgetPlan) { throw new NotFoundException(`Budget Plan ID not found: ${dto.budgetPlanId}`); }
        if (!strategy) { throw new NotFoundException(`Strategy ID not found: ${dto.strategyId}`); }
        if (!tactic) { throw new NotFoundException(`Tactic ID not found: ${dto.tacticId}`); }
        if (!plan) { throw new NotFoundException(`Plan ID not found: ${dto.planId}`); }

        // --- ส่วนของการสร้างข้อมูล (Creation) ---

        let agencyData: any;
        if (workHistory.governmentAgencies !== null) {
          // Internal project
          if (!workHistory.governmentAgencies) {
            throw new BadRequestException('User ภายในต้องมี governmentAgencies');
          }
          agencyData = { responsibleAgency: { id: workHistory.governmentAgencies.id } };
        } else {
          // External project
          if (!workHistory.localAdministrativeOrganization) {
            throw new BadRequestException('User ภายนอกต้องมี localAdministrativeOrganization');
          }
          agencyData = { originAgencyId: { id: workHistory.localAdministrativeOrganization.id } };
        }
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
          createdBy: workHistory,
          ...agencyData, // รวม agency data ที่เหมาะสม
        };

        const group = manager.create(this.projectGroupRepo.target, projectGroupData);
        const savedGroupResult = await manager.save(group);

        const trackingStatus = manager.create(this.trackingStatusRepo.target, {
          projectGroup: { id: savedGroupResult.id },
          status: { id: '62997bd6-b1d2-4484-a8fc-f597802d95c2' },
          workHistory: { id: workHistory.id },
        });
        await manager.save(trackingStatus);

        if (!Array.isArray(dto.budget) || dto.budget.length === 0) throw new BadRequestException('งบประมาณไม่ถูกต้องหรือไม่มีข้อมูล');

        const budgetPromises = dto.budget.map((item) => {
          const budget = manager.create(this.budgetRepo.target, {
            projectGroup: { id: savedGroupResult.id },
            year: item.year,
            quantity: item.quantity,
          });
          return manager.save(budget);
        });
        await Promise.all(budgetPromises);
        return savedGroupResult;
      });

      return savedGroup;

    } catch (error) {
      handleException(this.logger, error)
    }
  }

  async findProjectsByStatus(options: {
    userId: string;
    countOnly?: boolean;
    type?: 'draft' | 'pending' | 'edit' | 'approved'; 
  }) {
    const { userId, countOnly, type } = options;

    const workHistory = await this.workHistoryRepo.findOne({
      where: { user: { id: userId } },
      relations: ['user', 'localAdministrativeOrganization', 'governmentAgencies', 'workStatus'],
    });
    this.logger.log(workHistory);
    if (!workHistory) return countOnly ? 0 : [];
    if (workHistory.workStatus.id !== "c844d2a7-cf8b-4db1-958c-d7209dd30ff5") throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิในการเข้าถึงข้อมูล');

    let where: any = {};

    if (type) {
      switch (type) {
        case 'draft':
          where.trackingStatus = {
            isLatest: true,
            status: { id: '62997bd6-b1d2-4484-a8fc-f597802d95c2' },
          };
          break;
        case 'pending':
          where.trackingStatus = {
            isLatest: true,
            status: { id: '30da8501-4487-49b7-8acf-ede14ca4ac09' },
          };
          break;
        case 'edit':
          where.trackingStatus = {
            isLatest: true,
            status: { id: 'e4173695-f605-4f80-b8ab-7f4569fc8f60' },
          };
          break;
        case 'approved':
          where.trackingStatus = {
            isLatest: true,
            status: { id: 'ef3bffe9-cf5b-41bf-bee2-3390197c8bc5' },
          };
          break;
        // no default
      }
    }

    // Internal agency (ภาครัฐ)
    if (workHistory.governmentAgencies) {
      where.responsibleAgency = workHistory.governmentAgencies.id;
    }
    // External (องค์กรปกครองท้องถิ่น)
    if (!workHistory.governmentAgencies) {
      where.originAgencyId = workHistory.localAdministrativeOrganization.id;
    }
    // Default query
    return countOnly
      ? this.projectGroupRepo.count({ where, relations: ['trackingStatus'] })
      : this.projectGroupRepo.find({ where, relations: ['trackingStatus'] });
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
        relations: ['workHistory']
      });
      return result;
    } catch (error) {
      this.logger.error('Failed to count deleted projects', error.stack);
      throw new InternalServerErrorException('Unable to count deleted projects');
    }
  }

  async findOne(id : string ) : Promise<ProjectGroup>{
    try {
      const projectGroup = await this.projectGroupRepo.findOne({
        where: { id },
      });

      if (!projectGroup) {
        throw new NotFoundException(`Amphoe with ID ${id} not found`);
      }
      return projectGroup;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleProjectCleanUp() {
    try {
      const oldDeletedProjects = await this.projectGroupRepo
        .createQueryBuilder('group')
        .withDeleted()
        .where('group.deletedAt IS NOT NULL')
        .andWhere('group.deletedAt < NOW() - INTERVAL \'15 days\'')
        .getMany();

      const idsToDelete = oldDeletedProjects.map(p => p.id);

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

  async update(id: string, dto: UpdateProjectGroupDto, userId: string): Promise<ProjectGroup> {
    return await this.dataSource.transaction(async (manager) => {
      // 1. ตรวจสอบ workHistory
      const workHistory = await manager.findOne(this.workHistoryRepo.target, {
        where: { user: { id: userId } },
        relations: ['localAdministrativeOrganization', 'governmentAgencies' , 'workStatus'],
      });
      if (!workHistory || workHistory.workStatus.name.toLocaleLowerCase() !== "approved") throw new NotFoundException('Work history ID not found');

      // 2. ตรวจสอบ duplicate title (ยกเว้นตัวเอง)
      const duplicateTitle = await manager.findOne(this.projectGroupRepo.target, {
        where: { title: dto.title, createdBy: { id: workHistory.id }, id: Not(id) },
      });
      if (duplicateTitle) throw new ConflictException('Project group with this title already exists');

      // 3. ตรวจสอบ foreign key
      const [ strategy, tactic, plan] = await Promise.all([
        manager.findOne(this.strategyRepo.target, { where: { id: dto.strategyId } }),
        manager.findOne(this.tacticRepo.target, { where: { id: dto.tacticId } }),
        manager.findOne(this.planRepo.target, { where: { id: dto.planId } }),
      ]);
      if (!strategy) throw new NotFoundException(`Strategy ID not found: ${dto.strategyId}`);
      if (!tactic) throw new NotFoundException(`Tactic ID not found: ${dto.tacticId}`);
      if (!plan) throw new NotFoundException(`Plan ID not found: ${dto.planId}`);

      // 5. ดึง group เดิม
      const group = await manager.findOne(this.projectGroupRepo.target, {
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
      return { message: `projectGroup with ID ${id} has been permanently removed.` };
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
        throw new NotFoundException(`projectGroup with ID ${id} not found or was not deleted.`);
      }
      return { message: `projectGroup with ID ${id} has been restored.` };
    } catch (error) {
      handleException(this.logger, error);
    }
  }
}
