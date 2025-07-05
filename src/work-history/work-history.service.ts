import {
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  BadRequestException,
  HttpException,
  ForbiddenException,
} from '@nestjs/common';
import { CreateWorkHistoryDto } from './dto/create-work-history.dto';
import { UpdateWorkHistoryDto } from './dto/update-work-history.dto';
import { CreateWorkHistoryAmphoeResponsibilityDto } from './dto/create-work-history-amphoe-responsibility.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { WorkHistoryAmphoeResponsibility } from 'src/work-history/entities/work-history-amphoe-responsibility.entity';
import { User } from 'src/users/entities/user.entity';
import { LocalAdministrativeOrganization } from 'src/local-administrative-organizations/entities/local-administrative-organization.entity';
import { Amphoe } from 'src/amphoes/entities/amphoe.entity';
import { stat } from 'fs';

@Injectable()
export class WorkHistoryService {
  private readonly logger = new Logger(WorkHistoryService.name);

  constructor(
    @InjectRepository(WorkHistory)
    private readonly workHistoryRepository: Repository<WorkHistory>,
    @InjectRepository(WorkHistoryAmphoeResponsibility)
    private readonly responsibilityRepository: Repository<WorkHistoryAmphoeResponsibility>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(LocalAdministrativeOrganization)
    private readonly laoRepo: Repository<LocalAdministrativeOrganization>,
    @InjectRepository(Amphoe)
    private readonly amphoeRepo: Repository<Amphoe>,
  ) { }

  // ========================================
  // WORK HISTORY CRUD OPERATIONS
  // ========================================

  /**
   * Create a new work history for a user
   */
  async create(dto: CreateWorkHistoryDto): Promise<WorkHistory> {
    try {
      const user = await this.userRepository.findOneBy({ id: dto.userId });
      if (!user) throw new NotFoundException(`User with ID ${dto.userId} not found`);

      const existingAmphoe = await this.amphoeRepo.findOne({
        where: { id: dto.amphoeId },
      });
      if (!existingAmphoe) {
        throw new NotFoundException(`Amphoe not found with ID ${dto.amphoeId}`);
      }

      const existingLao = await this.laoRepo.findOne({
        where: { id: dto.localAdmistrativeOrganizationId },
      });
      if (!existingLao) {
        throw new NotFoundException(`LAO not found with ID ${dto.localAdmistrativeOrganizationId}`);
      }

      // Deactivate existing work history
      const existing = await this.workHistoryRepository.find({
        where: { user: { id: user.id } },
        relations: ['user'],
      });

      if (existing.length > 0) {
        await this.workHistoryRepository
          .createQueryBuilder()
          .update(WorkHistory)
          .set({ status: 'suspended' })
          .where('user_id = :userId', { userId: user.id })
          .execute();
      }

      // Create new work history
      const newHistory = this.workHistoryRepository.create({
        status: 'approved',
        user,
        amphoe: existingAmphoe,
        localAdministrativeOrganization: existingLao,
      });

      return await this.workHistoryRepository.save(newHistory);
    } catch (error) {
      this.logger.error('Error creating work history', error.stack);
      throw new InternalServerErrorException('Failed to create work history');
    }
  }

  /**
   * Get all work histories
   */
  async findAll(status?: string): Promise<WorkHistory[]> {
    try {
      const query = this.workHistoryRepository.createQueryBuilder('work_history')
        .leftJoinAndSelect('work_history.user', 'user')
        .leftJoinAndSelect('work_history.amphoe', 'workAmphoe')
        .leftJoinAndSelect('work_history.localAdministrativeOrganization', 'localAdministrativeOrganization')
        .leftJoinAndSelect('work_history.responsibilities', 'responsibilities')
        .leftJoinAndSelect('responsibilities.amphoe', 'amphoe')

      if (status) {
        query.andWhere('work_history.status = :status', { status });
      }
      return query.getMany()
    } catch (error) {
      this.logger.error('Error fetching all work histories', error.stack);
      throw new InternalServerErrorException('Failed to fetch work histories');
    }
  }

