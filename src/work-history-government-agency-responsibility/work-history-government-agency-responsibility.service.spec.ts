import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  Logger,
  NotFoundException,
  InternalServerErrorException,
  BadRequestException,
} from '@nestjs/common';
import { WorkHistoryGovernmentAgencyResponsibilityService } from './work-history-government-agency-responsibility.service';
import { WorkHistoryGovernmentAgencyResponsibility } from './entities/work-history-government-agency-responsibility.entity';
import { WorkHistory } from '../work-history/entities/work-history.entity';
import { GovernmentAgency } from '../government-agencies/entities/government-agency.entity';
import { User } from '../users/entities/user.entity';
import { CreateWorkHistoryGovernmentAgencyResponsibilityDto } from './dto/create-work-history-government-agency-responsibility.dto';
import { UpdateWorkHistoryGovernmentAgencyResponsibilityDto } from './dto/update-work-history-government-agency-responsibility.dto';
import * as handleException from 'src/util/handleException';

// Mock the handleException utility
jest.mock('src/util/handleException', () => ({
  handleException: jest.fn().mockImplementation((logger, error) => {
    if (
      error instanceof NotFoundException ||
      error instanceof BadRequestException
    ) {
      throw error;
    }
    throw new InternalServerErrorException(
      'An unexpected error occurred on the server.',
    );
  }),
}));

