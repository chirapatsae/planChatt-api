import {
  Injectable,
  NotFoundException,
  Logger,
  BadRequestException,
  UnauthorizedException,
  HttpException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, Not } from 'typeorm';
import { CreateDevelopmentPlanRevisionDto } from './dto/create-development-plan-revision.dto';
import { UpdateDevelopmentPlanRevisionDto } from './dto/update-development-plan-revision.dto';
import { DevelopmentPlanRevision } from './entities/development-plan-revision.entity';
import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { RevisionType } from 'src/revision-type/entities/revision-type.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';
import { handleException } from 'src/util/handleException';
import { UsersService } from 'src/users/users.service';
import { PdfService } from 'src/pdf/pdf.service';
import { WebsocketService } from 'src/websocket/websocket/websocket.service';
import { UnifiedProjectMapper } from 'src/project-groups/dto/unified-project-display.dto';

@Injectable()
export class DevelopmentPlanRevisionService {
  private readonly logger = new Logger(DevelopmentPlanRevisionService.name);

  constructor(
    @InjectRepository(DevelopmentPlanRevision)
    private readonly revisionRepository: Repository<DevelopmentPlanRevision>,

    @InjectRepository(DevelopmentPlan)
    private readonly developmentPlanRepository: Repository<DevelopmentPlan>,

    @InjectRepository(RevisionType)
    private readonly revisionTypeRepository: Repository<RevisionType>,

    @InjectRepository(WorkHistory)
    private readonly workHistoryRepository: Repository<WorkHistory>,

    @InjectRepository(RevisedProjectGroup)
    private readonly revisedProjectGroupRepository: Repository<RevisedProjectGroup>,

    private readonly usersService: UsersService,
    private readonly pdfService: PdfService,
    private readonly websocketService: WebsocketService,
  ) { }

  // ===================================================================
  // 🟢 1. CRUD Operations (Create, Read, Update, Delete)
  // ===================================================================

