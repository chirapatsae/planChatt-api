import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  Logger,
  NotFoundException,
  InternalServerErrorException,
  BadRequestException,
} from '@nestjs/common';
import { RolesService } from './roles.service';
import { Role } from './entities/role.entity';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
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

describe('RolesService', () => {
  let service: RolesService;
  let roleRepository: Repository<Role>;
  let mockLogger: jest.Mocked<Logger>;

  const mockRole: Role = {
    id: 'role-id-1',
    name: 'Admin',
    createdAt: new Date(),
    deletedAt: undefined,
    workHistory: [],
  };

  const mockRole2: Role = {
    id: 'role-id-2',
    name: 'User',
    createdAt: new Date(),
    deletedAt: undefined,
    workHistory: [],
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RolesService,
        {
          provide: getRepositoryToken(Role),
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

    service = module.get<RolesService>(RolesService);
    roleRepository = module.get<Repository<Role>>(getRepositoryToken(Role));
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
    const createDto: CreateRoleDto = { name: 'New Role' };
    describe('✅ Success Case', () => {
      it('should create a new role successfully', async () => {
        const mockCreatedRole = { ...mockRole, name: createDto.name };
        jest.spyOn(roleRepository, 'create').mockReturnValue(mockCreatedRole);
        jest.spyOn(roleRepository, 'save').mockResolvedValue(mockCreatedRole);
        const result = await service.create(createDto);
        expect(roleRepository.create).toHaveBeenCalledWith({
          name: createDto.name,
        });
        expect(roleRepository.save).toHaveBeenCalledWith(mockCreatedRole);
        expect(result).toEqual(mockCreatedRole);
      });
    });
    describe('❌ Error Cases', () => {
      it('should handle database errors during creation', async () => {
        const dbError = new Error('Database connection failed');
        jest.spyOn(roleRepository, 'create').mockReturnValue(mockRole);
        jest.spyOn(roleRepository, 'save').mockRejectedValue(dbError);
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
        jest.spyOn(roleRepository, 'create').mockReturnValue(mockRole);
        jest.spyOn(roleRepository, 'save').mockRejectedValue(validationError);
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
        const emptyNameDto: CreateRoleDto = { name: '' };
        const mockCreatedRole = { ...mockRole, name: '' };
        jest.spyOn(roleRepository, 'create').mockReturnValue(mockCreatedRole);
        jest.spyOn(roleRepository, 'save').mockResolvedValue(mockCreatedRole);
        const result = await service.create(emptyNameDto);
        expect(roleRepository.create).toHaveBeenCalledWith({ name: '' });
        expect(result).toEqual(mockCreatedRole);
      });
      it('should handle very long name', async () => {
        const longName = 'A'.repeat(1000);
        const longNameDto: CreateRoleDto = { name: longName };
        const mockCreatedRole = { ...mockRole, name: longName };
        jest.spyOn(roleRepository, 'create').mockReturnValue(mockCreatedRole);
        jest.spyOn(roleRepository, 'save').mockResolvedValue(mockCreatedRole);
        const result = await service.create(longNameDto);
        expect(roleRepository.create).toHaveBeenCalledWith({ name: longName });
        expect(result).toEqual(mockCreatedRole);
      });
    });
  });

  describe('findAll', () => {
    describe('✅ Success Case', () => {
      it('should return all non-deleted roles', async () => {
        const mockRoles = [mockRole, mockRole2];
        jest.spyOn(roleRepository, 'find').mockResolvedValue(mockRoles);
        const result = await service.findAll();
        expect(roleRepository.find).toHaveBeenCalledWith({
          where: { deletedAt: undefined },
          relations: [],
        });
        expect(result).toEqual(mockRoles);
      });
      it('should return empty array when no roles exist', async () => {
        jest.spyOn(roleRepository, 'find').mockResolvedValue([]);
        const result = await service.findAll();
        expect(roleRepository.find).toHaveBeenCalledWith({
          where: { deletedAt: undefined },
          relations: [],
        });
        expect(result).toEqual([]);
      });
    });
    describe('❌ Error Cases', () => {
      it('should handle database connection errors', async () => {
        const dbError = new Error('Database connection failed');
        jest.spyOn(roleRepository, 'find').mockRejectedValue(dbError);
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
        jest.spyOn(roleRepository, 'find').mockRejectedValue(queryError);
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
    const validId = 'role-id-1';
    describe('✅ Success Case', () => {
      it('should return a role by id', async () => {
        jest.spyOn(roleRepository, 'findOne').mockResolvedValue(mockRole);
        const result = await service.findOne(validId);
        expect(roleRepository.findOne).toHaveBeenCalledWith({
          where: { id: validId },
          relations: [],
        });
        expect(result).toEqual(mockRole);
      });
    });
    describe('❌ NotFoundException', () => {
      it('should throw NotFoundException when role not found', async () => {
        jest.spyOn(roleRepository, 'findOne').mockResolvedValue(null);
        await expect(service.findOne(validId)).rejects.toThrow(
          new NotFoundException(`Role with ID ${validId} not found`),
        );
        expect(roleRepository.findOne).toHaveBeenCalledWith({
          where: { id: validId },
          relations: [],
        });
      });
    });
    describe('❌ Error Cases', () => {
      it('should handle database errors', async () => {
        const dbError = new Error('Database error');
        jest.spyOn(roleRepository, 'findOne').mockRejectedValue(dbError);
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
        jest.spyOn(roleRepository, 'findOne').mockResolvedValue(null);
        await expect(service.findOne('')).rejects.toThrow(
          new NotFoundException('Role with ID  not found'),
        );
      });
      it('should handle null id', async () => {
        jest.spyOn(roleRepository, 'findOne').mockResolvedValue(null);
        await expect(service.findOne(null as any)).rejects.toThrow(
          new NotFoundException('Role with ID null not found'),
        );
      });
      it('should handle undefined id', async () => {
        jest.spyOn(roleRepository, 'findOne').mockResolvedValue(null);
        await expect(service.findOne(undefined as any)).rejects.toThrow(
          new NotFoundException('Role with ID undefined not found'),
        );
      });
    });
  });

  describe('update', () => {
    const validId = 'role-id-1';
    const updateDto: UpdateRoleDto = { name: 'Updated Role' };
    describe('✅ Success Case', () => {
      it('should update a role successfully', async () => {
        const updatedRole = { ...mockRole, ...updateDto };
        jest.spyOn(roleRepository, 'preload').mockResolvedValue(updatedRole);
        jest.spyOn(roleRepository, 'save').mockResolvedValue(updatedRole);
        const result = await service.update(validId, updateDto);
        expect(roleRepository.preload).toHaveBeenCalledWith({
          id: validId,
          ...updateDto,
        });
        expect(roleRepository.save).toHaveBeenCalledWith(updatedRole);
        expect(result).toEqual(updatedRole);
      });
    });
    describe('❌ NotFoundException', () => {
      it('should throw NotFoundException when role not found', async () => {
        jest.spyOn(roleRepository, 'preload').mockResolvedValue(undefined);
        await expect(service.update(validId, updateDto)).rejects.toThrow(
          new NotFoundException(`Role with ID ${validId} not found`),
        );
        expect(roleRepository.preload).toHaveBeenCalledWith({
          id: validId,
          ...updateDto,
        });
      });
    });
    describe('❌ Error Cases', () => {
      it('should handle database errors during update', async () => {
        const dbError = new Error('Database error');
        jest.spyOn(roleRepository, 'preload').mockResolvedValue(mockRole);
        jest.spyOn(roleRepository, 'save').mockRejectedValue(dbError);
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
          .spyOn(roleRepository, 'preload')
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
        jest.spyOn(roleRepository, 'preload').mockResolvedValue(undefined);
        await expect(service.update('', updateDto)).rejects.toThrow(
          new NotFoundException('Role with ID  not found'),
        );
      });
      it('should handle empty update dto', async () => {
        const emptyUpdateDto: UpdateRoleDto = {};
        const updatedRole = { ...mockRole };
        jest.spyOn(roleRepository, 'preload').mockResolvedValue(updatedRole);
        jest.spyOn(roleRepository, 'save').mockResolvedValue(updatedRole);
        const result = await service.update(validId, emptyUpdateDto);
        expect(roleRepository.preload).toHaveBeenCalledWith({
          id: validId,
          ...emptyUpdateDto,
        });
        expect(result).toEqual(updatedRole);
      });
    });
  });

  describe('remove', () => {
    const validId = 'role-id-1';
    describe('✅ Success Case', () => {
      it('should permanently remove a role', async () => {
        const deleteResult = { affected: 1 };
        jest
          .spyOn(roleRepository, 'delete')
          .mockResolvedValue(deleteResult as any);
        const result = await service.remove(validId);
        expect(roleRepository.delete).toHaveBeenCalledWith(validId);
        expect(result).toEqual({
          message: `Role with ID ${validId} has been permanently removed.`,
        });
      });
    });
    describe('❌ NotFoundException', () => {
      it('should throw NotFoundException when role not found', async () => {
        const deleteResult = { affected: 0 };
        jest
          .spyOn(roleRepository, 'delete')
          .mockResolvedValue(deleteResult as any);
        await expect(service.remove(validId)).rejects.toThrow(
          new NotFoundException(`Role with ID ${validId} not found`),
        );
        expect(roleRepository.delete).toHaveBeenCalledWith(validId);
      });
    });
    describe('❌ Error Cases', () => {
      it('should handle database errors during removal', async () => {
        const dbError = new Error('Database error');
        jest.spyOn(roleRepository, 'delete').mockRejectedValue(dbError);
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
          .spyOn(roleRepository, 'delete')
          .mockResolvedValue(deleteResult as any);
        await expect(service.remove('')).rejects.toThrow(
          new NotFoundException('Role with ID  not found'),
        );
      });
      it('should handle null id', async () => {
        const deleteResult = { affected: 0 };
        jest
          .spyOn(roleRepository, 'delete')
          .mockResolvedValue(deleteResult as any);
        await expect(service.remove(null as any)).rejects.toThrow(
          new NotFoundException('Role with ID null not found'),
        );
      });
    });
  });

  describe('softRemove', () => {
    const validId = 'role-id-1';
    describe('✅ Success Case', () => {
      it('should soft remove a role', async () => {
        const softDeleteResult = { affected: 1 };
        jest
          .spyOn(roleRepository, 'softDelete')
          .mockResolvedValue(softDeleteResult as any);
        const result = await service.softRemove(validId);
        expect(roleRepository.softDelete).toHaveBeenCalledWith(validId);
        expect(result).toEqual({
          message: `Role with ID ${validId} has been soft-removed.`,
        });
      });
    });
    describe('❌ NotFoundException', () => {
      it('should throw NotFoundException when role not found', async () => {
        const softDeleteResult = { affected: 0 };
        jest
          .spyOn(roleRepository, 'softDelete')
          .mockResolvedValue(softDeleteResult as any);
        await expect(service.softRemove(validId)).rejects.toThrow(
          new NotFoundException(`Role with ID ${validId} not found`),
        );
        expect(roleRepository.softDelete).toHaveBeenCalledWith(validId);
      });
    });
    describe('❌ Error Cases', () => {
      it('should handle database errors during soft removal', async () => {
        const dbError = new Error('Database error');
        jest.spyOn(roleRepository, 'softDelete').mockRejectedValue(dbError);
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
          .spyOn(roleRepository, 'softDelete')
          .mockResolvedValue(softDeleteResult as any);
        await expect(service.softRemove('')).rejects.toThrow(
          new NotFoundException('Role with ID  not found'),
        );
      });
    });
  });

  describe('restore', () => {
    const validId = 'role-id-1';
    describe('✅ Success Case', () => {
      it('should restore a soft-deleted role', async () => {
        const restoreResult = { affected: 1 };
        jest
          .spyOn(roleRepository, 'restore')
          .mockResolvedValue(restoreResult as any);
        const result = await service.restore(validId);
        expect(roleRepository.restore).toHaveBeenCalledWith(validId);
        expect(result).toEqual({
          message: `Role with ID ${validId} has been restored.`,
        });
      });
    });
    describe('❌ NotFoundException', () => {
      it('should throw NotFoundException when role not found or not deleted', async () => {
        const restoreResult = { affected: 0 };
        jest
          .spyOn(roleRepository, 'restore')
          .mockResolvedValue(restoreResult as any);
        await expect(service.restore(validId)).rejects.toThrow(
          new NotFoundException(
            `Role with ID ${validId} not found or was not deleted.`,
          ),
        );
        expect(roleRepository.restore).toHaveBeenCalledWith(validId);
      });
    });
    describe('❌ Error Cases', () => {
      it('should handle database errors during restoration', async () => {
        const dbError = new Error('Database error');
        jest.spyOn(roleRepository, 'restore').mockRejectedValue(dbError);
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
          .spyOn(roleRepository, 'restore')
          .mockResolvedValue(restoreResult as any);
        await expect(service.restore('')).rejects.toThrow(
          new NotFoundException('Role with ID  not found or was not deleted.'),
        );
      });
      it('should handle null id', async () => {
        const restoreResult = { affected: 0 };
        jest
          .spyOn(roleRepository, 'restore')
          .mockResolvedValue(restoreResult as any);
        await expect(service.restore(null as any)).rejects.toThrow(
          new NotFoundException(
            'Role with ID null not found or was not deleted.',
          ),
        );
      });
    });
  });
});
