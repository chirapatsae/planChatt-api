import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateWorkHistoryAmphoeResponsibilityDto } from './dto/create-work-history-amphoe-responsibility.dto';
import { UpdateWorkHistoryAmphoeResponsibilityDto, TransferResponsibilityDto } from './dto/update-work-history-amphoe-responsibility.dto';
import { WorkHistoryAmphoeResponsibility } from './entities/work-history-amphoe-responsibility.entity';
import { WorkHistory } from '../work-history/entities/work-history.entity';
import { Amphoe } from '../amphoes/entities/amphoe.entity';
import { User } from '../users/entities/user.entity';
import { handleException } from '../util/handleException';

@Injectable()
export class WorkHistoryAmphoeResponsibilityService {
  private readonly logger = new Logger(WorkHistoryAmphoeResponsibilityService.name);

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

  async create(dto: CreateWorkHistoryAmphoeResponsibilityDto, assignedByUserId?: string): Promise<WorkHistoryAmphoeResponsibility> {
    try {
      const workHistory = await this.workHistoryRepository.findOne({
        where: { id: dto.workHistoryId },
        relations: ['role', 'workStatus'],
      });
      if (!workHistory) throw new NotFoundException(`Work history with ID ${dto.workHistoryId} not found`);
      
      // Check if work history is approved and user has admin role
      if (workHistory.workStatus?.name !== 'approved' || workHistory.role?.name !== 'admin') {
        throw new BadRequestException('Responsibilities can only be added to an approved admin work history.');
      }
      
      const amphoe = await this.amphoeRepository.findOneBy({ id: dto.amphoeId });
      if (!amphoe) throw new NotFoundException(`Amphoe with ID ${dto.amphoeId} not found`);

      const existing = await this.responsibilityRepository.findOneBy({
        workHistory: { id: dto.workHistoryId },
        amphoe: { id: dto.amphoeId },
      });
      if (existing) throw new BadRequestException('This responsibility already exists.');
      
      let assignedByWorkHistory: WorkHistory | undefined = undefined;
      if (assignedByUserId) {
        const foundWorkHistory = await this.workHistoryRepository.findOne({
          where: { user: { id: assignedByUserId } },
          relations: ['workStatus'],
        });
        if (!foundWorkHistory || foundWorkHistory.workStatus?.name !== 'approved') {
          throw new NotFoundException(`Approved work history not found for user ${assignedByUserId}`);
        }
        assignedByWorkHistory = foundWorkHistory;
      }
      
      const responsibility = this.responsibilityRepository.create({ workHistory, amphoe, assignedByWorkHistory });
      return await this.responsibilityRepository.save(responsibility);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findAll(): Promise<WorkHistoryAmphoeResponsibility[]> {
    try {
      return this.responsibilityRepository.find({
        relations: ['workHistory', 'workHistory.user', 'amphoe', 'assignedByWorkHistory'],
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findOne(id: string): Promise<WorkHistoryAmphoeResponsibility> {
    try {
      const responsibility = await this.responsibilityRepository.findOne({
        where: { id },
        relations: ['workHistory', 'workHistory.user', 'amphoe', 'assignedByWorkHistory'],
      });
      if (!responsibility) {
        throw new NotFoundException(`Responsibility with ID ${id} not found`);
      }
      return responsibility;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async update(id: string, dto: UpdateWorkHistoryAmphoeResponsibilityDto): Promise<WorkHistoryAmphoeResponsibility> {
    try {
      const responsibility = await this.responsibilityRepository.preload({ id, ...dto });
      if (!responsibility) {
        throw new NotFoundException(`Responsibility with ID ${id} not found`);
      }
      return await this.responsibilityRepository.save(responsibility);
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

  async getResponsibilitiesByWorkHistory(workHistoryId: string): Promise<WorkHistoryAmphoeResponsibility[]> {
    try {
      return this.responsibilityRepository.find({
        where: { workHistory: { id: workHistoryId } },
        relations: ['amphoe'],
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }
  
  async getResponsibilitiesByAmphoe(amphoeId: string): Promise<WorkHistoryAmphoeResponsibility[]> {
    try {
      return this.responsibilityRepository.find({
        where: { amphoe: { id: amphoeId } },
        relations: ['workHistory', 'workHistory.user'],
      });
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async transferResponsibility(responsibilityId: string, newWorkHistoryId: string, assignedByUserId: string): Promise<any> {
    try {
      const responsibility = await this.responsibilityRepository.findOne({
        where: { id: responsibilityId },
        relations: ['workHistory', 'amphoe'],
      });
      if (!responsibility) {
        throw new NotFoundException(`Responsibility with ID ${responsibilityId} not found`);
      }

      const newWorkHistory = await this.workHistoryRepository.findOne({
        where: { id: newWorkHistoryId },
        relations: ['user'],
      });
      if (!newWorkHistory) {
        throw new NotFoundException(`New work history with ID ${newWorkHistoryId} not found`);
      }

      const assignedByWorkHistory = await this.workHistoryRepository.findOne({
        where: { user: { id: assignedByUserId } },
        relations: ['workStatus'],
      });
      if (!assignedByWorkHistory || assignedByWorkHistory.workStatus?.name !== 'approved') {
        throw new NotFoundException(`Approved work history not found for user ${assignedByUserId}`);
      }
      if (!assignedByWorkHistory) {
        throw new NotFoundException(`Approved work history not found for user ${assignedByUserId}`);
      }

      // Remove old responsibility
      await this.responsibilityRepository.remove(responsibility);

      // Create new responsibility
      const newResponsibility = this.responsibilityRepository.create({
        workHistory: newWorkHistory,
        amphoe: responsibility.amphoe,
        assignedByWorkHistory,
      });

      return await this.responsibilityRepository.save(newResponsibility);
    } catch (error) {
      handleException(this.logger, error);
    }
  }
}
