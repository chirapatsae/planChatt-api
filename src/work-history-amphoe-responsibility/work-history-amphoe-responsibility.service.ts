import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, Repository } from 'typeorm';
import { CreateWorkHistoryAmphoeResponsibilityDto } from './dto/create-work-history-amphoe-responsibility.dto';
import {
  TransferResponsibilityDto,
  UpdateWorkHistoryAmphoeResponsibilityDto,
} from './dto/update-work-history-amphoe-responsibility.dto';
import { WorkHistoryAmphoeResponsibility } from './entities/work-history-amphoe-responsibility.entity';
import { WorkHistory } from '../work-history/entities/work-history.entity';
import { Amphoe } from '../amphoes/entities/amphoe.entity';
import { User } from '../users/entities/user.entity';
import { handleException } from '../util/handleException';
import { UsersService } from '../users/users.service';
import { maskEmail } from '../notifications/email/utils/mask-email.util';

@Injectable()
export class WorkHistoryAmphoeResponsibilityService {
  private readonly logger = new Logger(
    WorkHistoryAmphoeResponsibilityService.name,
  );

  constructor(
    @InjectRepository(WorkHistoryAmphoeResponsibility)
    private readonly responsibilityRepository: Repository<WorkHistoryAmphoeResponsibility>,
    @InjectRepository(WorkHistory)
    private readonly workHistoryRepository: Repository<WorkHistory>,
    @InjectRepository(Amphoe)
    private readonly amphoeRepository: Repository<Amphoe>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly usersService: UsersService,
  ) { }

  /**
   * W100 PR6 — Mask `WorkHistory.user` PII on responsibility-table reads.
   * Cluster B6: amphoe-responsibility list/detail joins
   * `workHistory.user` and previously shipped W89 ciphertext to admin
   * assignment screens. Pattern 3 (mask) per master plan §1 decision rule
   * and the audit's recommendation column. Decrypts via
   * `UsersService.decryptUserPii` (idempotent post-W89B), then applies
   * `maskEmail`. `phone` and `citizenId` are nulled per default #5.
   */
  private async maskUsersOnResponsibilities(
    rows: Array<WorkHistoryAmphoeResponsibility | undefined | null>,
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
    dto: CreateWorkHistoryAmphoeResponsibilityDto,
    assignedByUserId?: string,
  ): Promise<WorkHistoryAmphoeResponsibility> {
    try {
      const workHistory = await this.workHistoryRepository.findOne({
        where: { id: dto.workHistoryId },
        relations: ['role', 'workStatus'],
      });
      if (!workHistory)
        throw new NotFoundException(
          `Work history with ID ${dto.workHistoryId} not found`,
        );

      if (
        workHistory.workStatus?.name !== 'approved' ||
        workHistory.role?.name !== 'staff'
      ) {
        throw new BadRequestException(
          'Responsibilities can only be added to an approved admin work history.',
        );
      }

      const amphoe = await this.amphoeRepository.findOneBy({
        id: dto.amphoeId,
      });
      if (!amphoe)
        throw new NotFoundException(`Amphoe with ID ${dto.amphoeId} not found`);

      const existing = await this.responsibilityRepository.findOneBy({
        workHistory: { id: dto.workHistoryId },
        amphoe: { id: dto.amphoeId },
      });
      if (existing)
        throw new BadRequestException('This responsibility already exists.');

      const assignedByWorkHistory = await this.workHistoryRepository.findOne({
        where: { user: { id: assignedByUserId } },
        relations: ['workStatus', 'role'],
      });
      if (
        !assignedByWorkHistory ||
        assignedByWorkHistory.workStatus?.name !== 'approved' ||
        assignedByWorkHistory.role?.name !== 'admin'
      ) {
        throw new NotFoundException(
          `Approved work history not pass the conditions for user ${assignedByUserId}`,
        );
      }

      const responsibility = this.responsibilityRepository.create({
        workHistory,
        amphoe,
        assignedByWorkHistory,
      });
      return await this.responsibilityRepository.save(responsibility);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findAll(
    amphoeId?: string,
    workHistoryId?: string,
  ): Promise<WorkHistoryAmphoeResponsibility[]> {
    try {
      const where: FindOptionsWhere<WorkHistoryAmphoeResponsibility> = {};

      if (amphoeId) {
        where.amphoe = { id: amphoeId };
      }

      if (workHistoryId) {
        where.workHistory = { id: workHistoryId };
      }

      const rows = await this.responsibilityRepository.find({
        where,
        relations: [
          'workHistory',
          'workHistory.user',
          'amphoe',
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

  async findOne(id: string): Promise<WorkHistoryAmphoeResponsibility> {
    try {
      const responsibility = await this.responsibilityRepository.findOne({
        where: { id },
        relations: [
          'workHistory',
          'workHistory.user',
          'amphoe',
          'assignedByWorkHistory',
          'assignedByWorkHistory.user',
        ],
      });
      if (!responsibility) {
        throw new NotFoundException(`Responsibility with ID ${id} not found`);
      }
      // W100 PR6 — admin assignment detail. Default #3 (mask) for
      // consistency with the list endpoint above.
      await this.maskUsersOnResponsibilities([responsibility]);
      return responsibility;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async update(
    id: string,
    dto: TransferResponsibilityDto,
    assignedByUserId?: string,
  ): Promise<WorkHistoryAmphoeResponsibility> {
    try {
      const assignedByWorkHistory = await this.workHistoryRepository.findOne({
        where: { user: { id: assignedByUserId } },
        relations: ['workStatus', 'role'],
      });

      if (
        !assignedByWorkHistory ||
        assignedByWorkHistory.workStatus?.name !== 'approved' ||
        assignedByWorkHistory.role?.name !== 'admin'
      ) {
        throw new NotFoundException(
          `Approved work history not pass the conditions for user ${assignedByUserId}`,
        );
      }
      const newWorkHistory = await this.workHistoryRepository.findOne({
        where: { id: dto.newWorkHistoryId },
      });
      if (!newWorkHistory)
        throw new NotFoundException(
          'Work history you want to transfer to not found',
        );
      // เตรียม object update
      const updatePayload: Partial<WorkHistoryAmphoeResponsibility> = {
        id,
        assignedByWorkHistory,
        workHistory: { id: newWorkHistory.id } as WorkHistory
      };


      const responsibility =
        await this.responsibilityRepository.preload(updatePayload);
      if (!responsibility) {
        throw new NotFoundException(`Responsibility with ID ${id} not found`);
      }

      await this.responsibilityRepository.save(responsibility);

      const updated = await this.responsibilityRepository.findOne({
        where: { id },
        relations: [
          'amphoe',
          'workHistory',
          'workHistory.user',
          'assignedByWorkHistory',
          'assignedByWorkHistory.user',
        ],
      });

      if (!updated) {
        throw new NotFoundException(
          `Responsibility with ID ${id} not found after update`,
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
        throw new NotFoundException(`Responsibility with ID ${id} not found`);
      }
      return { message: `Responsibility with ID ${id} has been deleted` };
    } catch (error) {
      handleException(this.logger, error);
    }
  }
}
