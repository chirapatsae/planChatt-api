import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { AiUsageQuotasService } from './ai-usage-quotas.service';
import { AiUsageQuota } from './entities/ai-usage-quota.entity';
import { User } from '../users/entities/user.entity';
import { CreateAiUsageQuotaDto } from './dto/create-ai-usage-quota.dto';
import { UpdateAiUsageQuotaDto } from './dto/update-ai-usage-quota.dto';

describe('AiUsageQuotasService', () => {
  let service: AiUsageQuotasService;
  let aiUsageQuotaRepository: Repository<AiUsageQuota>;
  let userRepository: Repository<User>;

  const mockAiUsageQuotaRepository = {
    create: jest.fn(),
    save: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    preload: jest.fn(),
    delete: jest.fn(),
    softRemove: jest.fn(),
    restore: jest.fn(),
  };

  const mockUserRepository = {
    findOne: jest.fn(),
  };

  const mockLogger = {
    log: jest.fn(),
    error: jest.fn(),
  };

  const mockUser: User = {
    id: 'user-123',
    citizenId: '1234567890123',
    citizenIdHash: 'hashed-citizen-id',
    prefix: 'นาย',
    firstname: 'John',
    lastname: 'Doe',
    email: 'john.doe@example.com',
    phone: '0812345678',
    isFirstLogin: false,
    createAt: new Date(),
    workHistory: [],
    createdWorkHistory: [],
    updatedWorkHistory: [],
    position: [],
    userActivityLogs: [],
    aiUsageQuota: undefined as any, // Type assertion to handle the relationship
  };

  const mockAiUsageQuota: AiUsageQuota = {
    id: 'quota-123',
    periodStart: new Date('2024-01-01'),
    periodEnd: new Date('2024-12-31'),
    quotaLimit: 1000,
    quotaUsed: 100,
    remainingQuota: 900,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: undefined,
    user: mockUser,
  };

  const mockCreateDto: CreateAiUsageQuotaDto = {
    periodStart: new Date('2024-01-01'),
    periodEnd: new Date('2024-12-31'),
    quotaLimit: 1000,
    quotaUsed: 0,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiUsageQuotasService,
        {
          provide: getRepositoryToken(AiUsageQuota),
          useValue: mockAiUsageQuotaRepository,
        },
        {
          provide: getRepositoryToken(User),
          useValue: mockUserRepository,
        },
      ],
    }).compile();

    service = module.get<AiUsageQuotasService>(AiUsageQuotasService);
    aiUsageQuotaRepository = module.get<Repository<AiUsageQuota>>(
      getRepositoryToken(AiUsageQuota),
    );
    userRepository = module.get<Repository<User>>(getRepositoryToken(User));

    // Mock the logger
    jest.spyOn(service['logger'], 'log').mockImplementation(mockLogger.log);
    jest.spyOn(service['logger'], 'error').mockImplementation(mockLogger.error);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('create', () => {
    const userId = 'user-123';

    describe('✅ Success Cases', () => {
      it('should create a new AI usage quota successfully', async () => {
        // Arrange
        mockUserRepository.findOne.mockResolvedValue(mockUser);
        mockAiUsageQuotaRepository.findOne.mockResolvedValue(null); // No existing quota
        mockAiUsageQuotaRepository.create.mockReturnValue(mockAiUsageQuota);
        mockAiUsageQuotaRepository.save.mockResolvedValue(mockAiUsageQuota);

        // Act
        const result = await service.create(mockCreateDto, userId);

        // Assert
        expect(result).toEqual(mockAiUsageQuota);
        expect(mockUserRepository.findOne).toHaveBeenCalledWith({
          where: { id: userId },
        });
        expect(mockAiUsageQuotaRepository.findOne).toHaveBeenCalledWith({
          where: { user: { id: userId }, deletedAt: undefined },
        });
        expect(mockAiUsageQuotaRepository.create).toHaveBeenCalledWith({
          periodStart: mockCreateDto.periodStart,
          periodEnd: mockCreateDto.periodEnd,
          quotaLimit: mockCreateDto.quotaLimit,
          quotaUsed: mockCreateDto.quotaUsed,
          remainingQuota: mockCreateDto.quotaLimit - (mockCreateDto.quotaUsed || 0),
          user: mockUser,
        });
        expect(mockAiUsageQuotaRepository.save).toHaveBeenCalledWith(mockAiUsageQuota);
      });

      it('should create quota with default values when quotaUsed is not provided', async () => {
        // Arrange
        const dtoWithoutQuotaUsed = { ...mockCreateDto };
        delete dtoWithoutQuotaUsed.quotaUsed;
        
        mockUserRepository.findOne.mockResolvedValue(mockUser);
        mockAiUsageQuotaRepository.findOne.mockResolvedValue(null);
        mockAiUsageQuotaRepository.create.mockReturnValue(mockAiUsageQuota);
        mockAiUsageQuotaRepository.save.mockResolvedValue(mockAiUsageQuota);

        // Act
        await service.create(dtoWithoutQuotaUsed, userId);

        // Assert
        expect(mockAiUsageQuotaRepository.create).toHaveBeenCalledWith({
          periodStart: dtoWithoutQuotaUsed.periodStart,
          periodEnd: dtoWithoutQuotaUsed.periodEnd,
          quotaLimit: dtoWithoutQuotaUsed.quotaLimit,
          quotaUsed: 0,
          remainingQuota: dtoWithoutQuotaUsed.quotaLimit,
          user: mockUser,
        });
      });
    });

    describe('❌ Error Cases', () => {
      it('should throw UnauthorizedException when user not found', async () => {
        // Arrange
        mockUserRepository.findOne.mockResolvedValue(null);

        // Act & Assert
        await expect(service.create(mockCreateDto, userId)).rejects.toThrow(
          UnauthorizedException,
        );
        expect(mockUserRepository.findOne).toHaveBeenCalledWith({
          where: { id: userId },
        });
      });

      it('should throw UnauthorizedException when user already has active quota', async () => {
        // Arrange
        mockUserRepository.findOne.mockResolvedValue(mockUser);
        mockAiUsageQuotaRepository.findOne.mockResolvedValue(mockAiUsageQuota);

        // Act & Assert
        await expect(service.create(mockCreateDto, userId)).rejects.toThrow(
          UnauthorizedException,
        );
        expect(mockAiUsageQuotaRepository.findOne).toHaveBeenCalledWith({
          where: { user: { id: userId }, deletedAt: undefined },
        });
      });

      it('should handle database errors during user lookup', async () => {
        // Arrange
        const dbError = new Error('Database connection failed');
        mockUserRepository.findOne.mockRejectedValue(dbError);

        // Act & Assert
        await expect(service.create(mockCreateDto, userId)).rejects.toThrow();
        expect(mockUserRepository.findOne).toHaveBeenCalledWith({
          where: { id: userId },
        });
      });

      it('should handle database errors during quota creation', async () => {
        // Arrange
        mockUserRepository.findOne.mockResolvedValue(mockUser);
        mockAiUsageQuotaRepository.findOne.mockResolvedValue(null);
        mockAiUsageQuotaRepository.create.mockReturnValue(mockAiUsageQuota);
        mockAiUsageQuotaRepository.save.mockRejectedValue(new Error('Save failed'));

        // Act & Assert
        await expect(service.create(mockCreateDto, userId)).rejects.toThrow();
      });
    });

    describe('⚠️ Edge Cases', () => {
      it('should handle empty userId', async () => {
        // Arrange
        mockUserRepository.findOne.mockResolvedValue(null);

        // Act & Assert
        await expect(service.create(mockCreateDto, '')).rejects.toThrow(
          UnauthorizedException,
        );
      });

      it('should handle invalid userId format', async () => {
        // Arrange
        mockUserRepository.findOne.mockResolvedValue(null);

        // Act & Assert
        await expect(service.create(mockCreateDto, 'invalid-uuid')).rejects.toThrow(
          UnauthorizedException,
        );
      });
    });
  });

  describe('findAll', () => {
    describe('✅ Success Cases', () => {
      it('should return all non-deleted AI usage quotas', async () => {
        // Arrange
        const mockQuotas = [mockAiUsageQuota];
        mockAiUsageQuotaRepository.find.mockResolvedValue(mockQuotas);

        // Act
        const result = await service.findAll();

        // Assert
        expect(result).toEqual(mockQuotas);
        expect(mockAiUsageQuotaRepository.find).toHaveBeenCalledWith({
          where: { deletedAt: undefined },
          relations: ['user'],
        });
        expect(mockLogger.log).toHaveBeenCalledWith('Fetching all AI usage quotas');
      });

      it('should return empty array when no quotas exist', async () => {
        // Arrange
        mockAiUsageQuotaRepository.find.mockResolvedValue([]);

        // Act
        const result = await service.findAll();

        // Assert
        expect(result).toEqual([]);
      });
    });

    describe('❌ Error Cases', () => {
      it('should handle database errors', async () => {
        // Arrange
        const dbError = new Error('Database connection failed');
        mockAiUsageQuotaRepository.find.mockRejectedValue(dbError);

        // Act & Assert
        await expect(service.findAll()).rejects.toThrow();
      });
    });
  });

  describe('findOne', () => {
    const quotaId = 'quota-123';

    describe('✅ Success Cases', () => {
      it('should return AI usage quota by ID', async () => {
        // Arrange
        mockAiUsageQuotaRepository.findOne.mockResolvedValue(mockAiUsageQuota);

        // Act
        const result = await service.findOne(quotaId);

        // Assert
        expect(result).toEqual(mockAiUsageQuota);
        expect(mockAiUsageQuotaRepository.findOne).toHaveBeenCalledWith({
          where: { id: quotaId },
          relations: ['user'],
        });
        expect(mockLogger.log).toHaveBeenCalledWith(
          `Fetching AI usage quota with ID: ${quotaId}`,
        );
      });
    });

    describe('❌ Error Cases', () => {
      it('should throw NotFoundException when quota not found', async () => {
        // Arrange
        mockAiUsageQuotaRepository.findOne.mockResolvedValue(null);

        // Act & Assert
        await expect(service.findOne(quotaId)).rejects.toThrow(
          NotFoundException,
        );
        expect(mockAiUsageQuotaRepository.findOne).toHaveBeenCalledWith({
          where: { id: quotaId },
          relations: ['user'],
        });
      });

      it('should handle database errors', async () => {
        // Arrange
        const dbError = new Error('Database connection failed');
        mockAiUsageQuotaRepository.findOne.mockRejectedValue(dbError);

        // Act & Assert
        await expect(service.findOne(quotaId)).rejects.toThrow();
      });
    });

    describe('⚠️ Edge Cases', () => {
      it('should handle empty ID', async () => {
        // Arrange
        mockAiUsageQuotaRepository.findOne.mockResolvedValue(null);

        // Act & Assert
        await expect(service.findOne('')).rejects.toThrow(NotFoundException);
      });

      it('should handle invalid UUID format', async () => {
        // Arrange
        mockAiUsageQuotaRepository.findOne.mockResolvedValue(null);

        // Act & Assert
        await expect(service.findOne('invalid-uuid')).rejects.toThrow(NotFoundException);
      });
    });
  });

  describe('update', () => {
    const quotaId = 'quota-123';
    const updateDto: UpdateAiUsageQuotaDto = {
      quotaLimit: 2000,
      quotaUsed: 150,
    };

    describe('✅ Success Cases', () => {
      it('should update AI usage quota successfully', async () => {
        // Arrange
        const updatedQuota = { ...mockAiUsageQuota, ...updateDto };
        mockAiUsageQuotaRepository.preload.mockResolvedValue(updatedQuota);
        mockAiUsageQuotaRepository.save.mockResolvedValue(updatedQuota);

        // Act
        const result = await service.update(quotaId, updateDto);

        // Assert
        expect(result).toEqual(updatedQuota);
        expect(mockAiUsageQuotaRepository.preload).toHaveBeenCalledWith({
          id: quotaId,
          ...updateDto,
        });
        expect(mockAiUsageQuotaRepository.save).toHaveBeenCalledWith(updatedQuota);
      });
    });

    describe('❌ Error Cases', () => {
      it('should throw NotFoundException when quota not found', async () => {
        // Arrange
        mockAiUsageQuotaRepository.preload.mockResolvedValue(null);

        // Act & Assert
        await expect(service.update(quotaId, updateDto)).rejects.toThrow(
          NotFoundException,
        );
        expect(mockAiUsageQuotaRepository.preload).toHaveBeenCalledWith({
          id: quotaId,
          ...updateDto,
        });
      });

      it('should handle database errors during preload', async () => {
        // Arrange
        const dbError = new Error('Database connection failed');
        mockAiUsageQuotaRepository.preload.mockRejectedValue(dbError);

        // Act & Assert
        await expect(service.update(quotaId, updateDto)).rejects.toThrow();
      });

      it('should handle database errors during save', async () => {
        // Arrange
        const updatedQuota = { ...mockAiUsageQuota, ...updateDto };
        mockAiUsageQuotaRepository.preload.mockResolvedValue(updatedQuota);
        mockAiUsageQuotaRepository.save.mockRejectedValue(new Error('Save failed'));

        // Act & Assert
        await expect(service.update(quotaId, updateDto)).rejects.toThrow();
      });
    });

    describe('⚠️ Edge Cases', () => {
      it('should handle empty ID', async () => {
        // Arrange
        mockAiUsageQuotaRepository.preload.mockResolvedValue(null);

        // Act & Assert
        await expect(service.update('', updateDto)).rejects.toThrow(NotFoundException);
      });

      it('should handle empty update DTO', async () => {
        // Arrange
        const emptyDto = {};
        mockAiUsageQuotaRepository.preload.mockResolvedValue(mockAiUsageQuota);
        mockAiUsageQuotaRepository.save.mockResolvedValue(mockAiUsageQuota);

        // Act
        const result = await service.update(quotaId, emptyDto);

        // Assert
        expect(result).toEqual(mockAiUsageQuota);
      });
    });
  });

  describe('remove', () => {
    const quotaId = 'quota-123';

    describe('✅ Success Cases', () => {
      it('should permanently remove AI usage quota', async () => {
        // Arrange
        mockAiUsageQuotaRepository.delete.mockResolvedValue({ affected: 1 });

        // Act
        const result = await service.remove(quotaId);

        // Assert
        expect(result).toEqual({
          message: `AI usage quota with ID ${quotaId} has been permanently removed.`,
        });
        expect(mockAiUsageQuotaRepository.delete).toHaveBeenCalledWith(quotaId);
      });
    });

    describe('❌ Error Cases', () => {
      it('should throw NotFoundException when quota not found', async () => {
        // Arrange
        mockAiUsageQuotaRepository.delete.mockResolvedValue({ affected: 0 });

        // Act & Assert
        await expect(service.remove(quotaId)).rejects.toThrow(NotFoundException);
        expect(mockAiUsageQuotaRepository.delete).toHaveBeenCalledWith(quotaId);
      });

      it('should handle database errors', async () => {
        // Arrange
        const dbError = new Error('Database connection failed');
        mockAiUsageQuotaRepository.delete.mockRejectedValue(dbError);

        // Act & Assert
        await expect(service.remove(quotaId)).rejects.toThrow();
      });
    });

    describe('⚠️ Edge Cases', () => {
      it('should handle empty ID', async () => {
        // Arrange
        mockAiUsageQuotaRepository.delete.mockResolvedValue({ affected: 0 });

        // Act & Assert
        await expect(service.remove('')).rejects.toThrow(NotFoundException);
      });
    });
  });

  describe('softRemove', () => {
    const quotaId = 'quota-123';

    describe('✅ Success Cases', () => {
      it('should soft remove AI usage quota', async () => {
        // Arrange
        mockAiUsageQuotaRepository.findOne.mockResolvedValue(mockAiUsageQuota);
        mockAiUsageQuotaRepository.softRemove.mockResolvedValue(undefined);

        // Act
        const result = await service.softRemove(quotaId);

        // Assert
        expect(result).toEqual({
          message: `AI usage quota with ID ${quotaId} has been soft-removed.`,
        });
        expect(mockAiUsageQuotaRepository.findOne).toHaveBeenCalledWith({
          where: { id: quotaId },
        });
        expect(mockAiUsageQuotaRepository.softRemove).toHaveBeenCalledWith(mockAiUsageQuota);
      });
    });

    describe('❌ Error Cases', () => {
      it('should throw NotFoundException when quota not found', async () => {
        // Arrange
        mockAiUsageQuotaRepository.findOne.mockResolvedValue(null);

        // Act & Assert
        await expect(service.softRemove(quotaId)).rejects.toThrow(NotFoundException);
        expect(mockAiUsageQuotaRepository.findOne).toHaveBeenCalledWith({
          where: { id: quotaId },
        });
      });

      it('should handle database errors during find', async () => {
        // Arrange
        const dbError = new Error('Database connection failed');
        mockAiUsageQuotaRepository.findOne.mockRejectedValue(dbError);

        // Act & Assert
        await expect(service.softRemove(quotaId)).rejects.toThrow();
      });

      it('should handle database errors during soft remove', async () => {
        // Arrange
        mockAiUsageQuotaRepository.findOne.mockResolvedValue(mockAiUsageQuota);
        mockAiUsageQuotaRepository.softRemove.mockRejectedValue(new Error('Soft remove failed'));

        // Act & Assert
        await expect(service.softRemove(quotaId)).rejects.toThrow();
      });
    });

    describe('⚠️ Edge Cases', () => {
      it('should handle empty ID', async () => {
        // Arrange
        mockAiUsageQuotaRepository.findOne.mockResolvedValue(null);

        // Act & Assert
        await expect(service.softRemove('')).rejects.toThrow(NotFoundException);
      });
    });
  });

  describe('restore', () => {
    const quotaId = 'quota-123';

    describe('✅ Success Cases', () => {
      it('should restore soft-removed AI usage quota', async () => {
        // Arrange
        mockAiUsageQuotaRepository.restore.mockResolvedValue({ affected: 1 });

        // Act
        const result = await service.restore(quotaId);

        // Assert
        expect(result).toEqual({
          message: `AI usage quota with ID ${quotaId} has been restored.`,
        });
        expect(mockAiUsageQuotaRepository.restore).toHaveBeenCalledWith(quotaId);
      });
    });

    describe('❌ Error Cases', () => {
      it('should throw NotFoundException when quota not found or not deleted', async () => {
        // Arrange
        mockAiUsageQuotaRepository.restore.mockResolvedValue({ affected: 0 });

        // Act & Assert
        await expect(service.restore(quotaId)).rejects.toThrow(NotFoundException);
        expect(mockAiUsageQuotaRepository.restore).toHaveBeenCalledWith(quotaId);
      });

      it('should handle database errors', async () => {
        // Arrange
        const dbError = new Error('Database connection failed');
        mockAiUsageQuotaRepository.restore.mockRejectedValue(dbError);

        // Act & Assert
        await expect(service.restore(quotaId)).rejects.toThrow();
      });
    });

    describe('⚠️ Edge Cases', () => {
      it('should handle empty ID', async () => {
        // Arrange
        mockAiUsageQuotaRepository.restore.mockResolvedValue({ affected: 0 });

        // Act & Assert
        await expect(service.restore('')).rejects.toThrow(NotFoundException);
      });
    });
  });

  describe('incrementUsage', () => {
    const quotaId = 'quota-123';

    describe('✅ Success Cases', () => {
      it('should increment usage by default amount (1)', async () => {
        // Arrange
        const originalQuota = JSON.parse(JSON.stringify(mockAiUsageQuota));
        const quotaWithUpdatedUsage = {
          ...originalQuota,
          quotaUsed: originalQuota.quotaUsed + 1,
          remainingQuota: originalQuota.remainingQuota - 1,
        };
        mockAiUsageQuotaRepository.findOne.mockResolvedValue(originalQuota);
        mockAiUsageQuotaRepository.save.mockResolvedValue(quotaWithUpdatedUsage);

        // Act
        const result = await service.incrementUsage(quotaId);

        // Assert
        expect(result).toEqual(quotaWithUpdatedUsage);
        expect(mockAiUsageQuotaRepository.findOne).toHaveBeenCalledWith({
          where: { id: quotaId },
        });
        expect(mockAiUsageQuotaRepository.save).toHaveBeenCalledTimes(1);
      });

      it('should increment usage by specified amount', async () => {
        // Arrange
        const incrementAmount = 5;
        const originalQuota = JSON.parse(JSON.stringify(mockAiUsageQuota));
        const quotaWithUpdatedUsage = {
          ...originalQuota,
          quotaUsed: originalQuota.quotaUsed + incrementAmount,
          remainingQuota: originalQuota.remainingQuota - incrementAmount,
        };
        mockAiUsageQuotaRepository.findOne.mockResolvedValue(originalQuota);
        mockAiUsageQuotaRepository.save.mockResolvedValue(quotaWithUpdatedUsage);

        // Act
        const result = await service.incrementUsage(quotaId, incrementAmount);

        // Assert
        expect(result).toEqual(quotaWithUpdatedUsage);
        expect(mockAiUsageQuotaRepository.save).toHaveBeenCalledTimes(1);
      });
    });

    describe('❌ Error Cases', () => {
      it('should throw NotFoundException when quota not found', async () => {
        // Arrange
        mockAiUsageQuotaRepository.findOne.mockResolvedValue(null);

        // Act & Assert
        await expect(service.incrementUsage(quotaId)).rejects.toThrow(NotFoundException);
        expect(mockAiUsageQuotaRepository.findOne).toHaveBeenCalledWith({
          where: { id: quotaId },
        });
      });

      it('should throw UnauthorizedException when quota limit exceeded', async () => {
        // Arrange
        const quotaAtLimit = {
          ...mockAiUsageQuota,
          quotaUsed: 1000,
          remainingQuota: 0,
        };
        mockAiUsageQuotaRepository.findOne.mockResolvedValue(quotaAtLimit);

        // Act & Assert
        await expect(service.incrementUsage(quotaId)).rejects.toThrow(UnauthorizedException);
        expect(mockAiUsageQuotaRepository.findOne).toHaveBeenCalledWith({
          where: { id: quotaId },
        });
      });

      it('should handle database errors during find', async () => {
        // Arrange
        const dbError = new Error('Database connection failed');
        mockAiUsageQuotaRepository.findOne.mockRejectedValue(dbError);

        // Act & Assert
        await expect(service.incrementUsage(quotaId)).rejects.toThrow();
      });

      it('should handle database errors during save', async () => {
        // Arrange
        mockAiUsageQuotaRepository.findOne.mockResolvedValue(mockAiUsageQuota);
        mockAiUsageQuotaRepository.save.mockRejectedValue(new Error('Save failed'));

        // Act & Assert
        await expect(service.incrementUsage(quotaId)).rejects.toThrow();
      });
    });

    describe('⚠️ Edge Cases', () => {
      it('should handle empty ID', async () => {
        // Arrange
        mockAiUsageQuotaRepository.findOne.mockResolvedValue(null);

        // Act & Assert
        await expect(service.incrementUsage('')).rejects.toThrow(NotFoundException);
      });

      it('should handle negative usage amount', async () => {
        // Arrange
        const negativeAmount = -5;
        const originalQuota = JSON.parse(JSON.stringify(mockAiUsageQuota));
        const quotaWithUpdatedUsage = {
          ...originalQuota,
          quotaUsed: originalQuota.quotaUsed + negativeAmount,
          remainingQuota: originalQuota.remainingQuota - negativeAmount,
        };
        mockAiUsageQuotaRepository.findOne.mockResolvedValue(originalQuota);
        mockAiUsageQuotaRepository.save.mockResolvedValue(quotaWithUpdatedUsage);

        // Act
        const result = await service.incrementUsage(quotaId, negativeAmount);

        // Assert
        expect(result).toEqual(quotaWithUpdatedUsage);
      });

      it('should handle zero usage amount', async () => {
        // Arrange
        const zeroAmount = 0;
        const originalQuota = JSON.parse(JSON.stringify(mockAiUsageQuota));
        const quotaWithUpdatedUsage = {
          ...originalQuota,
          quotaUsed: originalQuota.quotaUsed + zeroAmount,
          remainingQuota: originalQuota.remainingQuota - zeroAmount,
        };
        mockAiUsageQuotaRepository.findOne.mockResolvedValue(originalQuota);
        mockAiUsageQuotaRepository.save.mockResolvedValue(quotaWithUpdatedUsage);

        // Act
        const result = await service.incrementUsage(quotaId, zeroAmount);

        // Assert
        expect(result).toEqual(quotaWithUpdatedUsage);
      });

      it('should handle quota with exact remaining quota', async () => {
        // Arrange
        const quotaWithExactRemaining = {
          ...mockAiUsageQuota,
          quotaUsed: 999,
          remainingQuota: 1,
        };
        const quotaWithUpdatedUsage = {
          ...quotaWithExactRemaining,
          quotaUsed: 1000,
          remainingQuota: 0,
        };
        mockAiUsageQuotaRepository.findOne.mockResolvedValue(quotaWithExactRemaining);
        mockAiUsageQuotaRepository.save.mockResolvedValue(quotaWithUpdatedUsage);

        // Act
        const result = await service.incrementUsage(quotaId, 1);

        // Assert
        expect(result).toEqual(quotaWithUpdatedUsage);
      });
    });
  });
});
