import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Not, Repository, SelectQueryBuilder } from 'typeorm';
import { ProjectGroup } from './entities/project-group.entity';
import { CreateProjectGroupDto } from './dto/create-project-group.dto';
import { UpdateProjectGroupDto } from './dto/update-project-group.dto';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { ProjectType } from 'src/project-types/entities/project-type.entity';
import { BudgetPlan } from 'src/budget_plan/entities/budget_plan.entity';
import { TrackingStatus } from 'src/tracking-status/entities/tracking-status.entity';
import { Budget } from 'src/budget/entities/budget.entity';
import { Tactic } from 'src/tactic/entities/tactic.entity';
import { Plan } from 'src/plan/entities/plan.entity';
import { Strategy } from 'src/strategy/entities/strategy.entity';
import { Cron, CronExpression } from '@nestjs/schedule';
import { sendEmail } from 'src/util/emailService';

@Injectable()
export class ProjectGroupsService {
  private readonly logger = new Logger(ProjectGroupsService.name);

  constructor(
    @InjectRepository(ProjectGroup)
    private readonly projectGroupRepo: Repository<ProjectGroup>,

    @InjectRepository(WorkHistory)
    private readonly workHistoryRepo: Repository<WorkHistory>,

    @InjectRepository(ProjectType)
    private readonly projectTypeRepo: Repository<ProjectType>,

    @InjectRepository(BudgetPlan)
    private readonly budgetPlanRepo: Repository<BudgetPlan>,

    @InjectRepository(TrackingStatus)
    private readonly trackingStatusRepo: Repository<TrackingStatus>,

    @InjectRepository(Budget)
    private readonly budgetRepo: Repository<Budget>,

    private readonly dataSource: DataSource // 👈 Inject ตรงนี้
  ) { }

