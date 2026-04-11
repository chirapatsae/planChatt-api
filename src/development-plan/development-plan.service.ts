import { Budget } from './../budget/entities/budget.entity';
import {
  Injectable,
  NotFoundException,
  InternalServerErrorException,
  Logger,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Not, Repository, In, IsNull, EntityManager } from 'typeorm';
import { DevelopmentPlan } from './entities/development-plan.entity';
import { CreateDevelopmentPlanDto } from './dto/create-development-plan.dto';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { handleException } from 'src/util/handleException';
import { UpdateDevelopmentPlanDto } from './dto/update-development-plan.dto';
import { PdfService } from 'src/pdf/pdf.service';
import { ProjectGroupsService } from 'src/project-groups/project-groups.service';
import { WebsocketService } from 'src/websocket/websocket/websocket.service';
import { PlanPhase, PhaseType } from 'src/plan-phase/entities/plan-phase.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';
import { UnifiedProjectMapper } from 'src/project-groups/dto/unified-project-display.dto';
import { DevelopmentPlanRevision } from 'src/development-plan-revision/entities/development-plan-revision.entity';
import { DevelopmentPlanSupplement } from 'src/development-plan-supplement/entities/development-plan-supplement.entity';
import { CreateDevelopmentPlanWithPhaseDto } from './dto/create-development-plan-with-phase.dto';
import { UpdateDevelopmentPlanWithPhasesDto } from './dto/update-development-plan-with-phase.dto';
import { UpdateDevelopmentPlanLatestStatusDto } from './dto/update-development-plan-latest-status.dto';
import { UsersService } from 'src/users/users.service';
import { BookLockService } from 'src/common/book-lock/book-lock.service';

@Injectable()
export class DevelopmentPlanService {
  private readonly logger = new Logger(DevelopmentPlanService.name);

  constructor(
    @InjectRepository(DevelopmentPlan)
    private readonly developmentPlanRepository: Repository<DevelopmentPlan>,

    @InjectRepository(WorkHistory)
    private readonly workHistoryRepository: Repository<WorkHistory>,

    @InjectRepository(PlanPhase)
    private readonly planPhaseRepository: Repository<PlanPhase>,

    @InjectRepository(ProjectGroup)
    private readonly projectGroupRepository: Repository<ProjectGroup>,

    @InjectRepository(RevisedProjectGroup)
    private readonly revisedProjectGroupRepository: Repository<RevisedProjectGroup>,

    @InjectRepository(DevelopmentPlanRevision)
    private readonly developmentPlanRevisionRepository: Repository<DevelopmentPlanRevision>,

    @InjectRepository(DevelopmentPlanSupplement)
    private readonly developmentPlanSupplementRepository: Repository<DevelopmentPlanSupplement>,

    private readonly dataSource: DataSource,
    private readonly pdfService: PdfService,
    private readonly projectGroupsService: ProjectGroupsService,
    private readonly websocketService: WebsocketService,
    private readonly usersService: UsersService,
    private readonly bookLockService: BookLockService,
  ) { }

  private async validatePreviousPlanCompletion(manager: EntityManager): Promise<void> {
    const developmentPlanRepository = manager.getRepository(DevelopmentPlan);
    const planPhaseRepository = manager.getRepository(PlanPhase);
    const developmentPlanRevisionRepository = manager.getRepository(DevelopmentPlanRevision);
    const developmentPlanSupplementRepository = manager.getRepository(DevelopmentPlanSupplement);

    const latestPlan = await developmentPlanRepository.findOne({
      where: { isLatest: true },
    });

    if (latestPlan) {
      if (!latestPlan.isBooked) {
        throw new BadRequestException('ไม่สามารถสร้างแผนพัฒนาฉบับใหม่ได้ เนื่องจากแผนพัฒนาฉบับล่าสุดยังไม่ได้จัดทำรูปเล่ม (Booked)');
      }

      const openPhasesCount = await planPhaseRepository.count({
        where: { developmentPlan: { id: latestPlan.id }, isOpen: true },
      });
      if (openPhasesCount > 0) {
        throw new BadRequestException('ไม่สามารถสร้างแผนพัฒนาฉบับใหม่ได้ เนื่องจากยังมีห้วงเวลา (Phase) ของแผนล่าสุดที่เปิดรับข้อมูลอยู่');
      }

      const uncompletedRevisionsCount = await developmentPlanRevisionRepository.count({
        where: [
          { developmentPlan: { id: latestPlan.id }, isOpen: true },
          { developmentPlan: { id: latestPlan.id }, isBooked: false }
        ]
      });
      if (uncompletedRevisionsCount > 0) {
        throw new BadRequestException('ไม่สามารถสร้างแผนพัฒนาฉบับใหม่ได้ เนื่องจากยังมีรายการขอเปลี่ยนแปลง/แก้ไขของแผนล่าสุดที่ยังเปิดอยู่ หรือ ยังไม่ได้จัดทำรูปเล่ม');
      }

      const uncompletedSupplementsCount = await developmentPlanSupplementRepository.count({
        where: [
          { developmentPlan: { id: latestPlan.id }, isOpen: true },
          { developmentPlan: { id: latestPlan.id }, isBooked: false }
        ]
      });
      if (uncompletedSupplementsCount > 0) {
        throw new BadRequestException('ไม่สามารถสร้างแผนพัฒนาฉบับใหม่ได้ เนื่องจากยังมีรายการขอเพิ่มเติมของแผนล่าสุดที่ยังเปิดอยู่ หรือ ยังไม่ได้จัดทำรูปเล่ม');
      }
    }
  }

