import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UsersService } from './users.service';
import { User } from './entities/user.entity';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';

// Mock utility functions except handleException
jest.mock('../util/encryption.util', () => ({
  encryption: jest.fn(async (v) => `encrypted-${v}`),
  decryption: jest.fn(async (v) => v.replace('encrypted-', '')),
  hashCitizenId: jest.fn((v) => `hash-${v}`),
}));

import { encryption, decryption, hashCitizenId } from '../util/encryption.util';
import * as handleExceptionModule from '../util/handleException';

const mockUser = (overrides: Partial<User> = {}): User => ({
  id: 'uuid-1',
  citizenId: '1234567890123',
  citizenIdHash: 'hash',
  prefix: 'Mr.',
  firstname: 'John',
  lastname: 'Doe',
  email: 'john@example.com',
  phone: '0123456789',
  isFirstLogin: false,
  deletedAt: new Date(),
  createAt: new Date(),
  workHistory: [],
  createdWorkHistory: [],
  updatedWorkHistory: [],
  position: [],
  ...overrides,
});

const mockUserRepository = () => ({
  create: jest.fn(),
  save: jest.fn(),
  find: jest.fn(),
  findOne: jest.fn(),
  preload: jest.fn(),
  softDelete: jest.fn(),
  delete: jest.fn(),
  restore: jest.fn(),
});

