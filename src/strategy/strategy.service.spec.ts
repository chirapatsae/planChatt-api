import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { StrategyService } from './strategy.service';
import { Strategy } from './entities/strategy.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { CreateStrategyDto } from './dto/create-strategy.dto';
import { UpdateStrategyDto } from './dto/update-strategy.dto';
import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import * as handleExceptionModule from 'src/util/handleException';

const mockStrategy = (overrides: Partial<Strategy> = {}): Strategy => ({
  id: 'S001',
  name: 'Strategy Test',
  tactic: [],
  projectGroup: [],
  createdAt: new Date('2025-01-01T00:00:00.000Z'),
  createdBy: { id: 'user-1' } as WorkHistory,
  ...overrides,
} as Strategy);

const mockWorkHistory = (overrides: Partial<WorkHistory> = {}): WorkHistory => ({
  id: 'user-1',
  ...overrides,
} as WorkHistory);

const mockStrategyRepository = () => ({
  create: jest.fn(),
  save: jest.fn(),
  find: jest.fn(),
  findOne: jest.fn(),
  preload: jest.fn(),
  delete: jest.fn(),
  softRemove: jest.fn(),
  restore: jest.fn(),
});
const mockWorkHistoryRepository = () => ({
  findOne: jest.fn(),
});