  /**
   * Get all work histories grouped by user
   */
  async findAllGroupedByUser(): Promise<
    { userId: string; email: string; phone: string; histories: WorkHistory[] }[]
  > {
    try {
      const all = await this.workHistoryRepository.find({
        relations: ['user', 'responsibilities', 'responsibilities.amphoe'],
      });

      const groupedMap = new Map<
        string,
        { userId: string; email: string; phone: string; histories: WorkHistory[] }
      >();

      for (const history of all) {
        const { user } = history;
        if (!groupedMap.has(user.id)) {
          groupedMap.set(user.id, {
            userId: user.id,
            email: user.email || '',
            phone: user.phone || '',
            histories: [],
          });
        }
        groupedMap.get(user.id)!.histories.push(history);
      }

      return Array.from(groupedMap.values());
    } catch (error) {
      this.logger.error('Error grouping work histories', error.stack);
      throw new InternalServerErrorException('Failed to fetch grouped work histories');
    }
  }

  /**
   * Get a single work history by ID
   */
  async findOne(id: string): Promise<WorkHistory> {
    try {
      const workHistory = await this.workHistoryRepository.findOne({
        where: { id },
        relations: ['user', 'amphoe', 'localAdministrativeOrganization', 'responsibilities', 'responsibilities.amphoe']
      });

      if (!workHistory) {
        throw new NotFoundException(`Work history with ID ${id} not found`);
      }

      return workHistory;
    } catch (error) {
      this.logger.error(`Error fetching work history ${id}`, error.stack);
      throw error;
    }
  }

  async update(id: string, dto: UpdateWorkHistoryDto, userId: string): Promise<WorkHistory> {
    try {
        // 2. ค้นหา "ผู้กระทำ" พร้อมตรวจสอบ Role และ Status อย่างเข้มงวด
        const actor = await this.workHistoryRepository.findOne({
            where: {
                user: { id: userId },
                status: 'approved', // << เงื่อนไขที่ 1: status ต้อง approved
                role: In(['admin', 'superadmin']), // << เงื่อนไขที่ 2: role ต้องเป็น admin หรือ superadmin
            },
        });

        // ถ้าไม่พบ actor ที่ตรงตามเงื่อนไขทั้งหมด จะโยน Error ทันที
        if (!actor) {
            throw new ForbiddenException( // ใช้ ForbiddenException (403) จะสื่อความหมายได้ดีกว่า
                'You do not have permission to perform this action. Requires ADMIN or SUPERADMIN role with APPROVED status.',
            );
        }

        // 3. ค้นหา "ข้อมูลที่จะถูกแก้ไข" (ส่วนนี้เหมือนเดิม)
        const historyToUpdate = await this.workHistoryRepository.findOne({
            where: { id },
        });

        if (!historyToUpdate) {
            throw new NotFoundException(`Work history with ID ${id} not found`);
        }

        // 4. อัปเดตค่าจาก DTO (ส่วนนี้เหมือนเดิม)
        if (dto.role) {
            historyToUpdate.role = dto.role;
        }

        if (dto.status) {
            historyToUpdate.status = dto.status;
            historyToUpdate.approvedBy = actor; // บันทึกผู้ดำเนินการ
            historyToUpdate.approveAt = new Date(); // บันทึกเวลา
        }

        // 5. บันทึกข้อมูล (ส่วนนี้เหมือนเดิม)
        return await this.workHistoryRepository.save(historyToUpdate);

    } catch (error) {
        // จัดการ Error (แนะนำให้ re-throw error ที่เป็น instance ของ HttpException)
        if (error instanceof HttpException) {
            throw error;
        }
        this.logger.error(`Error updating work history ${id}`, error.stack);
        throw new InternalServerErrorException('Failed to update work history');
    }
}

  /**
   * Delete a work history
   */
  async remove(id: string): Promise<{ message: string }> {
    try {
      const history = await this.workHistoryRepository.findOne({
        where: { id },
        relations: ['user', 'amphoe', 'localAdministrativeOrganization', 'responsibilities', 'responsibilities.amphoe']
      });
      if (!history) throw new NotFoundException(`Work history with ID ${id} not found`);
      await this.workHistoryRepository.remove(history);
      return { message: `Work history with ID ${id} has been permanently deleted` };
    } catch (error) {
      this.logger.error(`Error deleting work history ${id}`, error.stack);
      throw error instanceof NotFoundException
        ? error
        : new InternalServerErrorException('Failed to delete work history');
    }
  }

  // ========================================
  // ADMIN WORK HISTORY OPERATIONS
  // ========================================

  /**
   * Get all admin work histories with responsibilities
   */
  async findAllAdminWorkHistories(): Promise<WorkHistory[]> {
    try {
      const workHistories = await this.workHistoryRepository.find({
        where: {
          status: 'approved',
          role: 'admin',
        },
        relations: ['user', 'amphoe', 'localAdministrativeOrganization', 'responsibilities', 'responsibilities.amphoe'],
      });
      return workHistories || [];
    } catch (error) {
      this.logger.error('Find all admin work histories failed', error.stack);
      throw new InternalServerErrorException('Failed to retrieve admin work histories');
    }
  }

