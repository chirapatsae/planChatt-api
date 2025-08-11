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

      const resolvedWorkStatusId =
        workStatusId ?? '64db0afc-c6e0-43ae-aa96-92bc289dc1b7';
      const workStatus = await this.workStatusRepository.findOneBy({
        id: resolvedWorkStatusId,
      });
      if (!workStatus) throw new NotFoundException('Work status not found');

      const resolvedRoleId = roleId ?? '74585119-b006-452c-ae3e-154b193aa83e';
      const role = await this.roleRepository.findOneBy({ id: resolvedRoleId });
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
        userId,
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
      });
      if (!workHistory) throw new NotFoundException('Work history not found');

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

      const workStatus = await this.workStatusRepository.findOneBy({
        id: workStatusId,
      });
      if (!workStatus) throw new NotFoundException('Work status not found');

      const role = await this.roleRepository.findOneBy({ id: roleId });
      if (!role) throw new NotFoundException('Role not found');

      workHistory.amphoe = amphoe;
      workHistory.localAdministrativeOrganization = lao;
      workHistory.user = user;
      workHistory.workStatus = workStatus;
      workHistory.role = role;
      workHistory.updatedBy = updator;
      
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

      return await this.workHistoryRepository.save(workHistory);
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