  async create(dto: CreateProjectGroupDto, userId: string) {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const workHistory = await queryRunner.manager.findOne(this.workHistoryRepo.target, {
        where: { user: { id: userId } },
        relations: ['localAdministrativeOrganization'],
      });

      if (!workHistory) {
        throw new NotFoundException('Work history ID not found');
      }

      const budgetPlan = await queryRunner.manager.findOne(this.budgetPlanRepo.target, {
        where: { id: dto.budgetPlanId },
      });

      if (!budgetPlan) {
        throw new NotFoundException('Budget plan ID not found');
      }

      const existing = await queryRunner.manager.findOne(this.projectGroupRepo.target, {
        where: { title: dto.title, workHistory: { id: workHistory.id } },
      });

      if (existing) {
        throw new ConflictException('Project group with this title already exists');
      }

      //internal project
      const projectTypeId = parseInt(dto.projectTypeId) === 1
        ? "ac47726d-d97b-4a86-89af-e673a660543e"
        : "28eb6771-0fb8-4de9-bdaa-87f9bd0dc3fe";

      const group = queryRunner.manager.create(this.projectGroupRepo.target, {
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
        workHistory,
        projectType: { id: projectTypeId },
        strategy: { id: dto.strategyId },
        tactic: { id: dto.tacticId },
        plan: { id: dto.planId },
        budgetPlanId: { id: dto.budgetPlanId },
        responsibleOrgId: dto.responsibleOrgId === 0 ? undefined : dto.responsibleOrgId
      });

      const savedGroup = await queryRunner.manager.save(group);

      const trackingStatus = queryRunner.manager.create(this.trackingStatusRepo.target, {
        projectGroup: { id: savedGroup.id },
        status: { id: '62997bd6-b1d2-4484-a8fc-f597802d95c2' },
        projectType: { id: projectTypeId },
        workHistory: { id: workHistory.id }
      });
      await queryRunner.manager.save(trackingStatus);

      // ✅ Insert budget items
      if (!Array.isArray(dto.budget) || dto.budget.length === 0) {
        throw new BadRequestException('งบประมาณไม่ถูกต้องหรือไม่มีข้อมูล');
      }

      for (const item of dto.budget) {
        const budget = queryRunner.manager.create(this.budgetRepo.target, {
          projectGroup: { id: savedGroup.id },
          year: item.year,
          quantity: item.quantity,
        });
        await queryRunner.manager.save(budget);
      }

      await queryRunner.commitTransaction();
      return savedGroup;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error('❌ Failed to create project group with tracking', error.stack);
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async findDraft(role: string, userId: string) {
    try {
      // ในตอนต้นของฟังก์ชัน
      const workHistory = await this.workHistoryRepo.findOne({
        where: {
          user: { id: userId },
        },
        relations: ['user', 'localAdministrativeOrganization'], // <-- เพิ่มตรงนี้
      });
      if (!workHistory) {
        throw new NotFoundException('Work history ID not found');
      }
      const statusId = '62997bd6-b1d2-4484-a8fc-f597802d95c2'; // Draft status ID
      // Subquery to get latest create_at for each group
      const subQuery = this.projectGroupRepo
        .createQueryBuilder()
        .subQuery()
        .select('MAX(ts_sub.create_at)')
        .from('tracking_status', 'ts_sub')
        .where('ts_sub.project_group_id = group.id')
        .getQuery();

      const qb = this.projectGroupRepo
        .createQueryBuilder('group')
        .innerJoinAndSelect('group.trackingStatus', 'trackingStatus') // ✅ select all columns
        .innerJoinAndSelect('trackingStatus.status', 'status')         // ✅ include status.name
        .innerJoinAndSelect('trackingStatus.workHistory', 'creatorWorkHistory') // 👈 this adds the creator
        .innerJoinAndSelect('creatorWorkHistory.user', 'creatorUser') // 👈 Load the user from workHistory
        .innerJoinAndSelect('group.workHistory', 'workHistory')
        .innerJoinAndSelect('workHistory.user', 'user')
        .innerJoinAndSelect('workHistory.localAdministrativeOrganization', 'localAdministrativeOrganization')
        .innerJoinAndSelect('workHistory.amphoe', 'amphoe')

        .where(`"trackingStatus"."create_at" = (${subQuery})`)
        .andWhere(`"trackingStatus"."status_id" = :statusId`, { statusId })
        .andWhere(`"workHistory"."local_admistrative_organization_id" = :orgId`, { orgId: workHistory.localAdministrativeOrganization.id }); const result = await qb.getMany();
      console.dir(result, { depth: null });
      return result;
    } catch (error) {
      this.logger.error('Failed to find draft projects', error.stack);
      throw new InternalServerErrorException('Unable to find draft projects');
    }
  }

  async findDraftdLength(role: string, userId: string) {
    try {
      // ในตอนต้นของฟังก์ชัน
      const workHistory = await this.workHistoryRepo.findOne({
        where: {
          user: { id: userId },
        },
        relations: ['user', 'localAdministrativeOrganization'], // <-- เพิ่มตรงนี้
      });
      if (!workHistory) {
        throw new NotFoundException('Work history ID not found');
      }
      const statusId = '62997bd6-b1d2-4484-a8fc-f597802d95c2'; // Draft status ID
      // Subquery to get latest create_at for each group
      const subQuery = this.projectGroupRepo
        .createQueryBuilder()
        .subQuery()
        .select('MAX(ts_sub.create_at)')
        .from('tracking_status', 'ts_sub')
        .where('ts_sub.project_group_id = group.id')
        .getQuery();

      const qb = this.projectGroupRepo
        .createQueryBuilder('group')
        .innerJoinAndSelect('group.trackingStatus', 'trackingStatus') // ✅ select all columns
        .innerJoinAndSelect('trackingStatus.status', 'status')         // ✅ include status.name
        .innerJoinAndSelect('trackingStatus.workHistory', 'creatorWorkHistory') // 👈 this adds the creator
        .innerJoinAndSelect('creatorWorkHistory.user', 'creatorUser') // 👈 Load the user from workHistory
        .innerJoinAndSelect('group.workHistory', 'workHistory')
        .innerJoinAndSelect('workHistory.user', 'user')
        .innerJoinAndSelect('workHistory.localAdministrativeOrganization', 'localAdministrativeOrganization')
        .innerJoinAndSelect('workHistory.amphoe', 'amphoe')

        .where(`"trackingStatus"."create_at" = (${subQuery})`)
        .andWhere(`"trackingStatus"."status_id" = :statusId`, { statusId })
        .andWhere(`"workHistory"."local_admistrative_organization_id" = :orgId`, { orgId: workHistory.localAdministrativeOrganization.id });
      const result = await qb.getCount();
      return result;
    } catch (error) {
      this.logger.error('Failed to find draft projects', error.stack);
      throw new InternalServerErrorException('Unable to find draft projects');
    }
  }


  async findEdit(role: string, userId: string) {
    try {
      const workHistory = await this.workHistoryRepo.findOne({
        where: {
          user: { id: userId },
        },
      });

      if (!workHistory) {
        throw new NotFoundException('Work history ID not found');
      }
      // Subquery to get latest create_at for each group
      const subQuery = this.projectGroupRepo
        .createQueryBuilder()
        .subQuery()
        .select('MAX(ts_sub.create_at)')
        .from('tracking_status', 'ts_sub')
        .where('ts_sub.project_group_id = group.id')
        .getQuery();

      const qb = this.projectGroupRepo
        .createQueryBuilder('group')
        .innerJoinAndSelect('group.trackingStatus', 'trackingStatus') // ✅ select all columns
        .innerJoinAndSelect('trackingStatus.status', 'status')         // ✅ include status.name
        .innerJoinAndSelect('trackingStatus.workHistory', 'creatorWorkHistory') // 👈 this adds the creator
        .innerJoinAndSelect('creatorWorkHistory.user', 'creatorUser') // 👈 Load the user from workHistory
        .innerJoinAndSelect('group.workHistory', 'workHistory')
        .innerJoinAndSelect('workHistory.user', 'user')
        .innerJoinAndSelect('workHistory.localAdministrativeOrganization', 'localAdministrativeOrganization')
        .innerJoinAndSelect('workHistory.amphoe', 'amphoe')
        .leftJoinAndSelect('trackingStatus.comments', 'comments')

        .where(`"trackingStatus"."create_at" = (${subQuery})`)
        .andWhere(`"status"."level" = :level`, { level: '3' })
        .andWhere(`"workHistory"."id" = :workHistoryId`, { workHistoryId: workHistory.id });
      const result = await qb.getMany();
      return result;

      // return await qb.getMany();
    } catch (error) {
      this.logger.error('Failed to find editable projects', error.stack);
      throw new InternalServerErrorException('Unable to find editable projects');
    }
  }

  async findEditLength(role: string, userId: string): Promise<number> {
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

      const subQuery = this.projectGroupRepo
        .createQueryBuilder('subGroup')
        .subQuery()
        .select('MAX(ts."create_at")')
        .from('tracking_status', 'ts')
        .where('"ts"."project_group_id" = "group"."id"')
        .getQuery();

      const qb = this.projectGroupRepo
        .createQueryBuilder('group')
        .innerJoin('group.trackingStatus', 'trackingStatus')
        .innerJoin('trackingStatus.status', 'status')
        .innerJoin('group.workHistory', 'workHistory')
        .where(`"trackingStatus"."create_at" = ${subQuery}`)
        .andWhere(`"status"."name" = :name`, { name: 'แก้ไขโครงการ' })
        .andWhere(`"workHistory"."id" = :workHistoryId`, { workHistoryId: workHistory.id });

      const count = await qb.getCount();
      return count;
    } catch (error) {
      console.error(error);
      this.logger.error('Failed to count edit projects', error.stack);
      throw new InternalServerErrorException('Unable to count edit projects');
    }
  }
  async findAVerify(role: string, userId: string) {
    try {
      const workHistory = await this.workHistoryRepo.findOne({
        where: { user: { id: userId } },
        relations: [
          'user',
          'localAdministrativeOrganization',
          'responsibilities',
          'responsibilities.amphoe',
        ],
      });

      if (!workHistory) {
        return [];
      }

      const statusId = '30da8501-4487-49b7-8acf-ede14ca4ac09';

      const qb = this.projectGroupRepo
        .createQueryBuilder('group')
        .leftJoinAndSelect('group.strategy', 'strategy')
        .leftJoinAndSelect('group.tactic', 'tactic')
        .leftJoinAndSelect('group.plan', 'plan')
        .leftJoinAndSelect('group.budgetPlanId', 'budgetPlan')
        .leftJoinAndSelect('group.projectType', 'projectType')
        .leftJoinAndSelect('group.workHistory', 'workHistory')
        .leftJoinAndSelect('workHistory.user', 'user')
        .leftJoinAndSelect('workHistory.amphoe', 'amphoe')
        .leftJoinAndSelect(
          'workHistory.localAdministrativeOrganization',
          'localAdministrativeOrganization',
        )
        .leftJoinAndSelect('group.trackingStatus', 'trackingStatus')
        .leftJoinAndSelect('trackingStatus.status', 'status')
        .leftJoinAndSelect('group.budgets', 'budgets')
        .where((qb2) => {
          const subQuery = qb2
            .subQuery()
            .select('MAX(ts2."create_at")')
            .from('tracking_status', 'ts2')
            .where('"ts2"."project_group_id" = "group"."id"')
            .getQuery();
          return `"trackingStatus"."create_at" = ${subQuery}`;
        })
        .andWhere(`"trackingStatus"."status_id" = :statusId`, { statusId });

      if (role === 'user') {
        if (!workHistory.localAdministrativeOrganization) {
          return [];
        }
        qb.andWhere(
          `"workHistory"."local_admistrative_organization_id" = :orgId`,
          { orgId: workHistory.localAdministrativeOrganization.id },
        );
      } else if (role === 'admin') {
        // const responsibleAmphoeIds = workHistory.responsibilities
        //   ?.map((r) => r.amphoe?.id)
        //   .filter((id) => !!id);

        // if (!responsibleAmphoeIds || responsibleAmphoeIds.length === 0) {
        //   return [];
        // }
        // qb.andWhere(`"workHistory"."amphoe_id" IN (:...amphoeIds)`, {
        //   amphoeIds: responsibleAmphoeIds,
        // });
      } else {
        return []; // No role matched, return empty
      }

      qb.orderBy('group.createdAt', 'DESC');

      // budgetSum
      qb.addSelect(
        (subQb) =>
          subQb
            .select('COALESCE(SUM(b2.quantity), 0)', 'sum')
            .from(Budget, 'b2')
            .where('b2.projectGroup = group.id'),
        'budgetSum',
      );

      const { entities, raw } = await qb.getRawAndEntities();

      const results = entities.map((entity, idx) => ({
        ...entity,
        budgetSum: parseFloat(raw[idx].budgetSum),
      }));

      return results;
    } catch (error) {
      console.error(error);
      this.logger.error('Failed to fetch verify projects', error.stack);
      throw new InternalServerErrorException('Unable to fetch verify projects');
    }
  }

