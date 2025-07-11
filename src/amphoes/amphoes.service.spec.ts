import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AmphoesService } from './amphoes.service';
import { Amphoe } from './entities/amphoe.entity';
import { CreateAmphoeDto } from './dto/create-amphoe.dto';
import { UpdateAmphoeDto } from './dto/update-amphoe.dto';
import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import * as handleExceptionModule from 'src/util/handleException';

const FIXED_DATE = new Date('2025-01-01T00:00:00.000Z');
const mockAmphoe = (overrides: Partial<Amphoe> = {}): Amphoe => ({
  id: 'A001',
  name: 'Amphoe Test',
  createAt: FIXED_DATE,
  deletedAt: undefined,
  workHistory: [],
  localAdministrativeOrganization: [],
  workHistoryResponsibleAdmins: [],
  ...overrides,
});

const mockAmphoeRepository = () => ({
  create: jest.fn(),
  save: jest.fn(),
  find: jest.fn(),
  findOne: jest.fn(),
  preload: jest.fn(),
  delete: jest.fn(),
  softDelete: jest.fn(),
  restore: jest.fn(),
});

describe('AmphoesService', () => {
  let service: AmphoesService;
  let amphoeRepository: ReturnType<typeof mockAmphoeRepository>;
  let handleExceptionSpy: jest.SpyInstance;

  beforeEach(async () => {
    jest.clearAllMocks();
    amphoeRepository = mockAmphoeRepository();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AmphoesService,
        {
          provide: getRepositoryToken(Amphoe),
          useValue: amphoeRepository,
        },
      ],
    }).compile();
    service = module.get<AmphoesService>(AmphoesService);
  });

  afterEach(() => {
    if (handleExceptionSpy) handleExceptionSpy.mockRestore();
  });

  describe('create', () => {
    const dto: CreateAmphoeDto = { code: 'A001', name: 'Amphoe Test' };
    it('should create and return an amphoe (success)', async () => {
      amphoeRepository.create.mockReturnValue(mockAmphoe());
      amphoeRepository.save.mockResolvedValue(mockAmphoe());
      const result = await service.create(dto);
      expect(amphoeRepository.create).toHaveBeenCalledWith({ id: dto.code, name: dto.name });
      expect(amphoeRepository.save).toHaveBeenCalled();
      expect(result).toEqual(mockAmphoe());
    });
    it('should throw ConflictException (DB unique violation)', async () => {
      amphoeRepository.create.mockReturnValue(mockAmphoe());
      amphoeRepository.save.mockRejectedValue({ code: '23505' });
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new ConflictException(); });
      await expect(service.create(dto)).rejects.toBeInstanceOf(ConflictException);
    });
    it('should throw BadRequestException (invalid input)', async () => {
      amphoeRepository.create.mockImplementation(() => { throw new BadRequestException(); });
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new BadRequestException(); });
      await expect(service.create({ ...dto, code: '' })).rejects.toBeInstanceOf(BadRequestException);
    });
    it('should throw InternalServerErrorException (other DB error)', async () => {
      amphoeRepository.create.mockReturnValue(mockAmphoe());
      amphoeRepository.save.mockRejectedValue(new Error('DB error'));
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new InternalServerErrorException(); });
      await expect(service.create(dto)).rejects.toBeInstanceOf(InternalServerErrorException);
    });
    it('should handle edge case: empty code', async () => {
      amphoeRepository.create.mockImplementation(() => { throw new BadRequestException(); });
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new BadRequestException(); });
      await expect(service.create({ ...dto, code: '' })).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('findAll', () => {
    it('should return all amphoes (success)', async () => {
      amphoeRepository.find.mockResolvedValue([mockAmphoe(), mockAmphoe({ id: 'A002' })]);
      const result = await service.findAll();
      expect(amphoeRepository.find).toHaveBeenCalledWith({ where: { deletedAt: undefined }, relations: ['localAdministrativeOrganization'] });
      expect(result).toHaveLength(2);
    });
    it('should throw InternalServerErrorException', async () => {
      amphoeRepository.find.mockRejectedValue(new Error('DB error'));
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new InternalServerErrorException(); });
      await expect(service.findAll()).rejects.toBeInstanceOf(InternalServerErrorException);
    });
  });

  describe('findOne', () => {
    it('should return an amphoe by id (success)', async () => {
      amphoeRepository.findOne.mockResolvedValue(mockAmphoe());
      const result = await service.findOne('A001');
      expect(amphoeRepository.findOne).toHaveBeenCalledWith({ where: { id: 'A001' }, relations: ['localAdministrativeOrganization'] });
      expect(result).toEqual(mockAmphoe());
    });
    it('should throw NotFoundException if amphoe not found', async () => {
      amphoeRepository.findOne.mockResolvedValue(undefined);
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new NotFoundException(); });
      await expect(service.findOne('not-exist')).rejects.toBeInstanceOf(NotFoundException);
    });
    it('should throw InternalServerErrorException', async () => {
      amphoeRepository.findOne.mockRejectedValue(new Error('DB error'));
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new InternalServerErrorException(); });
      await expect(service.findOne('A001')).rejects.toBeInstanceOf(InternalServerErrorException);
    });
    it('should handle edge case: empty id', async () => {
      amphoeRepository.findOne.mockResolvedValue(undefined);
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new NotFoundException(); });
      await expect(service.findOne('')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('update', () => {
    const updateDto: UpdateAmphoeDto = { name: 'Updated Amphoe' };
    it('should update and return the amphoe (success)', async () => {
      amphoeRepository.preload.mockResolvedValue(mockAmphoe({ name: 'Updated Amphoe' }));
      amphoeRepository.save.mockResolvedValue(mockAmphoe({ name: 'Updated Amphoe' }));
      const result = await service.update('A001', updateDto);
      expect(amphoeRepository.preload).toHaveBeenCalledWith({ id: 'A001', ...updateDto });
      expect(amphoeRepository.save).toHaveBeenCalled();
      expect(result.name).toBe('Updated Amphoe');
    });
    it('should throw NotFoundException if amphoe not found', async () => {
      amphoeRepository.preload.mockResolvedValue(undefined);
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new NotFoundException(); });
      await expect(service.update('not-exist', updateDto)).rejects.toBeInstanceOf(NotFoundException);
    });
    it('should throw InternalServerErrorException', async () => {
      amphoeRepository.preload.mockResolvedValue(mockAmphoe());
      amphoeRepository.save.mockRejectedValue(new Error('DB error'));
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new InternalServerErrorException(); });
      await expect(service.update('A001', updateDto)).rejects.toBeInstanceOf(InternalServerErrorException);
    });
    it('should handle edge case: empty id', async () => {
      amphoeRepository.preload.mockResolvedValue(undefined);
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new NotFoundException(); });
      await expect(service.update('', updateDto)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('remove', () => {
    it('should permanently delete an amphoe (success)', async () => {
      amphoeRepository.delete.mockResolvedValue({ affected: 1 });
      const result = await service.remove('A001');
      expect(amphoeRepository.delete).toHaveBeenCalledWith('A001');
      expect(result).toEqual({ message: 'Amphoe with ID A001 has been permanently removed.' });
    });
    it('should throw NotFoundException if amphoe not found', async () => {
      amphoeRepository.delete.mockResolvedValue({ affected: 0 });
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new NotFoundException(); });
      await expect(service.remove('not-exist')).rejects.toBeInstanceOf(NotFoundException);
    });
    it('should throw InternalServerErrorException', async () => {
      amphoeRepository.delete.mockRejectedValue(new Error('DB error'));
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new InternalServerErrorException(); });
      await expect(service.remove('A001')).rejects.toBeInstanceOf(InternalServerErrorException);
    });
    it('should handle edge case: empty id', async () => {
      amphoeRepository.delete.mockResolvedValue({ affected: 0 });
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new NotFoundException(); });
      await expect(service.remove('')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('softRemove', () => {
    it('should soft delete an amphoe (success)', async () => {
      amphoeRepository.softDelete.mockResolvedValue({ affected: 1 });
      const result = await service.softRemove('A001');
      expect(amphoeRepository.softDelete).toHaveBeenCalledWith('A001');
      expect(result).toEqual({ message: 'Amphoe with ID A001 has been soft-removed.' });
    });
    it('should throw NotFoundException if amphoe not found', async () => {
      amphoeRepository.softDelete.mockResolvedValue({ affected: 0 });
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new NotFoundException(); });
      await expect(service.softRemove('not-exist')).rejects.toBeInstanceOf(NotFoundException);
    });
    it('should throw InternalServerErrorException', async () => {
      amphoeRepository.softDelete.mockRejectedValue(new Error('DB error'));
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new InternalServerErrorException(); });
      await expect(service.softRemove('A001')).rejects.toBeInstanceOf(InternalServerErrorException);
    });
    it('should handle edge case: empty id', async () => {
      amphoeRepository.softDelete.mockResolvedValue({ affected: 0 });
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new NotFoundException(); });
      await expect(service.softRemove('')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('restore', () => {
    it('should restore a soft-deleted amphoe (success)', async () => {
      amphoeRepository.restore.mockResolvedValue({ affected: 1 });
      const result = await service.restore('A001');
      expect(amphoeRepository.restore).toHaveBeenCalledWith('A001');
      expect(result).toEqual({ message: 'Amphoe with ID A001 has been restored.' });
    });
    it('should throw NotFoundException if amphoe not found', async () => {
      amphoeRepository.restore.mockResolvedValue({ affected: 0 });
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new NotFoundException(); });
      await expect(service.restore('not-exist')).rejects.toBeInstanceOf(NotFoundException);
    });
    it('should throw InternalServerErrorException', async () => {
      amphoeRepository.restore.mockRejectedValue(new Error('DB error'));
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new InternalServerErrorException(); });
      await expect(service.restore('A001')).rejects.toBeInstanceOf(InternalServerErrorException);
    });
    it('should handle edge case: empty id', async () => {
      amphoeRepository.restore.mockResolvedValue({ affected: 0 });
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new NotFoundException(); });
      await expect(service.restore('')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
