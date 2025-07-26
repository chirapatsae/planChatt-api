import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotFoundException, InternalServerErrorException, Logger } from '@nestjs/common';
import { AiUsageLogsService } from './ai-usage-logs.service';
import { AiUsageLog } from './entities/ai-usage-log.entity';
import { CreateAiUsageLogDto } from './dto/create-ai-usage-log.dto';
import { AiUsageLogResponseDto } from './dto/ai-usage-log-response.dto';
import { AiUsageQuota } from 'src/ai-usage-quotas/entities/ai-usage-quota.entity';

describe('AiUsageLogsService', () => {
  let service: AiUsageLogsService;
  let repository: Repository<AiUsageLog>;

  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  const mockRepository = {
    create: jest.fn(),
    save: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
  };

  const mockAiUsageQuota: AiUsageQuota = {
    id: 'quota-123',
    periodStart: new Date('2024-01-01T00:00:00Z'),
    periodEnd: new Date('2024-01-31T23:59:59Z'),
    quotaLimit: 1000,
    quotaUsed: 100,
    remainingQuota: 900,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-15T00:00:00Z'),
    deletedAt: undefined,
    user: {
      id: 'user-1',
      citizenId: '1234567890123',
      citizenIdHash: 'hash',
      prefix: 'Mr.',
      firstname: 'Test',
      lastname: 'User',
      isFirstLogin: true,
      createAt: new Date('2024-01-01T00:00:00Z'),
    } as any,
    aiUsageLogs: [],
  };

  const mockAiUsageLog: AiUsageLog = {
    id: 'log-123',
    usageType: 'text-generation',
    inputTextLength: 100,
    outputTextLength: 200,
    costBaht: 0.50,
    used_at: new Date('2024-01-01T10:00:00Z'),
    aiUsageQuota: mockAiUsageQuota,
  };

  const mockCreateDto: CreateAiUsageLogDto = {
    usageType: 'text-generation',
    inputTextLength: 100,
    outputTextLength: 200,
    costBaht: 0.50,
    aiUsageQuotaId: 'quota-123',
  };

  const mockResponseDto: AiUsageLogResponseDto = {
    id: 'log-123',
    usageType: 'text-generation',
    inputTextLength: 100,
    outputTextLength: 200,
    costBaht: 0.50,
    usedAt: new Date('2024-01-01T10:00:00Z'),
    aiUsageQuota: mockAiUsageQuota,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiUsageLogsService,
        {
          provide: getRepositoryToken(AiUsageLog),
          useValue: mockRepository,
        },
      ],
    }).compile();

    service = module.get<AiUsageLogsService>(AiUsageLogsService);
    repository = module.get<Repository<AiUsageLog>>(getRepositoryToken(AiUsageLog));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('create', () => {
    describe('✅ Success Case', () => {
      it('should create an AI usage log successfully with quota', async () => {
        const expectedLog = { ...mockAiUsageLog };
        const expectedResponse = { ...mockResponseDto };

        mockRepository.create.mockReturnValue(expectedLog);
        mockRepository.save.mockResolvedValue(expectedLog);

        const result = await service.create(mockCreateDto);

        expect(mockRepository.create).toHaveBeenCalledWith({
          ...mockCreateDto,
          aiUsageQuota: { id: mockCreateDto.aiUsageQuotaId },
        });
        expect(mockRepository.save).toHaveBeenCalledWith(expectedLog);
        expect(result).toEqual(expectedResponse);
      });

      it('should create an AI usage log successfully without quota', async () => {
        const createDtoWithoutQuota = { ...mockCreateDto };
        delete createDtoWithoutQuota.aiUsageQuotaId;

        const expectedLog = { ...mockAiUsageLog, aiUsageQuota: undefined };
        const expectedResponse = { ...mockResponseDto, aiUsageQuota: undefined };

        mockRepository.create.mockReturnValue(expectedLog);
        mockRepository.save.mockResolvedValue(expectedLog);

        const result = await service.create(createDtoWithoutQuota);

        expect(mockRepository.create).toHaveBeenCalledWith({
          ...createDtoWithoutQuota,
          aiUsageQuota: undefined,
        });
        expect(mockRepository.save).toHaveBeenCalledWith(expectedLog);
        expect(result).toEqual(expectedResponse);
      });
    });

    describe('❌ InternalServerErrorException', () => {
      it('should throw InternalServerErrorException when repository.save fails', async () => {
        const dbError = new Error('Database connection failed');
        mockRepository.create.mockReturnValue(mockAiUsageLog);
        mockRepository.save.mockRejectedValue(dbError);

        await expect(service.create(mockCreateDto)).rejects.toThrow(InternalServerErrorException);
        await expect(service.create(mockCreateDto)).rejects.toThrow('Database connection failed');
      });

      it('should throw InternalServerErrorException when repository.create fails', async () => {
        const createError = new Error('Invalid entity creation');
        mockRepository.create.mockImplementation(() => {
          throw createError;
        });

        await expect(service.create(mockCreateDto)).rejects.toThrow(InternalServerErrorException);
        await expect(service.create(mockCreateDto)).rejects.toThrow('Invalid entity creation');
      });
    });

    describe('⚠️ Edge Cases', () => {
      it('should handle empty usage type', async () => {
        const createDtoWithEmptyType = { ...mockCreateDto, usageType: '' };
        const expectedLog = { ...mockAiUsageLog, usageType: '' };
        const expectedResponse = { ...mockResponseDto, usageType: '' };

        mockRepository.create.mockReturnValue(expectedLog);
        mockRepository.save.mockResolvedValue(expectedLog);

        const result = await service.create(createDtoWithEmptyType);

        expect(result).toEqual(expectedResponse);
      });

      it('should handle zero values for numeric fields', async () => {
        const createDtoWithZeros = {
          ...mockCreateDto,
          inputTextLength: 0,
          outputTextLength: 0,
          costBaht: 0,
        };
        const expectedLog = { ...mockAiUsageLog, inputTextLength: 0, outputTextLength: 0, costBaht: 0 };
        const expectedResponse = { ...mockResponseDto, inputTextLength: 0, outputTextLength: 0, costBaht: 0 };

        mockRepository.create.mockReturnValue(expectedLog);
        mockRepository.save.mockResolvedValue(expectedLog);

        const result = await service.create(createDtoWithZeros);

        expect(result).toEqual(expectedResponse);
      });

      it('should handle negative values for numeric fields', async () => {
        const createDtoWithNegatives = {
          ...mockCreateDto,
          inputTextLength: -10,
          outputTextLength: -5,
          costBaht: -0.25,
        };
        const expectedLog = { ...mockAiUsageLog, inputTextLength: -10, outputTextLength: -5, costBaht: -0.25 };
        const expectedResponse = { ...mockResponseDto, inputTextLength: -10, outputTextLength: -5, costBaht: -0.25 };

        mockRepository.create.mockReturnValue(expectedLog);
        mockRepository.save.mockResolvedValue(expectedLog);

        const result = await service.create(createDtoWithNegatives);

        expect(result).toEqual(expectedResponse);
      });
    });
  });

  describe('findAll', () => {
    describe('✅ Success Case', () => {
      it('should return all AI usage logs with relations', async () => {
        const mockLogs = [mockAiUsageLog];
        const expectedResponse = [mockResponseDto];

        mockRepository.find.mockResolvedValue(mockLogs);

        const result = await service.findAll();

        expect(mockRepository.find).toHaveBeenCalledWith({
          relations: ['aiUsageQuota'],
          order: { used_at: 'DESC' },
        });
        expect(result).toEqual(expectedResponse);
      });

      it('should return empty array when no logs exist', async () => {
        mockRepository.find.mockResolvedValue([]);

        const result = await service.findAll();

        expect(result).toEqual([]);
      });

      it('should return multiple logs in correct order', async () => {
        const log1 = { ...mockAiUsageLog, id: 'log-1', used_at: new Date('2024-01-02T10:00:00Z') };
        const log2 = { ...mockAiUsageLog, id: 'log-2', used_at: new Date('2024-01-01T10:00:00Z') };
        const mockLogs = [log1, log2];
        const expectedResponse = [
          { ...mockResponseDto, id: 'log-1', usedAt: new Date('2024-01-02T10:00:00Z') },
          { ...mockResponseDto, id: 'log-2', usedAt: new Date('2024-01-01T10:00:00Z') },
        ];

        mockRepository.find.mockResolvedValue(mockLogs);

        const result = await service.findAll();

        expect(result).toEqual(expectedResponse);
      });
    });

    describe('❌ InternalServerErrorException', () => {
      it('should throw InternalServerErrorException when repository.find fails', async () => {
        const dbError = new Error('Database query failed');
        mockRepository.find.mockRejectedValue(dbError);

        await expect(service.findAll()).rejects.toThrow(InternalServerErrorException);
        await expect(service.findAll()).rejects.toThrow('Database query failed');
      });
    });

    describe('⚠️ Edge Cases', () => {
      it('should handle logs without aiUsageQuota relation', async () => {
        const logWithoutQuota = { ...mockAiUsageLog, aiUsageQuota: null };
        const expectedResponse = { ...mockResponseDto, aiUsageQuota: null };

        mockRepository.find.mockResolvedValue([logWithoutQuota]);

        const result = await service.findAll();

        expect(result).toEqual([expectedResponse]);
      });

      it('should handle logs with undefined aiUsageQuota', async () => {
        const logWithUndefinedQuota = { ...mockAiUsageLog, aiUsageQuota: undefined };
        const expectedResponse = { ...mockResponseDto, aiUsageQuota: undefined };

        mockRepository.find.mockResolvedValue([logWithUndefinedQuota]);

        const result = await service.findAll();

        expect(result).toEqual([expectedResponse]);
      });
    });
  });

  describe('findOne', () => {
    describe('✅ Success Case', () => {
      it('should return AI usage log by id successfully', async () => {
        const logId = 'log-123';
        mockRepository.findOne.mockResolvedValue(mockAiUsageLog);

        const result = await service.findOne(logId);

        expect(mockRepository.findOne).toHaveBeenCalledWith({
          where: { id: logId },
          relations: ['aiUsageQuota'],
        });
        expect(result).toEqual(mockResponseDto);
      });

      it('should return log without quota when aiUsageQuota is null', async () => {
        const logId = 'log-123';
        const logWithoutQuota = { ...mockAiUsageLog, aiUsageQuota: null };
        const expectedResponse = { ...mockResponseDto, aiUsageQuota: null };

        mockRepository.findOne.mockResolvedValue(logWithoutQuota);

        const result = await service.findOne(logId);

        expect(result).toEqual(expectedResponse);
      });
    });

    describe('❌ NotFoundException', () => {
      it('should throw NotFoundException when log is not found', async () => {
        const logId = 'non-existent-id';
        mockRepository.findOne.mockResolvedValue(null);

        await expect(service.findOne(logId)).rejects.toThrow(NotFoundException);
        await expect(service.findOne(logId)).rejects.toThrow(`AI Usage Log with ID ${logId} not found`);
      });

      it('should throw NotFoundException when log id is empty string', async () => {
        const logId = '';
        mockRepository.findOne.mockResolvedValue(null);

        await expect(service.findOne(logId)).rejects.toThrow(NotFoundException);
        await expect(service.findOne(logId)).rejects.toThrow('AI Usage Log with ID  not found');
      });
    });

    describe('❌ InternalServerErrorException', () => {
      it('should throw InternalServerErrorException when repository.findOne fails', async () => {
        const logId = 'log-123';
        const dbError = new Error('Database query failed');
        mockRepository.findOne.mockRejectedValue(dbError);

        await expect(service.findOne(logId)).rejects.toThrow(InternalServerErrorException);
        await expect(service.findOne(logId)).rejects.toThrow('An unexpected error occurred on the server.');
      });
    });

    describe('⚠️ Edge Cases', () => {
      it('should handle null id parameter', async () => {
        const logId = null as any;
        mockRepository.findOne.mockResolvedValue(null);

        await expect(service.findOne(logId)).rejects.toThrow(NotFoundException);
        await expect(service.findOne(logId)).rejects.toThrow('AI Usage Log with ID null not found');
      });

      it('should handle undefined id parameter', async () => {
        const logId = undefined as any;
        mockRepository.findOne.mockResolvedValue(null);

        await expect(service.findOne(logId)).rejects.toThrow(NotFoundException);
        await expect(service.findOne(logId)).rejects.toThrow('AI Usage Log with ID undefined not found');
      });

      it('should handle very long id string', async () => {
        const longId = 'a'.repeat(1000);
        mockRepository.findOne.mockResolvedValue(null);

        await expect(service.findOne(longId)).rejects.toThrow(NotFoundException);
        await expect(service.findOne(longId)).rejects.toThrow(`AI Usage Log with ID ${longId} not found`);
      });

      it('should handle special characters in id', async () => {
        const specialId = 'log-123!@#$%^&*()';
        mockRepository.findOne.mockResolvedValue(null);

        await expect(service.findOne(specialId)).rejects.toThrow(NotFoundException);
        await expect(service.findOne(specialId)).rejects.toThrow(`AI Usage Log with ID ${specialId} not found`);
      });
    });
  });

  describe('mapToResponseDto (private method)', () => {
    it('should correctly map AiUsageLog to AiUsageLogResponseDto', () => {
      const result = (service as any).mapToResponseDto(mockAiUsageLog);

      expect(result).toEqual(mockResponseDto);
    });

    it('should handle log without aiUsageQuota', () => {
      const logWithoutQuota = { ...mockAiUsageLog, aiUsageQuota: null };
      const expectedResponse = { ...mockResponseDto, aiUsageQuota: null };

      const result = (service as any).mapToResponseDto(logWithoutQuota);

      expect(result).toEqual(expectedResponse);
    });

    it('should handle log with undefined aiUsageQuota', () => {
      const logWithUndefinedQuota = { ...mockAiUsageLog, aiUsageQuota: undefined };
      const expectedResponse = { ...mockResponseDto, aiUsageQuota: undefined };

      const result = (service as any).mapToResponseDto(logWithUndefinedQuota);

      expect(result).toEqual(expectedResponse);
    });
  });
});