  async findVerifyLength(role: string, userId: string): Promise<number> {
    try {
      const workHistory = await this.workHistoryRepo.findOne({
        where: { user: { id: userId } },
        relations: ['user', 'responsibilities', 'responsibilities.amphoe'],
      });
      console.log(workHistory);
      if (!workHistory) {
        return 0;
      }
      const statusId = '30da8501-4487-49b7-8acf-ede14ca4ac09';
      // Subquery to get latest create_at for each group
      if (role === 'user') {
        const subQuery = this.projectGroupRepo
          .createQueryBuilder()
          .subQuery()
          .select('MAX(ts_sub.create_at)')
          .from('tracking_status', 'ts_sub')
          .where('ts_sub.project_group_id = group.id')
          .getQuery();

        const qb = this.projectGroupRepo
          .createQueryBuilder('group')
          .innerJoinAndSelect('group.trackingStatus', 'trackingStatus') // ✅ select all columns
          .innerJoinAndSelect('trackingStatus.status', 'status') // ✅ include status.name
          .innerJoinAndSelect(
            'trackingStatus.workHistory',
            'creatorWorkHistory',
          ) // 👈 this adds the creator
          .innerJoinAndSelect('creatorWorkHistory.user', 'creatorUser') // 👈 Load the user from workHistory
          .innerJoinAndSelect('group.workHistory', 'workHistory')
          .innerJoinAndSelect('workHistory.user', 'user')
          .innerJoinAndSelect(
            'workHistory.localAdministrativeOrganization',
            'localAdministrativeOrganization',
          )
          .innerJoinAndSelect('workHistory.amphoe', 'amphoe')

          .where(`"trackingStatus"."create_at" = (${subQuery})`)
          .andWhere(`"trackingStatus"."status_id" = :statusId`, { statusId })
          .andWhere(
            `"workHistory"."local_admistrative_organization_id" = :orgId`,
            { orgId: workHistory.localAdministrativeOrganization.id },
          );
        const result = await qb.getCount();
        return result;
      } else if (role === 'admin') {
        // const responsibleAmphoeIds = workHistory.responsibilities
        //   ?.map((r) => r.amphoe?.id)
        //   .filter((id) => !!id);

        // if (!responsibleAmphoeIds || responsibleAmphoeIds.length === 0) {
        //   return 0;
        // }

        const subQuery = this.projectGroupRepo
          .createQueryBuilder()
          .subQuery()
          .select('MAX(ts_sub.create_at)')
          .from('tracking_status', 'ts_sub')
          .where('ts_sub.project_group_id = group.id')
          .getQuery();

        const qb = this.projectGroupRepo
          .createQueryBuilder('group')
          .innerJoin('group.trackingStatus', 'trackingStatus')
          .innerJoin('group.workHistory', 'projectWorkHistory')
          .where(`"trackingStatus"."create_at" = (${subQuery})`)
          .andWhere(`"trackingStatus"."status_id" = :statusId`, { statusId })
          // .andWhere(`"projectWorkHistory"."amphoe_id" IN (:...amphoeIds)`, {
          //   amphoeIds: responsibleAmphoeIds,
          // });

        return await qb.getCount();
      } else {
        return 0;
      }
    } catch (error) {
      console.error(error);
      this.logger.error('Failed to count edit projects', error.stack);
      throw new InternalServerErrorException('Unable to count edit projects');
    }
  }


