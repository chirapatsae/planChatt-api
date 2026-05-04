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
import { UsersService } from '../users/users.service';
import { maskEmail } from '../notifications/email/utils/mask-email.util';

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
    private readonly usersService: UsersService,
  ) { }

  /**
   * W100 PR6 — Mask `WorkHistory.user` PII on government-agency
   * responsibility-table reads (cluster B6). Pattern 3 (mask) per master
   * plan §1 decision rule. Decrypts via `UsersService.decryptUserPii`
   * (idempotent post-W89B) then applies `maskEmail`. `phone` and
   * `citizenId` are nulled per default #5.
   */
  private async maskUsersOnResponsibilities(
    rows: Array<WorkHistoryGovernmentAgencyResponsibility | undefined | null>,
  ): Promise<void> {
    for (const row of rows) {
      if (!row) continue;
      const wh = row.workHistory;
      if (wh?.user) {
        await this.usersService.decryptUserPii(wh.user);
        wh.user.email = wh.user.email
          ? maskEmail(wh.user.email)
          : (null as unknown as string);
        wh.user.phone = null as unknown as string;
        wh.user.citizenId = null as unknown as string;
      }
      const assignedWh = (row as any).assignedByWorkHistory as
        | WorkHistory
        | undefined;
      if (assignedWh?.user) {
        await this.usersService.decryptUserPii(assignedWh.user);
        assignedWh.user.email = assignedWh.user.email
          ? maskEmail(assignedWh.user.email)
          : (null as unknown as string);
        assignedWh.user.phone = null as unknown as string;
        assignedWh.user.citizenId = null as unknown as string;
      }
    }
  }

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

      const rows = await this.responsibilityRepository.find({
        where,
        relations: [
          'workHistory',
          'workHistory.user',
          'governmentAgency',
          'assignedByWorkHistory',
        ],
      });
      // W100 PR6 — admin assignment list. Default #3 (mask).
      await this.maskUsersOnResponsibilities(rows);
      return rows;
    } catch (error) {
      handleException(this.logger, error);
    }
  }
  async findOneByAgency(id: string, userId: string): Promise<WorkHistoryGovernmentAgencyResponsibility> {
    try {
      const exitUser = await this.userRepository.findOneBy({ id: userId });
      if (!exitUser) {
        throw new NotFoundException(`ไม่พบผู้ใช้ที่ ID ${id}`);
      }
      const responsibility = await this.responsibilityRepository.findOne({
        where: { governmentAgency: { id } },
        relations: [
          'workHistory',
          'workHistory.user',
          'workHistory.localAdministrativeOrganization',
          'workHistory.governmentAgencies'
        ],
        select: {
          id: true,
          workHistory: {
            id: true,
            user: {
              id: true,
              firstname: true,
              lastname: true,
              prefix: true,
              email: true,
            },
            localAdministrativeOrganization: true,
            governmentAgencies: true
          }
        }
      });
      if (!responsibility) {
        throw new NotFoundException(`ไม่พบความรับผิดชอบที่ ID ${id}`);
      }
      // W100 PR6 — agency assignment lookup. Default #3 (mask).
      await this.maskUsersOnResponsibilities([responsibility]);
      return responsibility;
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
      // W100 PR6 — admin assignment detail. Default #3 (mask).
      await this.maskUsersOnResponsibilities([responsibility]);
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

      // W100 PR6 — mask user PII on the post-update response so the
      // admin assignment screen never receives W89 ciphertext.
      await this.maskUsersOnResponsibilities([updated]);

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
