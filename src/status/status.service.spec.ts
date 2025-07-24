import { Test, TestingModule } from '@nestjs/testing';
import { StatusService } from './status.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Status } from './entities/status.entity';
import { User } from '../users/entities/user.entity';
import { WorkHistory } from '../work-history/entities/work-history.entity';
import { Repository } from 'typeorm';
import { BadRequestException, NotFoundException, UnauthorizedException, Logger } from '@nestjs/common';
import { CreateStatusDto } from './dto/create-status.dto';
import { UpdateStatusDto } from './dto/update-status.dto';

// Mock handleException
jest.mock('../util/handleException', () => ({
  handleException: jest.fn((logger, error) => { throw error; })
}));
import { handleException } from '../util/handleException';

const mockStatusRepository = () => ({
  findOne: jest.fn(),
  create: jest.fn(),
  save: jest.fn(),
  find: jest.fn(),
  softRemove: jest.fn(),
  delete: jest.fn(),
  restore: jest.fn(),
});
const mockUserRepository = () => ({
  findOne: jest.fn(),
});
const mockWorkHistoryRepository = () => ({
  findOne: jest.fn(),
});

const mockLogger = {
  error: jest.fn(),
  log: jest.fn(),
  warn: jest.fn(),
};

const minimalEntity = {} as any;

const sampleWorkHistory = {
  id: 'workhistory-uuid',
  amphoe: minimalEntity,
  localAdministrativeOrganization: minimalEntity,
  user: minimalEntity,
  workStatus: minimalEntity,
  role: minimalEntity,
  governmentAgencies: minimalEntity,
  createdAt: new Date(),
  createdBy: minimalEntity,
  deletedAt: undefined,
  updatedAt: new Date(),
  updatedBy: minimalEntity,
  workHistoryResponsibleAdmins: [],
  budgetPlan: [],
  creatorStrategy: [],
  deletorStrategy: [],
  creatorProjectGroup: [],
  responsibleProjectGroup: [],
  creatorTactic: [],
  deletorTactic: [],
  creatorPlan: [],
  deletorPlan: [],
  creatorTrackingStatus: [],
  deletorTrackingStatus: [],
  creatorStatus: [],
  deletorStatus: [],
};

const sampleStatus = {
  id: 'status-uuid',
  name: 'Active',
  createdAt: new Date(),
  createdBy: sampleWorkHistory,
  deleteAt: null,
  deletedBy: sampleWorkHistory,
  trackingStatus: [],
};

