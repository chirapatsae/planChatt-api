import {
  Injectable,
  NotFoundException,
  Logger,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
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
  ) { }

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
        // Validate foreign keys
        const [
          developmentPlanRevision,
          projectGroup,
          strategy,
          tactic,
          plan,
          workHistory,
        ] = await this.validateForeignKeys(manager, dto, userId);

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

        // Get responsibleAgency if provided (required field)
        const responsibleAgency = dto.responsibleAgency
          ? await manager.findOne(GovernmentAgency, {
            where: { id: dto.responsibleAgency },
          })
          : null;
        if (!responsibleAgency) {
          throw new NotFoundException(
            `ResponsibleAgency (GovernmentAgency) ID is required and not found: ${dto.responsibleAgency}`,
          );
        }

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
          indicator: dto.indicator,
          expected: dto.expected,
          projectYear: dto.projectYear,
          strategy,
          tactic,
          plan,
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
          });
          await manager.save(trackingStatus);
        }
        if (developmentPlanRevision.revisionType.name === 'เปลี่ยนแปลง') {
          const trackingStatus = manager.create(TrackingStatus, {
            revisedProjectGroupId: savedProject,
            statusId: { id: '96be5646-cd55-4542-ae92-b82b2935167e' } as any,
            createdBy: workHistory,
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
   * ดึง RevisedProjectGroup ตาม ID
   */
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

  /**
   * อัพเดท RevisedProjectGroup
   */
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

        // Update responsibleAgency if provided
        if (dto.responsibleAgency !== undefined) {
          const responsibleAgency = await manager.findOne(GovernmentAgency, {
            where: { id: dto.responsibleAgency },
          });
          if (!responsibleAgency) {
            throw new NotFoundException(
              `GovernmentAgency ID not found: ${dto.responsibleAgency}`,
            );
          }
          revisedProject.responsibleAgency = responsibleAgency;
        }

        // Update originAgencyId if provided
        if (dto.originAgencyId !== undefined) {
          if (dto.originAgencyId) {
            const originAgency = await manager.findOne(
              LocalAdministrativeOrganization,
              {
                where: { id: dto.originAgencyId },
              },
            );
            if (!originAgency) {
              throw new NotFoundException(
                `LocalAdministrativeOrganization ID not found: ${dto.originAgencyId}`,
              );
            }
            revisedProject.originAgencyId = originAgency;
          } else {
            revisedProject.originAgencyId = null as any; // Entity has nullable: true
          }
        }

        // Update developmentPlan if provided
        if (dto.developmentPlanId !== undefined) {
          if (dto.developmentPlanId) {
            const developmentPlan = await manager.findOne(DevelopmentPlan, {
              where: { id: dto.developmentPlanId },
            });
            if (!developmentPlan) {
              throw new NotFoundException(
                `DevelopmentPlan ID not found: ${dto.developmentPlanId}`,
              );
            }
            revisedProject.developmentPlan = developmentPlan;
          } else {
            revisedProject.developmentPlan = undefined;
          }
        }

        // Update amphoe if provided
        if (dto.amphoeId !== undefined) {
          if (dto.amphoeId) {
            const amphoe = await manager.findOne(Amphoe, {
              where: { id: dto.amphoeId },
            });
            if (!amphoe) {
              throw new NotFoundException(`Amphoe ID not found: ${dto.amphoeId}`);
            }
            revisedProject.amphoe = amphoe;
          } else {
            revisedProject.amphoe = undefined;
          }
        }

        // Update localAdministrativeOrganization if provided
        if (dto.localAdministrativeOrganizationId !== undefined) {
          if (dto.localAdministrativeOrganizationId) {
            const localAdministrativeOrganization = await manager.findOne(
              LocalAdministrativeOrganization,
              {
                where: { id: dto.localAdministrativeOrganizationId },
              },
            );
            if (!localAdministrativeOrganization) {
              throw new NotFoundException(
                `LocalAdministrativeOrganization ID not found: ${dto.localAdministrativeOrganizationId}`,
              );
            }
            revisedProject.localAdministrativeOrganization =
              localAdministrativeOrganization;
          } else {
            revisedProject.localAdministrativeOrganization = undefined;
          }
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

  /**
   * ลบ RevisedProjectGroup แบบ soft delete
   */
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
        .leftJoinAndSelect('rpg.amphoe', 'amphoe')
        .leftJoinAndSelect('rpg.localAdministrativeOrganization', 'localAdministrativeOrganization')
        .leftJoinAndSelect('rpg.originAgencyId', 'originAgency')
        .leftJoinAndSelect('rpg.responsibleAgency', 'responsibleAgency')
        .leftJoinAndSelect('rpg.budgets', 'budgets')
        .leftJoinAndSelect('rpg.trackingStatus', 'trackingStatus')
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
          } else {
            query.andWhere('1 = 0'); // Always false condition
          }
        }
      }

      if (countOnly) {
        const count = await query.getCount();
        return count;
      }

      return await query.orderBy('rpg.created_at', 'DESC').getMany();
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
        .leftJoinAndSelect('rpg.trackingStatus', 'trackingStatus')
        .leftJoinAndSelect('trackingStatus.statusId', 'status')
        .leftJoinAndSelect('trackingStatus.createdBy', 'trackingStatusCreatedBy')
        .leftJoinAndSelect('trackingStatusCreatedBy.user', 'trackingStatusCreatedByUser')
        .where('rt.name = :revisionTypeName', { revisionTypeName: 'แก้ไข' })
        .andWhere('trackingStatus.isLatest = :isLatest', { isLatest: true })
        .andWhere('status.name = :statusName', { statusName: 'Verified' })
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

      return await query.orderBy('rpg.created_at', 'DESC').getMany();
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
        .leftJoinAndSelect('rpg.trackingStatus', 'trackingStatus')
        .leftJoinAndSelect('trackingStatus.statusId', 'status')
        .leftJoinAndSelect('trackingStatus.createdBy', 'trackingStatusCreatedBy')
        .leftJoinAndSelect('trackingStatusCreatedBy.user', 'trackingStatusCreatedByUser')
        .where('rt.name = :revisionTypeName', { revisionTypeName: 'แก้ไข' })
        .andWhere('trackingStatus.isLatest = :isLatest', { isLatest: true })
        .andWhere('status.name = :statusName', { statusName: 'Pending_Approval' })
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

      return await query.orderBy('rpg.created_at', 'DESC').getMany();
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
        .leftJoinAndSelect('rpg.trackingStatus', 'trackingStatus')
        .leftJoinAndSelect('trackingStatus.statusId', 'status')
        .leftJoinAndSelect('trackingStatus.createdBy', 'trackingStatusCreatedBy')
        .leftJoinAndSelect('trackingStatusCreatedBy.user', 'trackingStatusCreatedByUser')
        .where('rt.name = :revisionTypeName', { revisionTypeName: 'แก้ไข' })
        .andWhere('trackingStatus.isLatest = :isLatest', { isLatest: true })
        .andWhere('status.name = :statusName', { statusName: 'Approved' })
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

      return await query.orderBy('rpg.created_at', 'DESC').getMany();
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

      return await query.orderBy('rpg.created_at', 'DESC').getMany();
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
        .leftJoinAndSelect('rpg.trackingStatus', 'trackingStatus')
        .leftJoinAndSelect('trackingStatus.statusId', 'status')
        .leftJoinAndSelect('trackingStatus.createdBy', 'trackingStatusCreatedBy')
        .leftJoinAndSelect('trackingStatusCreatedBy.user', 'trackingStatusCreatedByUser')
        .where('rt.name = :revisionTypeName', { revisionTypeName: 'เปลี่ยนแปลง' })
        .andWhere('trackingStatus.isLatest = :isLatest', { isLatest: true })
        .andWhere('status.name = :statusName', { statusName: 'Verified' })
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

      return await query.orderBy('rpg.created_at', 'DESC').getMany();
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
        .leftJoinAndSelect('rpg.trackingStatus', 'trackingStatus')
        .leftJoinAndSelect('trackingStatus.statusId', 'status')
        .leftJoinAndSelect('trackingStatus.createdBy', 'trackingStatusCreatedBy')
        .leftJoinAndSelect('trackingStatusCreatedBy.user', 'trackingStatusCreatedByUser')
        .where('rt.name = :revisionTypeName', { revisionTypeName: 'เปลี่ยนแปลง' })
        .andWhere('trackingStatus.isLatest = :isLatest', { isLatest: true })
        .andWhere('status.name = :statusName', { statusName: 'Pending_Approval' })
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

      return await query.orderBy('rpg.created_at', 'DESC').getMany();
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
        .leftJoinAndSelect('rpg.trackingStatus', 'trackingStatus')
        .leftJoinAndSelect('trackingStatus.statusId', 'status')
        .leftJoinAndSelect('trackingStatus.createdBy', 'trackingStatusCreatedBy')
        .leftJoinAndSelect('trackingStatusCreatedBy.user', 'trackingStatusCreatedByUser')
        .where('rt.name = :revisionTypeName', { revisionTypeName: 'เปลี่ยนแปลง' })
        .andWhere('trackingStatus.isLatest = :isLatest', { isLatest: true })
        .andWhere('status.name = :statusName', { statusName: 'Approved' })
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

      return await query.orderBy('rpg.created_at', 'DESC').getMany();
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
        relations: ['developmentPlan', 'revisionType'],
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
    if (!strategy) {
      throw new NotFoundException(`Strategy ID is required and not found: ${dto.strategyId}`);
    }
    if (!tactic) {
      throw new NotFoundException(`Tactic ID is required and not found: ${dto.tacticId}`);
    }
    if (!plan) {
      throw new NotFoundException(`Plan ID is required and not found: ${dto.planId}`);
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

  /**
   * คำนวณว่าเป็น "แก้ไขครั้งที่" หรือ "เปลี่ยนแปลงครั้งที่" เท่าไหร่
   * โดยนับจำนวน revision ไม่จำเป็นต้อง type เดียวกัน
   */
  private async calculateRevisionOccurrence(
    developmentPlanId: string,
    currentRevisionNumber: number,
  ): Promise<DevelopmentPlanRevision[]> {
    // ดึง revisions ทั้งหมดที่มี revisionNumber น้อยกว่า (ไม่จำกัด type)
    const previousRevisions = await this.developmentPlanRevisionRepo
      .createQueryBuilder('dpr')
      .where('dpr.development_plan_id = :developmentPlanId', { developmentPlanId })
      .andWhere('dpr.revision_number < :currentRevisionNumber', {
        currentRevisionNumber,
      }).getMany();

    // ครั้งที่ = จำนวนครั้งก่อนหน้า + 1
    return previousRevisions;
  }
}