describe('StrategyService', () => {
  let service: StrategyService;
  let strategyRepository: ReturnType<typeof mockStrategyRepository>;
  let workHistoryRepository: ReturnType<typeof mockWorkHistoryRepository>;
  let handleExceptionSpy: jest.SpyInstance;

  beforeEach(async () => {
    jest.clearAllMocks();
    strategyRepository = mockStrategyRepository();
    workHistoryRepository = mockWorkHistoryRepository();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StrategyService,
        {
          provide: getRepositoryToken(Strategy),
          useValue: strategyRepository,
        },
        {
          provide: getRepositoryToken(WorkHistory),
          useValue: workHistoryRepository,
        },
      ],
    }).compile();
    service = module.get<StrategyService>(StrategyService);
  });

  afterEach(() => {
    if (handleExceptionSpy) handleExceptionSpy.mockRestore();
  });

  describe('create', () => {
    const dto: CreateStrategyDto = { stratId: 'S001', name: 'Strategy Test' };
    const userId = 'user-1';
    it('should create and return a strategy (success)', async () => {
      workHistoryRepository.findOne.mockResolvedValue(mockWorkHistory());
      strategyRepository.create.mockReturnValue(mockStrategy());
      strategyRepository.save.mockResolvedValue(mockStrategy());
      const result = await service.create(dto, userId);
      expect(workHistoryRepository.findOne).toHaveBeenCalledWith({ where: { id: userId } });
      expect(strategyRepository.create).toHaveBeenCalledWith({ id: dto.stratId, name: dto.name, createdBy: expect.any(Object) });
      expect(strategyRepository.save).toHaveBeenCalled();
      expect(result).toEqual(mockStrategy());
    });
    it('should throw UnauthorizedException if work history not found', async () => {
      workHistoryRepository.findOne.mockResolvedValue(undefined);
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new UnauthorizedException(); });
      await expect(service.create(dto, userId)).rejects.toBeInstanceOf(UnauthorizedException);
    });
    it('should throw ConflictException (DB unique violation)', async () => {
      workHistoryRepository.findOne.mockResolvedValue(mockWorkHistory());
      strategyRepository.create.mockReturnValue(mockStrategy());
      strategyRepository.save.mockRejectedValue({ code: '23505' });
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new ConflictException(); });
      await expect(service.create(dto, userId)).rejects.toBeInstanceOf(ConflictException);
    });
    it('should throw BadRequestException (invalid input)', async () => {
      workHistoryRepository.findOne.mockResolvedValue(mockWorkHistory());
      strategyRepository.create.mockImplementation(() => { throw new BadRequestException(); });
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new BadRequestException(); });
      await expect(service.create({ ...dto, stratId: '' }, userId)).rejects.toBeInstanceOf(BadRequestException);
    });
    it('should throw InternalServerErrorException (other DB error)', async () => {
      workHistoryRepository.findOne.mockResolvedValue(mockWorkHistory());
      strategyRepository.create.mockReturnValue(mockStrategy());
      strategyRepository.save.mockRejectedValue(new Error('DB error'));
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new InternalServerErrorException(); });
      await expect(service.create(dto, userId)).rejects.toBeInstanceOf(InternalServerErrorException);
    });
    it('should handle edge case: empty stratId', async () => {
      workHistoryRepository.findOne.mockResolvedValue(mockWorkHistory());
      strategyRepository.create.mockImplementation(() => { throw new BadRequestException(); });
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new BadRequestException(); });
      await expect(service.create({ ...dto, stratId: '' }, userId)).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('findAll', () => {
    it('should return all strategies (success)', async () => {
      strategyRepository.find.mockResolvedValue([mockStrategy(), mockStrategy({ id: 'S002' })]);
      const result = await service.findAll();
      expect(strategyRepository.find).toHaveBeenCalledWith({ where: { deletedAt: undefined }, relations: ['tactic', 'createdBy', 'deletedBy'] });
      expect(result).toHaveLength(2);
    });
    it('should throw InternalServerErrorException', async () => {
      strategyRepository.find.mockRejectedValue(new Error('DB error'));
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new InternalServerErrorException(); });
      await expect(service.findAll()).rejects.toBeInstanceOf(InternalServerErrorException);
    });
  });

  describe('findOne', () => {
    it('should return a strategy by id (success)', async () => {
      strategyRepository.findOne.mockResolvedValue(mockStrategy());
      const result = await service.findOne('S001');
      expect(strategyRepository.findOne).toHaveBeenCalledWith({ where: { id: 'S001' }, relations: ['tactic', 'createdBy', 'deletedBy'] });
      expect(result).toEqual(mockStrategy());
    });
    it('should throw NotFoundException if strategy not found', async () => {
      strategyRepository.findOne.mockResolvedValue(undefined);
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new NotFoundException(); });
      await expect(service.findOne('not-exist')).rejects.toBeInstanceOf(NotFoundException);
    });
    it('should throw InternalServerErrorException', async () => {
      strategyRepository.findOne.mockRejectedValue(new Error('DB error'));
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new InternalServerErrorException(); });
      await expect(service.findOne('S001')).rejects.toBeInstanceOf(InternalServerErrorException);
    });
    it('should handle edge case: empty id', async () => {
      strategyRepository.findOne.mockResolvedValue(undefined);
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new NotFoundException(); });
      await expect(service.findOne('')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('update', () => {
    const updateDto: UpdateStrategyDto = { name: 'Updated Strategy' };
    it('should update and return the strategy (success)', async () => {
      strategyRepository.preload.mockResolvedValue(mockStrategy({ name: 'Updated Strategy' }));
      strategyRepository.save.mockResolvedValue(mockStrategy({ name: 'Updated Strategy' }));
      const result = await service.update('S001', updateDto);
      expect(strategyRepository.preload).toHaveBeenCalledWith({ id: 'S001', ...updateDto });
      expect(strategyRepository.save).toHaveBeenCalled();
      expect(result.name).toBe('Updated Strategy');
    });
    it('should throw NotFoundException if strategy not found', async () => {
      strategyRepository.preload.mockResolvedValue(undefined);
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new NotFoundException(); });
      await expect(service.update('not-exist', updateDto)).rejects.toBeInstanceOf(NotFoundException);
    });
    it('should throw InternalServerErrorException', async () => {
      strategyRepository.preload.mockResolvedValue(mockStrategy());
      strategyRepository.save.mockRejectedValue(new Error('DB error'));
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new InternalServerErrorException(); });
      await expect(service.update('S001', updateDto)).rejects.toBeInstanceOf(InternalServerErrorException);
    });
    it('should handle edge case: empty id', async () => {
      strategyRepository.preload.mockResolvedValue(undefined);
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new NotFoundException(); });
      await expect(service.update('', updateDto)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('remove', () => {
    it('should permanently delete a strategy (success)', async () => {
      strategyRepository.delete.mockResolvedValue({ affected: 1 });
      const result = await service.remove('S001');
      expect(strategyRepository.delete).toHaveBeenCalledWith('S001');
      expect(result).toEqual({ message: 'Strategy with ID S001 has been permanently removed.' });
    });
    it('should throw NotFoundException if strategy not found', async () => {
      strategyRepository.delete.mockResolvedValue({ affected: 0 });
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new NotFoundException(); });
      await expect(service.remove('not-exist')).rejects.toBeInstanceOf(NotFoundException);
    });
    it('should throw InternalServerErrorException', async () => {
      strategyRepository.delete.mockRejectedValue(new Error('DB error'));
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new InternalServerErrorException(); });
      await expect(service.remove('S001')).rejects.toBeInstanceOf(InternalServerErrorException);
    });
    it('should handle edge case: empty id', async () => {
      strategyRepository.delete.mockResolvedValue({ affected: 0 });
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new NotFoundException(); });
      await expect(service.remove('')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('softRemove', () => {
    const userId = 'user-1';
    it('should soft delete a strategy (success)', async () => {
      workHistoryRepository.findOne.mockResolvedValueOnce(mockWorkHistory());
      strategyRepository.findOne.mockResolvedValueOnce(mockStrategy());
      strategyRepository.save.mockResolvedValueOnce(mockStrategy());
      strategyRepository.softRemove.mockResolvedValueOnce(mockStrategy());
      const result = await service.softRemove('S001', userId);
      expect(workHistoryRepository.findOne).toHaveBeenCalledWith({ where: { id: userId } });
      expect(strategyRepository.findOne).toHaveBeenCalledWith({ where: { id: 'S001' } });
      expect(strategyRepository.save).toHaveBeenCalled();
      expect(strategyRepository.softRemove).toHaveBeenCalled();
      expect(result).toEqual({ message: 'Strategy with ID S001 has been soft-removed.' });
    });
    it('should throw UnauthorizedException if work history not found', async () => {
      workHistoryRepository.findOne.mockResolvedValueOnce(undefined);
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new UnauthorizedException(); });
      await expect(service.softRemove('S001', userId)).rejects.toBeInstanceOf(UnauthorizedException);
    });
    it('should throw NotFoundException if strategy not found', async () => {
      workHistoryRepository.findOne.mockResolvedValueOnce(mockWorkHistory());
      strategyRepository.findOne.mockResolvedValueOnce(undefined);
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new NotFoundException(); });
      await expect(service.softRemove('not-exist', userId)).rejects.toBeInstanceOf(NotFoundException);
    });
    it('should throw InternalServerErrorException', async () => {
      workHistoryRepository.findOne.mockResolvedValueOnce(mockWorkHistory());
      strategyRepository.findOne.mockResolvedValueOnce(mockStrategy());
      strategyRepository.save.mockResolvedValueOnce(mockStrategy());
      strategyRepository.softRemove.mockRejectedValueOnce(new Error('DB error'));
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new InternalServerErrorException(); });
      await expect(service.softRemove('S001', userId)).rejects.toBeInstanceOf(InternalServerErrorException);
    });
    it('should handle edge case: empty id', async () => {
      workHistoryRepository.findOne.mockResolvedValueOnce(mockWorkHistory());
      strategyRepository.findOne.mockResolvedValueOnce(undefined);
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new NotFoundException(); });
      await expect(service.softRemove('', userId)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('restore', () => {
    it('should restore a soft-deleted strategy (success)', async () => {
      strategyRepository.restore.mockResolvedValue({ affected: 1 });
      const result = await service.restore('S001');
      expect(strategyRepository.restore).toHaveBeenCalledWith('S001');
      expect(result).toEqual({ message: 'Strategy with ID S001 has been restored.' });
    });
    it('should throw NotFoundException if strategy not found', async () => {
      strategyRepository.restore.mockResolvedValue({ affected: 0 });
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new NotFoundException(); });
      await expect(service.restore('not-exist')).rejects.toBeInstanceOf(NotFoundException);
    });
    it('should throw InternalServerErrorException', async () => {
      strategyRepository.restore.mockRejectedValue(new Error('DB error'));
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new InternalServerErrorException(); });
      await expect(service.restore('S001')).rejects.toBeInstanceOf(InternalServerErrorException);
    });
    it('should handle edge case: empty id', async () => {
      strategyRepository.restore.mockResolvedValue({ affected: 0 });
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new NotFoundException(); });
      await expect(service.restore('')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
