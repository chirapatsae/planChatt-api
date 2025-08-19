import {
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateWorkHistoryDto } from './dto/create-work-history.dto';
import { UpdateWorkHistoryDto } from './dto/update-work-history.dto';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { User } from 'src/users/entities/user.entity';
import { LocalAdministrativeOrganization } from 'src/local-administrative-organizations/entities/local-administrative-organization.entity';
import { Amphoe } from 'src/amphoes/entities/amphoe.entity';
import { handleException } from 'src/util/handleException';
import { WorkStatus } from 'src/work-status/entities/work-status.entity';
import { Role } from 'src/roles/entities/role.entity';
import { GovernmentAgency } from 'src/government-agencies/entities/government-agency.entity';
import { Position } from 'src/positions/entities/position.entity';
import { WebsocketService } from 'src/websocket/websocket/websocket.service';

@Injectable()
export class WorkHistoryService {
  private readonly logger = new Logger(WorkHistoryService.name);

  constructor(
    @InjectRepository(WorkHistory)
    private readonly workHistoryRepository: Repository<WorkHistory>,

    @InjectRepository(Amphoe)
    private readonly amphoeRepository: Repository<Amphoe>,

    @InjectRepository(LocalAdministrativeOrganization)
    private readonly laoRepository: Repository<LocalAdministrativeOrganization>,

    @InjectRepository(User)
    private readonly userRepository: Repository<User>,

    @InjectRepository(WorkStatus)
    private readonly workStatusRepository: Repository<WorkStatus>,

    @InjectRepository(Role)
    private readonly roleRepository: Repository<Role>,

    @InjectRepository(GovernmentAgency)
    private readonly governmentAgencyRepository: Repository<GovernmentAgency>,

    @InjectRepository(Position)
    private readonly positionRepository: Repository<Position>,

    private readonly webSocketService: WebsocketService,
  ) {}

