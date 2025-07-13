import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Logger, NotFoundException, InternalServerErrorException, BadRequestException } from '@nestjs/common';
import { WorkHistoryAmphoeResponsibilityService } from './work-history-amphoe-responsibility.service';
import { WorkHistoryAmphoeResponsibility } from './entities/work-history-amphoe-responsibility.entity';
import { WorkHistory } from '../work-history/entities/work-history.entity';
import { Amphoe } from '../amphoes/entities/amphoe.entity';
import { User } from '../users/entities/user.entity';
import { CreateWorkHistoryAmphoeResponsibilityDto } from './dto/create-work-history-amphoe-responsibility.dto';
import { UpdateWorkHistoryAmphoeResponsibilityDto } from './dto/update-work-history-amphoe-responsibility.dto';
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
    throw new InternalServerErrorException('An unexpected error occurred on the server.');
  }),
}));

describe('WorkHistoryAmphoeResponsibilityService', () => {
  let service: WorkHistoryAmphoeResponsibilityService;
  let responsibilityRepository: Repository<WorkHistoryAmphoeResponsibility>;
  let workHistoryRepository: Repository<WorkHistory>;
  let amphoeRepository: Repository<Amphoe>;
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

  const mockAmphoe: Amphoe = {
    id: 'amphoe-id-1',
    name: 'Test Amphoe',
    province: 'Test Province',
    createdAt: new Date(),
    updatedAt: new Date(),
    workHistoryResponsibleAdmins: [],
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
    id: 'work-history-id-1',
    user: mockUser,
    workStatus: mockWorkStatus,
    role: mockRole,
    createdAt: new Date(),
    updatedAt: new Date(),
    workHistoryResponsibleAdmins: [],
  } as any;

  const mockResponsibility: WorkHistoryAmphoeResponsibility = {
    id: 'responsibility-id-1',
    workHistory: mockWorkHistory,
    amphoe: mockAmphoe,
    assignedByWorkHistory: mockAssignedByWorkHistory,
    createdAt: new Date(),
  };

  const mockResponsibility2: WorkHistoryAmphoeResponsibility = {
    id: 'responsibility-id-2',
    workHistory: mockWorkHistory,
    amphoe: mockAmphoe,
    assignedByWorkHistory: mockAssignedByWorkHistory,
    createdAt: new Date(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkHistoryAmphoeResponsibilityService,
        {
          provide: getRepositoryToken(WorkHistoryAmphoeResponsibility),
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
            findOneBy: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Amphoe),
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

    service = module.get<WorkHistoryAmphoeResponsibilityService>(WorkHistoryAmphoeResponsibilityService);
    responsibilityRepository = module.get<Repository<WorkHistoryAmphoeResponsibility>>(getRepositoryToken(WorkHistoryAmphoeResponsibility));
    workHistoryRepository = module.get<Repository<WorkHistory>>(getRepositoryToken(WorkHistory));
    amphoeRepository = module.get<Repository<Amphoe>>(getRepositoryToken(Amphoe));
    userRepository = module.get<Repository<User>>(getRepositoryToken(User));
    
    mockLogger = {
      log: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
      verbose: jest.fn(),
    } as any;
    
    (service as any).logger = mockLogger;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('create', () => {
    const createDto: CreateWorkHistoryAmphoeResponsibilityDto = {
      workHistoryId: 'work-history-id-1',
      amphoeId: 'amphoe-id-1',
    };
    const assignedByUserId = 'user-id-1';

    describe('✅ Success Case', () => {
      it('should create a new responsibility successfully', async () => {
        jest.spyOn(workHistoryRepository, 'findOne')
          .mockResolvedValueOnce(mockWorkHistory) // First call for work history
          .mockResolvedValueOnce(mockAssignedByWorkHistory); // Second call for assigned by work history
        jest.spyOn(amphoeRepository, 'findOneBy').mockResolvedValue(mockAmphoe);
        jest.spyOn(responsibilityRepository, 'findOneBy').mockResolvedValue(null);
        jest.spyOn(responsibilityRepository, 'create').mockReturnValue(mockResponsibility);
        jest.spyOn(responsibilityRepository, 'save').mockResolvedValue(mockResponsibility);

        const result = await service.create(createDto, assignedByUserId);

        expect(workHistoryRepository.findOne).toHaveBeenCalledWith({
          where: { id: createDto.workHistoryId },
          relations: ['role', 'workStatus'],
        });
        expect(amphoeRepository.findOneBy).toHaveBeenCalledWith({ id: createDto.amphoeId });
        expect(responsibilityRepository.findOneBy).toHaveBeenCalledWith({
          workHistory: { id: createDto.workHistoryId },
          amphoe: { id: createDto.amphoeId },
        });
        expect(responsibilityRepository.create).toHaveBeenCalledWith({
          workHistory: mockWorkHistory,
          amphoe: mockAmphoe,
          assignedByWorkHistory: mockAssignedByWorkHistory,
        });
        expect(result).toEqual(mockResponsibility);
      });
    });

    describe('❌ NotFoundException', () => {
      it('should throw NotFoundException when work history not found', async () => {
        jest.spyOn(workHistoryRepository, 'findOne').mockResolvedValue(null);

        await expect(service.create(createDto, assignedByUserId)).rejects.toThrow(
          new NotFoundException(`Work history with ID ${createDto.workHistoryId} not found`)
        );
      });

      it('should throw NotFoundException when amphoe not found', async () => {
        jest.spyOn(workHistoryRepository, 'findOne').mockResolvedValue(mockWorkHistory);
        jest.spyOn(amphoeRepository, 'findOneBy').mockResolvedValue(null);

        await expect(service.create(createDto, assignedByUserId)).rejects.toThrow(
          new NotFoundException(`Amphoe with ID ${createDto.amphoeId} not found`)
        );
      });

      it('should throw NotFoundException when assigned by user has no approved work history', async () => {
        jest.spyOn(workHistoryRepository, 'findOne')
          .mockResolvedValueOnce(mockWorkHistory) // First call for work history
          .mockResolvedValueOnce(null); // Second call for assigned by work history
        jest.spyOn(amphoeRepository, 'findOneBy').mockResolvedValue(mockAmphoe);
        jest.spyOn(responsibilityRepository, 'findOneBy').mockResolvedValue(null);

        await expect(service.create(createDto, assignedByUserId)).rejects.toThrow(
          new NotFoundException(`Approved work history not pass the conditions for user ${assignedByUserId}`)
        );
      });
    });

    describe('❌ BadRequestException', () => {
      it('should throw BadRequestException when work history is not approved admin', async () => {
        const nonApprovedWorkHistory = {
          ...mockWorkHistory,
          workStatus: { ...mockWorkStatus, name: 'pending' },
        };
        jest.spyOn(workHistoryRepository, 'findOne').mockResolvedValue(nonApprovedWorkHistory);

        await expect(service.create(createDto, assignedByUserId)).rejects.toThrow(
          new BadRequestException('Responsibilities can only be added to an approved admin work history.')
        );
      });

      it('should throw BadRequestException when responsibility already exists', async () => {
        jest.spyOn(workHistoryRepository, 'findOne').mockResolvedValue(mockWorkHistory);
        jest.spyOn(amphoeRepository, 'findOneBy').mockResolvedValue(mockAmphoe);
        jest.spyOn(responsibilityRepository, 'findOneBy').mockResolvedValue(mockResponsibility);

        await expect(service.create(createDto, assignedByUserId)).rejects.toThrow(
          new BadRequestException('This responsibility already exists.')
        );
      });
    });

    describe('❌ Error Cases', () => {
      it('should handle database errors during creation', async () => {
        const dbError = new Error('Database connection failed');
        jest.spyOn(workHistoryRepository, 'findOne').mockRejectedValue(dbError);

        await expect(service.create(createDto, assignedByUserId)).rejects.toThrow('An unexpected error occurred on the server.');
        expect(handleException.handleException).toHaveBeenCalledWith(mockLogger, dbError);
      });
    });

    describe('⚠️ Edge Cases', () => {
      it('should handle empty workHistoryId', async () => {
        const emptyWorkHistoryDto = { ...createDto, workHistoryId: '' };
        jest.spyOn(workHistoryRepository, 'findOne').mockResolvedValue(null);

        await expect(service.create(emptyWorkHistoryDto, assignedByUserId)).rejects.toThrow(
          new NotFoundException('Work history with ID  not found')
        );
      });

      it('should handle empty amphoeId', async () => {
        const emptyAmphoeDto = { ...createDto, amphoeId: '' };
        jest.spyOn(workHistoryRepository, 'findOne').mockResolvedValue(mockWorkHistory);
        jest.spyOn(amphoeRepository, 'findOneBy').mockResolvedValue(null);

        await expect(service.create(emptyAmphoeDto, assignedByUserId)).rejects.toThrow(
          new NotFoundException('Amphoe with ID  not found')
        );
      });

      it('should handle null assignedByUserId', async () => {
        jest.spyOn(workHistoryRepository, 'findOne').mockResolvedValue(mockWorkHistory);
        jest.spyOn(amphoeRepository, 'findOneBy').mockResolvedValue(mockAmphoe);
        jest.spyOn(responsibilityRepository, 'findOneBy').mockResolvedValue(null);
        jest.spyOn(responsibilityRepository, 'create').mockReturnValue(mockResponsibility);
        jest.spyOn(responsibilityRepository, 'save').mockResolvedValue(mockResponsibility);

        const result = await service.create(createDto, undefined);

        expect(result).toEqual(mockResponsibility);
      });
    });
  });

  describe('findAll', () => {
    describe('✅ Success Case', () => {
      it('should return all responsibilities when no filters provided', async () => {
        const mockResponsibilities = [mockResponsibility, mockResponsibility2];
        jest.spyOn(responsibilityRepository, 'find').mockResolvedValue(mockResponsibilities);

        const result = await service.findAll();

        expect(responsibilityRepository.find).toHaveBeenCalledWith({
          where: {},
          relations: ['workHistory', 'workHistory.user', 'amphoe', 'assignedByWorkHistory'],
        });
        expect(result).toEqual(mockResponsibilities);
      });

      it('should return filtered responsibilities by amphoeId', async () => {
        const mockResponsibilities = [mockResponsibility];
        jest.spyOn(responsibilityRepository, 'find').mockResolvedValue(mockResponsibilities);

        const result = await service.findAll('amphoe-id-1');

        expect(responsibilityRepository.find).toHaveBeenCalledWith({
          where: { amphoe: { id: 'amphoe-id-1' } },
          relations: ['workHistory', 'workHistory.user', 'amphoe', 'assignedByWorkHistory'],
        });
        expect(result).toEqual(mockResponsibilities);
      });

      it('should return filtered responsibilities by workHistoryId', async () => {
        const mockResponsibilities = [mockResponsibility];
        jest.spyOn(responsibilityRepository, 'find').mockResolvedValue(mockResponsibilities);

        const result = await service.findAll(undefined, 'work-history-id-1');

        expect(responsibilityRepository.find).toHaveBeenCalledWith({
          where: { workHistory: { id: 'work-history-id-1' } },
          relations: ['workHistory', 'workHistory.user', 'amphoe', 'assignedByWorkHistory'],
        });
        expect(result).toEqual(mockResponsibilities);
      });

      it('should return filtered responsibilities by both amphoeId and workHistoryId', async () => {
        const mockResponsibilities = [mockResponsibility];
        jest.spyOn(responsibilityRepository, 'find').mockResolvedValue(mockResponsibilities);

        const result = await service.findAll('amphoe-id-1', 'work-history-id-1');

        expect(responsibilityRepository.find).toHaveBeenCalledWith({
          where: { 
            amphoe: { id: 'amphoe-id-1' },
            workHistory: { id: 'work-history-id-1' }
          },
          relations: ['workHistory', 'workHistory.user', 'amphoe', 'assignedByWorkHistory'],
        });
        expect(result).toEqual(mockResponsibilities);
      });

      it('should return empty array when no responsibilities exist', async () => {
        jest.spyOn(responsibilityRepository, 'find').mockResolvedValue([]);

        const result = await service.findAll();

        expect(responsibilityRepository.find).toHaveBeenCalledWith({
          where: {},
          relations: ['workHistory', 'workHistory.user', 'amphoe', 'assignedByWorkHistory'],
        });
        expect(result).toEqual([]);
      });
    });

    describe('❌ Error Cases', () => {
      it('should handle database connection errors', async () => {
        const dbError = new Error('Database connection failed');
        jest.spyOn(responsibilityRepository, 'find').mockRejectedValue(dbError);

        await expect(service.findAll()).rejects.toThrow('Database connection failed');
      });

      it('should handle query execution errors', async () => {
        const queryError = new Error('Query execution failed');
        jest.spyOn(responsibilityRepository, 'find').mockRejectedValue(queryError);

        await expect(service.findAll()).rejects.toThrow('Query execution failed');
      });
    });
  });

  describe('findOne', () => {
    const validId = 'responsibility-id-1';

    describe('✅ Success Case', () => {
      it('should return a responsibility by id', async () => {
        jest.spyOn(responsibilityRepository, 'findOne').mockResolvedValue(mockResponsibility);

        const result = await service.findOne(validId);

        expect(responsibilityRepository.findOne).toHaveBeenCalledWith({
          where: { id: validId },
          relations: ['workHistory', 'workHistory.user', 'amphoe', 'assignedByWorkHistory', 'assignedByWorkHistory.user'],
        });
        expect(result).toEqual(mockResponsibility);
      });
    });

    describe('❌ NotFoundException', () => {
      it('should throw NotFoundException when responsibility not found', async () => {
        jest.spyOn(responsibilityRepository, 'findOne').mockResolvedValue(null);

        await expect(service.findOne(validId)).rejects.toThrow(
          new NotFoundException(`Responsibility with ID ${validId} not found`)
        );

        expect(responsibilityRepository.findOne).toHaveBeenCalledWith({
          where: { id: validId },
          relations: ['workHistory', 'workHistory.user', 'amphoe', 'assignedByWorkHistory', 'assignedByWorkHistory.user'],
        });
      });
    });

    describe('❌ Error Cases', () => {
      it('should handle database errors', async () => {
        const dbError = new Error('Database error');
        jest.spyOn(responsibilityRepository, 'findOne').mockRejectedValue(dbError);

        await expect(service.findOne(validId)).rejects.toThrow('An unexpected error occurred on the server.');
        expect(handleException.handleException).toHaveBeenCalledWith(mockLogger, dbError);
      });
    });

    describe('⚠️ Edge Cases', () => {
      it('should handle empty string id', async () => {
        jest.spyOn(responsibilityRepository, 'findOne').mockResolvedValue(null);

        await expect(service.findOne('')).rejects.toThrow(
          new NotFoundException('Responsibility with ID  not found')
        );
      });

      it('should handle null id', async () => {
        jest.spyOn(responsibilityRepository, 'findOne').mockResolvedValue(null);

        await expect(service.findOne(null as any)).rejects.toThrow(
          new NotFoundException('Responsibility with ID null not found')
        );
      });

      it('should handle undefined id', async () => {
        jest.spyOn(responsibilityRepository, 'findOne').mockResolvedValue(null);

        await expect(service.findOne(undefined as any)).rejects.toThrow(
          new NotFoundException('Responsibility with ID undefined not found')
        );
      });
    });
  });

  describe('update', () => {
    const validId = 'responsibility-id-1';
    const updateDto: UpdateWorkHistoryAmphoeResponsibilityDto = {
      workHistoryId: 'work-history-id-2',
      amphoeId: 'amphoe-id-2',
    };
    const assignedByUserId = 'user-id-1';

    describe('✅ Success Case', () => {
      it('should update a responsibility successfully', async () => {
        const newWorkHistory = { ...mockWorkHistory, id: 'work-history-id-2' };
        const updatedResponsibility = { ...mockResponsibility, workHistory: newWorkHistory };

        jest.spyOn(workHistoryRepository, 'findOne')
          .mockResolvedValueOnce(mockAssignedByWorkHistory) // First call for assigned by work history
          .mockResolvedValueOnce(newWorkHistory); // Second call for new work history
        jest.spyOn(responsibilityRepository, 'preload').mockResolvedValue(updatedResponsibility);
        jest.spyOn(responsibilityRepository, 'save').mockResolvedValue(updatedResponsibility);
        jest.spyOn(responsibilityRepository, 'findOne').mockResolvedValue(updatedResponsibility);

        const result = await service.update(validId, updateDto, assignedByUserId);

        expect(workHistoryRepository.findOne).toHaveBeenCalledWith({
          where: { user: { id: assignedByUserId } },
          relations: ['workStatus', 'role'],
        });
        expect(workHistoryRepository.findOne).toHaveBeenCalledWith({
          where: { id: updateDto.workHistoryId },
        });
        expect(responsibilityRepository.preload).toHaveBeenCalledWith({
          id: validId,
          assignedByWorkHistory: mockAssignedByWorkHistory,
          amphoe: { id: updateDto.amphoeId },
          workHistory: newWorkHistory,
        });
        expect(result).toEqual(updatedResponsibility);
      });

      it('should update a responsibility without workHistoryId', async () => {
        const updateDtoWithoutWorkHistory = { amphoeId: 'amphoe-id-2' };
        const updatedResponsibility = { ...mockResponsibility, amphoe: { ...mockAmphoe, id: 'amphoe-id-2' } };

        jest.spyOn(workHistoryRepository, 'findOne').mockResolvedValue(mockAssignedByWorkHistory);
        jest.spyOn(responsibilityRepository, 'preload').mockResolvedValue(updatedResponsibility);
        jest.spyOn(responsibilityRepository, 'save').mockResolvedValue(updatedResponsibility);
        jest.spyOn(responsibilityRepository, 'findOne').mockResolvedValue(updatedResponsibility);

        const result = await service.update(validId, updateDtoWithoutWorkHistory, assignedByUserId);

        expect(responsibilityRepository.preload).toHaveBeenCalledWith({
          id: validId,
          assignedByWorkHistory: mockAssignedByWorkHistory,
          amphoe: { id: updateDtoWithoutWorkHistory.amphoeId },
          workHistory: undefined,
        });
        expect(result).toEqual(updatedResponsibility);
      });
    });

    describe('❌ NotFoundException', () => {
      it('should throw NotFoundException when assigned by user has no approved work history', async () => {
        jest.spyOn(workHistoryRepository, 'findOne').mockResolvedValue(null);

        await expect(service.update(validId, updateDto, assignedByUserId)).rejects.toThrow(
          new NotFoundException(`Approved work history not pass the conditions for user ${assignedByUserId}`)
        );
      });

      it('should throw NotFoundException when new work history not found', async () => {
        jest.spyOn(workHistoryRepository, 'findOne')
          .mockResolvedValueOnce(mockAssignedByWorkHistory)
          .mockResolvedValueOnce(null);

        await expect(service.update(validId, updateDto, assignedByUserId)).rejects.toThrow(
          new NotFoundException('Work history you want to transfer to not found')
        );
      });

      it('should throw NotFoundException when responsibility not found during preload', async () => {
        jest.spyOn(workHistoryRepository, 'findOne')
          .mockResolvedValueOnce(mockAssignedByWorkHistory)
          .mockResolvedValueOnce(mockWorkHistory);
        jest.spyOn(responsibilityRepository, 'preload').mockResolvedValue(undefined);

        await expect(service.update(validId, updateDto, assignedByUserId)).rejects.toThrow(
          new NotFoundException(`Responsibility with ID ${validId} not found`)
        );
      });

      it('should throw NotFoundException when responsibility not found after update', async () => {
        jest.spyOn(workHistoryRepository, 'findOne')
          .mockResolvedValueOnce(mockAssignedByWorkHistory)
          .mockResolvedValueOnce(mockWorkHistory);
        jest.spyOn(responsibilityRepository, 'preload').mockResolvedValue(mockResponsibility);
        jest.spyOn(responsibilityRepository, 'save').mockResolvedValue(mockResponsibility);
        jest.spyOn(responsibilityRepository, 'findOne').mockResolvedValue(null);

        await expect(service.update(validId, updateDto, assignedByUserId)).rejects.toThrow(
          new NotFoundException(`Responsibility with ID ${validId} not found after update`)
        );
      });
    });

    describe('❌ Error Cases', () => {
      it('should handle database errors during update', async () => {
        const dbError = new Error('Database error');
        jest.spyOn(workHistoryRepository, 'findOne').mockRejectedValue(dbError);

        await expect(service.update(validId, updateDto, assignedByUserId)).rejects.toThrow('An unexpected error occurred on the server.');
        expect(handleException.handleException).toHaveBeenCalledWith(mockLogger, dbError);
      });
    });

    describe('⚠️ Edge Cases', () => {
      it('should handle empty string id', async () => {
        jest.spyOn(workHistoryRepository, 'findOne').mockResolvedValue(mockAssignedByWorkHistory);
        jest.spyOn(responsibilityRepository, 'preload').mockResolvedValue(undefined);

        await expect(service.update('', updateDto, assignedByUserId)).rejects.toThrow(
          new NotFoundException('Responsibility with ID  not found')
        );
      });

      it('should handle empty update dto', async () => {
        const emptyUpdateDto: UpdateWorkHistoryAmphoeResponsibilityDto = {};
        const updatedResponsibility = { ...mockResponsibility };

        jest.spyOn(workHistoryRepository, 'findOne').mockResolvedValue(mockAssignedByWorkHistory);
        jest.spyOn(responsibilityRepository, 'preload').mockResolvedValue(updatedResponsibility);
        jest.spyOn(responsibilityRepository, 'save').mockResolvedValue(updatedResponsibility);
        jest.spyOn(responsibilityRepository, 'findOne').mockResolvedValue(updatedResponsibility);

        const result = await service.update(validId, emptyUpdateDto, assignedByUserId);

        expect(responsibilityRepository.preload).toHaveBeenCalledWith({
          id: validId,
          assignedByWorkHistory: mockAssignedByWorkHistory,
          amphoe: undefined,
          workHistory: undefined,
        });
        expect(result).toEqual(updatedResponsibility);
      });
    });
  });

  describe('remove', () => {
    const validId = 'responsibility-id-1';

    describe('✅ Success Case', () => {
      it('should permanently remove a responsibility', async () => {
        const deleteResult = { affected: 1 };
        jest.spyOn(responsibilityRepository, 'delete').mockResolvedValue(deleteResult as any);

        const result = await service.remove(validId);

        expect(responsibilityRepository.delete).toHaveBeenCalledWith(validId);
        expect(result).toEqual({ message: `Responsibility with ID ${validId} has been deleted` });
      });
    });

    describe('❌ NotFoundException', () => {
      it('should throw NotFoundException when responsibility not found', async () => {
        const deleteResult = { affected: 0 };
        jest.spyOn(responsibilityRepository, 'delete').mockResolvedValue(deleteResult as any);

        await expect(service.remove(validId)).rejects.toThrow(
          new NotFoundException(`Responsibility with ID ${validId} not found`)
        );
        expect(responsibilityRepository.delete).toHaveBeenCalledWith(validId);
      });
    });

    describe('❌ Error Cases', () => {
      it('should handle database errors during removal', async () => {
        const dbError = new Error('Database error');
        jest.spyOn(responsibilityRepository, 'delete').mockRejectedValue(dbError);

        await expect(service.remove(validId)).rejects.toThrow('An unexpected error occurred on the server.');
        expect(handleException.handleException).toHaveBeenCalledWith(mockLogger, dbError);
      });
    });

    describe('⚠️ Edge Cases', () => {
      it('should handle empty string id', async () => {
        const deleteResult = { affected: 0 };
        jest.spyOn(responsibilityRepository, 'delete').mockResolvedValue(deleteResult as any);

        await expect(service.remove('')).rejects.toThrow(
          new NotFoundException('Responsibility with ID  not found')
        );
      });

      it('should handle null id', async () => {
        const deleteResult = { affected: 0 };
        jest.spyOn(responsibilityRepository, 'delete').mockResolvedValue(deleteResult as any);

        await expect(service.remove(null as any)).rejects.toThrow(
          new NotFoundException('Responsibility with ID null not found')
        );
      });
    });
  });
});
