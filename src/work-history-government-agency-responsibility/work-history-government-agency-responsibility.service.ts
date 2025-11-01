import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, Repository } from 'typeorm';
import { CreateWorkHistoryGovernmentAgencyResponsibilityDto } from './dto/create-work-history-government-agency-responsibility.dto';
import {
  UpdateWorkHistoryGovernmentAgencyResponsibilityDto,
} from './dto/update-work-history-government-agency-responsibility.dto';
import { WorkHistoryGovernmentAgencyResponsibility } from './entities/work-history-government-agency-responsibility.entity';
import { WorkHistory } from '../work-history/entities/work-history.entity';
import { GovernmentAgency } from '../government-agencies/entities/government-agency.entity';
import { User } from '../users/entities/user.entity';
import { handleException } from '../util/handleException';

//หลัง test ต้องแก้คน assign เป็น admin เท่านั้น
@Injectable()
export class WorkHistoryGovernmentAgencyResponsibilityService {
  private readonly logger = new Logger(
    WorkHistoryGovernmentAgencyResponsibilityService.name,
  );

  constructor(
    @InjectRepository(WorkHistoryGovernmentAgencyResponsibility)
    private readonly responsibilityRepository: Repository<WorkHistoryGovernmentAgencyResponsibility>,
    @InjectRepository(WorkHistory)
    private readonly workHistoryRepository: Repository<WorkHistory>,
    @InjectRepository(GovernmentAgency)
    private readonly governmentAgencyRepository: Repository<GovernmentAgency>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  async create(
    dto: CreateWorkHistoryGovernmentAgencyResponsibilityDto,
    assignedByUserId?: string,
  ): Promise<WorkHistoryGovernmentAgencyResponsibility> {
    try {
      const workHistory = await this.workHistoryRepository.findOne({
        where: { id: dto.workHistoryId },
        relations: ['role', 'workStatus'],
      });
      if (!workHistory)
        throw new NotFoundException(
          `ไม่พบประวัติการทำงานที่ ID ${dto.workHistoryId}`,
        );

      if (
        workHistory.workStatus?.name !== 'approved' ||
        workHistory.role?.name !== 'staff'
      ) {
        throw new BadRequestException(
          'สามารถมอบหมายความรับผิดชอบได้เฉพาะกับประวัติการทำงานที่มีสถานะอนุมัติและตำแหน่งพนักงานเท่านั้น',
        );
      }

      const governmentAgency = await this.governmentAgencyRepository.findOneBy({
        id: dto.governmentAgencyId,
      });
      if (!governmentAgency)
        throw new NotFoundException(`ไม่พบหน่วยงานรัฐบาลที่ ID ${dto.governmentAgencyId}`);

      const existing = await this.responsibilityRepository.findOneBy({
        workHistory: { id: dto.workHistoryId },
        governmentAgency: { id: dto.governmentAgencyId },
      });
      if (existing)
        throw new BadRequestException('ความรับผิดชอบนี้มีอยู่แล้ว');

      const assignedByWorkHistory = await this.workHistoryRepository.findOne({
        where: { user: { id: assignedByUserId } },
        relations: ['workStatus', 'role'],
      });
      if (
        !assignedByWorkHistory ||
        assignedByWorkHistory.workStatus?.name !== 'approved' ||
        (assignedByWorkHistory.role?.name !== 'admin' && assignedByWorkHistory.role?.name !== 'staff')
      ) {
        throw new NotFoundException(
          `ไม่พบประวัติการทำงานที่อนุมัติและมีสิทธิ์เป็นผู้ดูแลระบบหรือพนักงานสำหรับผู้ใช้ ${assignedByUserId}`,
        );
      }

      const responsibility = this.responsibilityRepository.create({
        workHistory,
        governmentAgency,
        assignedByWorkHistory,
      });
      return await this.responsibilityRepository.save(responsibility);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findAll(
    governmentAgencyId?: string,
    workHistoryId?: string,
  ): Promise<WorkHistoryGovernmentAgencyResponsibility[]> {
    try {
      const where: FindOptionsWhere<WorkHistoryGovernmentAgencyResponsibility> = {};

      if (governmentAgencyId) {
        where.governmentAgency = { id: governmentAgencyId };
      }

      if (workHistoryId) {
        where.workHistory = { id: workHistoryId };
      }

      return this.responsibilityRepository.find({
        where,
        relations: [
          'workHistory',
          'workHistory.user',
          'governmentAgency',
          'assignedByWorkHistory',
        ],
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findOne(id: string): Promise<WorkHistoryGovernmentAgencyResponsibility> {
    try {
      const responsibility = await this.responsibilityRepository.findOne({
        where: { id },
        relations: [
          'workHistory',
          'workHistory.user',
          'governmentAgency',
          'assignedByWorkHistory',
          'assignedByWorkHistory.user',
        ],
      });
      if (!responsibility) {
        throw new NotFoundException(`ไม่พบความรับผิดชอบที่ ID ${id}`);
      }
      return responsibility;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async update(
    id: string,
    dto: UpdateWorkHistoryGovernmentAgencyResponsibilityDto,
    assignedByUserId?: string,
  ): Promise<WorkHistoryGovernmentAgencyResponsibility> {
    try {
      const assignedByWorkHistory = await this.workHistoryRepository.findOne({
        where: { user: { id: assignedByUserId } },
        relations: ['workStatus', 'role'],
      });

      if (
        !assignedByWorkHistory ||
        assignedByWorkHistory.workStatus?.name !== 'approved' ||
        (assignedByWorkHistory.role?.name !== 'admin' && assignedByWorkHistory.role?.name !== 'staff')
      ) {
        throw new NotFoundException(
          `ไม่พบประวัติการทำงานที่อนุมัติและมีสิทธิ์เป็นผู้ดูแลระบบหรือพนักงานสำหรับผู้ใช้ ${assignedByUserId}`,
        );
      }

      // เตรียม object update
      const updatePayload: Partial<WorkHistoryGovernmentAgencyResponsibility> = {
        id,
        assignedByWorkHistory,
        governmentAgency: dto.governmentAgencyId ? ({ id: dto.governmentAgencyId } as any) : undefined,
      };

      // ถ้ามีการเปลี่ยน workHistory
      if (dto.workHistoryId) {
        const newWorkHistory = await this.workHistoryRepository.findOne({
          where: { id: dto.workHistoryId },
        });
        if (!newWorkHistory)
          throw new NotFoundException(
            'ไม่พบประวัติการทำงานที่ต้องการโอนย้ายไป',
          );
        updatePayload.workHistory = newWorkHistory;
      }

      const responsibility =
        await this.responsibilityRepository.preload(updatePayload);
      if (!responsibility) {
        throw new NotFoundException(`ไม่พบความรับผิดชอบที่ ID ${id}`);
      }

      await this.responsibilityRepository.save(responsibility);

      const updated = await this.responsibilityRepository.findOne({
        where: { id },
        relations: [
          'governmentAgency',
          'workHistory',
          'workHistory.user',
          'assignedByWorkHistory',
          'assignedByWorkHistory.user',
        ],
      });

      if (!updated) {
        throw new NotFoundException(
          `ไม่พบความรับผิดชอบที่ ID ${id} หลังจากการอัปเดต`,
        );
      }

      return updated;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async remove(id: string): Promise<{ message: string }> {
    try {
      const result = await this.responsibilityRepository.delete(id);
      if (result.affected === 0) {
        throw new NotFoundException(`ไม่พบความรับผิดชอบที่ ID ${id}`);
      }
      return { message: `ลบความรับผิดชอบที่ ID ${id} เรียบร้อยแล้ว` };
    } catch (error) {
      handleException(this.logger, error);
    }
  }
}