  async create(
    createDto: CreateDevelopmentPlanRevisionDto,
    userId: string,
  ): Promise<DevelopmentPlanRevision> {
    try {
      const startDate = createDto.startDate ? new Date(createDto.startDate) : null;
      const endDate = createDto.endDate ? new Date(createDto.endDate) : null;

      if ((startDate && !endDate) || (!startDate && endDate)) {
        throw new BadRequestException('กรุณาระบุวันที่เปิดและวันที่ปิดให้ครบถ้วน');
      }

      if (startDate && endDate && startDate >= endDate) {
        throw new BadRequestException('วันที่เปิดต้องน้อยกว่าวันที่ปิด');
      }

      // Validate relations exist
      const developmentPlan = await this.developmentPlanRepository.findOne({
        where: { id: createDto.developmentPlanId },
        relations:['developmentPlanRevision']
      });
      if (!developmentPlan) {
        throw new NotFoundException(
          `Development Plan with ID ${createDto.developmentPlanId} not found`,
        );
      }

      const revisionType = await this.revisionTypeRepository.findOne({
        where: { id: createDto.revisionTypeId },
      });
      if (!revisionType) {
        throw new NotFoundException(
          `Revision Type with ID ${createDto.revisionTypeId} not found`,
        );
      }

      const workHistory = await this.workHistoryRepository.findOne({
        where: { user: { id: userId } },
      });
      if (!workHistory) {
        throw new NotFoundException('Work history not found for this user');
      }

      // Validate date overlapping with other revisions of the same type
      if (startDate && endDate) {
        await this.ensureNoDateOverlap(
          developmentPlan.id,
          revisionType.id,
          startDate,
          endDate,
        );
      }

      // ปิดรอบอื่นที่เปิดอยู่ ถ้ามีการสร้างรอบใหม่แบบเปิดทันที
      if (createDto.isOpen) {
        await this.revisionRepository.update(
          {
            developmentPlan: { id: createDto.developmentPlanId },
            revisionType: { id: revisionType.id },
            isOpen: true,
          },
          { isOpen: false },
        );
      }

      // If setting as latest, unset other latest revisions for this development plan with same revision type
      if (createDto.isLatest) {
        await this.revisionRepository.update(
          {
            developmentPlan: { id: createDto.developmentPlanId },
            revisionType: { id: revisionType.id },
            isLatest: true,
          },
          { isLatest: false },
        );
      }
      const nextVersion  = developmentPlan.developmentPlanRevision.length + 1;

      const revision = this.revisionRepository.create({
        developmentPlan,
        revisionType,
        revisionNumber: nextVersion,
        description: createDto.description,
        isLatest: createDto.isLatest ?? false,
        isOpen: createDto.isOpen ?? false,
        startDate,
        endDate,
        createdBy: workHistory,
      });

      return await this.revisionRepository.save(revision);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findAll(): Promise<DevelopmentPlanRevision[]> {
    try {
      return await this.revisionRepository.find({
        relations: ['developmentPlan', 'revisionType', 'createdBy'],
        order: { createdAt: 'DESC' },
        where: { isLatest: true },
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findOne(id: string): Promise<DevelopmentPlanRevision> {
    try {
      const revision = await this.revisionRepository.findOne({
        where: { id },
        relations: ['developmentPlan', 'revisionType', 'createdBy'],
      });

      if (!revision) {
        this.logger.warn(`DevelopmentPlanRevision not found: ${id}`);
        throw new NotFoundException(
          `DevelopmentPlanRevision with id ${id} not found`,
        );
      }

      return revision;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findByDevelopmentPlan(developmentPlanId: string): Promise<DevelopmentPlanRevision[]> {
    try {
      return await this.revisionRepository.find({
        where: { developmentPlan: { id: developmentPlanId } },
        relations: ['developmentPlan', 'revisionType', 'createdBy'],
        order: { revisionNumber: 'ASC' },
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async update(
    id: string,
    updateDto: UpdateDevelopmentPlanRevisionDto,
  ): Promise<DevelopmentPlanRevision> {
    try {
      const revision = await this.findOne(id);

      const startDate =
        updateDto.startDate !== undefined
          ? updateDto.startDate
            ? new Date(updateDto.startDate)
            : null
          : revision.startDate;
      const endDate =
        updateDto.endDate !== undefined
          ? updateDto.endDate
            ? new Date(updateDto.endDate)
            : null
          : revision.endDate;

      if ((updateDto.startDate !== undefined || updateDto.endDate !== undefined) && (!startDate || !endDate)) {
        throw new BadRequestException('กรุณาระบุวันที่เปิดและวันที่ปิดให้ครบถ้วน');
      }

      if (startDate && endDate && startDate >= endDate) {
        throw new BadRequestException('วันที่เปิดต้องน้อยกว่าวันที่ปิด');
      }

      if (updateDto.developmentPlanId) {
        const developmentPlan = await this.developmentPlanRepository.findOne({
          where: { id: updateDto.developmentPlanId },
        });
        if (!developmentPlan) {
          throw new NotFoundException(
            `Development Plan with ID ${updateDto.developmentPlanId} not found`,
          );
        }
        revision.developmentPlan = developmentPlan;
      }

      if (updateDto.revisionTypeId) {
        const revisionType = await this.revisionTypeRepository.findOne({
          where: { id: updateDto.revisionTypeId },
        });
        if (!revisionType) {
          throw new NotFoundException(
            `Revision Type with ID ${updateDto.revisionTypeId} not found`,
          );
        }
        revision.revisionType = revisionType;
      }

      // Validate date overlapping with other revisions of the same type
      if (startDate && endDate) {
        await this.ensureNoDateOverlap(
          revision.developmentPlan.id,
          revision.revisionType.id,
          startDate,
          endDate,
          revision.id,
        );
      }

      // ถ้ามีการเปิดรอบ (isOpen = true) ให้ปิดรอบอื่นที่เปิดอยู่
      if (updateDto.isOpen === true && !revision.isOpen) {
        const currentRevisionTypeId = revision.revisionType.id;
        await this.revisionRepository.update(
          {
            developmentPlan: { id: revision.developmentPlan.id },
            revisionType: { id: currentRevisionTypeId },
            isOpen: true,
          },
          { isOpen: false },
        );
      }

      // If setting as latest, unset other latest revisions for this development plan with same revision type
      if (updateDto.isLatest === true && !revision.isLatest) {
        const currentRevisionTypeId = revision.revisionType.id;
        await this.revisionRepository.update(
          {
            developmentPlan: { id: revision.developmentPlan.id },
            revisionType: { id: currentRevisionTypeId },
            isLatest: true,
          },
          { isLatest: false },
        );
      }

      if (updateDto.description !== undefined) revision.description = updateDto.description;
      if (updateDto.isLatest !== undefined) revision.isLatest = updateDto.isLatest;
      if (updateDto.isOpen !== undefined) revision.isOpen = updateDto.isOpen;
      if (updateDto.startDate !== undefined) revision.startDate = startDate;
      if (updateDto.endDate !== undefined) revision.endDate = endDate;

      return await this.revisionRepository.save(revision);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async softRemove(
    id: string,
    userId: string,
    citizenIdSuffix: string,
  ): Promise<{ message: string }> {
    try {
      const user = await this.usersService.findOne(userId);
      if (!user || !user.citizenId) {
        throw new NotFoundException('User not found or citizen ID is missing');
      }

      const userCitizenIdSuffix = user.citizenId.slice(-6);
      if (userCitizenIdSuffix !== citizenIdSuffix) {
        throw new UnauthorizedException('Citizen ID suffix does not match');
      }

      const revision = await this.revisionRepository.findOne({
        where: { id },
        relations: ['developmentPlan', 'revisionType'],
      });
      if (!revision) {
        throw new NotFoundException(
          `DevelopmentPlanRevision with ID ${id} not found`,
        );
      }

      // ถ้าที่ลบเป็น isLatest ให้ตั้งอันก่อนหน้า (จัดกลุ่ม revisionType เดียวกัน เรียงตามวันที่ เอาอันที่ล่าสุด) เป็น isLatest
      // ถ้าไม่ใช่ isLatest ไม่ต้อง set อะไร
      if (revision.isLatest) {
        const previousRevision = await this.revisionRepository.findOne({
          where: {
            id: Not(id),
            developmentPlan: { id: revision.developmentPlan.id },
            revisionType: { id: revision.revisionType.id },
          },
          order: { createdAt: 'DESC' },
        });
        if (previousRevision) {
          await this.revisionRepository.update(
            { id: previousRevision.id },
            { isLatest: true },
          );
        }
        revision.isLatest = false;
      }

      // Set deletedBy (ผู้ลบ)
      const workHistory = await this.workHistoryRepository.findOne({
        where: { user: { id: userId }, workStatus: { name: 'approved' } },
      });
      if (workHistory) {
        revision.deletedBy = workHistory;
      }

      await this.revisionRepository.save(revision);
      await this.revisionRepository.softRemove(revision);

      this.logger.log(`Development plan revision ${id} soft-deleted by user ${userId}`);
      return {
        message: `DevelopmentPlanRevision with ID ${id} has been soft-removed.`,
      };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async updateOpenState(id: string, isOpen: boolean): Promise<DevelopmentPlanRevision> {
    try {
      const revision = await this.revisionRepository.findOne({
        where: { id },
        relations: ['developmentPlan', 'revisionType'],
      });

      if (!revision) {
        throw new NotFoundException(
          `DevelopmentPlanRevision with ID ${id} not found`,
        );
      }

      if (isOpen && !revision.isOpen) {
        await this.revisionRepository.update(
          {
            developmentPlan: { id: revision.developmentPlan.id },
            revisionType: { id: revision.revisionType.id },
            isOpen: true,
          },
          { isOpen: false },
        );
      }

      revision.isOpen = isOpen;
      return await this.revisionRepository.save(revision);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  // ===================================================================
  // 📘 2. Book Generation & Management (สร้าง/ยกเลิกเล่มอนุมัติ)
  // ===================================================================

  /**
   * สร้างเล่มอนุมัติสำหรับ "การแก้ไข" (Edit Revision)
   */
  async generateApprovedBookForEditRevision(developmentPlanRevisionId: string, userId: string) {
    try {
      const revision = await this.revisionRepository.findOne({
        where: { id: developmentPlanRevisionId },
        relations: ['developmentPlan', 'revisionType'],
      });
      if (!revision) {
        throw new NotFoundException(`Development Plan Revision with ID ${developmentPlanRevisionId} not found`);
      }

      const developmentPlanId = revision.developmentPlan.id;

      // Send progress: Starting (10%)
      await this.websocketService.notifyPdfGenerationProgress({
        userId,
        developmentPlanId: developmentPlanRevisionId,
        progress: {
          percentage: 10,
          stage: 'starting',
          message: 'กำลังเริ่มต้นสร้างเล่ม PDF...',
        },
      });

      // Send progress: Querying projects (20%)
      await this.websocketService.notifyPdfGenerationProgress({
        userId,
        developmentPlanId: developmentPlanRevisionId,
        progress: {
          percentage: 20,
          stage: 'querying',
          message: 'กำลังค้นหาโครงการที่อนุมัติแล้ว...',
        },
      });

      // Query revised projects (RevisedProjectGroup) สำหรับ revision นี้
      const revisedProjects = await this.revisedProjectGroupRepository
        .createQueryBuilder('revisedProject')
        .leftJoinAndSelect('revisedProject.developmentPlanRevision', 'developmentPlanRevision')
        .leftJoinAndSelect('developmentPlanRevision.developmentPlan', 'developmentPlan')
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
        .where('developmentPlanRevision.id = :developmentPlanRevisionId', { developmentPlanRevisionId })
        .andWhere('revisedProject.responsibleAgency IS NOT NULL')
        .andWhere('revisedProject.isBooked = :isBooked', { isBooked: false })
        .andWhere('trackingStatus.isLatest = :isLatest', { isLatest: true })
        .andWhere('status.name = :statusName', { statusName: 'Approved' })
        .andWhere('revisedProject.deletedAt IS NULL')
        .orderBy('strategy.id', 'ASC')
        .getMany();

      // Convert to unified format
      const allProjects = revisedProjects.map(p => UnifiedProjectMapper.fromRevisedProjectGroup(p));

      // Send progress: Preparing data (30%)
      await this.websocketService.notifyPdfGenerationProgress({
        userId,
        developmentPlanId: developmentPlanRevisionId,
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
        developmentPlanId: developmentPlanRevisionId,
        progress: {
          percentage: 40,
          stage: 'generating',
          message: 'กำลังสร้างไฟล์ PDF...',
        },
      });

      const { buffer: pdfBuffer, pageMap } = await this.pdfService.generateRevisionApprovedReportWithPageTracking(
        developmentPlanRevisionId,
        ['index', 'title', 'objective', 'target', 'budget', 'expectedResult', 'mainAgency'],
      );

      // Send progress: PDF generated (70%)
      await this.websocketService.notifyPdfGenerationProgress({
        userId,
        developmentPlanId: developmentPlanRevisionId,
        progress: {
          percentage: 70,
          stage: 'generated',
          message: 'สร้างไฟล์ PDF สำเร็จ กำลังบันทึก...',
        },
      });

      // Separate revised project IDs
      const revisedProjectIds: string[] = [];
      
      allProjects.forEach((p) => {
          revisedProjectIds.push(p.id);
      });

      const allProjectIds = [ ...revisedProjectIds];

      // Send progress: Saving to database (80%)
      await this.websocketService.notifyPdfGenerationProgress({
        userId,
        developmentPlanId: developmentPlanRevisionId,
        progress: {
          percentage: 80,
          stage: 'saving',
          message: 'กำลังบันทึกข้อมูลลงฐานข้อมูล...',
        },
      });

      const saved = await this.pdfService.saveRevisionEditApprovedPdfAndMeta({
        developmentPlanId,
        developmentPlanRevisionId,
        pdfBuffer,
        projectIdsSnapshot: allProjectIds,
        createdById: userId,
        editNo: revision.revisionNumber,
        pageMap,
      });

      // Mark revised projects as booked
      if (revisedProjectIds.length > 0) {
        await this.revisedProjectGroupRepository.update(
          { id: In(revisedProjectIds) },
          { isBooked: true, bookedAt: new Date() }
        );
      }

      // Ensure DevelopmentPlanRevision is marked as booked
      if (!revision.isBooked) {
        await this.revisionRepository.update({ id: developmentPlanRevisionId }, { isBooked: true });
      }

      // Send progress: Completed (100%)
      await this.websocketService.notifyPdfGenerationProgress({
        userId,
        developmentPlanId: developmentPlanRevisionId,
        progress: {
          percentage: 100,
          stage: 'completed',
          message: 'สร้างเล่ม PDF สำเร็จแล้ว!',
        },
      });

      return saved;
    } catch (error) {
      // Send error notification via websocket before throwing
      try {
        let errorMessage = 'เกิดข้อผิดพลาดในการสร้างเล่ม PDF';
        if (error instanceof HttpException) {
          const response = error.getResponse();
          errorMessage = typeof response === 'string' ? response : (response as any)?.message || errorMessage;
        } else if (error instanceof Error) {
          errorMessage = error.message || errorMessage;
        }
        
        await this.websocketService.notifyPdfGenerationProgress({
          userId,
          developmentPlanId: developmentPlanRevisionId,
          progress: {
            percentage: 0,
            stage: 'error',
            message: errorMessage,
          },
        });
      } catch (wsError) {
        this.logger.error('Failed to send error notification via websocket', wsError);
      }
      handleException(this.logger, error);
    }
  }

  /**
   * สร้างเล่มอนุมัติสำหรับ "การเปลี่ยนแปลง" (Change Revision)
   */
  async generateApprovedBookForChangeRevision(developmentPlanRevisionId: string, userId: string) {
    try {
      const revision = await this.revisionRepository.findOne({
        where: { id: developmentPlanRevisionId },
        relations: ['developmentPlan', 'revisionType'],
      });
      if (!revision) {
        throw new NotFoundException(`Development Plan Revision with ID ${developmentPlanRevisionId} not found`);
      }

      const developmentPlanId = revision.developmentPlan.id;

      // Send progress: Starting (10%)
      await this.websocketService.notifyPdfGenerationProgress({
        userId,
        developmentPlanId: developmentPlanRevisionId,
        progress: {
          percentage: 10,
          stage: 'starting',
          message: 'กำลังเริ่มต้นสร้างเล่ม PDF...',
        },
      });

      // Send progress: Querying projects (20%)
      await this.websocketService.notifyPdfGenerationProgress({
        userId,
        developmentPlanId: developmentPlanRevisionId,
        progress: {
          percentage: 20,
          stage: 'querying',
          message: 'กำลังค้นหาโครงการที่อนุมัติแล้ว...',
        },
      });

      // Query revised projects (RevisedProjectGroup) สำหรับ revision นี้
      const revisedProjects = await this.revisedProjectGroupRepository
        .createQueryBuilder('revisedProject')
        .leftJoinAndSelect('revisedProject.developmentPlanRevision', 'developmentPlanRevision')
        .leftJoinAndSelect('developmentPlanRevision.developmentPlan', 'developmentPlan')
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
        .where('developmentPlanRevision.id = :developmentPlanRevisionId', { developmentPlanRevisionId })
        .andWhere('revisedProject.responsibleAgency IS NOT NULL')
        .andWhere('revisedProject.isBooked = :isBooked', { isBooked: false })
        .andWhere('trackingStatus.isLatest = :isLatest', { isLatest: true })
        .andWhere('status.name = :statusName', { statusName: 'Approved' })
        .andWhere('revisedProject.deletedAt IS NULL')
        .orderBy('strategy.id', 'ASC')
        .getMany();

      // Convert to unified format
      const allProjects = revisedProjects.map(p => UnifiedProjectMapper.fromRevisedProjectGroup(p));

      // Send progress: Preparing data (30%)
      await this.websocketService.notifyPdfGenerationProgress({
        userId,
        developmentPlanId: developmentPlanRevisionId,
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
        developmentPlanId: developmentPlanRevisionId,
        progress: {
          percentage: 40,
          stage: 'generating',
          message: 'กำลังสร้างไฟล์ PDF...',
        },
      });

      const { buffer: pdfBuffer, pageMap } = await this.pdfService.generateRevisionApprovedReportWithPageTracking(
        developmentPlanRevisionId,
        ['index', 'title', 'objective', 'target', 'budget', 'expectedResult', 'mainAgency'],
      );

      // Send progress: PDF generated (70%)
      await this.websocketService.notifyPdfGenerationProgress({
        userId,
        developmentPlanId: developmentPlanRevisionId,
        progress: {
          percentage: 70,
          stage: 'generated',
          message: 'สร้างไฟล์ PDF สำเร็จ กำลังบันทึก...',
        },
      });

      // Separate revised project IDs
      const revisedProjectIds: string[] = [];
      
      allProjects.forEach((p) => {
          revisedProjectIds.push(p.id);
      });

      const allProjectIds = [ ...revisedProjectIds];

      // Send progress: Saving to database (80%)
      await this.websocketService.notifyPdfGenerationProgress({
        userId,
        developmentPlanId: developmentPlanRevisionId,
        progress: {
          percentage: 80,
          stage: 'saving',
          message: 'กำลังบันทึกข้อมูลลงฐานข้อมูล...',
        },
      });

      const saved = await this.pdfService.saveRevisionChangeApprovedPdfAndMeta({
        developmentPlanId,
        developmentPlanRevisionId,
        pdfBuffer,
        projectIdsSnapshot: allProjectIds,
        createdById: userId,
        changeNo: revision.revisionNumber,
        pageMap,
      });

      // Mark revised projects as booked
      if (revisedProjectIds.length > 0) {
        await this.revisedProjectGroupRepository.update(
          { id: In(revisedProjectIds) },
          { isBooked: true, bookedAt: new Date() }
        );
      }

      // Ensure DevelopmentPlanRevision is marked as booked
      if (!revision.isBooked) {
        await this.revisionRepository.update({ id: developmentPlanRevisionId }, { isBooked: true });
      }

      // Send progress: Completed (100%)
      await this.websocketService.notifyPdfGenerationProgress({
        userId,
        developmentPlanId: developmentPlanRevisionId,
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
  
  /**
   * ยกเลิกการออกเล่ม (Rollback Book)
   * - ยกเลิกสถานะ Booked ของโครงการและ Revision
   * - Deprecate ไฟล์ PDF
   */
  async rollbackBook(developmentPlanRevisionId: string, userId: string): Promise<{ message: string }> {
    try {
      const revision = await this.revisionRepository.findOne({
        where: { id: developmentPlanRevisionId },
        relations: ['developmentPlan'],
      });
      if (!revision) {
        throw new NotFoundException(`Development Plan Revision with ID ${developmentPlanRevisionId} not found`);
      }

      if (!revision.isBooked) {
        throw new BadRequestException(`Development Plan Revision with ID ${developmentPlanRevisionId} is not booked yet`);
      }

      const developmentPlanId = revision.developmentPlan.id;

      // Get all RevisedProjectGroups that are booked for this revision
      const bookedProjects = await this.revisedProjectGroupRepository.find({
        where: {
          developmentPlanRevision: { id: developmentPlanRevisionId },
          isBooked: true,
        },
        select: ['id'],
      });

      const projectIds = bookedProjects.map((p) => p.id);

      // Set all RevisedProjectGroup.isBooked = false for this revision
      if (projectIds.length > 0) {
        await this.revisedProjectGroupRepository.update(
          { id: In(projectIds) },
          { isBooked: false, bookedAt: null, pageNumber: null },
        );
      }

      // Set DevelopmentPlanRevision.isBooked = false
      await this.revisionRepository.update(
        { id: developmentPlanRevisionId },
        { isBooked: false },
      );

      this.logger.log(
        `Rollback book for development plan revision ${developmentPlanRevisionId} by user ${userId}. Unbooked ${projectIds.length} projects.`,
      );

      return {
        message: `เล่มแก้ไข/เปลี่ยนแปลงถูกยกเลิกแล้ว (Rollback สำเร็จ). ยกเลิกการจอง ${projectIds.length} โครงการ)`,
      };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  // ===================================================================
  // 🛠️ 3. Helpers & Validations (Private)
  // ===================================================================

  private async ensureNoDateOverlap(
    developmentPlanId: string,
    revisionTypeId: string,
    newStartDate: Date,
    newEndDate: Date,
    excludeRevisionId?: string,
  ) {
    const qb = this.revisionRepository
      .createQueryBuilder('revision')
      .leftJoin('revision.developmentPlan', 'developmentPlan')
      .leftJoin('revision.revisionType', 'revisionType')
      .where('developmentPlan.id = :developmentPlanId', { developmentPlanId })
      .andWhere('revisionType.id = :revisionTypeId', { revisionTypeId })
      .andWhere('revision.startDate IS NOT NULL')
      .andWhere('revision.endDate IS NOT NULL')
      // เช็ค overlap เฉพาะรอบที่เปิดอยู่ หรือรอบที่ปิดแต่ยังไม่ booked
      // ไม่ต้องเช็ครอบที่ปิดแล้วและ booked แล้ว (isOpen = false AND isBooked = true)
      .andWhere('(revision.isOpen = :isOpen OR (revision.isOpen = :isOpenFalse AND revision.isBooked = :isBookedFalse))', {
        isOpen: true,
        isOpenFalse: false,
        isBookedFalse: false,
      });

    if (excludeRevisionId) {
      qb.andWhere('revision.id != :excludeRevisionId', { excludeRevisionId });
    }

    const revisions = await qb.select(['revision.id', 'revision.startDate', 'revision.endDate', 'revision.isOpen', 'revision.isBooked']).getMany();

    const hasOverlap = revisions.some((rev) => {
      if (!rev.startDate || !rev.endDate) {
        return false;
      }
      const existingStart = new Date(rev.startDate);
      const existingEnd = new Date(rev.endDate);
      return newStartDate < existingEnd && newEndDate > existingStart;
    });

    if (hasOverlap) {
      throw new BadRequestException('ช่วงวันที่เปิด-ปิดซ้อนกับรอบก่อนในประเภทเดียวกัน');
    }
  }
}