describe('StatusService', () => {
  let service: StatusService;
  let statusRepository: jest.Mocked<Repository<Status>>;
  let userRepository: jest.Mocked<Repository<User>>;
  let workHistoryRepository: jest.Mocked<Repository<WorkHistory>>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StatusService,
        { provide: getRepositoryToken(Status), useFactory: mockStatusRepository },
        { provide: getRepositoryToken(User), useFactory: mockUserRepository },
        { provide: getRepositoryToken(WorkHistory), useFactory: mockWorkHistoryRepository },
      ],
    }).compile();

    service = module.get<StatusService>(StatusService);
    statusRepository = module.get(getRepositoryToken(Status));
    userRepository = module.get(getRepositoryToken(User));
    workHistoryRepository = module.get(getRepositoryToken(WorkHistory));
    // Patch logger
    (service as any).logger = mockLogger;
    jest.clearAllMocks();
  });

  describe('create', () => {
    const dto: CreateStatusDto = { name: 'Active' };
    const userId = 'workhistory-uuid';

    it('should create and return a status (success)', async () => {
      statusRepository.findOne.mockResolvedValueOnce(null); // No duplicate name
      workHistoryRepository.findOne.mockResolvedValueOnce(sampleWorkHistory);
      statusRepository.create.mockReturnValue({ ...sampleStatus, createdBy: sampleWorkHistory });
      statusRepository.save.mockResolvedValueOnce(sampleStatus as Status);

      const result = await service.create(dto, userId);
      expect(result).toEqual(sampleStatus);
      expect(statusRepository.create).toHaveBeenCalledWith({ ...dto, createdBy: sampleWorkHistory });
      expect(statusRepository.save).toHaveBeenCalled();
    });

    it('should throw BadRequestException if status name exists', async () => {
      statusRepository.findOne.mockResolvedValueOnce(sampleStatus as Status);
      await expect(service.create(dto, userId)).rejects.toThrow(BadRequestException);
    });

    it('should throw UnauthorizedException if work history not found', async () => {
      statusRepository.findOne.mockResolvedValueOnce(null);
      workHistoryRepository.findOne.mockResolvedValueOnce(null);
      await expect(service.create(dto, userId)).rejects.toThrow(UnauthorizedException);
    });

    it('should throw InternalServerErrorException on DB error', async () => {
      statusRepository.findOne.mockRejectedValueOnce(new Error('DB error'));
      await expect(service.create(dto, userId)).rejects.toThrow('DB error');
    });

    it('should handle edge case: empty name', async () => {
      const badDto = { name: '' };
      statusRepository.findOne.mockResolvedValueOnce(null);
      workHistoryRepository.findOne.mockResolvedValueOnce(sampleWorkHistory);
      statusRepository.create.mockReturnValue({ ...sampleStatus, name: '', createdBy: sampleWorkHistory });
      statusRepository.save.mockResolvedValueOnce({ ...sampleStatus, name: '' } as Status);
      const result = await service.create(badDto as any, userId);
      expect(result.name).toBe('');
    });
  });

  describe('findAll', () => {
    it('should return all statuses', async () => {
      statusRepository.find.mockResolvedValueOnce([sampleStatus as Status]);
      const result = await service.findAll();
      expect(result).toEqual([sampleStatus]);
      expect(statusRepository.find).toHaveBeenCalledWith({ relations: ['createdBy', 'deletedBy'] });
    });
    it('should throw InternalServerErrorException on DB error', async () => {
      statusRepository.find.mockRejectedValueOnce(new Error('DB error'));
      await expect(service.findAll()).rejects.toThrow('DB error');
    });
  });

  describe('findOne', () => {
    it('should return a status by id', async () => {
      statusRepository.findOne.mockResolvedValueOnce(sampleStatus as Status);
      const result = await service.findOne('status-uuid');
      expect(result).toEqual(sampleStatus);
    });
    it('should throw BadRequestException if not found', async () => {
      statusRepository.findOne.mockResolvedValueOnce(null);
      await expect(service.findOne('not-exist')).rejects.toThrow(BadRequestException);
    });
    it('should throw InternalServerErrorException on DB error', async () => {
      statusRepository.findOne.mockRejectedValueOnce(new Error('DB error'));
      await expect(service.findOne('status-uuid')).rejects.toThrow('DB error');
    });
    it('should handle edge case: empty id', async () => {
      statusRepository.findOne.mockResolvedValueOnce(null);
      await expect(service.findOne('')).rejects.toThrow(BadRequestException);
    });
  });

  describe('update', () => {
    const updateDto: UpdateStatusDto = { name: 'Updated' } as any;
    it('should update and return the status', async () => {
      statusRepository.findOne.mockResolvedValueOnce(null); // No duplicate name
      statusRepository.findOne.mockResolvedValueOnce(sampleStatus as Status); // Found by id
      statusRepository.save.mockResolvedValueOnce({ ...sampleStatus, ...updateDto } as Status);
      const result = await service.update('status-uuid', updateDto);
      expect(result).toEqual({ ...sampleStatus, ...updateDto });
    });
    it('should throw BadRequestException if name exists', async () => {
      statusRepository.findOne.mockResolvedValueOnce({ ...sampleStatus, id: 'other-id' } as Status);
      await expect(service.update('status-uuid', updateDto)).rejects.toThrow(BadRequestException);
    });
    it('should throw BadRequestException if status not found', async () => {
      statusRepository.findOne.mockResolvedValueOnce(null); // No duplicate name
      statusRepository.findOne.mockResolvedValueOnce(null); // Not found by id
      await expect(service.update('status-uuid', updateDto)).rejects.toThrow(BadRequestException);
    });
    it('should throw InternalServerErrorException on DB error', async () => {
      statusRepository.findOne.mockRejectedValueOnce(new Error('DB error'));
      await expect(service.update('status-uuid', updateDto)).rejects.toThrow('DB error');
    });
    it('should handle edge case: empty name', async () => {
      const badDto = { name: '' };
      statusRepository.findOne.mockResolvedValueOnce(null);
      statusRepository.findOne.mockResolvedValueOnce(sampleStatus as Status);
      statusRepository.save.mockResolvedValueOnce({ ...sampleStatus, name: '' } as Status);
      const result = await service.update('status-uuid', badDto as any);
      expect(result.name).toBe('');
    });
  });

  describe('softRemove', () => {
    const userId = 'workhistory-uuid';
    it('should soft remove a status', async () => {
      statusRepository.findOne.mockResolvedValueOnce(sampleStatus as Status);
      workHistoryRepository.findOne.mockResolvedValueOnce(sampleWorkHistory);
      statusRepository.save.mockResolvedValueOnce({ ...sampleStatus, deletedBy: sampleWorkHistory } as Status);
      statusRepository.softRemove.mockResolvedValueOnce(sampleStatus as Status);
      const result = await service.softRemove('status-uuid', userId);
      expect(result).toEqual({ message: `Status ${sampleStatus.name} soft removed successfully` });
    });
    it('should throw BadRequestException if status not found', async () => {
      statusRepository.findOne.mockResolvedValueOnce(null);
      await expect(service.softRemove('not-exist', userId)).rejects.toThrow(BadRequestException);
    });
    it('should throw UnauthorizedException if work history not found', async () => {
      statusRepository.findOne.mockResolvedValueOnce(sampleStatus as Status);
      workHistoryRepository.findOne.mockResolvedValueOnce(null);
      await expect(service.softRemove('status-uuid', userId)).rejects.toThrow(UnauthorizedException);
    });
    it('should throw InternalServerErrorException on DB error', async () => {
      statusRepository.findOne.mockRejectedValueOnce(new Error('DB error'));
      await expect(service.softRemove('status-uuid', userId)).rejects.toThrow('DB error');
    });
    it('should handle edge case: empty id', async () => {
      statusRepository.findOne.mockResolvedValueOnce(null);
      await expect(service.softRemove('', userId)).rejects.toThrow(BadRequestException);
    });
  });

  describe('remove', () => {
    it('should hard delete a status', async () => {
      statusRepository.delete.mockResolvedValueOnce({ affected: 1 } as any);
      const result = await service.remove('status-uuid');
      expect(result).toEqual({ message: `Status with ID status-uuid has been permanently removed.` });
    });
    it('should throw NotFoundException if status not found', async () => {
      statusRepository.delete.mockResolvedValueOnce({ affected: 0 } as any);
      await expect(service.remove('not-exist')).rejects.toThrow(NotFoundException);
    });
    it('should throw error on DB error', async () => {
      statusRepository.delete.mockRejectedValueOnce(new Error('DB error'));
      await expect(service.remove('status-uuid')).rejects.toThrow('DB error');
    });
    it('should handle edge case: empty id', async () => {
      statusRepository.delete.mockResolvedValueOnce({ affected: 0 } as any);
      await expect(service.remove('')).rejects.toThrow(NotFoundException);
    });
  });

  describe('restore', () => {
    it('should restore a status', async () => {
      statusRepository.findOne.mockResolvedValueOnce(sampleStatus as Status);
      statusRepository.restore.mockResolvedValueOnce({ affected: 1 } as any);
      const result = await service.restore('status-uuid');
      expect(result).toEqual({ message: `Status with ID status-uuid has been restored` });
    });
    it('should throw BadRequestException if status not found (findOne)', async () => {
      statusRepository.findOne.mockResolvedValueOnce(null);
      await expect(service.restore('not-exist')).rejects.toThrow(BadRequestException);
    });
    it('should throw BadRequestException if restore.affected === 0', async () => {
      statusRepository.findOne.mockResolvedValueOnce(sampleStatus as Status);
      statusRepository.restore.mockResolvedValueOnce({ affected: 0 } as any);
      await expect(service.restore('status-uuid')).rejects.toThrow(BadRequestException);
    });
    it('should throw InternalServerErrorException on DB error', async () => {
      statusRepository.findOne.mockRejectedValueOnce(new Error('DB error'));
      await expect(service.restore('status-uuid')).rejects.toThrow('DB error');
    });
    it('should handle edge case: empty id', async () => {
      statusRepository.findOne.mockResolvedValueOnce(null);
      await expect(service.restore('')).rejects.toThrow(BadRequestException);
    });
  });
});
