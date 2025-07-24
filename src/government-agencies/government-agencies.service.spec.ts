import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  Logger,
  NotFoundException,
  InternalServerErrorException,
  BadRequestException,
} from '@nestjs/common';
import { GovernmentAgenciesService } from './government-agencies.service';
import { GovernmentAgency } from './entities/government-agency.entity';
import { CreateGovernmentAgencyDto } from './dto/create-government-agency.dto';
import { UpdateGovernmentAgencyDto } from './dto/update-government-agency.dto';
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

describe('GovernmentAgenciesService', () => {
  let service: GovernmentAgenciesService;
  let governmentAgencyRepository: Repository<GovernmentAgency>;
  let mockLogger: jest.Mocked<Logger>;

  const mockGovernmentAgency: GovernmentAgency = {
    id: 'agency-id-1',
    name: 'Ministry of Finance',
    createdAt: new Date(),
    deletedAt: undefined,
    workHistory: [],
    responsibleAgencyProjectGroup: [],
  };

  const mockGovernmentAgency2: GovernmentAgency = {
    id: 'agency-id-2',
    name: 'Ministry of Education',
    createdAt: new Date(),
    deletedAt: undefined,
    workHistory: [],
    responsibleAgencyProjectGroup: [],
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GovernmentAgenciesService,
        {
          provide: getRepositoryToken(GovernmentAgency),
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

    service = module.get<GovernmentAgenciesService>(GovernmentAgenciesService);
    governmentAgencyRepository = module.get<Repository<GovernmentAgency>>(
      getRepositoryToken(GovernmentAgency),
    );
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
    const createDto: CreateGovernmentAgencyDto = {
      name: 'New Government Agency',
    };
    describe('✅ Success Case', () => {
      it('should create a new government agency successfully', async () => {
        const mockCreatedGovernmentAgency = {
          ...mockGovernmentAgency,
          name: createDto.name,
        };
        jest
          .spyOn(governmentAgencyRepository, 'create')
          .mockReturnValue(mockCreatedGovernmentAgency);
        jest
          .spyOn(governmentAgencyRepository, 'save')
          .mockResolvedValue(mockCreatedGovernmentAgency);
        const result = await service.create(createDto);
        expect(governmentAgencyRepository.create).toHaveBeenCalledWith({
          name: createDto.name,
        });
        expect(governmentAgencyRepository.save).toHaveBeenCalledWith(
          mockCreatedGovernmentAgency,
        );
        expect(result).toEqual(mockCreatedGovernmentAgency);
      });
    });
    describe('❌ Error Cases', () => {
      it('should handle database errors during creation', async () => {
        const dbError = new Error('Database connection failed');
        jest
          .spyOn(governmentAgencyRepository, 'create')
          .mockReturnValue(mockGovernmentAgency);
        jest
          .spyOn(governmentAgencyRepository, 'save')
          .mockRejectedValue(dbError);
        await expect(service.create(createDto)).rejects.toThrow(
          'An unexpected error occurred on the server.',
        );
        expect(handleException.handleException).toHaveBeenCalledWith(
          mockLogger,
          dbError,
        );
      });
      it('should handle validation errors', async () => {
        const validationError = new Error('Validation failed');
        jest
          .spyOn(governmentAgencyRepository, 'create')
          .mockReturnValue(mockGovernmentAgency);
        jest
          .spyOn(governmentAgencyRepository, 'save')
          .mockRejectedValue(validationError);
        await expect(service.create(createDto)).rejects.toThrow(
          'An unexpected error occurred on the server.',
        );
        expect(handleException.handleException).toHaveBeenCalledWith(
          mockLogger,
          validationError,
        );
      });
    });
    describe('⚠️ Edge Cases', () => {
      it('should handle empty name string', async () => {
        const emptyNameDto: CreateGovernmentAgencyDto = { name: '' };
        const mockCreatedGovernmentAgency = {
          ...mockGovernmentAgency,
          name: '',
        };
        jest
          .spyOn(governmentAgencyRepository, 'create')
          .mockReturnValue(mockCreatedGovernmentAgency);
        jest
          .spyOn(governmentAgencyRepository, 'save')
          .mockResolvedValue(mockCreatedGovernmentAgency);
        const result = await service.create(emptyNameDto);
        expect(governmentAgencyRepository.create).toHaveBeenCalledWith({
          name: '',
        });
        expect(result).toEqual(mockCreatedGovernmentAgency);
      });
      it('should handle very long name', async () => {
        const longName = 'A'.repeat(1000);
        const longNameDto: CreateGovernmentAgencyDto = { name: longName };
        const mockCreatedGovernmentAgency = {
          ...mockGovernmentAgency,
          name: longName,
        };
        jest
          .spyOn(governmentAgencyRepository, 'create')
          .mockReturnValue(mockCreatedGovernmentAgency);
        jest
          .spyOn(governmentAgencyRepository, 'save')
          .mockResolvedValue(mockCreatedGovernmentAgency);
        const result = await service.create(longNameDto);
        expect(governmentAgencyRepository.create).toHaveBeenCalledWith({
          name: longName,
        });
        expect(result).toEqual(mockCreatedGovernmentAgency);
      });
    });
  });

  describe('findAll', () => {
    describe('✅ Success Case', () => {
      it('should return all non-deleted government agencies', async () => {
        const mockGovernmentAgencies = [
          mockGovernmentAgency,
          mockGovernmentAgency2,
        ];
        jest
          .spyOn(governmentAgencyRepository, 'find')
          .mockResolvedValue(mockGovernmentAgencies);
        const result = await service.findAll();
        expect(governmentAgencyRepository.find).toHaveBeenCalledWith({
          where: { deletedAt: undefined },
          relations: [],
        });
        expect(result).toEqual(mockGovernmentAgencies);
      });
      it('should return empty array when no government agencies exist', async () => {
        jest.spyOn(governmentAgencyRepository, 'find').mockResolvedValue([]);
        const result = await service.findAll();
        expect(governmentAgencyRepository.find).toHaveBeenCalledWith({
          where: { deletedAt: undefined },
          relations: [],
        });
        expect(result).toEqual([]);
      });
    });
    describe('❌ Error Cases', () => {
      it('should handle database connection errors', async () => {
        const dbError = new Error('Database connection failed');
        jest
          .spyOn(governmentAgencyRepository, 'find')
          .mockRejectedValue(dbError);
        await expect(service.findAll()).rejects.toThrow(
          'An unexpected error occurred on the server.',
        );
        expect(handleException.handleException).toHaveBeenCalledWith(
          mockLogger,
          dbError,
        );
      });
      it('should handle query execution errors', async () => {
        const queryError = new Error('Query execution failed');
        jest
          .spyOn(governmentAgencyRepository, 'find')
          .mockRejectedValue(queryError);
        await expect(service.findAll()).rejects.toThrow(
          'An unexpected error occurred on the server.',
        );
        expect(handleException.handleException).toHaveBeenCalledWith(
          mockLogger,
          queryError,
        );
      });
    });
  });

  describe('findOne', () => {
    const validId = 'agency-id-1';
    describe('✅ Success Case', () => {
      it('should return a government agency by id', async () => {
        jest
          .spyOn(governmentAgencyRepository, 'findOne')
          .mockResolvedValue(mockGovernmentAgency);
        const result = await service.findOne(validId);
        expect(governmentAgencyRepository.findOne).toHaveBeenCalledWith({
          where: { id: validId },
          relations: [],
        });
        expect(result).toEqual(mockGovernmentAgency);
      });
    });
    describe('❌ NotFoundException', () => {
      it('should throw NotFoundException when government agency not found', async () => {
        jest
          .spyOn(governmentAgencyRepository, 'findOne')
          .mockResolvedValue(null);
        await expect(service.findOne(validId)).rejects.toThrow(
          new NotFoundException(
            `Government Agency with ID ${validId} not found`,
          ),
        );
        expect(governmentAgencyRepository.findOne).toHaveBeenCalledWith({
          where: { id: validId },
          relations: [],
        });
      });
    });
    describe('❌ Error Cases', () => {
      it('should handle database errors', async () => {
        const dbError = new Error('Database error');
        jest
          .spyOn(governmentAgencyRepository, 'findOne')
          .mockRejectedValue(dbError);
        await expect(service.findOne(validId)).rejects.toThrow(
          'An unexpected error occurred on the server.',
        );
        expect(handleException.handleException).toHaveBeenCalledWith(
          mockLogger,
          dbError,
        );
      });
    });
    describe('⚠️ Edge Cases', () => {
      it('should handle empty string id', async () => {
        jest
          .spyOn(governmentAgencyRepository, 'findOne')
          .mockResolvedValue(null);
        await expect(service.findOne('')).rejects.toThrow(
          new NotFoundException('Government Agency with ID  not found'),
        );
      });
      it('should handle null id', async () => {
        jest
          .spyOn(governmentAgencyRepository, 'findOne')
          .mockResolvedValue(null);
        await expect(service.findOne(null as any)).rejects.toThrow(
          new NotFoundException('Government Agency with ID null not found'),
        );
      });
      it('should handle undefined id', async () => {
        jest
          .spyOn(governmentAgencyRepository, 'findOne')
          .mockResolvedValue(null);
        await expect(service.findOne(undefined as any)).rejects.toThrow(
          new NotFoundException(
            'Government Agency with ID undefined not found',
          ),
        );
      });
    });
  });

  describe('update', () => {
    const validId = 'agency-id-1';
    const updateDto: UpdateGovernmentAgencyDto = {
      name: 'Updated Government Agency',
    };
    describe('✅ Success Case', () => {
      it('should update a government agency successfully', async () => {
        const updatedGovernmentAgency = {
          ...mockGovernmentAgency,
          ...updateDto,
        };
        jest
          .spyOn(governmentAgencyRepository, 'preload')
          .mockResolvedValue(updatedGovernmentAgency);
        jest
          .spyOn(governmentAgencyRepository, 'save')
          .mockResolvedValue(updatedGovernmentAgency);
        const result = await service.update(validId, updateDto);
        expect(governmentAgencyRepository.preload).toHaveBeenCalledWith({
          id: validId,
          ...updateDto,
        });
        expect(governmentAgencyRepository.save).toHaveBeenCalledWith(
          updatedGovernmentAgency,
        );
        expect(result).toEqual(updatedGovernmentAgency);
      });
    });
    describe('❌ NotFoundException', () => {
      it('should throw NotFoundException when government agency not found', async () => {
        jest
          .spyOn(governmentAgencyRepository, 'preload')
          .mockResolvedValue(undefined);
        await expect(service.update(validId, updateDto)).rejects.toThrow(
          new NotFoundException(
            `Government Agency with ID ${validId} not found`,
          ),
        );
        expect(governmentAgencyRepository.preload).toHaveBeenCalledWith({
          id: validId,
          ...updateDto,
        });
      });
    });
    describe('❌ Error Cases', () => {
      it('should handle database errors during update', async () => {
        const dbError = new Error('Database error');
        jest
          .spyOn(governmentAgencyRepository, 'preload')
          .mockResolvedValue(mockGovernmentAgency);
        jest
          .spyOn(governmentAgencyRepository, 'save')
          .mockRejectedValue(dbError);
        await expect(service.update(validId, updateDto)).rejects.toThrow(
          'An unexpected error occurred on the server.',
        );
        expect(handleException.handleException).toHaveBeenCalledWith(
          mockLogger,
          dbError,
        );
      });
      it('should handle validation errors', async () => {
        const validationError = new Error('Validation failed');
        jest
          .spyOn(governmentAgencyRepository, 'preload')
          .mockRejectedValue(validationError);
        await expect(service.update(validId, updateDto)).rejects.toThrow(
          'An unexpected error occurred on the server.',
        );
        expect(handleException.handleException).toHaveBeenCalledWith(
          mockLogger,
          validationError,
        );
      });
    });
    describe('⚠️ Edge Cases', () => {
      it('should handle empty string id', async () => {
        jest
          .spyOn(governmentAgencyRepository, 'preload')
          .mockResolvedValue(undefined);
        await expect(service.update('', updateDto)).rejects.toThrow(
          new NotFoundException('Government Agency with ID  not found'),
        );
      });
      it('should handle empty update dto', async () => {
        const emptyUpdateDto: UpdateGovernmentAgencyDto = {};
        const updatedGovernmentAgency = { ...mockGovernmentAgency };
        jest
          .spyOn(governmentAgencyRepository, 'preload')
          .mockResolvedValue(updatedGovernmentAgency);
        jest
          .spyOn(governmentAgencyRepository, 'save')
          .mockResolvedValue(updatedGovernmentAgency);
        const result = await service.update(validId, emptyUpdateDto);
        expect(governmentAgencyRepository.preload).toHaveBeenCalledWith({
          id: validId,
          ...emptyUpdateDto,
        });
        expect(result).toEqual(updatedGovernmentAgency);
      });
    });
  });

  describe('remove', () => {
    const validId = 'agency-id-1';
    describe('✅ Success Case', () => {
      it('should permanently remove a government agency', async () => {
        const deleteResult = { affected: 1 };
        jest
          .spyOn(governmentAgencyRepository, 'delete')
          .mockResolvedValue(deleteResult as any);
        const result = await service.remove(validId);
        expect(governmentAgencyRepository.delete).toHaveBeenCalledWith(validId);
        expect(result).toEqual({
          message: `Government Agency with ID ${validId} has been permanently removed.`,
        });
      });
    });
    describe('❌ NotFoundException', () => {
      it('should throw NotFoundException when government agency not found', async () => {
        const deleteResult = { affected: 0 };
        jest
          .spyOn(governmentAgencyRepository, 'delete')
          .mockResolvedValue(deleteResult as any);
        await expect(service.remove(validId)).rejects.toThrow(
          new NotFoundException(
            `Government Agency with ID ${validId} not found`,
          ),
        );
        expect(governmentAgencyRepository.delete).toHaveBeenCalledWith(validId);
      });
    });
    describe('❌ Error Cases', () => {
      it('should handle database errors during removal', async () => {
        const dbError = new Error('Database error');
        jest
          .spyOn(governmentAgencyRepository, 'delete')
          .mockRejectedValue(dbError);
        await expect(service.remove(validId)).rejects.toThrow(
          'An unexpected error occurred on the server.',
        );
        expect(handleException.handleException).toHaveBeenCalledWith(
          mockLogger,
          dbError,
        );
      });
    });
    describe('⚠️ Edge Cases', () => {
      it('should handle empty string id', async () => {
        const deleteResult = { affected: 0 };
        jest
          .spyOn(governmentAgencyRepository, 'delete')
          .mockResolvedValue(deleteResult as any);
        await expect(service.remove('')).rejects.toThrow(
          new NotFoundException('Government Agency with ID  not found'),
        );
      });
      it('should handle null id', async () => {
        const deleteResult = { affected: 0 };
        jest
          .spyOn(governmentAgencyRepository, 'delete')
          .mockResolvedValue(deleteResult as any);
        await expect(service.remove(null as any)).rejects.toThrow(
          new NotFoundException('Government Agency with ID null not found'),
        );
      });
    });
  });

  describe('softRemove', () => {
    const validId = 'agency-id-1';
    describe('✅ Success Case', () => {
      it('should soft remove a government agency', async () => {
        const softDeleteResult = { affected: 1 };
        jest
          .spyOn(governmentAgencyRepository, 'softDelete')
          .mockResolvedValue(softDeleteResult as any);
        const result = await service.softRemove(validId);
        expect(governmentAgencyRepository.softDelete).toHaveBeenCalledWith(
          validId,
        );
        expect(result).toEqual({
          message: `Government Agency with ID ${validId} has been soft-removed.`,
        });
      });
    });
    describe('❌ NotFoundException', () => {
      it('should throw NotFoundException when government agency not found', async () => {
        const softDeleteResult = { affected: 0 };
        jest
          .spyOn(governmentAgencyRepository, 'softDelete')
          .mockResolvedValue(softDeleteResult as any);
        await expect(service.softRemove(validId)).rejects.toThrow(
          new NotFoundException(
            `Government Agency with ID ${validId} not found`,
          ),
        );
        expect(governmentAgencyRepository.softDelete).toHaveBeenCalledWith(
          validId,
        );
      });
    });
    describe('❌ Error Cases', () => {
      it('should handle database errors during soft removal', async () => {
        const dbError = new Error('Database error');
        jest
          .spyOn(governmentAgencyRepository, 'softDelete')
          .mockRejectedValue(dbError);
        await expect(service.softRemove(validId)).rejects.toThrow(
          'An unexpected error occurred on the server.',
        );
        expect(handleException.handleException).toHaveBeenCalledWith(
          mockLogger,
          dbError,
        );
      });
    });
    describe('⚠️ Edge Cases', () => {
      it('should handle empty string id', async () => {
        const softDeleteResult = { affected: 0 };
        jest
          .spyOn(governmentAgencyRepository, 'softDelete')
          .mockResolvedValue(softDeleteResult as any);
        await expect(service.softRemove('')).rejects.toThrow(
          new NotFoundException('Government Agency with ID  not found'),
        );
      });
    });
  });

  describe('restore', () => {
    const validId = 'agency-id-1';
    describe('✅ Success Case', () => {
      it('should restore a soft-deleted government agency', async () => {
        const restoreResult = { affected: 1 };
        jest
          .spyOn(governmentAgencyRepository, 'restore')
          .mockResolvedValue(restoreResult as any);
        const result = await service.restore(validId);
        expect(governmentAgencyRepository.restore).toHaveBeenCalledWith(
          validId,
        );
        expect(result).toEqual({
          message: `Government Agency with ID ${validId} has been restored.`,
        });
      });
    });
    describe('❌ NotFoundException', () => {
      it('should throw NotFoundException when government agency not found or not deleted', async () => {
        const restoreResult = { affected: 0 };
        jest
          .spyOn(governmentAgencyRepository, 'restore')
          .mockResolvedValue(restoreResult as any);
        await expect(service.restore(validId)).rejects.toThrow(
          new NotFoundException(
            `Government Agency with ID ${validId} not found or was not deleted.`,
          ),
        );
        expect(governmentAgencyRepository.restore).toHaveBeenCalledWith(
          validId,
        );
      });
    });
    describe('❌ Error Cases', () => {
      it('should handle database errors during restoration', async () => {
        const dbError = new Error('Database error');
        jest
          .spyOn(governmentAgencyRepository, 'restore')
          .mockRejectedValue(dbError);
        await expect(service.restore(validId)).rejects.toThrow(
          'An unexpected error occurred on the server.',
        );
        expect(handleException.handleException).toHaveBeenCalledWith(
          mockLogger,
          dbError,
        );
      });
    });
    describe('⚠️ Edge Cases', () => {
      it('should handle empty string id', async () => {
        const restoreResult = { affected: 0 };
        jest
          .spyOn(governmentAgencyRepository, 'restore')
          .mockResolvedValue(restoreResult as any);
        await expect(service.restore('')).rejects.toThrow(
          new NotFoundException(
            'Government Agency with ID  not found or was not deleted.',
          ),
        );
      });
      it('should handle null id', async () => {
        const restoreResult = { affected: 0 };
        jest
          .spyOn(governmentAgencyRepository, 'restore')
          .mockResolvedValue(restoreResult as any);
        await expect(service.restore(null as any)).rejects.toThrow(
          new NotFoundException(
            'Government Agency with ID null not found or was not deleted.',
          ),
        );
      });
    });
  });
});
