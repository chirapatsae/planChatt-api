import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import { WorkHistoryService } from './work-history.service';
import { WorkHistory } from './entities/work-history.entity';
import { CreateWorkHistoryDto } from './dto/create-work-history.dto';
import { UpdateWorkHistoryDto } from './dto/update-work-history.dto';
import { Amphoe } from '../amphoes/entities/amphoe.entity';
import { LocalAdministrativeOrganization } from '../local-administrative-organizations/entities/local-administrative-organization.entity';
import { User } from '../users/entities/user.entity';
import { WorkStatus } from '../work-status/entities/work-status.entity';
import { Role } from '../roles/entities/role.entity';
import { GovernmentAgency } from '../government-agencies/entities/government-agency.entity';
import { Position } from '../positions/entities/position.entity';

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

  // Mock entities
  const mockAmphoe: Partial<Amphoe> = {
    id: 'amphoe-1',
    name: 'Test Amphoe',
  };

  const mockLao: Partial<LocalAdministrativeOrganization> = {
    id: 'lao-1',
    name: 'Test LAO',
  };

  const mockUser: Partial<User> = {
    id: 'user-1',
    firstname: 'John',
    lastname: 'Doe',
  };

  const mockCreator: Partial<User> = {
    id: 'creator-1',
    firstname: 'Creator',
    lastname: 'User',
  };

  const mockUpdater: Partial<User> = {
    id: 'updater-1',
    firstname: 'Updater',
    lastname: 'User',
  };

  const mockWorkStatus: Partial<WorkStatus> = {
    id: 'status-1',
    name: 'Active',
  };

  const mockRole: Partial<Role> = {
    id: 'role-1',
    name: 'Admin',
  };

  const mockGovernmentAgency: Partial<GovernmentAgency> = {
    id: 'gov-1',
    name: 'Test Agency',
  };

  const mockWorkHistory: Partial<WorkHistory> = {
    id: 'work-history-1',
    amphoe: mockAmphoe as Amphoe,
    localAdministrativeOrganization: mockLao as LocalAdministrativeOrganization,
    user: mockUser as User,
    workStatus: mockWorkStatus as WorkStatus,
    role: mockRole as Role,
    governmentAgencies: mockGovernmentAgency as GovernmentAgency,
    createdBy: mockCreator as User,
    updatedBy: mockUpdater as User,
    createdAt: new Date(),
  };

  // Mock repository methods
  const mockRepository = {
    save: jest.fn(),
    findOne: jest.fn(),
    findOneBy: jest.fn(),
    createQueryBuilder: jest.fn(),
    delete: jest.fn(),
    softDelete: jest.fn(),
    restore: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkHistoryService,
        {
          provide: getRepositoryToken(WorkHistory),
          useValue: mockRepository,
        },
        {
          provide: getRepositoryToken(Amphoe),
          useValue: mockRepository,
        },
        {
          provide: getRepositoryToken(LocalAdministrativeOrganization),
          useValue: mockRepository,
        },
        {
          provide: getRepositoryToken(User),
          useValue: mockRepository,
        },
        {
          provide: getRepositoryToken(WorkStatus),
          useValue: mockRepository,
        },
        {
          provide: getRepositoryToken(Role),
          useValue: mockRepository,
        },
        {
          provide: getRepositoryToken(GovernmentAgency),
          useValue: mockRepository,
        },
        {
          provide: getRepositoryToken(Position),
          useValue: mockRepository,
        },
      ],
    }).compile();

    service = module.get<WorkHistoryService>(WorkHistoryService);
    workHistoryRepository = module.get<Repository<WorkHistory>>(getRepositoryToken(WorkHistory));
    amphoeRepository = module.get<Repository<Amphoe>>(getRepositoryToken(Amphoe));
    laoRepository = module.get<Repository<LocalAdministrativeOrganization>>(getRepositoryToken(LocalAdministrativeOrganization));
    userRepository = module.get<Repository<User>>(getRepositoryToken(User));
    workStatusRepository = module.get<Repository<WorkStatus>>(getRepositoryToken(WorkStatus));
    roleRepository = module.get<Repository<Role>>(getRepositoryToken(Role));
    governmentAgencyRepository = module.get<Repository<GovernmentAgency>>(getRepositoryToken(GovernmentAgency));
    positionRepository = module.get<Repository<Position>>(getRepositoryToken(Position));

    // Clear all mocks before each test
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.clearAllMocks();
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

    describe('✅ Success Cases', () => {
      it('should create a work history with all required fields', async () => {
        // Arrange
        jest.spyOn(userRepository, 'findOne').mockResolvedValue(mockCreator as User);
        jest.spyOn(amphoeRepository, 'findOneBy').mockResolvedValue(mockAmphoe as Amphoe);
        jest.spyOn(laoRepository, 'findOneBy').mockResolvedValue(mockLao as LocalAdministrativeOrganization);
        jest.spyOn(userRepository, 'findOneBy').mockResolvedValue(mockUser as User);
        jest.spyOn(workStatusRepository, 'findOneBy').mockResolvedValue(mockWorkStatus as WorkStatus);
        jest.spyOn(roleRepository, 'findOneBy').mockResolvedValue(mockRole as Role);
        jest.spyOn(governmentAgencyRepository, 'findOneBy').mockResolvedValue(mockGovernmentAgency as GovernmentAgency);
        jest.spyOn(workHistoryRepository, 'save').mockResolvedValue(mockWorkHistory as WorkHistory);

        // Act
        const result = await service.create(createDto, 'creator-1');

        // Assert
        expect(result).toEqual(mockWorkHistory);
        expect(userRepository.findOne).toHaveBeenCalledWith({ where: { id: 'creator-1' } });
        expect(amphoeRepository.findOneBy).toHaveBeenCalledWith({ id: createDto.amphoeId });
        expect(laoRepository.findOneBy).toHaveBeenCalledWith({ id: createDto.localAdministrativeOrganizationId });
        expect(userRepository.findOneBy).toHaveBeenCalledWith({ id: createDto.userId });
        expect(workStatusRepository.findOneBy).toHaveBeenCalledWith({ id: createDto.workStatusId });
        expect(roleRepository.findOneBy).toHaveBeenCalledWith({ id: createDto.roleId });
        expect(governmentAgencyRepository.findOneBy).toHaveBeenCalledWith({ id: createDto.governmentAgenciesId });
        expect(workHistoryRepository.save).toHaveBeenCalled();
      });

      it('should create a work history without government agency', async () => {
        // Arrange
        const createDtoWithoutGov = { ...createDto };
        delete createDtoWithoutGov.governmentAgenciesId;

        jest.spyOn(userRepository, 'findOne').mockResolvedValue(mockCreator as User);
        jest.spyOn(amphoeRepository, 'findOneBy').mockResolvedValue(mockAmphoe as Amphoe);
        jest.spyOn(laoRepository, 'findOneBy').mockResolvedValue(mockLao as LocalAdministrativeOrganization);
        jest.spyOn(userRepository, 'findOneBy').mockResolvedValue(mockUser as User);
        jest.spyOn(workStatusRepository, 'findOneBy').mockResolvedValue(mockWorkStatus as WorkStatus);
        jest.spyOn(roleRepository, 'findOneBy').mockResolvedValue(mockRole as Role);
        jest.spyOn(workHistoryRepository, 'save').mockResolvedValue(mockWorkHistory as WorkHistory);

        // Act
        const result = await service.create(createDtoWithoutGov, 'creator-1');

        // Assert
        expect(result).toEqual(mockWorkHistory);
        // Note: governmentAgencyRepository.findOneBy will still be called but with undefined id
        // The service checks if governmentAgenciesId exists before calling findOneBy
      });
    });

    describe('❌ NotFoundException Cases', () => {
      it('should throw NotFoundException when creator not found', async () => {
        // Arrange
        jest.spyOn(userRepository, 'findOne').mockResolvedValue(null);

        // Act & Assert
        await expect(service.create(createDto, 'non-existent-creator')).rejects.toThrow(NotFoundException);
        expect(userRepository.findOne).toHaveBeenCalledWith({ where: { id: 'non-existent-creator' } });
      });

      it('should throw NotFoundException when amphoe not found', async () => {
        // Arrange
        jest.spyOn(userRepository, 'findOne').mockResolvedValue(mockCreator as User);
        jest.spyOn(amphoeRepository, 'findOneBy').mockResolvedValue(null);

        // Act & Assert
        await expect(service.create(createDto, 'creator-1')).rejects.toThrow(NotFoundException);
      });

      it('should throw NotFoundException when LAO not found', async () => {
        // Arrange
        jest.spyOn(userRepository, 'findOne').mockResolvedValue(mockCreator as User);
        jest.spyOn(amphoeRepository, 'findOneBy').mockResolvedValue(mockAmphoe as Amphoe);
        jest.spyOn(laoRepository, 'findOneBy').mockResolvedValue(null);

        // Act & Assert
        await expect(service.create(createDto, 'creator-1')).rejects.toThrow(NotFoundException);
      });

      it('should throw NotFoundException when user not found', async () => {
        // Arrange
        jest.spyOn(userRepository, 'findOne').mockResolvedValue(mockCreator as User);
        jest.spyOn(amphoeRepository, 'findOneBy').mockResolvedValue(mockAmphoe as Amphoe);
        jest.spyOn(laoRepository, 'findOneBy').mockResolvedValue(mockLao as LocalAdministrativeOrganization);
        jest.spyOn(userRepository, 'findOneBy').mockResolvedValue(null);

        // Act & Assert
        await expect(service.create(createDto, 'creator-1')).rejects.toThrow(NotFoundException);
      });

      it('should throw NotFoundException when work status not found', async () => {
        // Arrange
        jest.spyOn(userRepository, 'findOne').mockResolvedValue(mockCreator as User);
        jest.spyOn(amphoeRepository, 'findOneBy').mockResolvedValue(mockAmphoe as Amphoe);
        jest.spyOn(laoRepository, 'findOneBy').mockResolvedValue(mockLao as LocalAdministrativeOrganization);
        jest.spyOn(userRepository, 'findOneBy').mockResolvedValue(mockUser as User);
        jest.spyOn(workStatusRepository, 'findOneBy').mockResolvedValue(null);

        // Act & Assert
        await expect(service.create(createDto, 'creator-1')).rejects.toThrow(NotFoundException);
      });

      it('should throw NotFoundException when role not found', async () => {
        // Arrange
        jest.spyOn(userRepository, 'findOne').mockResolvedValue(mockCreator as User);
        jest.spyOn(amphoeRepository, 'findOneBy').mockResolvedValue(mockAmphoe as Amphoe);
        jest.spyOn(laoRepository, 'findOneBy').mockResolvedValue(mockLao as LocalAdministrativeOrganization);
        jest.spyOn(userRepository, 'findOneBy').mockResolvedValue(mockUser as User);
        jest.spyOn(workStatusRepository, 'findOneBy').mockResolvedValue(mockWorkStatus as WorkStatus);
        jest.spyOn(roleRepository, 'findOneBy').mockResolvedValue(null);

        // Act & Assert
        await expect(service.create(createDto, 'creator-1')).rejects.toThrow(NotFoundException);
      });

      it('should throw NotFoundException when government agency not found', async () => {
        // Arrange
        jest.spyOn(userRepository, 'findOne').mockResolvedValue(mockCreator as User);
        jest.spyOn(amphoeRepository, 'findOneBy').mockResolvedValue(mockAmphoe as Amphoe);
        jest.spyOn(laoRepository, 'findOneBy').mockResolvedValue(mockLao as LocalAdministrativeOrganization);
        jest.spyOn(userRepository, 'findOneBy').mockResolvedValue(mockUser as User);
        jest.spyOn(workStatusRepository, 'findOneBy').mockResolvedValue(mockWorkStatus as WorkStatus);
        jest.spyOn(roleRepository, 'findOneBy').mockResolvedValue(mockRole as Role);
        jest.spyOn(governmentAgencyRepository, 'findOneBy').mockResolvedValue(null);

        // Act & Assert
        await expect(service.create(createDto, 'creator-1')).rejects.toThrow(NotFoundException);
      });
    });

    describe('❌ InternalServerErrorException Cases', () => {
      it('should handle database save error', async () => {
        // Arrange
        jest.spyOn(userRepository, 'findOne').mockResolvedValue(mockCreator as User);
        jest.spyOn(amphoeRepository, 'findOneBy').mockResolvedValue(mockAmphoe as Amphoe);
        jest.spyOn(laoRepository, 'findOneBy').mockResolvedValue(mockLao as LocalAdministrativeOrganization);
        jest.spyOn(userRepository, 'findOneBy').mockResolvedValue(mockUser as User);
        jest.spyOn(workStatusRepository, 'findOneBy').mockResolvedValue(mockWorkStatus as WorkStatus);
        jest.spyOn(roleRepository, 'findOneBy').mockResolvedValue(mockRole as Role);
        jest.spyOn(governmentAgencyRepository, 'findOneBy').mockResolvedValue(mockGovernmentAgency as GovernmentAgency);
        jest.spyOn(workHistoryRepository, 'save').mockRejectedValue(new Error('Database error'));

        // Act & Assert
        await expect(service.create(createDto, 'creator-1')).rejects.toThrow();
      });
    });

    describe('⚠️ Edge Cases', () => {
      it('should handle empty string IDs', async () => {
        // Arrange
        const createDtoWithEmptyIds = {
          amphoeId: '',
          localAdministrativeOrganizationId: '',
          userId: '',
          workStatusId: '',
          roleId: '',
        };

        // Act & Assert
        await expect(service.create(createDtoWithEmptyIds, '')).rejects.toThrow();
      });

      it('should handle null/undefined values', async () => {
        // Arrange
        const createDtoWithNulls = {
          amphoeId: null as any,
          localAdministrativeOrganizationId: null as any,
          userId: null as any,
          workStatusId: null as any,
          roleId: null as any,
        };

        // Act & Assert
        await expect(service.create(createDtoWithNulls, null as any)).rejects.toThrow();
      });
    });
  });

  describe('findAll', () => {
    const mockQueryBuilder = {
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn(),
    };

    describe('✅ Success Cases', () => {
      it('should return all work histories without filters', async () => {
        // Arrange
        const mockWorkHistories = [mockWorkHistory, { ...mockWorkHistory, id: 'work-history-2' }];
        jest.spyOn(workHistoryRepository, 'createQueryBuilder').mockReturnValue(mockQueryBuilder as any);
        mockQueryBuilder.getMany.mockResolvedValue(mockWorkHistories);

        // Act
        const result = await service.findAll();

        // Assert
        expect(result).toEqual(mockWorkHistories);
        expect(workHistoryRepository.createQueryBuilder).toHaveBeenCalledWith('work_history');
        expect(mockQueryBuilder.leftJoinAndSelect).toHaveBeenCalledTimes(10); // Updated count based on actual service
        expect(mockQueryBuilder.getMany).toHaveBeenCalled();
      });

      it('should return filtered work histories with workStatusId', async () => {
        // Arrange
        const mockWorkHistories = [mockWorkHistory];
        jest.spyOn(workHistoryRepository, 'createQueryBuilder').mockReturnValue(mockQueryBuilder as any);
        mockQueryBuilder.getMany.mockResolvedValue(mockWorkHistories);

        // Act
        const result = await service.findAll('status-1');

        // Assert
        expect(result).toEqual(mockWorkHistories);
        expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith('workStatus.id = :workStatusId', { workStatusId: 'status-1' });
      });

      it('should return filtered work histories with roleId', async () => {
        // Arrange
        const mockWorkHistories = [mockWorkHistory];
        jest.spyOn(workHistoryRepository, 'createQueryBuilder').mockReturnValue(mockQueryBuilder as any);
        mockQueryBuilder.getMany.mockResolvedValue(mockWorkHistories);

        // Act
        const result = await service.findAll(undefined, 'role-1');

        // Assert
        expect(result).toEqual(mockWorkHistories);
        expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith('role.id = :roleId', { roleId: 'role-1' });
      });

      it('should return filtered work histories with both workStatusId and roleId', async () => {
        // Arrange
        const mockWorkHistories = [mockWorkHistory];
        jest.spyOn(workHistoryRepository, 'createQueryBuilder').mockReturnValue(mockQueryBuilder as any);
        mockQueryBuilder.getMany.mockResolvedValue(mockWorkHistories);

        // Act
        const result = await service.findAll('status-1', 'role-1');

        // Assert
        expect(result).toEqual(mockWorkHistories);
        expect(mockQueryBuilder.andWhere).toHaveBeenCalledTimes(2);
      });
    });

    describe('❌ InternalServerErrorException Cases', () => {
      it('should handle database query error', async () => {
        // Arrange
        jest.spyOn(workHistoryRepository, 'createQueryBuilder').mockReturnValue(mockQueryBuilder as any);
        mockQueryBuilder.getMany.mockRejectedValue(new Error('Database error'));

        // Act & Assert
        await expect(service.findAll()).rejects.toThrow();
      });
    });

    describe('⚠️ Edge Cases', () => {
      it('should handle empty string filters', async () => {
        // Arrange
        const mockWorkHistories = [mockWorkHistory];
        jest.spyOn(workHistoryRepository, 'createQueryBuilder').mockReturnValue(mockQueryBuilder as any);
        mockQueryBuilder.getMany.mockResolvedValue(mockWorkHistories);

        // Act
        const result = await service.findAll('', '');

        // Assert
        expect(result).toEqual(mockWorkHistories);
        // Empty strings are falsy, so andWhere should not be called
        expect(mockQueryBuilder.andWhere).toHaveBeenCalledTimes(0);
      });
    });
  });

  describe('findOne', () => {
    describe('✅ Success Cases', () => {
      it('should return a work history by ID', async () => {
        // Arrange
        jest.spyOn(workHistoryRepository, 'findOne').mockResolvedValue(mockWorkHistory as WorkHistory);

        // Act
        const result = await service.findOne('work-history-1');

        // Assert
        expect(result).toEqual(mockWorkHistory);
        expect(workHistoryRepository.findOne).toHaveBeenCalledWith({
          where: { id: 'work-history-1' },
          relations: ['user', 'amphoe', 'localAdministrativeOrganization', 'workStatus', 'role', 'position', 'createdBy', 'updatedBy', 'governmentAgencies'],
        });
      });
    });

    describe('❌ NotFoundException Cases', () => {
      it('should throw NotFoundException when work history not found', async () => {
        // Arrange
        jest.spyOn(workHistoryRepository, 'findOne').mockResolvedValue(null);

        // Act & Assert
        await expect(service.findOne('non-existent-id')).rejects.toThrow(NotFoundException);
        expect(workHistoryRepository.findOne).toHaveBeenCalledWith({
          where: { id: 'non-existent-id' },
          relations: ['user', 'amphoe', 'localAdministrativeOrganization', 'workStatus', 'role', 'position', 'createdBy', 'updatedBy', 'governmentAgencies'],
        });
      });
    });

    describe('❌ InternalServerErrorException Cases', () => {
      it('should handle database query error', async () => {
        // Arrange
        jest.spyOn(workHistoryRepository, 'findOne').mockRejectedValue(new Error('Database error'));

        // Act & Assert
        await expect(service.findOne('work-history-1')).rejects.toThrow();
      });
    });

    describe('⚠️ Edge Cases', () => {
      it('should handle empty string ID', async () => {
        // Arrange
        jest.spyOn(workHistoryRepository, 'findOne').mockResolvedValue(null);

        // Act & Assert
        await expect(service.findOne('')).rejects.toThrow(NotFoundException);
      });

      it('should handle null/undefined ID', async () => {
        // Arrange
        jest.spyOn(workHistoryRepository, 'findOne').mockResolvedValue(null);

        // Act & Assert
        await expect(service.findOne(null as any)).rejects.toThrow(NotFoundException);
      });
    });
  });

  describe('update', () => {
    const updateDto: UpdateWorkHistoryDto = {
      amphoeId: 'amphoe-2',
      localAdministrativeOrganizationId: 'lao-2',
      userId: 'user-2',
      workStatusId: 'status-2',
      roleId: 'role-2',
      governmentAgenciesId: 'gov-2',
    };

    describe('✅ Success Cases', () => {
      it('should update a work history with all fields', async () => {
        // Arrange
        const updatedWorkHistory = { ...mockWorkHistory, ...updateDto };
        jest.spyOn(userRepository, 'findOne').mockResolvedValue(mockUpdater as User);
        jest.spyOn(workHistoryRepository, 'findOne').mockResolvedValue(mockWorkHistory as WorkHistory);
        jest.spyOn(amphoeRepository, 'findOneBy').mockResolvedValue(mockAmphoe as Amphoe);
        jest.spyOn(laoRepository, 'findOneBy').mockResolvedValue(mockLao as LocalAdministrativeOrganization);
        jest.spyOn(userRepository, 'findOneBy').mockResolvedValue(mockUser as User);
        jest.spyOn(workStatusRepository, 'findOneBy').mockResolvedValue(mockWorkStatus as WorkStatus);
        jest.spyOn(roleRepository, 'findOneBy').mockResolvedValue(mockRole as Role);
        jest.spyOn(governmentAgencyRepository, 'findOneBy').mockResolvedValue(mockGovernmentAgency as GovernmentAgency);
        jest.spyOn(workHistoryRepository, 'save').mockResolvedValue(updatedWorkHistory as WorkHistory);

        // Act
        const result = await service.update('work-history-1', updateDto, 'updater-1');

        // Assert
        expect(result).toEqual(updatedWorkHistory);
        expect(userRepository.findOne).toHaveBeenCalledWith({ where: { id: 'updater-1' } });
        expect(workHistoryRepository.findOne).toHaveBeenCalledWith({ where: { id: 'work-history-1' } });
        expect(workHistoryRepository.save).toHaveBeenCalled();
      });

      it('should update a work history without government agency', async () => {
        // Arrange
        const updateDtoWithoutGov = { ...updateDto };
        delete updateDtoWithoutGov.governmentAgenciesId;

        jest.spyOn(userRepository, 'findOne').mockResolvedValue(mockUpdater as User);
        jest.spyOn(workHistoryRepository, 'findOne').mockResolvedValue(mockWorkHistory as WorkHistory);
        jest.spyOn(amphoeRepository, 'findOneBy').mockResolvedValue(mockAmphoe as Amphoe);
        jest.spyOn(laoRepository, 'findOneBy').mockResolvedValue(mockLao as LocalAdministrativeOrganization);
        jest.spyOn(userRepository, 'findOneBy').mockResolvedValue(mockUser as User);
        jest.spyOn(workStatusRepository, 'findOneBy').mockResolvedValue(mockWorkStatus as WorkStatus);
        jest.spyOn(roleRepository, 'findOneBy').mockResolvedValue(mockRole as Role);
        jest.spyOn(workHistoryRepository, 'save').mockResolvedValue(mockWorkHistory as WorkHistory);

        // Act
        const result = await service.update('work-history-1', updateDtoWithoutGov, 'updater-1');

        // Assert
        expect(result).toEqual(mockWorkHistory);
        // Note: governmentAgencyRepository.findOneBy will not be called when governmentAgenciesId is undefined
        // The service checks if governmentAgenciesId exists before calling findOneBy
      });
    });

    describe('❌ NotFoundException Cases', () => {
      it('should throw NotFoundException when updator not found', async () => {
        // Arrange
        jest.spyOn(userRepository, 'findOne').mockResolvedValue(null);

        // Act & Assert
        await expect(service.update('work-history-1', updateDto, 'non-existent-updater')).rejects.toThrow(NotFoundException);
        expect(userRepository.findOne).toHaveBeenCalledWith({ where: { id: 'non-existent-updater' } });
      });

      it('should throw NotFoundException when work history not found', async () => {
        // Arrange
        jest.spyOn(userRepository, 'findOne').mockResolvedValue(mockUpdater as User);
        jest.spyOn(workHistoryRepository, 'findOne').mockResolvedValue(null);

        // Act & Assert
        await expect(service.update('non-existent-id', updateDto, 'updater-1')).rejects.toThrow(NotFoundException);
      });

      it('should throw NotFoundException when amphoe not found', async () => {
        // Arrange
        jest.spyOn(userRepository, 'findOne').mockResolvedValue(mockUpdater as User);
        jest.spyOn(workHistoryRepository, 'findOne').mockResolvedValue(mockWorkHistory as WorkHistory);
        jest.spyOn(amphoeRepository, 'findOneBy').mockResolvedValue(null);

        // Act & Assert
        await expect(service.update('work-history-1', updateDto, 'updater-1')).rejects.toThrow(NotFoundException);
      });

      it('should throw NotFoundException when LAO not found', async () => {
        // Arrange
        jest.spyOn(userRepository, 'findOne').mockResolvedValue(mockUpdater as User);
        jest.spyOn(workHistoryRepository, 'findOne').mockResolvedValue(mockWorkHistory as WorkHistory);
        jest.spyOn(amphoeRepository, 'findOneBy').mockResolvedValue(mockAmphoe as Amphoe);
        jest.spyOn(laoRepository, 'findOneBy').mockResolvedValue(null);

        // Act & Assert
        await expect(service.update('work-history-1', updateDto, 'updater-1')).rejects.toThrow(NotFoundException);
      });

      it('should throw NotFoundException when user not found', async () => {
        // Arrange
        jest.spyOn(userRepository, 'findOne').mockResolvedValue(mockUpdater as User);
        jest.spyOn(workHistoryRepository, 'findOne').mockResolvedValue(mockWorkHistory as WorkHistory);
        jest.spyOn(amphoeRepository, 'findOneBy').mockResolvedValue(mockAmphoe as Amphoe);
        jest.spyOn(laoRepository, 'findOneBy').mockResolvedValue(mockLao as LocalAdministrativeOrganization);
        jest.spyOn(userRepository, 'findOneBy').mockResolvedValue(null);

        // Act & Assert
        await expect(service.update('work-history-1', updateDto, 'updater-1')).rejects.toThrow(NotFoundException);
      });

      it('should throw NotFoundException when work status not found', async () => {
        // Arrange
        jest.spyOn(userRepository, 'findOne').mockResolvedValue(mockUpdater as User);
        jest.spyOn(workHistoryRepository, 'findOne').mockResolvedValue(mockWorkHistory as WorkHistory);
        jest.spyOn(amphoeRepository, 'findOneBy').mockResolvedValue(mockAmphoe as Amphoe);
        jest.spyOn(laoRepository, 'findOneBy').mockResolvedValue(mockLao as LocalAdministrativeOrganization);
        jest.spyOn(userRepository, 'findOneBy').mockResolvedValue(mockUser as User);
        jest.spyOn(workStatusRepository, 'findOneBy').mockResolvedValue(null);

        // Act & Assert
        await expect(service.update('work-history-1', updateDto, 'updater-1')).rejects.toThrow(NotFoundException);
      });

      it('should throw NotFoundException when role not found', async () => {
        // Arrange
        jest.spyOn(userRepository, 'findOne').mockResolvedValue(mockUpdater as User);
        jest.spyOn(workHistoryRepository, 'findOne').mockResolvedValue(mockWorkHistory as WorkHistory);
        jest.spyOn(amphoeRepository, 'findOneBy').mockResolvedValue(mockAmphoe as Amphoe);
        jest.spyOn(laoRepository, 'findOneBy').mockResolvedValue(mockLao as LocalAdministrativeOrganization);
        jest.spyOn(userRepository, 'findOneBy').mockResolvedValue(mockUser as User);
        jest.spyOn(workStatusRepository, 'findOneBy').mockResolvedValue(mockWorkStatus as WorkStatus);
        jest.spyOn(roleRepository, 'findOneBy').mockResolvedValue(null);

        // Act & Assert
        await expect(service.update('work-history-1', updateDto, 'updater-1')).rejects.toThrow(NotFoundException);
      });

      it('should throw NotFoundException when government agency not found', async () => {
        // Arrange
        jest.spyOn(userRepository, 'findOne').mockResolvedValue(mockUpdater as User);
        jest.spyOn(workHistoryRepository, 'findOne').mockResolvedValue(mockWorkHistory as WorkHistory);
        jest.spyOn(amphoeRepository, 'findOneBy').mockResolvedValue(mockAmphoe as Amphoe);
        jest.spyOn(laoRepository, 'findOneBy').mockResolvedValue(mockLao as LocalAdministrativeOrganization);
        jest.spyOn(userRepository, 'findOneBy').mockResolvedValue(mockUser as User);
        jest.spyOn(workStatusRepository, 'findOneBy').mockResolvedValue(mockWorkStatus as WorkStatus);
        jest.spyOn(roleRepository, 'findOneBy').mockResolvedValue(mockRole as Role);
        jest.spyOn(governmentAgencyRepository, 'findOneBy').mockResolvedValue(null);

        // Act & Assert
        await expect(service.update('work-history-1', updateDto, 'updater-1')).rejects.toThrow(NotFoundException);
      });
    });

    describe('❌ InternalServerErrorException Cases', () => {
      it('should handle database save error', async () => {
        // Arrange
        jest.spyOn(userRepository, 'findOne').mockResolvedValue(mockUpdater as User);
        jest.spyOn(workHistoryRepository, 'findOne').mockResolvedValue(mockWorkHistory as WorkHistory);
        jest.spyOn(amphoeRepository, 'findOneBy').mockResolvedValue(mockAmphoe as Amphoe);
        jest.spyOn(laoRepository, 'findOneBy').mockResolvedValue(mockLao as LocalAdministrativeOrganization);
        jest.spyOn(userRepository, 'findOneBy').mockResolvedValue(mockUser as User);
        jest.spyOn(workStatusRepository, 'findOneBy').mockResolvedValue(mockWorkStatus as WorkStatus);
        jest.spyOn(roleRepository, 'findOneBy').mockResolvedValue(mockRole as Role);
        jest.spyOn(governmentAgencyRepository, 'findOneBy').mockResolvedValue(mockGovernmentAgency as GovernmentAgency);
        jest.spyOn(workHistoryRepository, 'save').mockRejectedValue(new Error('Database error'));

        // Act & Assert
        await expect(service.update('work-history-1', updateDto, 'updater-1')).rejects.toThrow();
      });
    });

    describe('⚠️ Edge Cases', () => {
      it('should handle empty string ID', async () => {
        // Arrange
        jest.spyOn(userRepository, 'findOne').mockResolvedValue(null);

        // Act & Assert
        await expect(service.update('', updateDto, 'updater-1')).rejects.toThrow(NotFoundException);
      });

      it('should handle null/undefined ID', async () => {
        // Arrange
        jest.spyOn(userRepository, 'findOne').mockResolvedValue(null);

        // Act & Assert
        await expect(service.update(null as any, updateDto, 'updater-1')).rejects.toThrow(NotFoundException);
      });
    });
  });

  describe('remove', () => {
    describe('✅ Success Cases', () => {
      it('should permanently delete a work history', async () => {
        // Arrange
        jest.spyOn(workHistoryRepository, 'delete').mockResolvedValue({ affected: 1 } as any);

        // Act
        const result = await service.remove('work-history-1');

        // Assert
        expect(result).toEqual({ message: 'Work history with ID work-history-1 has been permanently deleted' });
        expect(workHistoryRepository.delete).toHaveBeenCalledWith('work-history-1');
      });
    });

    describe('❌ NotFoundException Cases', () => {
      it('should throw NotFoundException when work history not found', async () => {
        // Arrange
        jest.spyOn(workHistoryRepository, 'delete').mockResolvedValue({ affected: 0 } as any);

        // Act & Assert
        await expect(service.remove('non-existent-id')).rejects.toThrow(NotFoundException);
        expect(workHistoryRepository.delete).toHaveBeenCalledWith('non-existent-id');
      });
    });

    describe('❌ InternalServerErrorException Cases', () => {
      it('should handle database delete error', async () => {
        // Arrange
        jest.spyOn(workHistoryRepository, 'delete').mockRejectedValue(new Error('Database error'));

        // Act & Assert
        await expect(service.remove('work-history-1')).rejects.toThrow();
      });
    });

    describe('⚠️ Edge Cases', () => {
      it('should handle empty string ID', async () => {
        // Arrange
        jest.spyOn(workHistoryRepository, 'delete').mockResolvedValue({ affected: 0 } as any);

        // Act & Assert
        await expect(service.remove('')).rejects.toThrow(NotFoundException);
      });

      it('should handle null/undefined ID', async () => {
        // Arrange
        jest.spyOn(workHistoryRepository, 'delete').mockResolvedValue({ affected: 0 } as any);

        // Act & Assert
        await expect(service.remove(null as any)).rejects.toThrow(NotFoundException);
      });
    });
  });

  describe('softRemove', () => {
    describe('✅ Success Cases', () => {
      it('should soft delete a work history', async () => {
        // Arrange
        jest.spyOn(workHistoryRepository, 'softDelete').mockResolvedValue({ affected: 1 } as any);

        // Act
        const result = await service.softRemove('work-history-1');

        // Assert
        expect(result).toEqual({ message: 'Work history with ID work-history-1 has been soft-removed.' });
        expect(workHistoryRepository.softDelete).toHaveBeenCalledWith('work-history-1');
      });
    });

    describe('❌ NotFoundException Cases', () => {
      it('should throw NotFoundException when work history not found', async () => {
        // Arrange
        jest.spyOn(workHistoryRepository, 'softDelete').mockResolvedValue({ affected: 0 } as any);

        // Act & Assert
        await expect(service.softRemove('non-existent-id')).rejects.toThrow(NotFoundException);
        expect(workHistoryRepository.softDelete).toHaveBeenCalledWith('non-existent-id');
      });
    });

    describe('❌ InternalServerErrorException Cases', () => {
      it('should handle database soft delete error', async () => {
        // Arrange
        jest.spyOn(workHistoryRepository, 'softDelete').mockRejectedValue(new Error('Database error'));

        // Act & Assert
        await expect(service.softRemove('work-history-1')).rejects.toThrow();
      });
    });

    describe('⚠️ Edge Cases', () => {
      it('should handle empty string ID', async () => {
        // Arrange
        jest.spyOn(workHistoryRepository, 'softDelete').mockResolvedValue({ affected: 0 } as any);

        // Act & Assert
        await expect(service.softRemove('')).rejects.toThrow(NotFoundException);
      });

      it('should handle null/undefined ID', async () => {
        // Arrange
        jest.spyOn(workHistoryRepository, 'softDelete').mockResolvedValue({ affected: 0 } as any);

        // Act & Assert
        await expect(service.softRemove(null as any)).rejects.toThrow(NotFoundException);
      });
    });
  });

  describe('restore', () => {
    describe('✅ Success Cases', () => {
      it('should restore a soft-deleted work history', async () => {
        // Arrange
        jest.spyOn(workHistoryRepository, 'restore').mockResolvedValue({ affected: 1 } as any);

        // Act
        const result = await service.restore('work-history-1');

        // Assert
        expect(result).toEqual({ message: 'Work history with ID work-history-1 has been restored.' });
        expect(workHistoryRepository.restore).toHaveBeenCalledWith('work-history-1');
      });
    });

    describe('❌ NotFoundException Cases', () => {
      it('should throw NotFoundException when work history not found or not deleted', async () => {
        // Arrange
        jest.spyOn(workHistoryRepository, 'restore').mockResolvedValue({ affected: 0 } as any);

        // Act & Assert
        await expect(service.restore('non-existent-id')).rejects.toThrow(NotFoundException);
        expect(workHistoryRepository.restore).toHaveBeenCalledWith('non-existent-id');
      });
    });

    describe('❌ InternalServerErrorException Cases', () => {
      it('should handle database restore error', async () => {
        // Arrange
        jest.spyOn(workHistoryRepository, 'restore').mockRejectedValue(new Error('Database error'));

        // Act & Assert
        await expect(service.restore('work-history-1')).rejects.toThrow();
      });
    });

    describe('⚠️ Edge Cases', () => {
      it('should handle empty string ID', async () => {
        // Arrange
        jest.spyOn(workHistoryRepository, 'restore').mockResolvedValue({ affected: 0 } as any);

        // Act & Assert
        await expect(service.restore('')).rejects.toThrow(NotFoundException);
      });

      it('should handle null/undefined ID', async () => {
        // Arrange
        jest.spyOn(workHistoryRepository, 'restore').mockResolvedValue({ affected: 0 } as any);

        // Act & Assert
        await expect(service.restore(null as any)).rejects.toThrow(NotFoundException);
      });
    });
  });
});