  /**
   * Find admin work histories responsible for a specific amphoe
   */
  async findAdminWorkHistoriesByAmphoe(amphoeId: string): Promise<WorkHistory[]> {
    try {
      const workHistories = await this.workHistoryRepository.find({
        where: {
          status: 'approved',
          role: 'admin',
        },
        relations: ['user', 'amphoe', 'localAdministrativeOrganization', 'responsibilities', 'responsibilities.amphoe'],
      });

      // Filter only those with responsibilities for this amphoe
      return workHistories.filter(wh =>
        wh.responsibilities?.some(resp => resp.amphoe.id === amphoeId)
      );
    } catch (error) {
      this.logger.error(`Find admin work histories by amphoe ${amphoeId} failed`, error.stack);
      throw new InternalServerErrorException('Failed to retrieve admin work histories by amphoe');
    }
  }

  // ========================================
  // RESPONSIBILITY CRUD OPERATIONS
  // ========================================

  /**
   * Add a new responsibility to a work history
   */
  async addResponsibility(dto: CreateWorkHistoryAmphoeResponsibilityDto, assignedByUserId?: string): Promise<WorkHistoryAmphoeResponsibility> {
    try {
      const workHistory = await this.workHistoryRepository.findOne({
        where: { id: dto.workHistoryId },
        relations: ['user'],
      });

      if (!workHistory) {
        throw new NotFoundException(`Work history with ID ${dto.workHistoryId} not found`);
      }

      // Check if user is admin and workHistory is approved
      if (workHistory.status !== 'approved') {
        throw new BadRequestException('Work history is not approved');
      }

      if (workHistory.role !== 'admin') {
        throw new BadRequestException('WorkHistory is not admin');
      }

      const amphoe = await this.amphoeRepo.findOne({
        where: { id: dto.amphoeId },
      });

      if (!amphoe) {
        throw new NotFoundException(`Amphoe with ID ${dto.amphoeId} not found`);
      }

      // Check for duplicates
      const existing = await this.responsibilityRepository.findOne({
        where: {
          workHistory: { id: dto.workHistoryId },
          amphoe: { id: dto.amphoeId },
        },
      });

      if (existing) {
        throw new BadRequestException('Responsibility already exists for this work history and amphoe');
      }

      // Find assignedByWorkHistory
      let assignedByWorkHistory: WorkHistory | null = null;
      if (assignedByUserId) {
        assignedByWorkHistory = await this.workHistoryRepository.findOne({
          where: { user: { id: assignedByUserId }, status: 'approved' },
          relations: ['user'],
        });
        if (!assignedByWorkHistory) {
          throw new NotFoundException(`Approved work history not found for user ${assignedByUserId}`);
        }
      }

      // Create the responsibility
      const responsibility = this.responsibilityRepository.create({
        workHistory: { id: dto.workHistoryId },
        amphoe: { id: dto.amphoeId },
        assignedByWorkHistory: assignedByWorkHistory || undefined,
      });

      const savedResponsibility = await this.responsibilityRepository.save(responsibility);

      return savedResponsibility;
    } catch (error) {
      this.logger.error('Error adding responsibility', error.stack);
      throw error instanceof BadRequestException || error instanceof NotFoundException
        ? error
        : new InternalServerErrorException('Failed to add responsibility');
    }
  }

  /**
   * Remove a responsibility
   */
  async removeResponsibility(id: string): Promise<{ message: string }> {
    try {
      const responsibility = await this.responsibilityRepository.findOne({
        where: { id },
      });

      if (!responsibility) {
        throw new NotFoundException(`Responsibility with ID ${id} not found`);
      }

      await this.responsibilityRepository.remove(responsibility);
      return { message: `Responsibility with ID ${id} has been deleted` };
    } catch (error) {
      this.logger.error(`Error removing responsibility ${id}`, error.stack);
      throw error instanceof NotFoundException
        ? error
        : new InternalServerErrorException('Failed to remove responsibility');
    }
  }