  async findApproveLength(): Promise<number> {
    try {
      const subQuery = this.projectGroupRepo
        .createQueryBuilder('subGroup')
        .subQuery()
        .select('MAX(ts."create_at")')
        .from('tracking_status', 'ts')
        .where('"ts"."project_group_id" = "group"."id"')
        .getQuery();

      const qb = this.projectGroupRepo
        .createQueryBuilder('group')
        .innerJoin('group.trackingStatus', 'trackingStatus')
        .innerJoin('trackingStatus.status', 'status')
        .where(`"trackingStatus"."create_at" = ${subQuery} AND "status"."name" = :name`, {
          name: 'อนุมัติโครงการ',
        });

      const count = await qb.getCount();
      return count;

    } catch (error) {
      console.error(error);
      this.logger.error('Failed to count edit projects', error.stack);
      throw new InternalServerErrorException('Unable to count edit projects');
    }
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
          workHistory: { id: workHistory.id },
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

  async findDeleteLength(): Promise<number> {
    try {
      const count = await this.projectGroupRepo
        .createQueryBuilder('group')
        .withDeleted()  // Include soft-deleted rows in the query
        .where('group.deletedAt IS NOT NULL')
        .getCount();

      return count;
    } catch (error) {
      this.logger.error('Failed to count deleted projects', error.stack);
      throw new InternalServerErrorException('Unable to count deleted projects');
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

  async findAll(): Promise<(ProjectGroup)[]> {
    try {
      // 1. สร้าง QueryBuilder
      const qb = this.projectGroupRepo
        .createQueryBuilder('group')

        // --- joins ---
        .leftJoinAndSelect('group.strategy', 'strategy')
        .leftJoinAndSelect('group.tactic', 'tactic')
        .leftJoinAndSelect('group.plan', 'plan')
        .leftJoinAndSelect('group.budgetPlanId', 'budgetPlan')
        .leftJoinAndSelect('group.projectType', 'projectType')
        .leftJoinAndSelect('group.workHistory', 'workHistory')
        .leftJoinAndSelect('workHistory.user', 'user')
        .leftJoinAndSelect('workHistory.amphoe', 'amphoe')
        .leftJoinAndSelect(
          'workHistory.localAdministrativeOrganization',
          'localAdministrativeOrganization',
        )

        // join budgets so we can sum them
        .leftJoinAndSelect('group.budgets', 'budgets')

        // join & sort trackingStatus
        .leftJoinAndSelect('group.trackingStatus', 'trackingStatus')
        .leftJoinAndSelect('trackingStatus.status', 'status')
        // ensure statuses are in date-desc order:
        .addOrderBy('trackingStatus.createAt', 'DESC')

        // 2. subquery to compute SUM(budgets.quantity)
        .addSelect(subQb =>
          subQb
            .select('COALESCE(SUM(b2.quantity), 0)', 'sum')
            .from(Budget, 'b2')
            .where('b2.projectGroup = group.id'),
          'budgetSum',
        )

        // 3. finally order the projects themselves
        .orderBy('group.createdAt', 'DESC');

      // 4. execute and pull out both raw+entities
      const { entities, raw } = await qb.getRawAndEntities();
      sendEmail(
        'skull.death1994@gmail.com',
        'แจ้งเตือนใหม่',
        'ข้อความแบบ text',
        '<b>ข้อความแบบ HTML</b>'
      );

      // 5. stamp the numeric budgetSum back onto each entity
      return entities.map((entity, idx) => ({
        ...entity,

      }));
    } catch (error) {
      this.logger.error(
        'Failed to fetch project groups with budgets and sum',
        error.stack,
      );
      throw new InternalServerErrorException(
        'Unable to fetch project groups',
      );
    }
  }

  async findOne(id: string): Promise<ProjectGroup> {
    try {
      const group = await this.projectGroupRepo
        .createQueryBuilder('group')
        .leftJoinAndSelect('group.strategy', 'strategy')
        .leftJoinAndSelect('group.tactic', 'tactic')
        .leftJoinAndSelect('group.plan', 'plan')
        .leftJoinAndSelect('group.budgetPlanId', 'budgetPlan')
        .leftJoinAndSelect('group.projectType', 'projectType')
        .leftJoinAndSelect('group.workHistory', 'workHistory')
        .leftJoinAndSelect('workHistory.user', 'user')
        .leftJoinAndSelect('workHistory.amphoe', 'amphoe')
        .leftJoinAndSelect('workHistory.localAdministrativeOrganization', 'localAdministrativeOrganization')
        .leftJoinAndSelect('group.budgets', 'budgets')
        .leftJoinAndSelect('group.trackingStatus', 'trackingStatus')
        .leftJoinAndSelect('trackingStatus.status', 'status')
        .leftJoinAndSelect('trackingStatus.workHistory', 'tsWorkHistory')
        .leftJoinAndSelect('tsWorkHistory.user', 'tsUser')
        .leftJoinAndSelect('trackingStatus.comments', 'comments')
        .where('group.id = :id', { id })
        .select([
          'group',
          'strategy.id', 'strategy.name',
          'tactic.id', 'tactic.name',
          'plan.id', 'plan.name',
          'budgetPlan.id', 'budgetPlan.name', 'budgetPlan.startYear', 'budgetPlan.endYear',
          'projectType.id', 'projectType.name',
          'workHistory.id', 'workHistory.divisionId', 'workHistory.divisionName',
          'amphoe.id', 'amphoe.name',
          'localAdministrativeOrganization.id', 'localAdministrativeOrganization.name',
          'user.id', 'user.firstname', 'user.lastname',
          'budgets',
          'trackingStatus.id', 'trackingStatus.comment', 'trackingStatus.createAt',
          'status.id', 'status.name', 'status.level',
          'tsWorkHistory', 'tsUser', 'comments'
        ])
        .getOne();

      if (!group) {
        throw new NotFoundException(`Project group ${id} not found`);
      }

      return group;
    } catch (error) {
      this.logger.error(`Failed to fetch project group ${id}`, error.stack);
      this.handleError(error);
    }
  }

  async update(id: string, dto: UpdateProjectGroupDto): Promise<ProjectGroup> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const requiredFields = [
        dto.title,
        dto.objective,
        dto.goal,
        dto.strategyId,
        dto.tacticId,
        dto.planId,
        dto.indicator,
        dto.expected,
        dto.startLat,
        dto.startLng,
      ];

      if (requiredFields.some(field => field === undefined || field === null)) {
        throw new BadRequestException('กรุณากรอกข้อมูลให้ครบถ้วน');
      }

      if (!Array.isArray(dto.budget) || dto.budget.length === 0) {
        throw new BadRequestException('กรุณาระบุงบประมาณอย่างน้อย 1 รายการ');
      }
      const group = await queryRunner.manager.findOne(this.projectGroupRepo.target, {
        where: { id },
        relations: ['budgets', 'strategy', 'tactic', 'plan'],
      });

      if (!group) {
        throw new NotFoundException(`Project group ${id} not found`);
      }

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
        responsibleOrgId: dto.responsibleOrgId === 0 ? undefined : dto.responsibleOrgId,
        strategy: { id: dto.strategyId } as Strategy,
        tactic: { id: dto.tacticId } as Tactic,
        plan: { id: dto.planId } as Plan,
      });
      await queryRunner.manager.save(group);

      // 🧹 ลบ budget เดิมทั้งหมด
      await queryRunner.manager.delete(this.budgetRepo.target, {
        projectGroup: group,
      });
      // ✅ Insert budget items
      if (!Array.isArray(dto.budget) || dto.budget.length === 0) {
        throw new BadRequestException('งบประมาณไม่ถูกต้องหรือไม่มีข้อมูล');
      }
      for (const item of dto.budget) {
        const budget = queryRunner.manager.create(this.budgetRepo.target, {
          projectGroup: { id: group.id },
          year: item.year,
          quantity: item.quantity,
        });
        await queryRunner.manager.save(budget);
      }
      await queryRunner.commitTransaction();
      return group!;
    } catch (error) {
      console.error('❌ Error in update:', error);
      await queryRunner.rollbackTransaction();
      this.logger.error(`Failed to update project group ${id}`, error.stack);
      throw error;
    } finally {
      await queryRunner.release();
    }
  }






  async remove(id: string): Promise<{ message: string }> {
    try {
      const group = await this.projectGroupRepo
        .createQueryBuilder('group')
        .leftJoinAndSelect('group.trackingStatus', 'trackingStatus')
        .leftJoinAndSelect('trackingStatus.status', 'status')
        .where('group.id = :id', { id })
        .orderBy('trackingStatus.createAt', 'DESC') // ensures latest status is first
        .getOne();

      if (!group) {
        throw new NotFoundException(`Project group ${id} not found`);
      }
      await this.projectGroupRepo.softRemove(group);
      return { message: `Project group ${id} has been removed successfully` };
    } catch (error) {
      this.logger.error(`Failed to remove project group ${id}`, error.stack);
      this.handleError(error);
    }
  }



  async softRemove(id: string): Promise<{ message: string }> {
    try {
      const group = await this.findOne(id);
      await this.projectGroupRepo.softRemove(group);
      return { message: `Project group ${id} has been soft removed successfully` };
    } catch (error) {
      this.logger.error(`Failed to remove project group ${id}`, error.stack);
      this.handleError(error);
    }
  }

  async restore(id: string): Promise<{ message: string }> {

    try {
      const group = await this.projectGroupRepo.findOne({
        where: { id },
        withDeleted: true,
      });

      if (!group) {
        throw new NotFoundException(`Project group ${id} not found`);
      }

      await this.projectGroupRepo.restore(id);
      return { message: `Project group ${id} has been restored successfully` };
    } catch (error) {
      this.logger.error(`Failed to restore project group ${id}`, error.stack);
      this.handleError(error);
    }

  }

  private async ensureNameIsUnique(title: string, excludeId?: string) {
    const existing = await this.projectGroupRepo.findOne({ where: { title } });
    if (existing && existing.id !== excludeId) {
      throw new ConflictException('Project group with this title already exists');
    }
  }

  private handleError(error: any): never {
    if (
      error instanceof ConflictException ||
      error instanceof NotFoundException ||
      error instanceof BadRequestException
    ) {
      throw error; // ✅ Don't swallow the actual error
    }

    // Optional: log raw error if needed
    this.logger.error('Unexpected error:', error);

    throw new InternalServerErrorException('Unexpected error occurred');
  }

}
