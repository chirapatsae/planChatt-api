import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, QueryBuilder } from 'typeorm';
import { WorkHistoryService } from './work-history.service';
import { WorkHistory } from './entities/work-history.entity';
import { Amphoe } from 'src/amphoes/entities/amphoe.entity';
import { LocalAdministrativeOrganization } from 'src/local-administrative-organizations/entities/local-administrative-organization.entity';
import { User } from 'src/users/entities/user.entity';
import { WorkStatus } from 'src/work-status/entities/work-status.entity';
import { Role } from 'src/roles/entities/role.entity';
import { GovernmentAgency } from 'src/government-agencies/entities/government-agency.entity';
import { Position } from 'src/positions/entities/position.entity';
import { CreateWorkHistoryDto } from './dto/create-work-history.dto';
import { UpdateWorkHistoryDto } from './dto/update-work-history.dto';
import { NotFoundException } from '@nestjs/common';

describe('WorkHistoryService', () => {
  let service: WorkHistoryService;
  let workHistoryRepository: Repository<WorkHistory>;
  let amphoeRepository: Repository<Amphoe>;
  let laoRepository: Repository<LocalAdministrativeOrganization>;
  let userRepository: Repository<User>;
  let workStatusRepository: Repository<WorkStatus>;
  let roleRepository: Repository<Role>;
  let governmentAgencyRepository: Repository<GovernmentAgency>;
  let positionRepository: Repository<Position>;

  const mockWorkHistoryRepository = {
    createQueryBuilder: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    softDelete: jest.fn(),
    restore: jest.fn(),
  };

  const mockAmphoeRepository = {
    findOneBy: jest.fn(),
  };

  const mockLaoRepository = {
    findOneBy: jest.fn(),
  };

  const mockUserRepository = {
    findOne: jest.fn(),
    findOneBy: jest.fn(),
  };

  const mockWorkStatusRepository = {
    findOneBy: jest.fn(),
  };

  const mockRoleRepository = {
    findOneBy: jest.fn(),
  };

  const mockGovernmentAgencyRepository = {
    findOneBy: jest.fn(),
  };

  const mockPositionRepository = {
    findOneBy: jest.fn(),
  };

  const mockQueryBuilder = {
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getMany: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkHistoryService,
        {
          provide: getRepositoryToken(WorkHistory),
          useValue: mockWorkHistoryRepository,
        },
        {
          provide: getRepositoryToken(Amphoe),
          useValue: mockAmphoeRepository,
        },
        {
          provide: getRepositoryToken(LocalAdministrativeOrganization),
          useValue: mockLaoRepository,
        },
        {
          provide: getRepositoryToken(User),
          useValue: mockUserRepository,
        },
        {
          provide: getRepositoryToken(WorkStatus),
          useValue: mockWorkStatusRepository,
        },
        {
          provide: getRepositoryToken(Role),
          useValue: mockRoleRepository,
        },
        {
          provide: getRepositoryToken(GovernmentAgency),
          useValue: mockGovernmentAgencyRepository,
        },
        {
          provide: getRepositoryToken(Position),
          useValue: mockPositionRepository,
        },
      ],
    }).compile();

    service = module.get<WorkHistoryService>(WorkHistoryService);
    workHistoryRepository = module.get<Repository<WorkHistory>>(
      getRepositoryToken(WorkHistory),
    );
    amphoeRepository = module.get<Repository<Amphoe>>(
      getRepositoryToken(Amphoe),
    );
    laoRepository = module.get<Repository<LocalAdministrativeOrganization>>(
      getRepositoryToken(LocalAdministrativeOrganization),
    );
    userRepository = module.get<Repository<User>>(getRepositoryToken(User));
    workStatusRepository = module.get<Repository<WorkStatus>>(
      getRepositoryToken(WorkStatus),
    );
    roleRepository = module.get<Repository<Role>>(getRepositoryToken(Role));
    governmentAgencyRepository = module.get<Repository<GovernmentAgency>>(
      getRepositoryToken(GovernmentAgency),
    );
    positionRepository = module.get<Repository<Position>>(
      getRepositoryToken(Position),
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    const createDto: CreateWorkHistoryDto = {
      amphoeId: 'amphoe-1',
      localAdministrativeOrganizationId: 'lao-1',
      userId: 'user-1',
      workStatusId: 'status-1',
      roleId: 'role-1',
      governmentAgenciesId: 'gov-1',
    };

    const creatorId = 'creator-1';

    const mockCreator = { id: 'creator-1' };
    const mockAmphoe = { id: 'amphoe-1' };
    const mockLao = { id: 'lao-1' };
    const mockUser = { id: 'user-1' };
    const mockWorkStatus = { id: 'status-1' };
    const mockRole = { id: 'role-1' };
    const mockGovernmentAgency = { id: 'gov-1' };

    beforeEach(() => {
      mockUserRepository.findOne.mockResolvedValue(mockCreator);
      mockAmphoeRepository.findOneBy.mockResolvedValue(mockAmphoe);
      mockLaoRepository.findOneBy.mockResolvedValue(mockLao);
      mockUserRepository.findOneBy.mockResolvedValue(mockUser);
      mockWorkStatusRepository.findOneBy.mockResolvedValue(mockWorkStatus);
      mockRoleRepository.findOneBy.mockResolvedValue(mockRole);
      mockGovernmentAgencyRepository.findOneBy.mockResolvedValue(mockGovernmentAgency);
      mockWorkHistoryRepository.update.mockResolvedValue({ affected: 1 });
      mockWorkHistoryRepository.save.mockResolvedValue({ id: 'work-history-1' });
    });

    it('should create a work history successfully', async () => {
      const result = await service.create(createDto, creatorId);

      expect(mockUserRepository.findOne).toHaveBeenCalledWith({
        where: { id: creatorId },
      });
      expect(mockAmphoeRepository.findOneBy).toHaveBeenCalledWith({ id: createDto.amphoeId });
      expect(mockLaoRepository.findOneBy).toHaveBeenCalledWith({
        id: createDto.localAdministrativeOrganizationId,
      });
      expect(mockUserRepository.findOneBy).toHaveBeenCalledWith({ id: createDto.userId });
      expect(mockWorkStatusRepository.findOneBy).toHaveBeenCalledWith({
        id: createDto.workStatusId,
      });
      expect(mockRoleRepository.findOneBy).toHaveBeenCalledWith({ id: createDto.roleId });
      expect(mockGovernmentAgencyRepository.findOneBy).toHaveBeenCalledWith({
        id: createDto.governmentAgenciesId,
      });
      expect(mockWorkHistoryRepository.update).toHaveBeenCalledWith(
        { user: { id: createDto.userId }, isCurrent: true },
        { isCurrent: false }
      );
      expect(mockWorkHistoryRepository.save).toHaveBeenCalled();
      expect(result).toEqual({ id: 'work-history-1' });
    });

    it('should create a work history with default workStatusId and roleId', async () => {
      const createDtoWithoutDefaults = {
        amphoeId: 'amphoe-1',
        localAdministrativeOrganizationId: 'lao-1',
        userId: 'user-1',
      };

      const defaultWorkStatus = { id: '64db0afc-c6e0-43ae-aa96-92bc289dc1b7' };
      const defaultRole = { id: '74585119-b006-452c-ae3e-154b193aa83e' };

      mockWorkStatusRepository.findOneBy.mockResolvedValue(defaultWorkStatus);
      mockRoleRepository.findOneBy.mockResolvedValue(defaultRole);

      const result = await service.create(createDtoWithoutDefaults as any, creatorId);

      expect(mockWorkStatusRepository.findOneBy).toHaveBeenCalledWith({
        id: '64db0afc-c6e0-43ae-aa96-92bc289dc1b7',
      });
      expect(mockRoleRepository.findOneBy).toHaveBeenCalledWith({
        id: '74585119-b006-452c-ae3e-154b193aa83e',
      });
      expect(result).toEqual({ id: 'work-history-1' });
    });

    it('should create a work history without government agency when not provided', async () => {
      const createDtoWithoutGov = { ...createDto };
      delete createDtoWithoutGov.governmentAgenciesId;

      const result = await service.create(createDtoWithoutGov, creatorId);

      expect(mockGovernmentAgencyRepository.findOneBy).not.toHaveBeenCalled();
      expect(result).toEqual({ id: 'work-history-1' });
    });

    it('should throw NotFoundException when creator not found', async () => {
      mockUserRepository.findOne.mockResolvedValue(null);

      await expect(service.create(createDto, creatorId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException when amphoe not found', async () => {
      mockAmphoeRepository.findOneBy.mockResolvedValue(null);

      await expect(service.create(createDto, creatorId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException when local administrative organization not found', async () => {
      mockLaoRepository.findOneBy.mockResolvedValue(null);

      await expect(service.create(createDto, creatorId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException when user not found', async () => {
      mockUserRepository.findOneBy.mockResolvedValue(null);

      await expect(service.create(createDto, creatorId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException when work status not found', async () => {
      mockWorkStatusRepository.findOneBy.mockResolvedValue(null);

      await expect(service.create(createDto, creatorId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException when role not found', async () => {
      mockRoleRepository.findOneBy.mockResolvedValue(null);

      await expect(service.create(createDto, creatorId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException when government agency not found', async () => {
      mockGovernmentAgencyRepository.findOneBy.mockResolvedValue(null);

      await expect(service.create(createDto, creatorId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('findAll', () => {
    beforeEach(() => {
      mockWorkHistoryRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);
    });

    it('should return all work histories without filters', async () => {
      const expectedResult = [
        { id: '1', userId: 'user-1' },
        { id: '2', userId: 'user-2' },
      ];
      mockQueryBuilder.getMany.mockResolvedValue(expectedResult);

      const result = await service.findAll();

      expect(mockWorkHistoryRepository.createQueryBuilder).toHaveBeenCalledWith('work_history');
      expect(mockQueryBuilder.leftJoinAndSelect).toHaveBeenCalledTimes(10);
      expect(mockQueryBuilder.where).toHaveBeenCalledWith('work_history.isCurrent = :isCurrent', { isCurrent: true });
      expect(mockQueryBuilder.getMany).toHaveBeenCalled();
      expect(result).toEqual(expectedResult);
    });

    it('should return work histories filtered by work status name', async () => {
      const workStatusName = 'approved';
      const expectedResult = [{ id: '1', userId: 'user-1' }];
      mockQueryBuilder.getMany.mockResolvedValue(expectedResult);

      const result = await service.findAll(workStatusName);

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith('workStatus.name = :workStatusName', { workStatusName });
      expect(result).toEqual(expectedResult);
    });

    it('should return work histories filtered by work status name and role name', async () => {
      const workStatusName = 'approved';
      const roleName = 'admin';
      const expectedResult = [{ id: '1', userId: 'user-1' }];
      mockQueryBuilder.getMany.mockResolvedValue(expectedResult);

      const result = await service.findAll(workStatusName, roleName);

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith('workStatus.name = :workStatusName', { workStatusName });
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith('role.name = :roleName', { roleName });
      expect(result).toEqual(expectedResult);
    });
  });

  describe('findOne', () => {
    it('should return a work history by id with relations', async () => {
      const id = 'test-id';
      const mockWorkHistory = {
        id,
        userId: 'user-1',
        amphoe: { id: 'amphoe-1' },
        localAdministrativeOrganization: { id: 'lao-1' },
      };

      mockWorkHistoryRepository.findOne.mockResolvedValue(mockWorkHistory);

      const result = await service.findOne(id);

      expect(mockWorkHistoryRepository.findOne).toHaveBeenCalledWith({
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
      expect(result).toEqual(mockWorkHistory);
    });

    it('should throw NotFoundException when work history not found', async () => {
      const id = 'test-id';

      mockWorkHistoryRepository.findOne.mockResolvedValue(null);

      await expect(service.findOne(id)).rejects.toThrow(NotFoundException);
    });
  });

  describe('update', () => {
    const updateDto: UpdateWorkHistoryDto = {
      amphoeId: 'new-amphoe',
      localAdministrativeOrganizationId: 'new-lao',
      userId: 'new-user',
      workStatusId: 'new-status',
      roleId: 'new-role',
      governmentAgenciesId: 'new-gov',
    };

    const updateId = 'updater-1';

    const mockUpdater = { id: 'updater-1' };
    const mockWorkHistory = { id: 'work-history-1' };
    const mockAmphoe = { id: 'new-amphoe' };
    const mockLao = { id: 'new-lao' };
    const mockUser = { id: 'new-user' };
    const mockWorkStatus = { id: 'new-status' };
    const mockRole = { id: 'new-role' };
    const mockGovernmentAgency = { id: 'new-gov' };

    beforeEach(() => {
      mockUserRepository.findOne.mockResolvedValue(mockUpdater);
      mockWorkHistoryRepository.findOne.mockResolvedValue(mockWorkHistory);
      mockAmphoeRepository.findOneBy.mockResolvedValue(mockAmphoe);
      mockLaoRepository.findOneBy.mockResolvedValue(mockLao);
      mockUserRepository.findOneBy.mockResolvedValue(mockUser);
      mockWorkStatusRepository.findOneBy.mockResolvedValue(mockWorkStatus);
      mockRoleRepository.findOneBy.mockResolvedValue(mockRole);
      mockGovernmentAgencyRepository.findOneBy.mockResolvedValue(mockGovernmentAgency);
      mockWorkHistoryRepository.save.mockResolvedValue({ id: 'work-history-1', ...updateDto });
    });

    it('should update a work history successfully', async () => {
      const result = await service.update('work-history-1', updateDto, updateId);

      expect(mockUserRepository.findOne).toHaveBeenCalledWith({
        where: { id: updateId },
      });
      expect(mockWorkHistoryRepository.findOne).toHaveBeenCalledWith({
        where: { id: 'work-history-1' },
      });
      expect(mockAmphoeRepository.findOneBy).toHaveBeenCalledWith({ id: updateDto.amphoeId });
      expect(mockLaoRepository.findOneBy).toHaveBeenCalledWith({
        id: updateDto.localAdministrativeOrganizationId,
      });
      expect(mockUserRepository.findOneBy).toHaveBeenCalledWith({ id: updateDto.userId });
      expect(mockWorkStatusRepository.findOneBy).toHaveBeenCalledWith({
        id: updateDto.workStatusId,
      });
      expect(mockRoleRepository.findOneBy).toHaveBeenCalledWith({ id: updateDto.roleId });
      // Government agency is only checked when amphoe is 3001 and lao is 3001027
      expect(mockGovernmentAgencyRepository.findOneBy).not.toHaveBeenCalled();
      // In the default case, save is called twice: once to clear government agencies, once at the end
      expect(mockWorkHistoryRepository.save).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ id: 'work-history-1', ...updateDto });
    });

    it('should clear government agencies when amphoe is not 3001 and lao is not 3001027', async () => {
      const updateDtoWithSpecialIds = {
        ...updateDto,
        amphoeId: '3002', // Not 3001
        localAdministrativeOrganizationId: '3001028', // Not 3001027
      };

      const mockSpecialAmphoe = { id: '3002' };
      const mockSpecialLao = { id: '3001028' };

      mockAmphoeRepository.findOneBy.mockResolvedValue(mockSpecialAmphoe);
      mockLaoRepository.findOneBy.mockResolvedValue(mockSpecialLao);
      mockWorkHistoryRepository.save.mockResolvedValue({ id: 'work-history-1', ...updateDtoWithSpecialIds });

      const result = await service.update('work-history-1', updateDtoWithSpecialIds, updateId);

      expect(mockWorkHistoryRepository.save).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ id: 'work-history-1', ...updateDtoWithSpecialIds });
    });

    it('should set government agency when amphoe is 3001 and lao is 3001027', async () => {
      const updateDtoWithSpecialIds = {
        ...updateDto,
        amphoeId: '3001',
        localAdministrativeOrganizationId: '3001027',
      };

      const mockSpecialAmphoe = { id: '3001' };
      const mockSpecialLao = { id: '3001027' };

      mockAmphoeRepository.findOneBy.mockResolvedValue(mockSpecialAmphoe);
      mockLaoRepository.findOneBy.mockResolvedValue(mockSpecialLao);
      mockWorkHistoryRepository.save.mockResolvedValue({ id: 'work-history-1', ...updateDtoWithSpecialIds });

      const result = await service.update('work-history-1', updateDtoWithSpecialIds, updateId);

      expect(mockGovernmentAgencyRepository.findOneBy).toHaveBeenCalledWith({
        id: updateDto.governmentAgenciesId,
      });
      expect(mockWorkHistoryRepository.save).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ id: 'work-history-1', ...updateDtoWithSpecialIds });
    });

    it('should throw NotFoundException when updater not found', async () => {
      mockUserRepository.findOne.mockResolvedValue(null);

      await expect(service.update('work-history-1', updateDto, updateId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException when work history not found', async () => {
      mockWorkHistoryRepository.findOne.mockResolvedValue(null);

      await expect(service.update('work-history-1', updateDto, updateId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException when amphoe not found', async () => {
      mockAmphoeRepository.findOneBy.mockResolvedValue(null);

      await expect(service.update('work-history-1', updateDto, updateId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException when local administrative organization not found', async () => {
      mockLaoRepository.findOneBy.mockResolvedValue(null);

      await expect(service.update('work-history-1', updateDto, updateId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException when user not found', async () => {
      mockUserRepository.findOneBy.mockResolvedValue(null);

      await expect(service.update('work-history-1', updateDto, updateId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException when work status not found', async () => {
      mockWorkStatusRepository.findOneBy.mockResolvedValue(null);

      await expect(service.update('work-history-1', updateDto, updateId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException when role not found', async () => {
      mockRoleRepository.findOneBy.mockResolvedValue(null);

      await expect(service.update('work-history-1', updateDto, updateId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException when government agency not found', async () => {
      // Set up the special case where government agency is checked
      const updateDtoWithSpecialIds = {
        ...updateDto,
        amphoeId: '3001',
        localAdministrativeOrganizationId: '3001027',
      };

      const mockSpecialAmphoe = { id: '3001' };
      const mockSpecialLao = { id: '3001027' };

      mockAmphoeRepository.findOneBy.mockResolvedValue(mockSpecialAmphoe);
      mockLaoRepository.findOneBy.mockResolvedValue(mockSpecialLao);
      mockGovernmentAgencyRepository.findOneBy.mockResolvedValue(null);

      await expect(service.update('work-history-1', updateDtoWithSpecialIds, updateId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('remove', () => {
    it('should permanently delete a work history successfully', async () => {
      const id = 'test-id';
      mockWorkHistoryRepository.delete.mockResolvedValue({ affected: 1 });

      const result = await service.remove(id);

      expect(mockWorkHistoryRepository.delete).toHaveBeenCalledWith(id);
      expect(result).toEqual({
        message: `Work history with ID ${id} has been permanently deleted`,
      });
    });

    it('should throw NotFoundException when work history not found', async () => {
      const id = 'test-id';
      mockWorkHistoryRepository.delete.mockResolvedValue({ affected: 0 });

      await expect(service.remove(id)).rejects.toThrow(NotFoundException);
    });
  });

  describe('softRemove', () => {
    it('should soft delete a work history successfully', async () => {
      const id = 'test-id';
      mockWorkHistoryRepository.softDelete.mockResolvedValue({ affected: 1 });

      const result = await service.softRemove(id);

      expect(mockWorkHistoryRepository.softDelete).toHaveBeenCalledWith(id);
      expect(result).toEqual({
        message: `Work history with ID ${id} has been soft-removed.`,
      });
    });

    it('should throw NotFoundException when work history not found', async () => {
      const id = 'test-id';
      mockWorkHistoryRepository.softDelete.mockResolvedValue({ affected: 0 });

      await expect(service.softRemove(id)).rejects.toThrow(NotFoundException);
    });
  });

  describe('restore', () => {
    it('should restore a work history successfully', async () => {
      const id = 'test-id';
      mockWorkHistoryRepository.restore.mockResolvedValue({ affected: 1 });

      const result = await service.restore(id);

      expect(mockWorkHistoryRepository.restore).toHaveBeenCalledWith(id);
      expect(result).toEqual({
        message: `Work history with ID ${id} has been restored.`,
      });
    });

    it('should throw NotFoundException when work history not found or not deleted', async () => {
      const id = 'test-id';
      mockWorkHistoryRepository.restore.mockResolvedValue({ affected: 0 });

      await expect(service.restore(id)).rejects.toThrow(NotFoundException);
    });
  });
});
