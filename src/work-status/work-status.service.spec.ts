import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Logger, NotFoundException, InternalServerErrorException, BadRequestException } from '@nestjs/common';
import { WorkStatusService } from './work-status.service';
import { WorkStatus } from './entities/work-status.entity';
import { CreateWorkStatusDto } from './dto/create-work-status.dto';
import { UpdateWorkStatusDto } from './dto/update-work-status.dto';
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

describe('WorkStatusService', () => {
  let service: WorkStatusService;
  let workStatusRepository: Repository<WorkStatus>;
  let mockLogger: jest.Mocked<Logger>;

  const mockWorkStatus: WorkStatus = {
    id: 'test-id-1',
    name: 'Test Work Status',
    createdAt: new Date(),
    deletedAt: undefined,
    workHistory: [],
  };

  const mockWorkStatus2: WorkStatus = {
    id: 'test-id-2',
    name: 'Another Work Status',
    createdAt: new Date(),
    deletedAt: undefined,
    workHistory: [],
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkStatusService,
        {
          provide: getRepositoryToken(WorkStatus),
          useValue: {
            create: jest.fn(),
            save: jest.fn(),
            find: jest.fn(),
            findOne: jest.fn(),
            preload: jest.fn(),
            delete: jest.fn(),
            softDelete: jest.fn(),
            restore: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<WorkStatusService>(WorkStatusService);
    workStatusRepository = module.get<Repository<WorkStatus>>(getRepositoryToken(WorkStatus));
    
    // Mock the logger
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
    const createDto: CreateWorkStatusDto = { name: 'New Work Status' };

    describe('✅ Success Case', () => {
      it('should create a new work status successfully', async () => {
        const mockCreatedWorkStatus = { ...mockWorkStatus, name: createDto.name };
        
        jest.spyOn(workStatusRepository, 'create').mockReturnValue(mockCreatedWorkStatus);
        jest.spyOn(workStatusRepository, 'save').mockResolvedValue(mockCreatedWorkStatus);

        const result = await service.create(createDto);

        expect(workStatusRepository.create).toHaveBeenCalledWith({ name: createDto.name });
        expect(workStatusRepository.save).toHaveBeenCalledWith(mockCreatedWorkStatus);
        expect(result).toEqual(mockCreatedWorkStatus);
      });
    });

    describe('❌ Error Cases', () => {
      it('should handle database errors during creation', async () => {
        const dbError = new Error('Database connection failed');
        
        jest.spyOn(workStatusRepository, 'create').mockReturnValue(mockWorkStatus);
        jest.spyOn(workStatusRepository, 'save').mockRejectedValue(dbError);

        await expect(service.create(createDto)).rejects.toThrow('An unexpected error occurred on the server.');

        expect(handleException.handleException).toHaveBeenCalledWith(mockLogger, dbError);
      });

      it('should handle validation errors', async () => {
        const validationError = new Error('Validation failed');
        
        jest.spyOn(workStatusRepository, 'create').mockReturnValue(mockWorkStatus);
        jest.spyOn(workStatusRepository, 'save').mockRejectedValue(validationError);

        await expect(service.create(createDto)).rejects.toThrow('An unexpected error occurred on the server.');

        expect(handleException.handleException).toHaveBeenCalledWith(mockLogger, validationError);
      });
    });

    describe('⚠️ Edge Cases', () => {
      it('should handle empty name string', async () => {
        const emptyNameDto: CreateWorkStatusDto = { name: '' };
        const mockCreatedWorkStatus = { ...mockWorkStatus, name: '' };
        
        jest.spyOn(workStatusRepository, 'create').mockReturnValue(mockCreatedWorkStatus);
        jest.spyOn(workStatusRepository, 'save').mockResolvedValue(mockCreatedWorkStatus);

        const result = await service.create(emptyNameDto);

        expect(workStatusRepository.create).toHaveBeenCalledWith({ name: '' });
        expect(result).toEqual(mockCreatedWorkStatus);
      });

      it('should handle very long name', async () => {
        const longName = 'A'.repeat(1000);
        const longNameDto: CreateWorkStatusDto = { name: longName };
        const mockCreatedWorkStatus = { ...mockWorkStatus, name: longName };
        
        jest.spyOn(workStatusRepository, 'create').mockReturnValue(mockCreatedWorkStatus);
        jest.spyOn(workStatusRepository, 'save').mockResolvedValue(mockCreatedWorkStatus);

        const result = await service.create(longNameDto);

        expect(workStatusRepository.create).toHaveBeenCalledWith({ name: longName });
        expect(result).toEqual(mockCreatedWorkStatus);
      });
    });
  });

  describe('findAll', () => {
    describe('✅ Success Case', () => {
      it('should return all non-deleted work statuses', async () => {
        const mockWorkStatuses = [mockWorkStatus, mockWorkStatus2];
        
        jest.spyOn(workStatusRepository, 'find').mockResolvedValue(mockWorkStatuses);

        const result = await service.findAll();

        expect(workStatusRepository.find).toHaveBeenCalledWith({
          where: { deletedAt: undefined },
          relations: [],
        });
        expect(result).toEqual(mockWorkStatuses);
      });

      it('should return empty array when no work statuses exist', async () => {
        jest.spyOn(workStatusRepository, 'find').mockResolvedValue([]);

        const result = await service.findAll();

        expect(workStatusRepository.find).toHaveBeenCalledWith({
          where: { deletedAt: undefined },
          relations: [],
        });
        expect(result).toEqual([]);
      });
    });

    describe('❌ Error Cases', () => {
      it('should handle database connection errors', async () => {
        const dbError = new Error('Database connection failed');
        
        jest.spyOn(workStatusRepository, 'find').mockRejectedValue(dbError);

        await expect(service.findAll()).rejects.toThrow('An unexpected error occurred on the server.');

        expect(handleException.handleException).toHaveBeenCalledWith(mockLogger, dbError);
      });

      it('should handle query execution errors', async () => {
        const queryError = new Error('Query execution failed');
        
        jest.spyOn(workStatusRepository, 'find').mockRejectedValue(queryError);

        await expect(service.findAll()).rejects.toThrow('An unexpected error occurred on the server.');

        expect(handleException.handleException).toHaveBeenCalledWith(mockLogger, queryError);
      });
    });
  });

  describe('findOne', () => {
    const validId = 'test-id-1';

    describe('✅ Success Case', () => {
      it('should return a work status by id', async () => {
        jest.spyOn(workStatusRepository, 'findOne').mockResolvedValue(mockWorkStatus);

        const result = await service.findOne(validId);

        expect(workStatusRepository.findOne).toHaveBeenCalledWith({
          where: { id: validId },
          relations: [],
        });
        expect(result).toEqual(mockWorkStatus);
      });
    });

    describe('❌ NotFoundException', () => {
      it('should throw NotFoundException when work status not found', async () => {
        jest.spyOn(workStatusRepository, 'findOne').mockResolvedValue(null);

        await expect(service.findOne(validId)).rejects.toThrow(
          new NotFoundException(`Work Status with ID ${validId} not found`)
        );

        expect(workStatusRepository.findOne).toHaveBeenCalledWith({
          where: { id: validId },
          relations: [],
        });
      });
    });

    describe('❌ Error Cases', () => {
      it('should handle database errors', async () => {
        const dbError = new Error('Database error');
        
        jest.spyOn(workStatusRepository, 'findOne').mockRejectedValue(dbError);

        await expect(service.findOne(validId)).rejects.toThrow('An unexpected error occurred on the server.');

        expect(handleException.handleException).toHaveBeenCalledWith(mockLogger, dbError);
      });
    });

    describe('⚠️ Edge Cases', () => {
      it('should handle empty string id', async () => {
        jest.spyOn(workStatusRepository, 'findOne').mockResolvedValue(null);

        await expect(service.findOne('')).rejects.toThrow(
          new NotFoundException('Work Status with ID  not found')
        );
      });

      it('should handle null id', async () => {
        jest.spyOn(workStatusRepository, 'findOne').mockResolvedValue(null);

        await expect(service.findOne(null as any)).rejects.toThrow(
          new NotFoundException('Work Status with ID null not found')
        );
      });

      it('should handle undefined id', async () => {
        jest.spyOn(workStatusRepository, 'findOne').mockResolvedValue(null);

        await expect(service.findOne(undefined as any)).rejects.toThrow(
          new NotFoundException('Work Status with ID undefined not found')
        );
      });
    });
  });

  describe('update', () => {
    const validId = 'test-id-1';
    const updateDto: UpdateWorkStatusDto = { name: 'Updated Work Status' };

    describe('✅ Success Case', () => {
      it('should update a work status successfully', async () => {
        const updatedWorkStatus = { ...mockWorkStatus, ...updateDto };
        
        jest.spyOn(workStatusRepository, 'preload').mockResolvedValue(updatedWorkStatus);
        jest.spyOn(workStatusRepository, 'save').mockResolvedValue(updatedWorkStatus);

        const result = await service.update(validId, updateDto);

        expect(workStatusRepository.preload).toHaveBeenCalledWith({
          id: validId,
          ...updateDto,
        });
        expect(workStatusRepository.save).toHaveBeenCalledWith(updatedWorkStatus);
        expect(result).toEqual(updatedWorkStatus);
      });
    });

    describe('❌ NotFoundException', () => {
      it('should throw NotFoundException when work status not found', async () => {
        jest.spyOn(workStatusRepository, 'preload').mockResolvedValue(undefined);

        await expect(service.update(validId, updateDto)).rejects.toThrow(
          new NotFoundException(`Work Status with ID ${validId} not found`)
        );

        expect(workStatusRepository.preload).toHaveBeenCalledWith({
          id: validId,
          ...updateDto,
        });
      });
    });

    describe('❌ Error Cases', () => {
      it('should handle database errors during update', async () => {
        const dbError = new Error('Database error');
        
        jest.spyOn(workStatusRepository, 'preload').mockResolvedValue(mockWorkStatus);
        jest.spyOn(workStatusRepository, 'save').mockRejectedValue(dbError);

        await expect(service.update(validId, updateDto)).rejects.toThrow('An unexpected error occurred on the server.');

        expect(handleException.handleException).toHaveBeenCalledWith(mockLogger, dbError);
      });

      it('should handle validation errors', async () => {
        const validationError = new Error('Validation failed');
        
        jest.spyOn(workStatusRepository, 'preload').mockRejectedValue(validationError);

        await expect(service.update(validId, updateDto)).rejects.toThrow('An unexpected error occurred on the server.');

        expect(handleException.handleException).toHaveBeenCalledWith(mockLogger, validationError);
      });
    });

    describe('⚠️ Edge Cases', () => {
      it('should handle empty string id', async () => {
        jest.spyOn(workStatusRepository, 'preload').mockResolvedValue(undefined);

        await expect(service.update('', updateDto)).rejects.toThrow(
          new NotFoundException('Work Status with ID  not found')
        );
      });

      it('should handle empty update dto', async () => {
        const emptyUpdateDto: UpdateWorkStatusDto = {};
        const updatedWorkStatus = { ...mockWorkStatus };
        
        jest.spyOn(workStatusRepository, 'preload').mockResolvedValue(updatedWorkStatus);
        jest.spyOn(workStatusRepository, 'save').mockResolvedValue(updatedWorkStatus);

        const result = await service.update(validId, emptyUpdateDto);

        expect(workStatusRepository.preload).toHaveBeenCalledWith({
          id: validId,
          ...emptyUpdateDto,
        });
        expect(result).toEqual(updatedWorkStatus);
      });
    });
  });

  describe('remove', () => {
    const validId = 'test-id-1';

    describe('✅ Success Case', () => {
      it('should permanently remove a work status', async () => {
        const deleteResult = { affected: 1 };
        
        jest.spyOn(workStatusRepository, 'delete').mockResolvedValue(deleteResult as any);

        const result = await service.remove(validId);

        expect(workStatusRepository.delete).toHaveBeenCalledWith(validId);
        expect(result).toEqual({ message: `Work Status with ID ${validId} has been permanently removed.` });
      });
    });

    describe('❌ NotFoundException', () => {
      it('should throw NotFoundException when work status not found', async () => {
        const deleteResult = { affected: 0 };
        
        jest.spyOn(workStatusRepository, 'delete').mockResolvedValue(deleteResult as any);

        await expect(service.remove(validId)).rejects.toThrow(
          new NotFoundException(`Work Status with ID ${validId} not found`)
        );

        expect(workStatusRepository.delete).toHaveBeenCalledWith(validId);
      });
    });

    describe('❌ Error Cases', () => {
      it('should handle database errors during removal', async () => {
        const dbError = new Error('Database error');
        
        jest.spyOn(workStatusRepository, 'delete').mockRejectedValue(dbError);

        await expect(service.remove(validId)).rejects.toThrow('An unexpected error occurred on the server.');

        expect(handleException.handleException).toHaveBeenCalledWith(mockLogger, dbError);
      });
    });

    describe('⚠️ Edge Cases', () => {
      it('should handle empty string id', async () => {
        const deleteResult = { affected: 0 };
        
        jest.spyOn(workStatusRepository, 'delete').mockResolvedValue(deleteResult as any);

        await expect(service.remove('')).rejects.toThrow(
          new NotFoundException('Work Status with ID  not found')
        );
      });

      it('should handle null id', async () => {
        const deleteResult = { affected: 0 };
        
        jest.spyOn(workStatusRepository, 'delete').mockResolvedValue(deleteResult as any);

        await expect(service.remove(null as any)).rejects.toThrow(
          new NotFoundException('Work Status with ID null not found')
        );
      });
    });
  });

  describe('softRemove', () => {
    const validId = 'test-id-1';

    describe('✅ Success Case', () => {
      it('should soft remove a work status', async () => {
        const softDeleteResult = { affected: 1 };
        
        jest.spyOn(workStatusRepository, 'softDelete').mockResolvedValue(softDeleteResult as any);

        const result = await service.softRemove(validId);

        expect(workStatusRepository.softDelete).toHaveBeenCalledWith(validId);
        expect(result).toEqual({ message: `Work Status with ID ${validId} has been soft-removed.` });
      });
    });

    describe('❌ NotFoundException', () => {
      it('should throw NotFoundException when work status not found', async () => {
        const softDeleteResult = { affected: 0 };
        
        jest.spyOn(workStatusRepository, 'softDelete').mockResolvedValue(softDeleteResult as any);

        await expect(service.softRemove(validId)).rejects.toThrow(
          new NotFoundException(`Work Status with ID ${validId} not found`)
        );

        expect(workStatusRepository.softDelete).toHaveBeenCalledWith(validId);
      });
    });

    describe('❌ Error Cases', () => {
      it('should handle database errors during soft removal', async () => {
        const dbError = new Error('Database error');
        
        jest.spyOn(workStatusRepository, 'softDelete').mockRejectedValue(dbError);

        await expect(service.softRemove(validId)).rejects.toThrow('An unexpected error occurred on the server.');

        expect(handleException.handleException).toHaveBeenCalledWith(mockLogger, dbError);
      });
    });

    describe('⚠️ Edge Cases', () => {
      it('should handle empty string id', async () => {
        const softDeleteResult = { affected: 0 };
        
        jest.spyOn(workStatusRepository, 'softDelete').mockResolvedValue(softDeleteResult as any);

        await expect(service.softRemove('')).rejects.toThrow(
          new NotFoundException('Work Status with ID  not found')
        );
      });
    });
  });

  describe('restore', () => {
    const validId = 'test-id-1';

    describe('✅ Success Case', () => {
      it('should restore a soft-deleted work status', async () => {
        const restoreResult = { affected: 1 };
        
        jest.spyOn(workStatusRepository, 'restore').mockResolvedValue(restoreResult as any);

        const result = await service.restore(validId);

        expect(workStatusRepository.restore).toHaveBeenCalledWith(validId);
        expect(result).toEqual({ message: `Work Status with ID ${validId} has been restored.` });
      });
    });

    describe('❌ NotFoundException', () => {
      it('should throw NotFoundException when work status not found or not deleted', async () => {
        const restoreResult = { affected: 0 };
        
        jest.spyOn(workStatusRepository, 'restore').mockResolvedValue(restoreResult as any);

        await expect(service.restore(validId)).rejects.toThrow(
          new NotFoundException(`Work Status with ID ${validId} not found or was not deleted.`)
        );

        expect(workStatusRepository.restore).toHaveBeenCalledWith(validId);
      });
    });

    describe('❌ Error Cases', () => {
      it('should handle database errors during restoration', async () => {
        const dbError = new Error('Database error');
        
        jest.spyOn(workStatusRepository, 'restore').mockRejectedValue(dbError);

        await expect(service.restore(validId)).rejects.toThrow('An unexpected error occurred on the server.');

        expect(handleException.handleException).toHaveBeenCalledWith(mockLogger, dbError);
      });
    });

    describe('⚠️ Edge Cases', () => {
      it('should handle empty string id', async () => {
        const restoreResult = { affected: 0 };
        
        jest.spyOn(workStatusRepository, 'restore').mockResolvedValue(restoreResult as any);

        await expect(service.restore('')).rejects.toThrow(
          new NotFoundException('Work Status with ID  not found or was not deleted.')
        );
      });

      it('should handle null id', async () => {
        const restoreResult = { affected: 0 };
        
        jest.spyOn(workStatusRepository, 'restore').mockResolvedValue(restoreResult as any);

        await expect(service.restore(null as any)).rejects.toThrow(
          new NotFoundException('Work Status with ID null not found or was not deleted.')
        );
      });
    });
  });
});