  /**
   * Get responsibilities by work history ID
   */
  async getResponsibilitiesByWorkHistory(workHistoryId: string): Promise<WorkHistoryAmphoeResponsibility[]> {
    try {
      return await this.responsibilityRepository.find({
        where: { workHistory: { id: workHistoryId } },
        relations: ['amphoe'],
      });
    } catch (error) {
      this.logger.error(`Error fetching responsibilities for work history ${workHistoryId}`, error.stack);
      throw new InternalServerErrorException('Failed to fetch responsibilities');
    }
  }

  /**
   * Get responsibilities by amphoe ID
   */
  async getResponsibilitiesByAmphoe(amphoeId: string): Promise<WorkHistoryAmphoeResponsibility[]> {
    try {
      return await this.responsibilityRepository.find({
        where: { amphoe: { id: amphoeId } },
        relations: ['workHistory', 'workHistory.user'],
      });
    } catch (error) {
      this.logger.error(`Error fetching responsibilities for amphoe ${amphoeId}`, error.stack);
      throw new InternalServerErrorException('Failed to fetch responsibilities');
    }
  }

  // ========================================
  // RESPONSIBILITY TRANSFER OPERATIONS
  // ========================================

  /**
   * Transfer a specific responsibility from one admin to another
   */
  async transferResponsibility(
    responsibilityId: string,
    newWorkHistoryId: string,
    assignedByUserId: string,
  ): Promise<any> {
    this.logger.log('=== Starting transferResponsibility ===');
    this.logger.log('Responsibility ID:', responsibilityId);
    this.logger.log('New Work History ID:', newWorkHistoryId);
    this.logger.log('Assigned By User ID:', assignedByUserId);

    try {
      // Find the responsibility
      const responsibility = await this.responsibilityRepository.findOne({
        where: { id: responsibilityId },
        relations: ['amphoe', 'workHistory', 'workHistory.user'],
      });

      if (!responsibility) {
        throw new NotFoundException(`Responsibility with ID ${responsibilityId} not found`);
      }

      const oldWorkHistoryId = responsibility.workHistory.id;
      const amphoeName = responsibility.amphoe.name;
      const currentWorkHistoryUser = `${responsibility.workHistory.user.prefix}${responsibility.workHistory.user.firstname} ${responsibility.workHistory.user.lastname}`;

      this.logger.log('Found responsibility:', {
        id: responsibility.id,
        amphoeName: responsibility.amphoe.name,
        currentWorkHistoryId: responsibility.workHistory.id,
        currentWorkHistoryUser: currentWorkHistoryUser,
      });

      // Find the new work history
      const newWorkHistory = await this.workHistoryRepository.findOne({
        where: { id: newWorkHistoryId },
        relations: ['user', 'amphoe', 'localAdministrativeOrganization'],
      });

      if (!newWorkHistory) {
        throw new NotFoundException(`Work history with ID ${newWorkHistoryId} not found`);
      }

      const newWorkHistoryUserName = `${newWorkHistory.user.prefix}${newWorkHistory.user.firstname} ${newWorkHistory.user.lastname}`;

      this.logger.log('Found new work history:', {
        newWorkHistoryId: newWorkHistory.id,
        newWorkHistoryUser: newWorkHistoryUserName,
      });

      // Check if new admin is eligible for this amphoe
      const isMuangAmphoe = newWorkHistory.amphoe.id.toString() === '3001';
      const isKoratLao = newWorkHistory.localAdministrativeOrganization?.id ? newWorkHistory.localAdministrativeOrganization.id.toString() === "3001027" : false;

      if (!isMuangAmphoe && !isKoratLao) {
        throw new BadRequestException(`Admin is not eligible for amphoe ${amphoeName}`);
      }

      // Find the assignedByWorkHistory for the user performing the transfer
      const assignedByWorkHistory = await this.workHistoryRepository.findOne({
        where: { user: { id: assignedByUserId }, status: 'approved' },
        relations: ['user'],
      });

      if (!assignedByWorkHistory) {
        throw new NotFoundException(`Approved work history not found for user ${assignedByUserId}`);
      }

      // Transfer responsibility
      responsibility.workHistory = newWorkHistory;
      responsibility.assignedByWorkHistory = assignedByWorkHistory;
      await this.responsibilityRepository.save(responsibility);

      return { message: `Responsibility with ID ${responsibilityId} has been transferred to work history with ID ${newWorkHistoryId}` };
    } catch (error) {
      this.logger.error('Error transferring responsibility', error.stack);
      throw error instanceof BadRequestException || error instanceof NotFoundException
        ? error
        : new InternalServerErrorException('Failed to transfer responsibility');
    }
  }
}