describe('UsersService', () => {
  let service: UsersService;
  let userRepository: ReturnType<typeof mockUserRepository>;
  let handleExceptionSpy: jest.SpyInstance;

  beforeEach(async () => {
    jest.clearAllMocks();
    userRepository = mockUserRepository();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        {
          provide: getRepositoryToken(User),
          useValue: userRepository,
        },
      ],
    }).compile();
    service = module.get<UsersService>(UsersService);
  });

  afterEach(() => {
    if (handleExceptionSpy) handleExceptionSpy.mockRestore();
  });

  describe('create', () => {
    const dto: CreateUserDto = {
      citizenId: '1234567890123',
      prefix: 'Mr.',
      firstname: 'John',
      lastname: 'Doe',
      email: 'john@example.com',
      phone: '0812345678',
    };
    it('should create and return a user (success)', async () => {
      userRepository.create.mockReturnValue(mockUser());
      userRepository.save.mockResolvedValue(mockUser());
      (decryption as jest.Mock).mockResolvedValue(dto.citizenId);
      const result = await service.create(dto);
      expect(userRepository.create).toHaveBeenCalledWith(expect.objectContaining({
        ...dto,
        citizenId: 'encrypted-1234567890123',
        citizenIdHash: 'hash-1234567890123',
      }));
      expect(userRepository.save).toHaveBeenCalled();
      expect(result.citizenId).toBe(dto.citizenId);
    });
    it('should throw ConflictException (DB unique violation)', async () => {
      userRepository.create.mockReturnValue(mockUser());
      userRepository.save.mockRejectedValue({ code: '23505' });
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new ConflictException(); });
      await expect(service.create(dto)).rejects.toBeInstanceOf(ConflictException);
    });
    it('should throw BadRequestException (invalid input)', async () => {
      userRepository.create.mockImplementation(() => { throw new BadRequestException(); });
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new BadRequestException(); });
      await expect(service.create({ ...dto, citizenId: '' })).rejects.toBeInstanceOf(BadRequestException);
    });
    it('should throw InternalServerErrorException (other DB error)', async () => {
      userRepository.create.mockReturnValue(mockUser());
      userRepository.save.mockRejectedValue(new Error('DB error'));
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new InternalServerErrorException(); });
      await expect(service.create(dto)).rejects.toBeInstanceOf(InternalServerErrorException);
    });
    it('should handle edge case: empty citizenId', async () => {
      userRepository.create.mockImplementation(() => { throw new BadRequestException(); });
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new BadRequestException(); });
      await expect(service.create({ ...dto, citizenId: '' })).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('findAll', () => {
    it('should return all users (success)', async () => {
      userRepository.find.mockResolvedValue([mockUser(), mockUser({ id: 'uuid-2' })]);
      const result = await service.findAll();
      expect(userRepository.find).toHaveBeenCalledWith({
        relations: {
          workHistory: {
            amphoe: true,
            localAdministrativeOrganization: true,
            workHistoryResponsibleAdmins: { amphoe: true },
            governmentAgencies: true,
          },
        },
      });
      expect(result).toHaveLength(2);
    });
    it('should throw InternalServerErrorException', async () => {
      userRepository.find.mockRejectedValue(new Error('DB error'));
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new InternalServerErrorException(); });
      await expect(service.findAll()).rejects.toBeInstanceOf(InternalServerErrorException);
    });
  });

  describe('findOne', () => {
    it('should return a user by id (success)', async () => {
      userRepository.findOne.mockResolvedValue(mockUser());
      (decryption as jest.Mock).mockResolvedValue('1234567890123');
      const result = await service.findOne('uuid-1');
      expect(userRepository.findOne).toHaveBeenCalledWith({
        where: { id: 'uuid-1' },
        relations: {
          workHistory: {
            amphoe: true,
            localAdministrativeOrganization: true,
            workHistoryResponsibleAdmins: { amphoe: true },
            governmentAgencies: true,
          },
        },
      });
      expect(result.citizenId).toBe('1234567890123');
    });
    it('should throw NotFoundException if user not found', async () => {
      userRepository.findOne.mockResolvedValue(undefined);
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new NotFoundException(); });
      await expect(service.findOne('not-exist')).rejects.toBeInstanceOf(NotFoundException);
    });
    it('should throw InternalServerErrorException', async () => {
      userRepository.findOne.mockRejectedValue(new Error('DB error'));
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new InternalServerErrorException(); });
      await expect(service.findOne('uuid-1')).rejects.toBeInstanceOf(InternalServerErrorException);
    });
    it('should handle edge case: empty id', async () => {
      userRepository.findOne.mockResolvedValue(undefined);
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new NotFoundException(); });
      await expect(service.findOne('')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('update', () => {
    const updateDto: UpdateUserDto = { firstname: 'Jane', lastname: 'Smith', citizenId: '9876543210987' };
    it('should update and return the user (success)', async () => {
      userRepository.preload.mockResolvedValue(mockUser({ firstname: 'Jane', lastname: 'Smith', citizenId: 'encrypted-9876543210987', citizenIdHash: 'hash-9876543210987' }));
      userRepository.save.mockResolvedValue(mockUser({ firstname: 'Jane', lastname: 'Smith', citizenId: 'encrypted-9876543210987', citizenIdHash: 'hash-9876543210987' }));
      (decryption as jest.Mock).mockResolvedValue('9876543210987');
      const result = await service.update('uuid-1', updateDto);
      expect(userRepository.preload).toHaveBeenCalledWith(expect.objectContaining({ id: 'uuid-1', firstname: 'Jane', lastname: 'Smith', citizenId: 'encrypted-9876543210987', citizenIdHash: 'hash-9876543210987' }));
      expect(userRepository.save).toHaveBeenCalled();
      expect(result.firstname).toBe('Jane');
      expect(result.citizenId).toBe('9876543210987');
    });
    it('should throw NotFoundException if user not found', async () => {
      userRepository.preload.mockResolvedValue(undefined);
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new NotFoundException(); });
      await expect(service.update('not-exist', updateDto)).rejects.toBeInstanceOf(NotFoundException);
    });
    it('should throw InternalServerErrorException', async () => {
      userRepository.preload.mockResolvedValue(mockUser());
      userRepository.save.mockRejectedValue(new Error('DB error'));
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new InternalServerErrorException(); });
      await expect(service.update('uuid-1', updateDto)).rejects.toBeInstanceOf(InternalServerErrorException);
    });
    it('should handle edge case: empty id', async () => {
      userRepository.preload.mockResolvedValue(undefined);
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new NotFoundException(); });
      await expect(service.update('', updateDto)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('softRemove', () => {
    it('should soft delete a user (success)', async () => {
      userRepository.softDelete.mockResolvedValue({ affected: 1 });
      const result = await service.softRemove('uuid-1');
      expect(userRepository.softDelete).toHaveBeenCalledWith('uuid-1');
      expect(result).toEqual({ message: 'User with ID uuid-1 has been soft-deleted.' });
    });
    it('should throw NotFoundException if user not found', async () => {
      userRepository.softDelete.mockResolvedValue({ affected: 0 });
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new NotFoundException(); });
      await expect(service.softRemove('not-exist')).rejects.toBeInstanceOf(NotFoundException);
    });
    it('should throw InternalServerErrorException', async () => {
      userRepository.softDelete.mockRejectedValue(new Error('DB error'));
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new InternalServerErrorException(); });
      await expect(service.softRemove('uuid-1')).rejects.toBeInstanceOf(InternalServerErrorException);
    });
    it('should handle edge case: empty id', async () => {
      userRepository.softDelete.mockResolvedValue({ affected: 0 });
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new NotFoundException(); });
      await expect(service.softRemove('')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('remove', () => {
    it('should permanently delete a user (success)', async () => {
      userRepository.delete.mockResolvedValue({ affected: 1 });
      const result = await service.remove('uuid-1');
      expect(userRepository.delete).toHaveBeenCalledWith('uuid-1');
      expect(result).toEqual({ message: 'User with ID uuid-1 has been permanently removed.' });
    });
    it('should throw NotFoundException if user not found', async () => {
      userRepository.delete.mockResolvedValue({ affected: 0 });
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new NotFoundException(); });
      await expect(service.remove('not-exist')).rejects.toBeInstanceOf(NotFoundException);
    });
    it('should throw InternalServerErrorException', async () => {
      userRepository.delete.mockRejectedValue(new Error('DB error'));
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new InternalServerErrorException(); });
      await expect(service.remove('uuid-1')).rejects.toBeInstanceOf(InternalServerErrorException);
    });
    it('should handle edge case: empty id', async () => {
      userRepository.delete.mockResolvedValue({ affected: 0 });
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new NotFoundException(); });
      await expect(service.remove('')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('restore', () => {
    it('should restore a soft-deleted user (success)', async () => {
      userRepository.restore.mockResolvedValue({ affected: 1 });
      const result = await service.restore('uuid-1');
      expect(userRepository.restore).toHaveBeenCalledWith('uuid-1');
      expect(result).toEqual({ message: 'User with ID uuid-1 has been restored.' });
    });
    it('should throw NotFoundException if user not found', async () => {
      userRepository.restore.mockResolvedValue({ affected: 0 });
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new NotFoundException(); });
      await expect(service.restore('not-exist')).rejects.toBeInstanceOf(NotFoundException);
    });
    it('should throw InternalServerErrorException', async () => {
      userRepository.restore.mockRejectedValue(new Error('DB error'));
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new InternalServerErrorException(); });
      await expect(service.restore('uuid-1')).rejects.toBeInstanceOf(InternalServerErrorException);
    });
    it('should handle edge case: empty id', async () => {
      userRepository.restore.mockResolvedValue({ affected: 0 });
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new NotFoundException(); });
      await expect(service.restore('')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});