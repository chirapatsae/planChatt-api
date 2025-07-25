import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common';
import { PositionsService } from './positions.service';
import { Position } from './entities/position.entity';
import { User } from '../users/entities/user.entity';
import { CreatePositionDto } from './dto/create-position.dto';
import { UpdatePositionDto } from './dto/update-position.dto';

describe('PositionsService', () => {
  let service: PositionsService;

  const mockPosition = {
    id: 'position-1',
    name: 'Manager',
    isLatest: true,
    createdAt: new Date(),
    deletedAt: null,
    user: {
      id: 'user-1',
      name: 'John Doe',
    },
  };

  const mockUser = {
    id: 'user-1',
    name: 'John Doe',
  };

  const mockPositionRepository = {
    create: jest.fn(),
    save: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    preload: jest.fn(),
    delete: jest.fn(),
    softDelete: jest.fn(),
    restore: jest.fn(),
    update: jest.fn(),
  };

  const mockUserRepository = {
    findOne: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PositionsService,
        {
          provide: getRepositoryToken(Position),
          useValue: mockPositionRepository,
        },
        {
          provide: getRepositoryToken(User),
          useValue: mockUserRepository,
        },
      ],
    }).compile();

    service = module.get<PositionsService>(PositionsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    const createPositionDto: CreatePositionDto = {
      name: 'Manager',
      userId: 'user-1',
    };

    it('should create a new position successfully', async () => {
      // Arrange
      mockUserRepository.findOne.mockResolvedValue(mockUser);
      mockPositionRepository.update.mockResolvedValue({ affected: 1 });
      mockPositionRepository.create.mockReturnValue(mockPosition);
      mockPositionRepository.save.mockResolvedValue(mockPosition);

      // Act
      const result = await service.create(createPositionDto);

      // Assert
      expect(mockUserRepository.findOne).toHaveBeenCalledWith({
        where: { id: 'user-1' },
      });
      expect(mockPositionRepository.update).toHaveBeenCalledWith(
        { user: { id: 'user-1' }, isLatest: true },
        { isLatest: false },
      );
      expect(mockPositionRepository.create).toHaveBeenCalledWith({
        name: 'Manager',
        isLatest: true,
        user: mockUser,
      });
      expect(mockPositionRepository.save).toHaveBeenCalledWith(mockPosition);
      expect(result).toEqual(mockPosition);
    });

    it('should throw NotFoundException when user not found', async () => {
      // Arrange
      mockUserRepository.findOne.mockResolvedValue(null);

      // Act & Assert
      await expect(service.create(createPositionDto)).rejects.toThrow(
        NotFoundException,
      );
      expect(mockUserRepository.findOne).toHaveBeenCalledWith({
        where: { id: 'user-1' },
      });
    });
  });

  describe('findAll', () => {
    it('should return all non-deleted positions with user relations', async () => {
      // Arrange
      const mockPositions = [mockPosition];
      mockPositionRepository.find.mockResolvedValue(mockPositions);

      // Act
      const result = await service.findAll();

      // Assert
      expect(mockPositionRepository.find).toHaveBeenCalledWith({
        where: { deletedAt: undefined },
        relations: ['user'],
      });
      expect(result).toEqual(mockPositions);
    });

    it('should handle errors and throw InternalServerErrorException', async () => {
      // Arrange
      mockPositionRepository.find.mockRejectedValue(
        new Error('Database error'),
      );

      // Act & Assert
      await expect(service.findAll()).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('findOne', () => {
    it('should return a position by id with user relations', async () => {
      // Arrange
      mockPositionRepository.findOne.mockResolvedValue(mockPosition);

      // Act
      const result = await service.findOne('position-1');

      // Assert
      expect(mockPositionRepository.findOne).toHaveBeenCalledWith({
        where: { id: 'position-1' },
        relations: ['user'],
      });
      expect(result).toEqual(mockPosition);
    });

    it('should throw NotFoundException when position not found', async () => {
      // Arrange
      mockPositionRepository.findOne.mockResolvedValue(null);

      // Act & Assert
      await expect(service.findOne('non-existent')).rejects.toThrow(
        NotFoundException,
      );
      expect(mockPositionRepository.findOne).toHaveBeenCalledWith({
        where: { id: 'non-existent' },
        relations: ['user'],
      });
    });

    it('should handle errors and throw InternalServerErrorException', async () => {
      // Arrange
      mockPositionRepository.findOne.mockRejectedValue(
        new Error('Database error'),
      );

      // Act & Assert
      await expect(service.findOne('position-1')).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('update', () => {
    const updatePositionDto: UpdatePositionDto = {
      name: 'Senior Manager',
    };

    it('should update a position successfully', async () => {
      // Arrange
      const updatedPosition = { ...mockPosition, name: 'Senior Manager' };
      mockPositionRepository.preload.mockResolvedValue(updatedPosition);
      mockPositionRepository.save.mockResolvedValue(updatedPosition);

      // Act
      const result = await service.update('position-1', updatePositionDto);

      // Assert
      expect(mockPositionRepository.preload).toHaveBeenCalledWith({
        id: 'position-1',
        ...updatePositionDto,
      });
      expect(mockPositionRepository.save).toHaveBeenCalledWith(updatedPosition);
      expect(result).toEqual(updatedPosition);
    });

    it('should throw NotFoundException when position not found', async () => {
      // Arrange
      mockPositionRepository.preload.mockResolvedValue(null);

      // Act & Assert
      await expect(
        service.update('non-existent', updatePositionDto),
      ).rejects.toThrow(NotFoundException);
      expect(mockPositionRepository.preload).toHaveBeenCalledWith({
        id: 'non-existent',
        ...updatePositionDto,
      });
    });

    it('should handle errors and throw InternalServerErrorException', async () => {
      // Arrange
      mockPositionRepository.preload.mockRejectedValue(
        new Error('Database error'),
      );

      // Act & Assert
      await expect(
        service.update('position-1', updatePositionDto),
      ).rejects.toThrow(InternalServerErrorException);
    });
  });

  describe('remove', () => {
    it('should permanently remove a position successfully', async () => {
      // Arrange
      mockPositionRepository.delete.mockResolvedValue({ affected: 1 });

      // Act
      const result = await service.remove('position-1');

      // Assert
      expect(mockPositionRepository.delete).toHaveBeenCalledWith('position-1');
      expect(result).toEqual({
        message: 'Position with ID position-1 has been permanently removed.',
      });
    });

    it('should throw NotFoundException when position not found', async () => {
      // Arrange
      mockPositionRepository.delete.mockResolvedValue({ affected: 0 });

      // Act & Assert
      await expect(service.remove('non-existent')).rejects.toThrow(
        NotFoundException,
      );
      expect(mockPositionRepository.delete).toHaveBeenCalledWith(
        'non-existent',
      );
    });

    it('should handle errors and throw InternalServerErrorException', async () => {
      // Arrange
      mockPositionRepository.delete.mockRejectedValue(
        new Error('Database error'),
      );

      // Act & Assert
      await expect(service.remove('position-1')).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('softRemove', () => {
    it('should soft remove a position successfully', async () => {
      // Arrange
      mockPositionRepository.softDelete.mockResolvedValue({ affected: 1 });

      // Act
      const result = await service.softRemove('position-1');

      // Assert
      expect(mockPositionRepository.softDelete).toHaveBeenCalledWith(
        'position-1',
      );
      expect(result).toEqual({
        message: 'Position with ID position-1 has been soft-removed.',
      });
    });

    it('should throw NotFoundException when position not found', async () => {
      // Arrange
      mockPositionRepository.softDelete.mockResolvedValue({ affected: 0 });

      // Act & Assert
      await expect(service.softRemove('non-existent')).rejects.toThrow(
        NotFoundException,
      );
      expect(mockPositionRepository.softDelete).toHaveBeenCalledWith(
        'non-existent',
      );
    });

    it('should handle errors and throw InternalServerErrorException', async () => {
      // Arrange
      mockPositionRepository.softDelete.mockRejectedValue(
        new Error('Database error'),
      );

      // Act & Assert
      await expect(service.softRemove('position-1')).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('restore', () => {
    it('should restore a soft-deleted position successfully', async () => {
      // Arrange
      mockPositionRepository.restore.mockResolvedValue({ affected: 1 });

      // Act
      const result = await service.restore('position-1');

      // Assert
      expect(mockPositionRepository.restore).toHaveBeenCalledWith('position-1');
      expect(result).toEqual({
        message: 'Position with ID position-1 has been restored.',
      });
    });

    it('should throw NotFoundException when position not found or not deleted', async () => {
      // Arrange
      mockPositionRepository.restore.mockResolvedValue({ affected: 0 });

      // Act & Assert
      await expect(service.restore('non-existent')).rejects.toThrow(
        NotFoundException,
      );
      expect(mockPositionRepository.restore).toHaveBeenCalledWith(
        'non-existent',
      );
    });

    it('should handle errors and throw InternalServerErrorException', async () => {
      // Arrange
      mockPositionRepository.restore.mockRejectedValue(
        new Error('Database error'),
      );

      // Act & Assert
      await expect(service.restore('position-1')).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });
});