  async create(dto: CreateDevelopmentPlanDto, userId: string): Promise<DevelopmentPlan> {
    try {
      const { name, startYear, endYear } = dto;

      const workHistory = await this.workHistoryRepository.findOne({
        where: { user: { id: userId }, workStatus: { name: 'approved' } },
      });
      if (!workHistory)
        throw new NotFoundException('Work history not found for this user');

      if (startYear >= endYear) {
        throw new BadRequestException('Start year must be less than end year');
      }

      return await this.dataSource.transaction(async (manager) => {
        await this.validatePreviousPlanCompletion(manager);

        const existingPlans = await manager.find(DevelopmentPlan);

        const isExactDuplicate = existingPlans.some(
          (plan) => plan.startYear === startYear && plan.endYear === endYear,
        );
        if (isExactDuplicate) {
          throw new BadRequestException('แผนพัฒนาช่วงปีนี้มีอยู่แล้ว');
        }

        const isOverlapping = existingPlans.some((plan) => {
          return (
            (startYear >= plan.startYear && startYear <= plan.endYear) ||
            (endYear >= plan.startYear && endYear <= plan.endYear) ||
            (startYear <= plan.startYear && endYear >= plan.endYear)
          );
        });
        if (isOverlapping) {
          throw new BadRequestException(
            'ช่วงปีนี้ซ้อนกับแผนพัฒนาที่มีอยู่แล้ว',
          );
        }

        await manager.update(
          DevelopmentPlan,
          { isLatest: true },
          { isLatest: false },
        );

        const newDevelopmentPlan = manager.create(DevelopmentPlan, {
          name,
          startYear,
          endYear,
          isLatest: true,
          isBooked: dto.isBooked ?? false,
          createdBy: { id: workHistory.id },
        });

        return await manager.save(newDevelopmentPlan);
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async createWithPhase(
    dto: CreateDevelopmentPlanWithPhaseDto,
    userId: string,
  ): Promise<{ developmentPlan: DevelopmentPlan; planPhases: PlanPhase[] }> {
    try {
      const { developmentPlan: developmentPlanDto, planPhases } = dto;

      if (!developmentPlanDto || !planPhases || planPhases.length === 0) {
        throw new BadRequestException('ข้อมูล developmentPlan หรือ planPhases ไม่ครบถ้วน');
      }
      const { name, startYear, endYear } = developmentPlanDto;

      const workHistory = await this.workHistoryRepository.findOne({
        where: { user: { id: userId }, workStatus: { name: 'approved' } },
      });
      if (!workHistory) {
        throw new NotFoundException('Work history not found for this user');
      }

      if (startYear >= endYear) {
        throw new BadRequestException('Start year must be less than end year');
      }

      const parsedPlanPhases = planPhases.map((planPhaseDto, index) => {
        const openDate = planPhaseDto.openDate ? new Date(planPhaseDto.openDate) : undefined;
        const closeDate = planPhaseDto.closeDate ? new Date(planPhaseDto.closeDate) : undefined;

        if (!openDate || Number.isNaN(openDate.getTime())) {
          throw new BadRequestException(`รูปแบบวันที่เปิดไม่ถูกต้อง (รายการที่ ${index + 1})`);
        }

        if (!closeDate || Number.isNaN(closeDate.getTime())) {
          throw new BadRequestException(`รูปแบบวันที่ปิดไม่ถูกต้อง (รายการที่ ${index + 1})`);
        }

        if (openDate > closeDate) {
          throw new BadRequestException(`วันที่เปิดต้องน้อยกว่าวันที่ปิด (รายการที่ ${index + 1})`);
        }

        return {
          openDate,
          closeDate,
          phaseType: planPhaseDto.phaseType as PhaseType,
          isMerged: planPhaseDto.isMerged ?? false,
          isOpen: planPhaseDto.isOpen ?? false,
        };
      });

      const phaseTypes = [...new Set(parsedPlanPhases.map(p => p.phaseType))];
      for (const type of phaseTypes) {
        const openPhases = parsedPlanPhases.filter(p => p.phaseType === type && p.isOpen);
        if (openPhases.length > 1) {
          throw new BadRequestException(`ประเภทแผน ${type} ไม่สามารถเปิดพร้อมกันได้เกิน 1 รอบ`);
        }
      }

      // ตรวจสอบเวลาในรายการที่ส่งมาเองไม่ให้ซ้อนกัน หาก phase type เดียวกัน
      const phasesByType = new Map<string, { openDate: Date; closeDate: Date }[]>();
      parsedPlanPhases.forEach((phase) => {
        const phases = phasesByType.get(phase.phaseType) ?? [];
        phases.push({ openDate: phase.openDate, closeDate: phase.closeDate });
        phases.sort((a, b) => a.openDate.getTime() - b.openDate.getTime());
        phasesByType.set(phase.phaseType, phases);
      });

      for (const [phaseType, phases] of phasesByType.entries()) {
        for (let i = 1; i < phases.length; i++) {
          const prev = phases[i - 1];
          const current = phases[i];
          if (current.openDate <= prev.closeDate) {
            throw new BadRequestException(
              `ช่วงวันที่ของ Phase ${phaseType} ซ้อนกัน กรุณาตรวจสอบ`,
            );
          }
        }
      }

      return await this.dataSource.transaction(async (manager) => {
        await this.validatePreviousPlanCompletion(manager);

        const developmentPlanRepository = manager.getRepository(DevelopmentPlan);
        const planPhaseRepository = manager.getRepository(PlanPhase);

        const existingPlans = await developmentPlanRepository.find();

        const isExactDuplicate = existingPlans.some(
          (plan) => plan.startYear === startYear && plan.endYear === endYear,
        );
        if (isExactDuplicate) {
          throw new BadRequestException('แผนพัฒนาช่วงปีนี้มีอยู่แล้ว');
        }

        const isOverlapping = existingPlans.some((plan) => {
          return (
            (startYear >= plan.startYear && startYear <= plan.endYear) ||
            (endYear >= plan.startYear && endYear <= plan.endYear) ||
            (startYear <= plan.startYear && endYear >= plan.endYear)
          );
        });
        if (isOverlapping) {
          throw new BadRequestException('ช่วงปีนี้ซ้อนกับแผนพัฒนาที่มีอยู่แล้ว');
        }

        await developmentPlanRepository.update(
          { isLatest: true },
          { isLatest: false },
        );

        const newDevelopmentPlan = developmentPlanRepository.create({
          name,
          startYear,
          endYear,
          isLatest: true,
          isBooked: false,
          createdBy: { id: workHistory.id },
        });

        const savedDevelopmentPlan = await developmentPlanRepository.save(newDevelopmentPlan);

        const planPhaseEntities = parsedPlanPhases.map((phase) =>
          planPhaseRepository.create({
            developmentPlan: savedDevelopmentPlan,
            openDate: phase.openDate,
            closeDate: phase.closeDate,
            phaseType: phase.phaseType,
            isMerged: phase.isMerged,
            isOpen: phase.isOpen,
            createdBy: workHistory,
          }),
        );

        const savedPlanPhases = await planPhaseRepository.save(planPhaseEntities);

        const openPhaseIdsByType = new Map<PhaseType, string>();
        savedPlanPhases.forEach((phase, index) => {
          if (parsedPlanPhases[index].isOpen) {
            openPhaseIdsByType.set(phase.phaseType, phase.id);
          }
        });

        for (const [phaseType, phaseId] of openPhaseIdsByType.entries()) {
          await planPhaseRepository.update(
            {
              developmentPlan: { id: savedDevelopmentPlan.id },
              phaseType,
              id: Not(phaseId),
            },
            { isOpen: false },
          );

          await planPhaseRepository.update(
            {
              developmentPlan: { id: Not(savedDevelopmentPlan.id) },
              phaseType,
              isOpen: true,
            },
            { isOpen: false },
          );
        }

        return { developmentPlan: savedDevelopmentPlan, planPhases: savedPlanPhases };
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async getCurrentPlanStatus() {
    try {
      const latestPlan = await this.developmentPlanRepository.findOne({
        where: { isLatest: true },
        select: ['id', 'name', 'startYear', 'endYear'],
      });

      if (!latestPlan) {
        return {
          plan: null,
          counts: {
            openPhases: 0,
            openRevisions: 0,
            openSupplements: 0,
          },
        };
      }

      const openPhasesCount = await this.planPhaseRepository.count({
        where: { developmentPlan: { id: latestPlan.id }, isOpen: true },
      });

      const openEditCount = await this.developmentPlanRevisionRepository.count({
        where: {
          developmentPlan: { id: latestPlan.id },
          isOpen: true,
          isBooked: false,
          revisionType: { name: 'แก้ไข' },
        },
      });

      const openChangeCount = await this.developmentPlanRevisionRepository.count({
        where: {
          developmentPlan: { id: latestPlan.id },
          isOpen: true,
          isBooked: false,
          revisionType: { name: 'เปลี่ยนแปลง' },
        },
      });

      const openSupplementsCount = await this.developmentPlanSupplementRepository.count({
        where: { developmentPlan: { id: latestPlan.id }, isOpen: true },
      });

      return {
        plan: latestPlan,
        counts: {
          openPhases: openPhasesCount,
          openEdit: openEditCount,
          openChange: openChangeCount,
          openSupplements: openSupplementsCount,
        },
      };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async updateWithPhases(
    id: string,
    dto: UpdateDevelopmentPlanWithPhasesDto,
    userId: string,
  ): Promise<{ developmentPlan: DevelopmentPlan; planPhases: PlanPhase[] }> {
    try {
      const { developmentPlan: developmentPlanDto, planPhases } = dto;

      if (!developmentPlanDto && !planPhases) {
        throw new BadRequestException('ไม่มีข้อมูลสำหรับอัปเดต');
      }

      const workHistory = await this.workHistoryRepository.findOne({
        where: { user: { id: userId }, workStatus: { name: 'approved' } },
      });
      if (!workHistory) {
        throw new NotFoundException('Work history not found for this user');
      }

      return await this.dataSource.transaction(async (manager) => {
        const developmentPlanRepository = manager.getRepository(DevelopmentPlan);
        const planPhaseRepository = manager.getRepository(PlanPhase);

        const developmentPlan = await developmentPlanRepository.findOne({
          where: { id },
        });

        if (!developmentPlan) {
          throw new NotFoundException(`Development Plan with ID ${id} not found`);
        }

        if (!developmentPlan.isLatest) {
          throw new BadRequestException('Only the latest development plan can be updated');
        }

        // CLAUDE.md §15 — Book Lineage Immutability. A plan with ANY
        // non-soft-deleted revision or supplement is locked. Runs inside
        // the caller transaction so the read matches the subsequent write.
        await this.bookLockService.assertEditable(id, 'development_plan', manager);

        if (developmentPlanDto) {
          const startYear =
            developmentPlanDto.startYear ?? developmentPlan.startYear;
          const endYear = developmentPlanDto.endYear ?? developmentPlan.endYear;

          if (startYear >= endYear) {
            throw new BadRequestException('startYear ต้องน้อยกว่า endYear');
          }

          const otherPlans = await developmentPlanRepository.find({
            where: { id: Not(id) },
          });

          const isExactDuplicate = otherPlans.some(
            (plan) => plan.startYear === startYear && plan.endYear === endYear,
          );

          if (isExactDuplicate) {
            throw new BadRequestException('แผนพัฒนาช่วงปีนี้มีอยู่แล้ว');
          }

          const isOverlapping = otherPlans.some((plan) => {
            return (
              (startYear >= plan.startYear && startYear <= plan.endYear) ||
              (endYear >= plan.startYear && endYear <= plan.endYear) ||
              (startYear <= plan.startYear && endYear >= plan.endYear)
            );
          });

          if (isOverlapping) {
            throw new BadRequestException(
              'ช่วงปีนี้ซ้อนกับแผนพัฒนาที่มีอยู่แล้ว',
            );
          }

          if (developmentPlanDto.name !== undefined) {
            developmentPlan.name = developmentPlanDto.name;
          }

          developmentPlan.startYear = startYear;
          developmentPlan.endYear = endYear;

          if (developmentPlanDto.isBooked !== undefined) {
            developmentPlan.isBooked = developmentPlanDto.isBooked;
          }
        }

        let updatedPlanPhases: PlanPhase[] = [];

        if (planPhases !== undefined) {
          const parsedPlanPhases = planPhases.map((planPhaseDto, index) => {
            const openDate = planPhaseDto.openDate
              ? new Date(planPhaseDto.openDate)
              : undefined;
            const closeDate = planPhaseDto.closeDate
              ? new Date(planPhaseDto.closeDate)
              : undefined;

            if (!openDate || Number.isNaN(openDate.getTime())) {
              throw new BadRequestException(
                `รูปแบบวันที่เปิดไม่ถูกต้อง (รายการที่ ${index + 1})`,
              );
            }

            if (!closeDate || Number.isNaN(closeDate.getTime())) {
              throw new BadRequestException(
                `รูปแบบวันที่ปิดไม่ถูกต้อง (รายการที่ ${index + 1})`,
              );
            }

            if (openDate > closeDate) {
              throw new BadRequestException(
                `วันที่เปิดต้องน้อยกว่าวันที่ปิด (รายการที่ ${index + 1})`,
              );
            }

            return {
              id: planPhaseDto.id,
              openDate,
              closeDate,
              phaseType: planPhaseDto.phaseType as PhaseType,
              isMerged: planPhaseDto.isMerged ?? false,
              isOpen: planPhaseDto.isOpen,
            };
          });

          const phaseTypes = [...new Set(parsedPlanPhases.map(p => p.phaseType))];
          for (const type of phaseTypes) {
            const openPhases = parsedPlanPhases.filter(p => p.phaseType === type && p.isOpen);
            if (openPhases.length > 1) {
              throw new BadRequestException(`ประเภทแผน ${type} ไม่สามารถเปิดพร้อมกันได้เกิน 1 รอบ`);
            }
          }

          const phasesByType = new Map<
            string,
            { openDate: Date; closeDate: Date }[]
          >();
          parsedPlanPhases.forEach((phase) => {
            const phases = phasesByType.get(phase.phaseType) ?? [];
            phases.push({ openDate: phase.openDate, closeDate: phase.closeDate });
            phases.sort((a, b) => a.openDate.getTime() - b.openDate.getTime());
            phasesByType.set(phase.phaseType, phases);
          });

          for (const [phaseType, phases] of phasesByType.entries()) {
            for (let i = 1; i < phases.length; i++) {
              const prev = phases[i - 1];
              const current = phases[i];
              if (current.openDate <= prev.closeDate) {
                throw new BadRequestException(
                  `ช่วงวันที่ของ Phase ${phaseType} ซ้อนกัน กรุณาตรวจสอบ`,
                );
              }
            }
          }

          const existingPhases = await planPhaseRepository.find({
            where: { developmentPlan: { id } },
          });
          const existingPhaseMap = new Map(
            existingPhases.map((phase) => [phase.id, phase]),
          );

          const phasesToSave: PlanPhase[] = [];
          const incomingIds = new Set<string>();

          parsedPlanPhases.forEach((phase) => {
            if (phase.id) {
              const existingPhase = existingPhaseMap.get(phase.id);
              if (!existingPhase) {
                throw new NotFoundException(
                  `Plan Phase with ID ${phase.id} not found`,
                );
              }

              existingPhase.openDate = phase.openDate;
              existingPhase.closeDate = phase.closeDate;
              existingPhase.phaseType = phase.phaseType;
              existingPhase.isMerged = phase.isMerged;
              if (phase.isOpen !== undefined) {
                existingPhase.isOpen = phase.isOpen;
              }
              phasesToSave.push(existingPhase);
              incomingIds.add(phase.id);
            } else {
              const newPhase = planPhaseRepository.create({
                developmentPlan,
                openDate: phase.openDate,
                closeDate: phase.closeDate,
                phaseType: phase.phaseType,
                isMerged: phase.isMerged,
                isOpen: phase.isOpen ?? false,
                createdBy: workHistory,
              });
              phasesToSave.push(newPhase);
            }
          });

          const idsToDelete = existingPhases
            .filter((phase) => !incomingIds.has(phase.id))
            .map((phase) => phase.id);

          if (idsToDelete.length > 0) {
            await planPhaseRepository.delete(idsToDelete);
          }

          updatedPlanPhases = await planPhaseRepository.save(phasesToSave);

          const openPhaseIdsByType = new Map<PhaseType, string>();
          updatedPlanPhases.forEach((phase) => {
            if (phase.isOpen) {
              openPhaseIdsByType.set(phase.phaseType, phase.id);
            }
          });

          for (const [phaseType, phaseId] of openPhaseIdsByType.entries()) {
            await planPhaseRepository.update(
              {
                developmentPlan: { id },
                phaseType,
                id: Not(phaseId),
              },
              { isOpen: false },
            );

            await planPhaseRepository.update(
              {
                developmentPlan: { id: Not(id) },
                phaseType,
                isOpen: true,
              },
              { isOpen: false },
            );
          }
        } else {
          updatedPlanPhases = await planPhaseRepository.find({
            where: { developmentPlan: { id } },
          });
        }

        const savedDevelopmentPlan =
          await developmentPlanRepository.save(developmentPlan);

        return { developmentPlan: savedDevelopmentPlan, planPhases: updatedPlanPhases };
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async generateApprovedBookForPlan(developmentPlanId: string, userId: string) {
    try {
      // CLAUDE.md §15 / OQ-8 — legacy generateApprovedBookForPlan is
      // defensively guarded. Producing a new main-plan book for a
      // plan that already has a revision or supplement would create
      // a new head beneath the existing descendant and break lineage
      // ordering. Guard BEFORE any websocket progress is emitted so
      // the client does not see a bogus "starting" message on a
      // locked plan.
      await this.bookLockService.assertEditable(
        developmentPlanId,
        'development_plan',
        this.developmentPlanRepository.manager,
      );

      // Send progress: Starting (10%)
      await this.websocketService.notifyPdfGenerationProgress({
        userId,
        developmentPlanId,
        progress: {
          percentage: 10,
          stage: 'starting',
          message: 'กำลังเริ่มต้นสร้างเล่ม PDF...',
        },
      });

      const plan = await this.developmentPlanRepository.findOne({ where: { id: developmentPlanId } });
      if (!plan) {
        throw new NotFoundException(`Development Plan with ID ${developmentPlanId} not found`);
      }

      // Send progress: Querying projects (20%)
      await this.websocketService.notifyPdfGenerationProgress({
        userId,
        developmentPlanId,
        progress: {
          percentage: 20,
          stage: 'querying',
          message: 'กำลังค้นหาโครงการที่อนุมัติแล้ว...',
        },
      });

      // Query original projects (ProjectGroup) - สอดคล้องกับการออก PDF และ WebSocket
      const originalProjects = await this.projectGroupRepository
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
        .leftJoinAndSelect('projectGroup.revisedProjectGroups', 'revisedProjectGroups')
        .leftJoinAndSelect('originAgencyId.amphoe', 'originAgencyAmphoe')
        .where('projectGroup.developmentPlan.id = :developmentPlanId', { developmentPlanId })
        .andWhere('projectGroup.responsibleAgency IS NOT NULL')
        .andWhere('projectGroup.isBooked = :isBooked', { isBooked: false })
        .andWhere('projectGroup.isDraft = :isDraft', { isDraft: false })
        .andWhere('projectGroup.deletedAt IS NULL')
        .andWhere('trackingStatus.isLatest = :isLatest', { isLatest: true })
        .andWhere('status.name = :statusName', { statusName: 'Approved' })
        .andWhere('revisedProjectGroups.id IS NULL') // คือต้องไม่มีโครงการลูก
        .orderBy('strategy.id', 'ASC')
        .getMany();

      // Convert to unified format
      const allProjects = [
        ...originalProjects.map(p => UnifiedProjectMapper.fromProjectGroup(p)),
      ];

      // Send progress: Preparing data (30%)
      await this.websocketService.notifyPdfGenerationProgress({
        userId,
        developmentPlanId,
        progress: {
          percentage: 30,
          stage: 'preparing',
          message: `กำลังเตรียมข้อมูล ${allProjects.length} โครงการ...`,
        },
      });

      // Generate PDF using plan-specific context
      // Send progress: Generating PDF (40-70%)
      await this.websocketService.notifyPdfGenerationProgress({
        userId,
        developmentPlanId,
        progress: {
          percentage: 40,
          stage: 'generating',
          message: 'กำลังสร้างไฟล์ PDF...',
        },
      });

      const { buffer: pdfBuffer, pageMap } = await this.pdfService.generateProjectReportWithPageTracking(
        allProjects,
        ['index', 'title', 'objective', 'target', 'budget', 'expectedResult', 'mainAgency'],
        { developmentPlanId: String(developmentPlanId) },
      );

      // Send progress: PDF generated (70%)
      await this.websocketService.notifyPdfGenerationProgress({
        userId,
        developmentPlanId,
        progress: {
          percentage: 70,
          stage: 'generated',
          message: 'สร้างไฟล์ PDF สำเร็จ กำลังบันทึก...',
        },
      });

      // Separate original and revised project IDs
      const originalProjectIds: string[] = [];

      allProjects.forEach((p) => {
        originalProjectIds.push(p.id);
      });

      const allProjectIds = [...originalProjectIds];

      // Send progress: Saving to database (80%)
      await this.websocketService.notifyPdfGenerationProgress({
        userId,
        developmentPlanId,
        progress: {
          percentage: 80,
          stage: 'saving',
          message: 'กำลังบันทึกข้อมูลลงฐานข้อมูล...',
        },
      });

      const saved = await this.pdfService.saveApprovedPdfAndMetaForPlan({
        developmentPlanId,
        pdfBuffer,
        projectIdsSnapshot: allProjectIds,
        originalProjectIds,
        createdById: userId,
        pageMap,
      });

      // Ensure DevelopmentPlan is marked as booked
      if (!plan.isBooked) {
        await this.developmentPlanRepository.update({ id: developmentPlanId }, { isBooked: true });
      }

      // Set all PlanPhase for this DevelopmentPlan to isMerged = true
      await this.planPhaseRepository.update(
        { developmentPlan: { id: developmentPlanId } },
        { isMerged: true },
      );

      // Send progress: Completed (100%)
      await this.websocketService.notifyPdfGenerationProgress({
        userId,
        developmentPlanId,
        progress: {
          percentage: 100,
          stage: 'completed',
          message: 'สร้างเล่ม PDF สำเร็จแล้ว!',
        },
      });

      return saved;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async generateApprovedBookPreviewForPlan(
    developmentPlanId: string,
    userId: string,
  ): Promise<Buffer> {
    try {
      this.logger.log(
        `Generating approved book PREVIEW for development plan ${developmentPlanId} by user ${userId}`,
      );

      const plan = await this.developmentPlanRepository.findOne({
        where: { id: developmentPlanId },
      });
      if (!plan) {
        throw new NotFoundException(
          `Development Plan with ID ${developmentPlanId} not found`,
        );
      }

      const originalProjects = await this.projectGroupRepository
        .createQueryBuilder('projectGroup')
        .leftJoinAndSelect('projectGroup.createdBy', 'createdBy')
        .leftJoinAndSelect('createdBy.user', 'createdByUser')
        .leftJoinAndSelect('createdBy.amphoe', 'amphoe')
        .leftJoinAndSelect(
          'createdBy.localAdministrativeOrganization',
          'localAdministrativeOrganization',
        )
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
        .leftJoinAndSelect(
          'workHistory.localAdministrativeOrganization',
          'localAdministrativeOrganizationWorkHistory',
        )
        .leftJoinAndSelect('workHistory.governmentAgencies', 'governmentAgencies')
        .leftJoinAndSelect('workHistory.workStatus', 'workStatus')
        .leftJoinAndSelect('projectGroup.responsibleAgency', 'responsibleAgency')
        .leftJoinAndSelect('projectGroup.originAgencyId', 'originAgencyId')
        .leftJoinAndSelect(
          'projectGroup.revisedProjectGroups',
          'revisedProjectGroups',
        )
        .leftJoinAndSelect('originAgencyId.amphoe', 'originAgencyAmphoe')
        .where('projectGroup.developmentPlan.id = :developmentPlanId', {
          developmentPlanId,
        })
        .andWhere('projectGroup.responsibleAgency IS NOT NULL')
        .andWhere('projectGroup.isBooked = :isBooked', { isBooked: false })
        .andWhere('projectGroup.isDraft = :isDraft', { isDraft: false })
        .andWhere('projectGroup.deletedAt IS NULL')
        .andWhere('trackingStatus.isLatest = :isLatest', { isLatest: true })
        .andWhere('status.name = :statusName', { statusName: 'Approved' })
        .andWhere('revisedProjectGroups.id IS NULL')
        .orderBy('strategy.id', 'ASC')
        .getMany();

      const allProjects = [
        ...originalProjects.map((p) => UnifiedProjectMapper.fromProjectGroup(p)),
      ];

      this.logger.log(
        `Prepared ${allProjects.length} approved projects for preview of development plan ${developmentPlanId}`,
      );

      const pdfBuffer = await this.pdfService.generateProjectReportWithColumns(
        allProjects,
        [
          'index',
          'title',
          'objective',
          'target',
          'budget',
          'expectedResult',
          'mainAgency',
        ],
        { developmentPlanId },
      );

      return pdfBuffer;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async updateLatestStatus(
    id: string,
    dto: UpdateDevelopmentPlanLatestStatusDto,
  ): Promise<DevelopmentPlan> {
    try {
      const { isLatest } = dto;

      return await this.dataSource.transaction(async (manager) => {
        const developmentPlanRepository = manager.getRepository(DevelopmentPlan);

        const plan = await developmentPlanRepository.findOne({
          where: { id },
        });

        if (!plan) {
          throw new NotFoundException(`Development Plan with ID ${id} not found`);
        }

        // CLAUDE.md §15 / OQ-6 — updateLatestStatus is a plan field
        // mutation and MUST obey the book-lineage lock. A plan with
        // any non-soft-deleted revision or supplement cannot have its
        // latest flag flipped.
        await this.bookLockService.assertEditable(id, 'development_plan', manager);

        if (isLatest) {
          await developmentPlanRepository.update(
            { isLatest: true },
            { isLatest: false },
          );
        }

        plan.isLatest = isLatest;

        await developmentPlanRepository.save(plan);

        return plan;
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findAll(): Promise<DevelopmentPlan[]> {
    try {
      const dv = await this.developmentPlanRepository.find({
        relations: ['createdBy', 'developmentPlanRevision', 'developmentPlanRevision.revisionType', 'planPhases', 'developmentPlanSupplements'],
        order: { createAt: 'DESC' },
        where: { isLatest: true },
      });
      const plans = dv || [];
      this.decorateBookLockFlags(plans);
      return plans;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findAllUnordered(): Promise<DevelopmentPlan[]> {
    try {
      // CLAUDE.md §15 Book Lineage Immutability.
      //
      // This endpoint is the ONLY source of `hasNewerRevision` flags for
      // `/local-plan-book/assembly/edit` and `/local-plan-book/assembly/change`,
      // so correctness of the nested `developmentPlanRevision` and
      // `developmentPlanSupplements` collections is load-bearing for the UI
      // lock. We intentionally keep the query simple:
      //
      //   - NO nested `where` on OneToMany relations. In TypeORM 0.3.x a
      //     nested `where` adds a LEFT JOIN + AND filter against the main
      //     query. Combined with the `relations` array loader it reliably
      //     loads siblings, but any mismatch between the join filter and
      //     the eager-load query risks dropping rows silently — which is
      //     the exact symptom the UI lock was suffering from. Soft-deleted
      //     children are already excluded at the entity level via
      //     `@DeleteDateColumn` (TypeORM auto-filters soft-deleted rows
      //     on eager relation loads), so the additional filter is
      //     redundant AND fragile.
      //
      //   - NO nested `order` on OneToMany relations. TypeORM 0.3.x applies
      //     nested relation ordering to the MAIN query's ORDER BY by adding
      //     a second LEFT JOIN with `select: false`, which produces a
      //     Cartesian product across `developmentPlanRevision` ×
      //     `developmentPlanSupplements`. The raw-to-entity transformer
      //     then dedupes by primary key, but the interaction with the
      //     nested `where` above has been observed to drop revisions /
      //     supplements in some topologies. We sort in memory below
      //     instead — O(n log n) per plan, trivial compared to the
      //     network round-trip.
      //
      // `decorateBookLockFlags` runs AFTER the in-memory sort so that the
      // timestamp comparisons operate on the canonical global timeline,
      // NOT on whatever order TypeORM happened to return.
      const plans = await this.developmentPlanRepository.find({
        relations: [
          'createdBy',
          'createdBy.user',
          'createdBy.amphoe',
          'createdBy.localAdministrativeOrganization',
          'developmentPlanRevision',
          'developmentPlanRevision.revisionType',
          'planPhases',
          'developmentPlanSupplements',
        ],
        where: {
          deletedAt: IsNull(),
        },
        order: {
          createAt: 'DESC',
        },
      });

      // Sort children in memory so the frontend sees the same ordering
      // it used to get from the (fragile) nested `order` clauses. The
      // lineage-lock flags are computed from `createdAt`, not this order,
      // so this is purely cosmetic for the UI list rendering.
      for (const plan of plans) {
        if (Array.isArray(plan.developmentPlanRevision)) {
          plan.developmentPlanRevision.sort(
            (a, b) => (b?.revisionNumber ?? 0) - (a?.revisionNumber ?? 0),
          );
        }
        if (Array.isArray(plan.developmentPlanSupplements)) {
          plan.developmentPlanSupplements.sort(
            (a, b) => (b?.supplementNumber ?? 0) - (a?.supplementNumber ?? 0),
          );
        }
      }

      this.decorateBookLockFlags(plans);
      return plans;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  /**
   * CLAUDE.md §15 — attach `hasNewerRevision` flags to fetched plan,
   * revision, and supplement rows so the frontend can render the
   * book-lineage lock UI without a second round-trip.
   *
   * Detection semantics mirror `BookLockService` exactly but run
   * entirely in memory, using the already-eager-loaded
   * `developmentPlanRevision` and `developmentPlanSupplements` arrays
   * attached to each plan. For read endpoints this is strictly cheaper
   * than issuing a per-row subquery — no N+1 and no batched round-trip.
   *
   * The plan row itself is flagged `hasNewerRevision = true` as soon as
   * it has ANY non-soft-deleted revision or supplement child (the
   * `where: { deletedAt: IsNull() }` filters applied upstream already
   * exclude soft-deleted children from the in-memory arrays).
   *
   * For each revision and each supplement row, the flag is set to
   * `true` iff ANY other non-soft-deleted child of the same plan has a
   * strictly-newer `createdAt`, across BOTH `developmentPlanRevision`
   * and `developmentPlanSupplements` collections — OQ-2=(B) global
   * lineage. Same-millisecond ties do NOT lock each other; they both
   * still lock their parent plan (already covered by the plan-level
   * predicate above).
   *
   * Note: `DevelopmentPlan` stores its own timestamp as `createAt`
   * (sic — historical column name), while `DevelopmentPlanRevision`
   * and `DevelopmentPlanSupplement` use `createdAt`. Only the child
   * timestamps are compared here; the plan's own `createAt` is never
   * part of the global lineage ordering.
   */
  private decorateBookLockFlags(plans: DevelopmentPlan[]): void {
    if (!plans || plans.length === 0) return;

    for (const plan of plans) {
      const revisions: DevelopmentPlanRevision[] =
        (plan.developmentPlanRevision ?? []).filter(
          (r) => !r.deletedAt,
        );
      const supplements: DevelopmentPlanSupplement[] =
        (plan.developmentPlanSupplements ?? []).filter(
          (s) => !s.deletedAt,
        );

      const childTimestamps: number[] = [
        ...revisions.map((r) => new Date(r.createdAt).getTime()),
        ...supplements.map((s) => new Date(s.createdAt).getTime()),
      ];

      const planHasAnyChild = childTimestamps.length > 0;
      // `hasNewerRevision` is declared as a plain field on the entity
      // classes (see `DevelopmentPlan.hasNewerRevision` and siblings)
      // precisely so we can assign it without an `as any` cast and so
      // that `ClassSerializerInterceptor` deterministically preserves
      // it in the JSON response.
      plan.hasNewerRevision = planHasAnyChild;

      if (!planHasAnyChild) continue;

      const maxChildTs = Math.max(...childTimestamps);

      for (const revision of revisions) {
        const ts = new Date(revision.createdAt).getTime();
        revision.hasNewerRevision = ts < maxChildTs;
      }
      for (const supplement of supplements) {
        const ts = new Date(supplement.createdAt).getTime();
        supplement.hasNewerRevision = ts < maxChildTs;
      }
    }
  }

  async findOne(id: string): Promise<DevelopmentPlan> {
    try {
      // CLAUDE.md §15 — historical (locked) plans MUST remain loadable
      // for read so the frontend can render them as disabled/locked.
      // Previously this method filtered `isLatest: true`, which made
      // any plan with a newer revision permanently unreadable through
      // this endpoint. The lock is enforced in the write paths, not
      // by hiding rows from reads.
      const developmentPlan = await this.developmentPlanRepository.findOne({
        where: { id },
        relations: ['projectGroup', 'workHistory'],
      });

      if (!developmentPlan) {
        this.logger.warn(`DevelopmentPlan not found: ${id}`);
        throw new NotFoundException(`DevelopmentPlan with id ${id} not found`);
      }

      // CLAUDE.md §15 — attach `hasNewerRevision` so single-row detail
      // endpoints surface the same lock state as list endpoints.
      // `findOne` does not eagerly load the child arrays, so we defer
      // to the live BookLockService lookup rather than the in-memory
      // helper used by findAll/findAllUnordered. The field is a plain
      // class member on `DevelopmentPlan` (§15) — no cast required.
      developmentPlan.hasNewerRevision =
        await this.bookLockService.hasNewerRevision(
          id,
          'development_plan',
          this.developmentPlanRepository.manager,
        );

      return developmentPlan;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async update(id: string, dto: UpdateDevelopmentPlanDto): Promise<DevelopmentPlan> {
    try {
      const developmentPlan = await this.developmentPlanRepository.findOneBy({ id });

      if (!developmentPlan) {
        throw new NotFoundException(`Development Plan with ID ${id} not found`);
      }

      if (!developmentPlan.isLatest) {
        throw new BadRequestException(
          `Only the latest development plan can be updated`,
        );
      }

      // CLAUDE.md §15 — Book Lineage Immutability. Guard BEFORE any
      // mutation; the non-transactional path here uses the default
      // entity manager. If the caller wraps this in its own transaction
      // in the future, pass `manager` through instead.
      await this.bookLockService.assertEditable(
        id,
        'development_plan',
        this.developmentPlanRepository.manager,
      );

      const startYear = dto.startYear ?? developmentPlan.startYear;
      const endYear = dto.endYear ?? developmentPlan.endYear;

      if (startYear >= endYear) {
        throw new BadRequestException('startYear ต้องน้อยกว่า endYear');
      }

      const otherPlans = await this.developmentPlanRepository.find({
        where: { id: Not(id) },
      });

      const isExactDuplicate = otherPlans.some(
        (plan) => plan.startYear === startYear && plan.endYear === endYear,
      );

      if (isExactDuplicate) {
        throw new BadRequestException('ช่วงปีซ้ำกับแผนพัฒนาอื่น');
      }

      const isOverlapping = otherPlans.some((plan) => {
        return (
          (startYear >= plan.startYear && startYear <= plan.endYear) ||
          (endYear >= plan.startYear && endYear <= plan.endYear) ||
          (startYear <= plan.startYear && endYear >= plan.endYear)
        );
      });

      if (isOverlapping) {
        throw new BadRequestException('ช่วงปีซ้อนกับแผนพัฒนาอื่น');
      }

      const updated = this.developmentPlanRepository.merge(developmentPlan, {
        ...dto,
      });

      return await this.developmentPlanRepository.save(updated);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async remove(id: string): Promise<{ message: string }> {
    try {
      // CLAUDE.md §15 — Book Lineage Immutability. Guard BEFORE any
      // repository write. This is critical because the FK
      // `development_plan_revision.development_plan_id` declares
      // `onDelete: 'CASCADE'`, so a delayed guard on `.delete()` would
      // silently cascade through children and bypass the invariant.
      await this.bookLockService.assertDeletable(
        id,
        'development_plan',
        this.developmentPlanRepository.manager,
      );

      const result = await this.developmentPlanRepository.delete(id);
      if (result.affected === 0) {
        throw new NotFoundException(`DevelopmentPlan with ID ${id} not found`);
      }
      return { message: `DevelopmentPlan with ID ${id} has been permanently removed.` };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async softRemove(id: string, userId: string, citizenIdSuffix: string): Promise<{ message: string }> {
    try {
      // Get user to verify citizen ID
      const user = await this.usersService.findOne(userId);

      if (!user || !user.citizenId) {
        throw new NotFoundException('User not found or citizen ID is missing');
      }

      // Extract last 6 digits of citizen ID
      const userCitizenIdSuffix = user.citizenId.slice(-6);

      // Verify that the provided suffix matches the user's citizen ID
      if (userCitizenIdSuffix !== citizenIdSuffix) {
        throw new UnauthorizedException('Citizen ID suffix does not match');
      }

      // Check if development plan exists
      const developmentPlan = await this.developmentPlanRepository.findOne({
        where: { id },
      });

      if (!developmentPlan) {
        throw new NotFoundException(`DevelopmentPlan with ID ${id} not found`);
      }

      // CLAUDE.md §15 — Book Lineage Immutability. Guard BEFORE any
      // repository write. Runs before the `save(deletedBy)` step below
      // so a locked plan never receives a partial mutation.
      await this.bookLockService.assertDeletable(
        id,
        'development_plan',
        this.developmentPlanRepository.manager,
      );

      // Get workHistory for deletedBy
      const workHistory = await this.workHistoryRepository.findOne({
        where: { user: { id: userId }, workStatus: { name: 'approved' } },
      });
      if (workHistory) {
        developmentPlan.deletedBy = workHistory;
      }

      // ถ้าที่ลบเป็น isLatest ให้ตั้งอันก่อนหน้า (เรียงจาก createAt) เป็น isLatest และตั้งตัวที่ลบเป็น false
      if (developmentPlan.isLatest) {
        const previousPlan = await this.developmentPlanRepository.findOne({
          where: { id: Not(id) },
          order: { createAt: 'DESC' },
        });
        if (previousPlan) {
          await this.developmentPlanRepository.update(
            { id: previousPlan.id },
            { isLatest: true },
          );
        }
        developmentPlan.isLatest = false;
      }

      await this.developmentPlanRepository.save(developmentPlan);
      await this.developmentPlanRepository.softRemove(developmentPlan);

      this.logger.log(`Development plan ${id} soft-deleted by user ${userId}`);
      return { message: `DevelopmentPlan with ID ${id} has been soft-removed.` };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async checkCitizenIdSuffix(
    userId: string,
    citizenIdSuffix: string,
  ): Promise<{ valid: boolean }> {
    try {
      const user = await this.usersService.findOne(userId);
      if (user.workHistory[0].role.name !== 'admin' && user.workHistory[0].role.name !== 'super_admin' && user.workHistory[0].role.name !== 'staff') {
        throw new UnauthorizedException('คุณไม่มีสิทธิ์ใช้งานฟังก์ชันนี้');
      }

      if (!user || !user.citizenId) {
        throw new NotFoundException('ไม่พบผู้ใช้งานหรือไม่มีข้อมูลเลขบัตรประชาชน');
      }

      const userCitizenIdSuffix = user.citizenId.slice(-6);

      if (userCitizenIdSuffix !== citizenIdSuffix) {
        throw new UnauthorizedException('เลข 6 หลักท้ายของบัตรประชาชนไม่ถูกต้อง');
      }

      return { valid: true };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async restore(id: string): Promise<{ message: string }> {
    try {
      // CLAUDE.md §15 — Book Lineage Immutability. Restore of a
      // soft-deleted plan is blocked when the plan still has any
      // non-soft-deleted child (revision or supplement) — an unlocked
      // restore would resurrect a dead parent beneath a live child.
      // Guard operates on the raw table so soft-deleted rows are also
      // visible for the detection lookup; the child count check in
      // `hasAnyChildForPlan` is independent of the parent's lifecycle.
      await this.bookLockService.assertEditable(
        id,
        'development_plan',
        this.developmentPlanRepository.manager,
      );

      const result = await this.developmentPlanRepository.restore(id);
      if (result.affected === 0) {
        throw new NotFoundException(
          `DevelopmentPlan with ID ${id} not found or was not deleted.`,
        );
      }
      return { message: `DevelopmentPlan with ID ${id} has been restored.` };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async rollbackBook(developmentPlanId: string, userId: string): Promise<{ message: string }> {
    try {
      const plan = await this.developmentPlanRepository.findOne({ where: { id: developmentPlanId } });
      if (!plan) {
        throw new NotFoundException(`Development Plan with ID ${developmentPlanId} not found`);
      }

      if (!plan.isBooked) {
        throw new BadRequestException(`Development Plan with ID ${developmentPlanId} is not booked yet`);
      }

      // CLAUDE.md §15 / OQ-7 — legacy rollbackBook is defensively
      // guarded against the book-lineage lock. Rolling back a main
      // plan that has ANY revision or supplement child is never
      // valid: the child's lineage chain depends on the plan being
      // booked at the time the child was created.
      await this.bookLockService.assertEditable(
        developmentPlanId,
        'development_plan',
        this.developmentPlanRepository.manager,
      );

      // Get all ProjectGroups that are booked for this development plan
      // แต่ไม่เอาโครงการที่ Rejected (Out Authority)
      const bookedProjects = await this.projectGroupRepository
        .createQueryBuilder('projectGroup')
        .leftJoin('projectGroup.trackingStatus', 'trackingStatus')
        .leftJoin('trackingStatus.statusId', 'status')
        .where('projectGroup.developmentPlan.id = :developmentPlanId', { developmentPlanId })
        .andWhere('projectGroup.isBooked = :isBooked', { isBooked: true })
        .andWhere('trackingStatus.isLatest = :isLatest', { isLatest: true })
        .andWhere('status.name != :statusName', { statusName: 'Rejected' })
        .select(['projectGroup.id'])
        .getMany();

      const projectIds = bookedProjects.map((p) => p.id);

      // Set all ProjectGroup.isBooked = false for this development plan
      if (projectIds.length > 0) {
        await this.projectGroupRepository.update(
          { id: In(projectIds) },
          { isBooked: false, bookedAt: null, pageNumber: null },
        );
      }

      // Set DevelopmentPlan.isBooked = false
      await this.developmentPlanRepository.update(
        { id: developmentPlanId },
        { isBooked: false },
      );

      // Set all PlanPhase.isMerged = false for this DevelopmentPlan
      await this.planPhaseRepository.update(
        { developmentPlan: { id: developmentPlanId } },
        { isMerged: false },
      );

      // Deprecate PDF files and records (rename files, mark as deprecated in DB)
      const deprecateResult = await this.pdfService.deprecateApprovedPdfsForPlan(
        developmentPlanId,
        userId,
      );

      this.logger.log(
        `Rollback book for development plan ${developmentPlanId} by user ${userId}. Unbooked ${projectIds.length} projects. Deprecated ${deprecateResult.deprecatedCount} PDF files.`,
      );

      return {
        message: `เล่มแผนพัฒนาถูกยกเลิกแล้ว (Rollback สำเร็จ). ยกเลิกการจอง ${projectIds.length} โครงการ และ deprecate ${deprecateResult.deprecatedCount} ไฟล์ PDF (เก็บไว้สำหรับ audit log)`,
      };
    } catch (error) {
      handleException(this.logger, error);
    }
  }
}