describe('WorkHistoryGovernmentAgencyResponsibilityService', () => {
  let service: WorkHistoryGovernmentAgencyResponsibilityService;
  let responsibilityRepository: Repository<WorkHistoryGovernmentAgencyResponsibility>;
  let workHistoryRepository: Repository<WorkHistory>;
  let governmentAgencyRepository: Repository<GovernmentAgency>;
  let userRepository: Repository<User>;
  let mockLogger: jest.Mocked<Logger>;

  const mockUser: User = {
    id: 'user-id-1',
    name: 'Test User',
    email: 'test@example.com',
    password: 'hashedPassword',
    createdAt: new Date(),
    updatedAt: new Date(),
    workHistory: [],
  } as any;

  const mockGovernmentAgency: GovernmentAgency = {
    id: 'agency-id-1',
    name: 'Test Government Agency',
    createdAt: new Date(),
    deletedAt: undefined,
    workHistory: [],
    responsibleAgencyProjectGroup: [],
  } as any;

  const mockWorkStatus = {
    id: 'status-id-1',
    name: 'approved',
    createdAt: new Date(),
    deletedAt: undefined,
    workHistory: [],
  };

  const mockRole = {
    id: 'role-id-1',
    name: 'staff',
    createdAt: new Date(),
    deletedAt: undefined,
    workHistory: [],
  };

  const mockAdminRole = {
    id: 'role-id-2',
    name: 'admin',
    createdAt: new Date(),
    deletedAt: undefined,
    workHistory: [],
  };

  const mockWorkHistory: WorkHistory = {
    id: 'work-history-id-1',
    user: mockUser,
    workStatus: mockWorkStatus,
    role: mockRole,
    createdAt: new Date(),
    updatedAt: new Date(),
    workHistoryResponsibleAdmins: [],
  } as any;

  const mockAssignedByWorkHistory: WorkHistory = {
    id: 'work-history-id-2',
    user: mockUser,
    workStatus: mockWorkStatus,
    role: mockAdminRole,
    createdAt: new Date(),
    updatedAt: new Date(),
    workHistoryResponsibleAdmins: [],
  } as any;

  const mockResponsibility: WorkHistoryGovernmentAgencyResponsibility = {
    id: 'responsibility-id-1',
    workHistory: mockWorkHistory,
    governmentAgency: mockGovernmentAgency,
    assignedByWorkHistory: mockAssignedByWorkHistory,
    createdAt: new Date(),
  } as any;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkHistoryGovernmentAgencyResponsibilityService,
        {
          provide: getRepositoryToken(WorkHistoryGovernmentAgencyResponsibility),
          useValue: {
            create: jest.fn(),
            save: jest.fn(),
            find: jest.fn(),
            findOne: jest.fn(),
            findOneBy: jest.fn(),
            preload: jest.fn(),
            delete: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(WorkHistory),
          useValue: {
            findOne: jest.fn(),
            find: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(GovernmentAgency),
          useValue: {
            findOneBy: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(User),
          useValue: {
            findOne: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<WorkHistoryGovernmentAgencyResponsibilityService>(
      WorkHistoryGovernmentAgencyResponsibilityService,
    );
    responsibilityRepository = module.get<Repository<WorkHistoryGovernmentAgencyResponsibility>>(
      getRepositoryToken(WorkHistoryGovernmentAgencyResponsibility),
    );
    workHistoryRepository = module.get<Repository<WorkHistory>>(
      getRepositoryToken(WorkHistory),
    );
    governmentAgencyRepository = module.get<Repository<GovernmentAgency>>(
      getRepositoryToken(GovernmentAgency),
    );
    userRepository = module.get<Repository<User>>(
      getRepositoryToken(User),
    );

    mockLogger = {
      log: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
      verbose: jest.fn(),
    } as any;
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    const createDto: CreateWorkHistoryGovernmentAgencyResponsibilityDto = {
      workHistoryId: 'work-history-id-1',
      governmentAgencyId: 'agency-id-1',
    };

    it('should create a new responsibility successfully', async () => {
      jest.spyOn(workHistoryRepository, 'findOne').mockResolvedValue(mockWorkHistory);
      jest.spyOn(governmentAgencyRepository, 'findOneBy').mockResolvedValue(mockGovernmentAgency);
      jest.spyOn(responsibilityRepository, 'findOneBy').mockResolvedValue(null);
      jest.spyOn(workHistoryRepository, 'findOne').mockResolvedValueOnce(mockWorkHistory).mockResolvedValueOnce(mockAssignedByWorkHistory);
      jest.spyOn(responsibilityRepository, 'create').mockReturnValue(mockResponsibility);
      jest.spyOn(responsibilityRepository, 'save').mockResolvedValue(mockResponsibility);

      const result = await service.create(createDto, 'user-id-1');

      expect(result).toEqual(mockResponsibility);
      expect(workHistoryRepository.findOne).toHaveBeenCalledWith({
        where: { id: createDto.workHistoryId },
        relations: ['role', 'workStatus'],
      });
      expect(governmentAgencyRepository.findOneBy).toHaveBeenCalledWith({
        id: createDto.governmentAgencyId,
      });
      expect(responsibilityRepository.create).toHaveBeenCalledWith({
        workHistory: mockWorkHistory,
        governmentAgency: mockGovernmentAgency,
        assignedByWorkHistory: mockAssignedByWorkHistory,
      });
    });

    it('should throw NotFoundException when work history not found', async () => {
      jest.spyOn(workHistoryRepository, 'findOne').mockResolvedValue(null);

      await expect(service.create(createDto, 'user-id-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw BadRequestException when work history is not approved staff', async () => {
      const invalidWorkHistory = { ...mockWorkHistory, workStatus: { name: 'pending' } };
      jest.spyOn(workHistoryRepository, 'findOne').mockResolvedValue(invalidWorkHistory);

      await expect(service.create(createDto, 'user-id-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw NotFoundException when government agency not found', async () => {
      jest.spyOn(workHistoryRepository, 'findOne').mockResolvedValue(mockWorkHistory);
      jest.spyOn(governmentAgencyRepository, 'findOneBy').mockResolvedValue(null);

      await expect(service.create(createDto, 'user-id-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw BadRequestException when responsibility already exists', async () => {
      jest.spyOn(workHistoryRepository, 'findOne').mockResolvedValue(mockWorkHistory);
      jest.spyOn(governmentAgencyRepository, 'findOneBy').mockResolvedValue(mockGovernmentAgency);
      jest.spyOn(responsibilityRepository, 'findOneBy').mockResolvedValue(mockResponsibility);

      await expect(service.create(createDto, 'user-id-1')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('findAll', () => {
    it('should return all responsibilities when no filters provided', async () => {
      jest.spyOn(responsibilityRepository, 'find').mockResolvedValue([mockResponsibility]);

      const result = await service.findAll();

      expect(result).toEqual([mockResponsibility]);
      expect(responsibilityRepository.find).toHaveBeenCalledWith({
        where: {},
        relations: [
          'workHistory',
          'workHistory.user',
          'governmentAgency',
          'assignedByWorkHistory',
        ],
      });
    });

    it('should filter by government agency ID', async () => {
      jest.spyOn(responsibilityRepository, 'find').mockResolvedValue([mockResponsibility]);

      const result = await service.findAll('agency-id-1');

      expect(result).toEqual([mockResponsibility]);
      expect(responsibilityRepository.find).toHaveBeenCalledWith({
        where: { governmentAgency: { id: 'agency-id-1' } },
        relations: [
          'workHistory',
          'workHistory.user',
          'governmentAgency',
          'assignedByWorkHistory',
        ],
      });
    });

    it('should filter by work history ID', async () => {
      jest.spyOn(responsibilityRepository, 'find').mockResolvedValue([mockResponsibility]);

      const result = await service.findAll(undefined, 'work-history-id-1');

      expect(result).toEqual([mockResponsibility]);
      expect(responsibilityRepository.find).toHaveBeenCalledWith({
        where: { workHistory: { id: 'work-history-id-1' } },
        relations: [
          'workHistory',
          'workHistory.user',
          'governmentAgency',
          'assignedByWorkHistory',
        ],
      });
    });
  });

  describe('findOne', () => {
    it('should return a responsibility by ID', async () => {
      jest.spyOn(responsibilityRepository, 'findOne').mockResolvedValue(mockResponsibility);

      const result = await service.findOne('responsibility-id-1');

      expect(result).toEqual(mockResponsibility);
      expect(responsibilityRepository.findOne).toHaveBeenCalledWith({
        where: { id: 'responsibility-id-1' },
        relations: [
          'workHistory',
          'workHistory.user',
          'governmentAgency',
          'assignedByWorkHistory',
          'assignedByWorkHistory.user',
        ],
      });
    });

    it('should throw NotFoundException when responsibility not found', async () => {
      jest.spyOn(responsibilityRepository, 'findOne').mockResolvedValue(null);

      await expect(service.findOne('non-existent-id')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('update', () => {
    const updateDto: UpdateWorkHistoryGovernmentAgencyResponsibilityDto = {
      governmentAgencyId: 'agency-id-2',
    };

    it('should update a responsibility successfully', async () => {
      const updatedResponsibility = { ...mockResponsibility, governmentAgency: { id: 'agency-id-2' } };
      
      jest.spyOn(workHistoryRepository, 'findOne').mockResolvedValue(mockAssignedByWorkHistory);
      jest.spyOn(responsibilityRepository, 'preload').mockResolvedValue(mockResponsibility);
      jest.spyOn(responsibilityRepository, 'save').mockResolvedValue(mockResponsibility);
      jest.spyOn(responsibilityRepository, 'findOne').mockResolvedValue(updatedResponsibility);

      const result = await service.update('responsibility-id-1', updateDto, 'user-id-1');

      expect(result).toEqual(updatedResponsibility);
      expect(responsibilityRepository.preload).toHaveBeenCalled();
      expect(responsibilityRepository.save).toHaveBeenCalled();
    });

    it('should throw NotFoundException when responsibility not found', async () => {
      jest.spyOn(workHistoryRepository, 'findOne').mockResolvedValue(mockAssignedByWorkHistory);
      jest.spyOn(responsibilityRepository, 'preload').mockResolvedValue(null);

      await expect(service.update('non-existent-id', updateDto, 'user-id-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('remove', () => {
    it('should delete a responsibility successfully', async () => {
      jest.spyOn(responsibilityRepository, 'delete').mockResolvedValue({ affected: 1 } as any);

      const result = await service.remove('responsibility-id-1');

      expect(result).toEqual({ message: 'Responsibility with ID responsibility-id-1 has been deleted' });
      expect(responsibilityRepository.delete).toHaveBeenCalledWith('responsibility-id-1');
    });

    it('should throw NotFoundException when responsibility not found', async () => {
      jest.spyOn(responsibilityRepository, 'delete').mockResolvedValue({ affected: 0 } as any);

      await expect(service.remove('non-existent-id')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