  async create(
    dto: CreateWorkHistoryDto,
    creatorId: string,
  ): Promise<WorkHistory> {
    try {
      const {
        amphoeId,
        localAdministrativeOrganizationId,
        userId,
        workStatusId,
        roleId,
        governmentAgenciesId,
      } = dto;

      const creator = await this.userRepository.findOne({
        where: { id: creatorId },
      });
      if (!creator) throw new NotFoundException('Creator not found');

      const amphoe = await this.amphoeRepository.findOneBy({ id: amphoeId });
      if (!amphoe) throw new NotFoundException('Amphoe not found');

      const lao = await this.laoRepository.findOneBy({
        id: localAdministrativeOrganizationId,
      });
      if (!lao)
        throw new NotFoundException(
          'Local Administrative Organization not found',
        );

      const user = await this.userRepository.findOneBy({ id: userId });
      if (!user) throw new NotFoundException('User not found');

      // Resolve workStatus by id, fallback to default name 'pending'
      let workStatus: WorkStatus | null = null;
      if (workStatusId) {
        workStatus = await this.workStatusRepository.findOneBy({ id: workStatusId });
      } else {
        workStatus = await this.workStatusRepository.findOneBy({ name: 'pending' });
      }
      if (!workStatus) throw new NotFoundException('Work status not found');

      // Resolve role by id, fallback to default name 'user'
      let role: Role | null = null;
      if (roleId) {
        role = await this.roleRepository.findOneBy({ id: roleId });
      } else {
        role = await this.roleRepository.findOneBy({ name: 'user' });
      }
      if (!role) throw new NotFoundException('Role not found');

      const workHistory = new WorkHistory();
      workHistory.amphoe = amphoe;
      workHistory.localAdministrativeOrganization = lao;
      workHistory.user = user;
      workHistory.workStatus = workStatus;
      workHistory.role = role;
      workHistory.createdBy = creator;

      if (governmentAgenciesId) {
        const govAgency = await this.governmentAgencyRepository.findOneBy({
          id: governmentAgenciesId,
        });
        if (!govAgency)
          throw new NotFoundException('Government agency not found');
        workHistory.governmentAgencies = govAgency;
      }

      // Disactive workHistory อื่นๆ ของ user เดียวกันก่อน
      await this.workHistoryRepository.update(
        { user: { id: userId }, isCurrent: true },
        { isCurrent: false }
      );

      // ตั้งค่า isCurrent = true สำหรับ workHistory ใหม่
      workHistory.isCurrent = true;

      return this.workHistoryRepository.save(workHistory);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findAll(
    workStatusName?: string,
    roleName?: string,
  ): Promise<WorkHistory[]> {
    try {
      const query = this.workHistoryRepository
        .createQueryBuilder('work_history')
        .leftJoinAndSelect('work_history.user', 'user')
        .leftJoinAndSelect('work_history.amphoe', 'amphoe')
        .leftJoinAndSelect(
          'work_history.localAdministrativeOrganization',
          'lao',
        )
        .leftJoinAndSelect(
          'work_history.workHistoryResponsibleAdmins',
          'responsibilities',
        )
        .leftJoinAndSelect('work_history.role', 'role')
        .leftJoinAndSelect('work_history.createdBy', 'createdBy')
        .leftJoinAndSelect('work_history.updatedBy', 'updatedBy')
        .leftJoinAndSelect('work_history.workStatus', 'workStatus')
        .leftJoinAndSelect(
          'work_history.governmentAgencies',
          'governmentAgencies',
        )
        .leftJoinAndSelect('responsibilities.amphoe', 'respAmphoe')
        .where('work_history.isCurrent = :isCurrent', { isCurrent: true });
      if (workStatusName)
        query.andWhere('workStatus.name = :workStatusName', { workStatusName });
      if (roleName) query.andWhere('role.name = :roleName', { roleName });

      return query.getMany();
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findOne(id: string): Promise<WorkHistory> {
    try {
      const workHistory = await this.workHistoryRepository.findOne({
        where: { id },
        relations: [
          'user',
          'amphoe',
          'localAdministrativeOrganization',
          'workStatus',
          'role',
          'createdBy',
          'updatedBy',
          'governmentAgencies',
          'workHistoryResponsibleAdmins',
          'workHistoryResponsibleAdmins.amphoe'

        ],
      });
      if (!workHistory) {
        throw new NotFoundException(`Work history with ID ${id} not found`);
      }
      return workHistory;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async update(
    id: string,
    dto: UpdateWorkHistoryDto,
    updateId: string,
  ): Promise<WorkHistory> {
    try {
      const {
        amphoeId,
        localAdministrativeOrganizationId,
        workStatusId,
        roleId,
        governmentAgenciesId,
      } = dto;

      const updator = await this.userRepository.findOne({
        where: { id: updateId },
      });
      if (!updator) throw new NotFoundException('creator id not found');

      const workHistory = await this.workHistoryRepository.findOne({
        where: { id },
        relations: ['workStatus'],
      });
      if (!workHistory) throw new NotFoundException('Work history not found');

      // Store previous work status for comparison
      const previousWorkStatus = workHistory.workStatus?.name;

      const amphoe = await this.amphoeRepository.findOneBy({ id: amphoeId });
      if (!amphoe) throw new NotFoundException('Amphoe not found');

      const lao = await this.laoRepository.findOneBy({
        id: localAdministrativeOrganizationId,
      });
      if (!lao)
        throw new NotFoundException(
          'Local Administrative Organization not found',
        );

      // Resolve work status and role by id if provided; otherwise keep current
      let workStatus = workHistory.workStatus;
      if (workStatusId) {
        const found = await this.workStatusRepository.findOneBy({ id: workStatusId });
        if (!found) throw new NotFoundException('Work status not found');
        workStatus = found;
      }

      let role = workHistory.role;
      if (roleId) {
        const foundRole = await this.roleRepository.findOneBy({ id: roleId });
        if (!foundRole) throw new NotFoundException('Role not found');
        role = foundRole;
      }

      workHistory.amphoe = amphoe;
      workHistory.localAdministrativeOrganization = lao;
      workHistory.workStatus = workStatus;
      workHistory.role = role;
      workHistory.updatedBy = updator;
      workHistory.isCurrent = true;
      
      // Clear government agencies if amphoe is not 3001 AND lao is not 3001027
      if (amphoe.id !== '3001' && localAdministrativeOrganizationId !== '3001027') {
        workHistory.governmentAgencies = null;
        // Force save to ensure the null value is persisted
        await this.workHistoryRepository.save(workHistory);
      } else if (governmentAgenciesId) {
        const govAgency = await this.governmentAgencyRepository.findOneBy({
          id: governmentAgenciesId,
        });
        if (!govAgency)
          throw new NotFoundException('Government agency not found');
        workHistory.governmentAgencies = govAgency;
      }

      const savedWorkHistory = await this.workHistoryRepository.save(workHistory);

      // Send notification if work status changed
      if (previousWorkStatus !== workStatus.name) {
        try {
          // ส่ง notification ทั่วไป
          await this.webSocketService.notifyWorkStatusUpdate({
            userId: workHistory.user.id,
            workStatus: workStatus.name,
            workHistoryId: workHistory.id,
            previousWorkStatus,
            updatedBy: updator.id,
            timestamp: new Date(),
          });

          // ถ้า work status เปลี่ยนเป็น 'approved' ให้ส่ง event เฉพาะ
          if (workStatus.name === 'approved') {
            await this.webSocketService.notifyUser({
              userId: workHistory.user.id,
              event: 'work-status-approved',
              data: {
                workStatus: 'approved',
                workHistoryId: workHistory.id,
                userId: workHistory.user.id,
                role: role.name, // เพิ่ม role
                message: 'Your account has been approved!',
                timestamp: new Date(),
              }
            });
          }

          // ถ้า work status เปลี่ยนเป็น 'suspended' ให้ส่ง event เฉพาะ
          if (workStatus.name === 'suspended') {
            await this.webSocketService.notifyUser({
              userId: workHistory.user.id,
              event: 'work-status-suspended',
              data: {
                workStatus: 'suspended',
                workHistoryId: workHistory.id,
                userId: workHistory.user.id,
                message: 'Your account has been suspended!',
                timestamp: new Date(),
              }
            });
          }

          // ถ้า work status เปลี่ยนกลับเป็น 'pending' ให้ส่ง event เฉพาะ
          if (workStatus.name === 'pending') {
            await this.webSocketService.notifyUser({
              userId: workHistory.user.id,
              event: 'work-status-pending',
              data: {
                workStatus: 'pending',
                workHistoryId: workHistory.id,
                userId: workHistory.user.id,
                message: 'Your account status has been changed back to pending!',
                timestamp: new Date(),
              }
            });
          }
          
          this.logger.log(
            `Work status updated from ${previousWorkStatus} to ${workStatus.name} for user ${workHistory.user.id}`,
          );
        } catch (notificationError) {
          this.logger.error(
            `Failed to send work status update notification: ${notificationError.message}`,
            notificationError.stack,
          );
          // Don't fail the main operation if notification fails
        }
      }

      return savedWorkHistory;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async remove(id: string): Promise<{ message: string }> {
    try {
      const result = await this.workHistoryRepository.delete(id);
      if (result.affected === 0) {
        throw new NotFoundException(`Work history with ID ${id} not found`);
      }
      return {
        message: `Work history with ID ${id} has been permanently deleted`,
      };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async softRemove(id: string): Promise<{ message: string }> {
    try {
      const result = await this.workHistoryRepository.softDelete(id);
      if (result.affected === 0) {
        throw new NotFoundException(`Work history with ID ${id} not found`);
      }
      return { message: `Work history with ID ${id} has been soft-removed.` };
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async restore(id: string): Promise<{ message: string }> {
    try {
      const result = await this.workHistoryRepository.restore(id);
      if (result.affected === 0) {
        throw new NotFoundException(
          `Work history with ID ${id} not found or was not deleted.`,
        );
      }
      return { message: `Work history with ID ${id} has been restored.` };
    } catch (error) {
      handleException(this.logger, error);
    }
  }
}
