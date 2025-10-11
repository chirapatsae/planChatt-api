import {
  Injectable,
  NotFoundException,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { CreateRevisedProjectGroupDto } from './dto/create-revised-project-group.dto';
import { UpdateRevisedProjectGroupDto } from './dto/update-revised-project-group.dto';
import { RevisedProjectGroup } from './entities/revised-project-group.entity';
import { DevelopmentPlanRevision } from 'src/development-plan-revision/entities/development-plan-revision.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { BudgetPlan } from 'src/budget_plan/entities/budget_plan.entity';
import { Strategy } from 'src/strategy/entities/strategy.entity';
import { Tactic } from 'src/tactic/entities/tactic.entity';
import { Plan } from 'src/plan/entities/plan.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { Budget } from 'src/budget/entities/budget.entity';
import { handleException } from 'src/util/handleException';
import { TrackingStatus } from 'src/tracking-status/entities/tracking-status.entity';

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

    @InjectRepository(BudgetPlan)
    private readonly budgetPlanRepo: Repository<BudgetPlan>,

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
  ) { }

  async create(
    dto: CreateRevisedProjectGroupDto,
    userId: string,
  ): Promise<RevisedProjectGroup> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        // Validate foreign keys
        const [
          developmentPlanRevision,
          projectGroup,
          strategy,
          tactic,
          plan,
          workHistory,
        ] = await this.validateForeignKeys(manager, dto, userId);

        const budgetPlan = developmentPlanRevision.budgetPlan;

        // Set isLatest = false for all previous revised projects of the same projectGroup
        if (projectGroup) {
          await manager.update(
            RevisedProjectGroup,
            { projectGroup: { id: projectGroup.id }, isLatest: true },
            { isLatest: false },
          );
        }

        // Create revised project group (isLatest = true by default)
        const revisedProjectGroup = manager.create(RevisedProjectGroup, {
          developmentPlanRevision,
          projectGroup,
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
          strategy,
          tactic,
          plan,
          createdBy: workHistory,
          responsibleBy: workHistory,
          additionalDetail: dto.additionalDetail,
          isLatest: true, // Set as latest version
        });

        const savedProject = await manager.save(revisedProjectGroup);

        // Create tracking status for revision type "แก้ไข"
        if (developmentPlanRevision.revisionType.name === 'แก้ไข') {
          const trackingStatus = manager.create(TrackingStatus, {
            revisedProjectGroupId: savedProject,
            statusId: { id: '09b37525-31db-49f8-92be-7c8a14392ae1' } as any,
            createdBy: workHistory,
          });
          await manager.save(trackingStatus);
        }
        if (developmentPlanRevision.revisionType.name === 'เปลี่ยนแปลง') {
          const trackingStatus = manager.create(TrackingStatus, {
            revisedProjectGroupId: savedProject,
            statusId: { id: 'ac6275f0-0491-4cfe-86e7-307ed21a62a9' } as any,
            createdBy: workHistory,
          });
          await manager.save(trackingStatus);
        }

        // Create budgets if provided
        if (dto.budget && dto.budget.length > 0) {
          // Validate budget year is within budget plan range
          for (const budgetItem of dto.budget) {
            if (
              budgetItem.year < budgetPlan.startYear ||
              budgetItem.year > budgetPlan.endYear
            ) {
              throw new BadRequestException(
                `ปีงบประมาณต้องอยู่ในช่วง พ.ศ. ${budgetPlan.startYear} - ${budgetPlan.endYear} (ปีที่ส่งมา: ${budgetItem.year})`,
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
          'responsibleBy',
          'budgets',
        ],
        order: { createdAt: 'DESC' },
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

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
          'responsibleBy',
          'budgets',
        ],
        order: { createdAt: 'DESC' },
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findOne(id: string): Promise<RevisedProjectGroup> {
    try {
      const revisedProject = await this.revisedProjectGroupRepo.findOne({
        where: { id },
        relations: [
          'developmentPlanRevision',
          'projectGroup',
          // budgetPlan is derived via developmentPlanRevision
          'strategy',
          'tactic',
          'plan',
          'createdBy',
          'responsibleBy',
          'budgets',
          'trackingStatus',
          'trackingStatus.statusId',
          'trackingStatus.createdBy',
          'trackingStatus.createdBy.user',
        ],
      });

      if (!revisedProject) {
        this.logger.warn(`RevisedProjectGroup not found: ${id}`);
        throw new NotFoundException(
          `RevisedProjectGroup with id ${id} not found`,
        );
      }

      return revisedProject;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async update(
    id: string,
    dto: UpdateRevisedProjectGroupDto,
  ): Promise<RevisedProjectGroup> {
    try {
      const revisedProject = await this.findOne(id);

      return await this.dataSource.transaction(async (manager) => {
        // Update foreign keys if provided
        if (dto.developmentPlanRevisionId) {
          const revision = await manager.findOne(DevelopmentPlanRevision, {
            where: { id: dto.developmentPlanRevisionId },
          });
          if (!revision) {
            throw new NotFoundException(
              `DevelopmentPlanRevision not found: ${dto.developmentPlanRevisionId}`,
            );
          }
          revisedProject.developmentPlanRevision = revision;
        }

        if (dto.projectGroupId !== undefined) {
          if (dto.projectGroupId) {
            const projectGroup = await manager.findOne(ProjectGroup, {
              where: { id: dto.projectGroupId },
            });
            if (!projectGroup) {
              throw new NotFoundException(
                `ProjectGroup not found: ${dto.projectGroupId}`,
              );
            }
            revisedProject.projectGroup = projectGroup;
          } else {
            revisedProject.projectGroup = null;
          }
        }

        // budgetPlan is no longer updated directly; it follows developmentPlanRevision

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
          isDraft: dto.isDraft ?? revisedProject.isDraft,
          additionalDetail: dto.additionalDetail ?? revisedProject.additionalDetail,
        });

        return await manager.save(revisedProject);
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async remove(id: string): Promise<{ message: string }> {
    try {
      const result = await this.revisedProjectGroupRepo.delete(id);
      if (result.affected === 0) {
        throw new NotFoundException(
          `RevisedProjectGroup with ID ${id} not found`,
        );
      }
      return {
        message: `RevisedProjectGroup with ID ${id} has been permanently removed.`,
      };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async softRemove(id: string): Promise<{ message: string }> {
    try {
      const result = await this.revisedProjectGroupRepo.softDelete(id);
      if (result.affected === 0) {
        throw new NotFoundException(
          `RevisedProjectGroup with ID ${id} not found`,
        );
      }
      return {
        message: `RevisedProjectGroup with ID ${id} has been soft-removed.`,
      };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

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
        .leftJoinAndSelect('dpr.budgetPlan', 'bp')
        .leftJoinAndSelect('rpg.projectGroup', 'pg')
        .leftJoinAndSelect('rpg.strategy', 'strategy')
        .leftJoinAndSelect('rpg.tactic', 'tactic')
        .leftJoinAndSelect('rpg.plan', 'plan')
        .leftJoinAndSelect('rpg.createdBy', 'createdBy')
        .leftJoinAndSelect('createdBy.user', 'createdByUser')
        .leftJoinAndSelect('rpg.responsibleBy', 'responsibleBy')
        .leftJoinAndSelect('responsibleBy.user', 'responsibleByUser')
        .leftJoinAndSelect('rpg.budgets', 'budgets')
        .leftJoinAndSelect('rpg.trackingStatus', 'trackingStatus')
        .leftJoinAndSelect('trackingStatus.statusId', 'statusId')
        .leftJoinAndSelect('trackingStatus.createdBy', 'trackingStatusCreatedBy')
        .leftJoinAndSelect('trackingStatusCreatedBy.user', 'trackingStatusCreatedByUser')
        .leftJoinAndSelect('rpg.originAgencyId', 'originAgency')
        .leftJoinAndSelect('rpg.responsibleAgency', 'responsibleAgency')
        .where('dpr.is_latest = :isLatest', { isLatest: true })
        .orderBy('rpg.created_at', 'DESC')
        .getMany();
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * คำนวณว่าเป็น "แก้ไขครั้งที่" หรือ "เปลี่ยนแปลงครั้งที่" เท่าไหร่
   * โดยนับจำนวน revision ก่อนหน้าที่เป็น type เดียวกัน
   */
  private async calculateRevisionOccurrence(
    budgetPlanId: string,
    currentRevisionNumber: number,
    revisionTypeName: string,
  ): Promise<number> {
    // ดึง revisions ทั้งหมดที่มี revisionNumber น้อยกว่า และเป็น type เดียวกัน
    const previousRevisionsOfSameType = await this.developmentPlanRevisionRepo
      .createQueryBuilder('dpr')
      .leftJoin('dpr.revisionType', 'rt')
      .where('dpr.budget_plan_id = :budgetPlanId', { budgetPlanId })
      .andWhere('dpr.revision_number < :currentRevisionNumber', {
        currentRevisionNumber,
      })
      .andWhere('rt.name = :revisionTypeName', { revisionTypeName })
      .getCount();

    // ครั้งที่ = จำนวนครั้งก่อนหน้า + 1
    return previousRevisionsOfSameType + 1;
  }

  /**
   * แสดงรายละเอียดโครงการพร้อมเปรียบเทียบข้อมูลเดิม
   * - ถ้า revisionNumber = 1 → เทียบกับ ProjectGroup (เล่มแม่)
   * - ถ้า revisionNumber > 1 → เทียบกับ RevisedProjectGroup จาก revision ก่อนหน้า (ไม่ว่า type จะเหมือนกันหรือไม่)
   */
  async findProjectComparison(id: string): Promise<{
    current: RevisedProjectGroup;
    previous: ProjectGroup | RevisedProjectGroup | null;
    comparisonType: 'original' | 'revised' | 'new';
    revisionInfo: {
      revisionNumber: number;
      revisionTypeName: string;
      occurrence: number; // แก้ไขครั้งที่ X หรือ เปลี่ยนแปลงครั้งที่ X
      displayName: string; // "แผนพัฒนาแก้ไขครั้งที่ 1"
    };
  }> {
    try {
      // ดึงข้อมูลโครงการปัจจุบัน
      const current = await this.revisedProjectGroupRepo.findOne({
        where: { id },
        relations: [
          'developmentPlanRevision',
          'developmentPlanRevision.revisionType',
          'developmentPlanRevision.budgetPlan',
          'projectGroup',
          'strategy',
          'tactic',
          'plan',
          'createdBy',
          'createdBy.user',
          'responsibleBy',
          'responsibleBy.user',
          'budgets',
          'trackingStatus',
          'trackingStatus.statusId',
          'trackingStatus.createdBy',
          'trackingStatus.createdBy.user',
          'originAgencyId',
          'responsibleAgency',
        ],
      });

      if (!current) {
        throw new NotFoundException(
          `RevisedProjectGroup with id ${id} not found`,
        );
      }

      let previous: ProjectGroup | RevisedProjectGroup | null = null;
      let comparisonType: 'original' | 'revised' | 'new' = 'new';

      const currentRevisionNumber =
        current.developmentPlanRevision.revisionNumber;
      const revisionTypeName = current.developmentPlanRevision.revisionType.name;
      const budgetPlanId = current.developmentPlanRevision.budgetPlan.id;

      // คำนวณว่าเป็นครั้งที่เท่าไหร่ (แก้ไขครั้งที่ X หรือ เปลี่ยนแปลงครั้งที่ X)
      const occurrence = await this.calculateRevisionOccurrence(
        budgetPlanId,
        currentRevisionNumber,
        revisionTypeName,
      );

      // สร้าง displayName
      const displayName = `แผนพัฒนา${revisionTypeName}ครั้งที่ ${occurrence}`;

      // ถ้ามี projectGroupId = เป็นการแก้ไข/เปลี่ยนแปลงโครงการเดิม
      if (current.projectGroup) {
        // ถ้า revisionNumber = 1 → เทียบกับเล่มแม่ (ProjectGroup)
        if (currentRevisionNumber === 1) {
          previous = await this.projectGroupRepo.findOne({
            where: { id: current.projectGroup.id },
            relations: [
              'budgetPlan',
              'strategy',
              'tactic',
              'plan',
              'createdBy',
              'createdBy.user',
              'responsibleBy',
              'responsibleBy.user',
              'budgets',
              'trackingStatus',
              'trackingStatus.statusId',
              'trackingStatus.createdBy',
              'trackingStatus.createdBy.user',
              'originAgencyId',
              'responsibleAgency',
            ],
          });
          comparisonType = 'original';
        }
        // ถ้า revisionNumber > 1 → เทียบกับ RevisedProjectGroup จาก revision ก่อนหน้า (revisionNumber - 1)
        else if (currentRevisionNumber > 1) {
          // ค้นหา revision ก่อนหน้า (revisionNumber - 1) ของโครงการเดิม
          const previousRevision = await this.developmentPlanRevisionRepo.findOne(
            {
              where: {
                budgetPlan: {
                  id: budgetPlanId,
                },
                revisionNumber: currentRevisionNumber - 1,
              },
            },
          );

          if (previousRevision) {
            // ค้นหา RevisedProjectGroup ที่เชื่อมกับ revision ก่อนหน้า และ projectGroup เดียวกัน
            previous = await this.revisedProjectGroupRepo.findOne({
              where: {
                developmentPlanRevision: { id: previousRevision.id },
                projectGroup: { id: current.projectGroup.id },
              },
              relations: [
                'developmentPlanRevision',
                'developmentPlanRevision.revisionType',
                'developmentPlanRevision.budgetPlan',
                'projectGroup',
                'strategy',
                'tactic',
                'plan',
                'createdBy',
                'createdBy.user',
                'responsibleBy',
                'responsibleBy.user',
                'budgets',
                'trackingStatus',
                'trackingStatus.statusId',
                'trackingStatus.createdBy',
                'trackingStatus.createdBy.user',
                'originAgencyId',
                'responsibleAgency',
              ],
            });
          }
          comparisonType = 'revised';
        }
      }

      return {
        current,
        previous,
        comparisonType,
        revisionInfo: {
          revisionNumber: currentRevisionNumber,
          revisionTypeName,
          occurrence,
          displayName,
        },
      };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  private async validateForeignKeys(
    manager,
    dto: CreateRevisedProjectGroupDto,
    userId: string,
  ): Promise<
    [
      DevelopmentPlanRevision,
      ProjectGroup | null,
      Strategy,
      Tactic,
      Plan,
      WorkHistory,
    ]
  > {
    const [
      developmentPlanRevision,
      projectGroup,
      strategy,
      tactic,
      plan,
    ] = await Promise.all([
      manager.findOne(DevelopmentPlanRevision, {
        where: { id: dto.developmentPlanRevisionId },
        relations: ['budgetPlan', 'revisionType'],
      }),
      dto.projectGroupId
        ? manager.findOne(ProjectGroup, { where: { id: dto.projectGroupId } })
        : null,
      dto.strategyId
        ? manager.findOne(Strategy, { where: { id: dto.strategyId } })
        : null,
      dto.tacticId
        ? manager.findOne(Tactic, { where: { id: dto.tacticId } })
        : null,
      dto.planId ? manager.findOne(Plan, { where: { id: dto.planId } }) : null,
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
    // budgetPlan is obtained from developmentPlanRevision
    if (dto.strategyId && !strategy) {
      throw new NotFoundException(`Strategy ID not found: ${dto.strategyId}`);
    }
    if (dto.tacticId && !tactic) {
      throw new NotFoundException(`Tactic ID not found: ${dto.tacticId}`);
    }
    if (dto.planId && !plan) {
      throw new NotFoundException(`Plan ID not found: ${dto.planId}`);
    }

    const workHistory = await manager.findOne(WorkHistory, {
      where: { user: { id: userId } },
    });
    if (!workHistory) {
      throw new NotFoundException('Work history not found for this user');
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
}
