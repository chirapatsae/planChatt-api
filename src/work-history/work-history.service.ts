import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {  Repository } from 'typeorm';
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
  ) { }

  async create(dto: CreateWorkHistoryDto , userId : string): Promise<WorkHistory> {
    try {
      const {
        amphoeId,
        localAdministrativeOrganizationId,
        userId,
        workStatusId,
        roleId,
        governmentAgenciesId,
      } = dto;

      const amphoe = await this.amphoeRepository.findOneBy({ id: amphoeId });
      if (!amphoe) throw new NotFoundException('Amphoe not found');

      const lao = await this.laoRepository.findOneBy({ id: localAdministrativeOrganizationId });
      if (!lao) throw new NotFoundException('Local Administrative Organization not found');

      const user = await this.userRepository.findOneBy({ id: userId });
      if (!user) throw new NotFoundException('User not found');

      const workStatus = await this.workStatusRepository.findOneBy({ id: workStatusId });
      if (!workStatus) throw new NotFoundException('Work status not found');

      const role = await this.roleRepository.findOneBy({ id: roleId });
      if (!role) throw new NotFoundException('Role not found');

      const workHistory = new WorkHistory();
      workHistory.amphoe = amphoe;
      workHistory.localAdministrativeOrganization = lao;
      workHistory.user = user;
      workHistory.workStatus = workStatus;
      workHistory.role = role;

      if (governmentAgenciesId) {
        const govAgency = await this.governmentAgencyRepository.findOneBy({ id: governmentAgenciesId });
        if (!govAgency) throw new NotFoundException('Government agency not found');
        workHistory.governmentAgencies = govAgency;
      }

      return this.workHistoryRepository.save(workHistory);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findAll(status?: string, role?: string): Promise<WorkHistory[]> {
    try {
      const query = this.workHistoryRepository.createQueryBuilder('work_history')
        .leftJoinAndSelect('work_history.user', 'user')
        .leftJoinAndSelect('work_history.amphoe', 'amphoe')
        .leftJoinAndSelect('work_history.localAdministrativeOrganization', 'lao')
        .leftJoinAndSelect('work_history.workHistoryResponsibleAdmins', 'responsibilities')
        .leftJoinAndSelect('responsibilities.amphoe', 'respAmphoe');

      if (status) query.andWhere('work_history.status = :status', { status });
      if (role) query.andWhere('work_history.role = :role', { role });

      return query.getMany();
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async findOne(id: string): Promise<WorkHistory> {
    try {
      const workHistory = await this.workHistoryRepository.findOne({
        where: { id },
        relations: ['user', 'amphoe', 'localAdministrativeOrganization'],
      });
      if (!workHistory) {
        throw new NotFoundException(`Work history with ID ${id} not found`);
      }
      return workHistory;
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async update(id: string, dto: UpdateWorkHistoryDto, userId: string) : Promise<WorkHistory> {
    try {
      const {
        amphoeId,
        localAdministrativeOrganizationId,
        userId,
        workStatusId,
        roleId,
        governmentAgenciesId,
      } = dto;

      const workHistory =await this.workHistoryRepository.findOne({where : {id}})
      if (!workHistory) throw new NotFoundException('Work history not found');

      const amphoe = await this.amphoeRepository.findOneBy({ id: amphoeId });
      if (!amphoe) throw new NotFoundException('Amphoe not found');

      const lao = await this.laoRepository.findOneBy({ id: localAdministrativeOrganizationId });
      if (!lao) throw new NotFoundException('Local Administrative Organization not found');

      const user = await this.userRepository.findOneBy({ id: userId });
      if (!user) throw new NotFoundException('User not found');

      const workStatus = await this.workStatusRepository.findOneBy({ id: workStatusId });
      if (!workStatus) throw new NotFoundException('Work status not found');

      const role = await this.roleRepository.findOneBy({ id: roleId });
      if (!role) throw new NotFoundException('Role not found');


      workHistory.amphoe = amphoe;
      workHistory.localAdministrativeOrganization = lao;
      workHistory.user = user;
      workHistory.workStatus = workStatus;
      workHistory.role = role;

      if (governmentAgenciesId) {
        const govAgency = await this.governmentAgencyRepository.findOneBy({ id: governmentAgenciesId });
        if (!govAgency) throw new NotFoundException('Government agency not found');
        workHistory.governmentAgencies = govAgency;
      }

      return await this.workHistoryRepository.save(workHistory);
    } catch (error) {
      handleException(this.logger, error);
    }
  }

  async remove(id: string): Promise<{ message: string }> {
    try {
      // ✨ REFACTOR: Use delete(id) for better performance
      const result = await this.workHistoryRepository.delete(id);
      if (result.affected === 0) {
        throw new NotFoundException(`Work history with ID ${id} not found`);
      }
      return { message: `Work history with ID ${id} has been permanently deleted` };
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
        throw new NotFoundException(`Work history with ID ${id} not found or was not deleted.`);
      }
      return { message: `Work history with ID ${id} has been restored.` };
    } catch (error) {
      handleException(this.logger, error);
    }
  }
}