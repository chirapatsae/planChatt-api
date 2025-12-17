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
import { DataSource, Not, Repository, In, IsNull } from 'typeorm';
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
import { CreateDevelopmentPlanWithPhaseDto } from './dto/create-development-plan-with-phase.dto';
import { UpdateDevelopmentPlanWithPhasesDto } from './dto/update-development-plan-with-phase.dto';
import { UpdateDevelopmentPlanLatestStatusDto } from './dto/update-development-plan-latest-status.dto';
import { UsersService } from 'src/users/users.service';

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

    private readonly dataSource: DataSource,
    private readonly pdfService: PdfService,
    private readonly projectGroupsService: ProjectGroupsService,
    private readonly websocketService: WebsocketService,
    private readonly usersService: UsersService,
  ) {}

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
      const { name, startYear, endYear, isBooked } = developmentPlanDto;

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

        if (openDate >= closeDate) {
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

      const openTypeSet = new Set<string>();
      parsedPlanPhases.forEach((phase) => {
        if (phase.isOpen) {
          if (openTypeSet.has(phase.phaseType)) {
            phase.isOpen = false;
          } else {
            openTypeSet.add(phase.phaseType);
          }
        }
      });

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
          isBooked: isBooked ?? false,
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

            if (openDate >= closeDate) {
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

        const phaseTypeOpenHandled = new Set<string>();
        parsedPlanPhases.forEach((phase) => {
          if (phase.isOpen) {
            if (phaseTypeOpenHandled.has(phase.phaseType)) {
              phase.isOpen = false;
            } else {
              phaseTypeOpenHandled.add(phase.phaseType);
            }
          }
        });

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

      const pdfBuffer = await this.pdfService.generateProjectReportWithColumns(
        allProjects,
        ['index', 'title', 'objective', 'target', 'budget', 'kpi', 'expectedResult', 'mainAgency'],
        {developmentPlanId},
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
      const dv =  await this.developmentPlanRepository.find({
        relations: ['createdBy' , 'developmentPlanRevision' ,'developmentPlanRevision.revisionType'  , 'planPhases'],
        order: { createAt: 'DESC' },
        where: { isLatest: true },
      });
      return dv;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findAllUnordered(): Promise<DevelopmentPlan[]> {
    try {
      return await this.developmentPlanRepository.find({
        relations: [
          'createdBy',
          'createdBy.user',
          'developmentPlanRevision',
          'developmentPlanRevision.revisionType',
          'planPhases',
          'developmentPlanSupplements',
        ],
        where: { deletedAt: IsNull() },
        order: {
          createAt: 'DESC',
          developmentPlanRevision: {
            revisionNumber: 'DESC', // or 'createdAt', 'version', etc. — depends on your column name
          },
          developmentPlanSupplements: {
            supplementNumber: 'DESC',
          },
        },
      });
      
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findOne(id: string): Promise<DevelopmentPlan> {
    try {
      const developmentPlan = await this.developmentPlanRepository.findOne({
        where: { id  , isLatest: true},
        relations: ['projectGroup', 'workHistory'],
      });

      if (!developmentPlan) {
        this.logger.warn(`DevelopmentPlan not found: ${id}`);
        throw new NotFoundException(`DevelopmentPlan with id ${id} not found`);
      }

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

      // Perform soft delete
      const result = await this.developmentPlanRepository.softDelete(id);
      if (result.affected === 0) {
        throw new NotFoundException(`DevelopmentPlan with ID ${id} not found`);
      }
      
      this.logger.log(`Development plan ${id} soft-deleted by user ${userId}`);
      return { message: `DevelopmentPlan with ID ${id} has been soft-removed.` };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async restore(id: string): Promise<{ message: string }> {
    try {
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
          { isBooked: false, bookedAt: null },
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

