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
  UpdateWorkHistoryAmphoeResponsibilityDto,
  TransferResponsibilityDto,
} from './dto/update-work-history-amphoe-responsibility.dto';
import { WorkHistoryAmphoeResponsibility } from './entities/work-history-amphoe-responsibility.entity';
import { WorkHistory } from '../work-history/entities/work-history.entity';
import { Amphoe } from '../amphoes/entities/amphoe.entity';
import { User } from '../users/entities/user.entity';
import { handleException } from '../util/handleException';

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
  ) {}

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
        workHistory.role?.name !== 'admin'
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

      return this.responsibilityRepository.find({
        where,
        relations: [
          'workHistory',
          'workHistory.user',
          'amphoe',
          'assignedByWorkHistory',
        ],
      });
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
      return responsibility;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async update(
    id: string,
    dto: UpdateWorkHistoryAmphoeResponsibilityDto,
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

      // เตรียม object update
      const updatePayload: Partial<WorkHistoryAmphoeResponsibility> = {
        id,
        assignedByWorkHistory,
        amphoe: dto.amphoeId ? ({ id: dto.amphoeId } as any) : undefined,
      };

      // ถ้ามีการเปลี่ยน workHistory
      if (dto.workHistoryId) {
        const newWorkHistory = await this.workHistoryRepository.findOne({
          where: { id: dto.workHistoryId },
        });
        if (!newWorkHistory)
          throw new NotFoundException(
            'Work history you want to transfer to not found',
          );
        updatePayload.workHistory = newWorkHistory;
      }

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
