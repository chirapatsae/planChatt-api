import { Test, TestingModule } from '@nestjs/testing';
import { BudgetPlanService } from './budget_plan.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BudgetPlan } from './entities/budget_plan.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { Repository, DataSource, QueryFailedError } from 'typeorm';
import { CreateBudgetPlanDto } from './dto/create-budget_plan.dto';
import { UpdateBudgetPlanDto } from './dto/update-budget_plan.dto';
import {
  BadRequestException,
  NotFoundException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import * as handleExceptionModule from 'src/util/handleException';

const mockBudgetPlan = (overrides: Partial<BudgetPlan> = {}): BudgetPlan => ({
  id: 'plan-uuid',
  name: 'Test Plan',
  startYear: 2020,
  endYear: 2021,
  isLatest: true,
  createAt: new Date(),
  deletedAt: new Date(),
  createdBy: {} as WorkHistory,
  projectGroup: [],
  budget: overrides.budget ?? [],
  ...overrides,
});

const mockWorkHistory = (overrides: Partial<WorkHistory> = {}): WorkHistory => ({
  id: 'work-uuid',
  user: { id: 'user-uuid' },
  workStatus: { name: 'approved' },
  budgetPlan: [],
  ...overrides,
} as any);

const mockBudgetPlanRepository = () => ({
  find: jest.fn(),
  findOne: jest.fn(),
  findOneBy: jest.fn(),
  save: jest.fn(),
  merge: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  softDelete: jest.fn(),
  restore: jest.fn(),
  create: jest.fn(),
});
const mockWorkHistoryRepository = () => ({
  findOne: jest.fn(),
});
const mockDataSource = () => ({
  transaction: jest.fn(),
});

describe('BudgetPlanService', () => {
  let service: BudgetPlanService;
  let budgetPlanRepository: ReturnType<typeof mockBudgetPlanRepository>;
  let workHistoryRepository: ReturnType<typeof mockWorkHistoryRepository>;
  let dataSource: ReturnType<typeof mockDataSource>;
  let handleExceptionSpy: jest.SpyInstance;

  beforeEach(async () => {
    jest.clearAllMocks();
    budgetPlanRepository = mockBudgetPlanRepository();
    workHistoryRepository = mockWorkHistoryRepository();
    dataSource = mockDataSource();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BudgetPlanService,
        { provide: getRepositoryToken(BudgetPlan), useValue: budgetPlanRepository },
        { provide: getRepositoryToken(WorkHistory), useValue: workHistoryRepository },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();
    service = module.get<BudgetPlanService>(BudgetPlanService);
  });

  afterEach(() => {
    if (handleExceptionSpy) handleExceptionSpy.mockRestore();
  });

  describe('create', () => {
    const dto: CreateBudgetPlanDto = { name: 'Test Plan', startYear: 2565, endYear: 2566 };
    const userId = 'user-uuid';
    it('should create and return a budget plan (success)', async () => {
      workHistoryRepository.findOne.mockResolvedValue(mockWorkHistory());
      const manager = {
        find: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue(undefined),
        create: jest.fn().mockReturnValue(mockBudgetPlan()),
        save: jest.fn().mockResolvedValue(mockBudgetPlan()),
      };
      dataSource.transaction.mockImplementation(async (cb) => cb(manager));
      const result = await service.create(dto, userId);
      expect(result).toMatchObject({
        ...mockBudgetPlan(),
        createAt: expect.any(Date),
        deletedAt: expect.any(Date),
      });
      expect(result.createAt).toBeInstanceOf(Date);
      expect(manager.save).toHaveBeenCalled();
    });
    it('should throw NotFoundException if work history not found', async () => {
      workHistoryRepository.findOne.mockResolvedValue(undefined);
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new NotFoundException(); });
      await expect(service.create(dto, userId)).rejects.toBeInstanceOf(NotFoundException);
    });
    it('should throw BadRequestException if startYear >= endYear', async () => {
      workHistoryRepository.findOne.mockResolvedValue(mockWorkHistory());
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new BadRequestException(); });
      await expect(service.create({ ...dto, startYear: 2567, endYear: 2566 }, userId)).rejects.toBeInstanceOf(BadRequestException);
    });
    it('should throw BadRequestException if exact duplicate exists', async () => {
      workHistoryRepository.findOne.mockResolvedValue(mockWorkHistory());
      const manager = {
        find: jest.fn().mockResolvedValue([mockBudgetPlan({ startYear: 2565, endYear: 2566 })]),
        update: jest.fn(),
        create: jest.fn(),
        save: jest.fn(),
      };
      dataSource.transaction.mockImplementation(async (cb) => cb(manager));
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new BadRequestException(); });
      await expect(service.create(dto, userId)).rejects.toBeInstanceOf(BadRequestException);
    });
    it('should throw BadRequestException if overlapping exists', async () => {
      workHistoryRepository.findOne.mockResolvedValue(mockWorkHistory());
      const manager = {
        find: jest.fn().mockResolvedValue([mockBudgetPlan({ startYear: 2564, endYear: 2566 })]),
        update: jest.fn(),
        create: jest.fn(),
        save: jest.fn(),
      };
      dataSource.transaction.mockImplementation(async (cb) => cb(manager));
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new BadRequestException(); });
      await expect(service.create(dto, userId)).rejects.toBeInstanceOf(BadRequestException);
    });
    it('should throw InternalServerErrorException on DB error', async () => {
      workHistoryRepository.findOne.mockRejectedValue(new Error('DB error'));
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new InternalServerErrorException(); });
      await expect(service.create(dto, userId)).rejects.toBeInstanceOf(InternalServerErrorException);
    });
    it('should handle edge case: empty userId', async () => {
      workHistoryRepository.findOne.mockResolvedValue(undefined);
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new NotFoundException(); });
      await expect(service.create(dto, '')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('findAll', () => {
    it('should return all budget plans (success)', async () => {
      budgetPlanRepository.find.mockResolvedValue([mockBudgetPlan(), mockBudgetPlan({ id: 'plan-2' })]);
      const result = await service.findAll();
      expect(budgetPlanRepository.find).toHaveBeenCalledWith({ relations: ['createdBy'], order: { createAt: 'DESC' } });
      expect(result).toHaveLength(2);
    });
    it('should throw InternalServerErrorException', async () => {
      budgetPlanRepository.find.mockRejectedValue(new Error('DB error'));
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new InternalServerErrorException(); });
      await expect(service.findAll()).rejects.toBeInstanceOf(InternalServerErrorException);
    });
  });

  describe('findOne', () => {
    it('should return a budget plan by id (success)', async () => {
      budgetPlanRepository.findOne.mockResolvedValue(mockBudgetPlan());
      const result = await service.findOne('plan-uuid');
      expect(budgetPlanRepository.findOne).toHaveBeenCalledWith({ where: { id: 'plan-uuid' }, relations: ['projectGroup', 'workHistory'] });
      expect(result).toMatchObject({
        ...mockBudgetPlan(),
        createAt: expect.any(Date),
        deletedAt: expect.any(Date),
      });
      expect(result.createAt).toBeInstanceOf(Date);
    });
    it('should throw NotFoundException if not found', async () => {
      budgetPlanRepository.findOne.mockResolvedValue(undefined);
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new NotFoundException(); });
      await expect(service.findOne('not-exist')).rejects.toBeInstanceOf(NotFoundException);
    });
    it('should throw InternalServerErrorException', async () => {
      budgetPlanRepository.findOne.mockRejectedValue(new Error('DB error'));
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new InternalServerErrorException(); });
      await expect(service.findOne('plan-uuid')).rejects.toBeInstanceOf(InternalServerErrorException);
    });
    it('should handle edge case: empty id', async () => {
      budgetPlanRepository.findOne.mockResolvedValue(undefined);
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new NotFoundException(); });
      await expect(service.findOne('')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('update', () => {
    const updateDto: UpdateBudgetPlanDto = { name: 'Updated', startYear: 2565, endYear: 2567 };
    it('should update and return the budget plan (success)', async () => {
      budgetPlanRepository.findOneBy.mockResolvedValue(mockBudgetPlan());
      budgetPlanRepository.find.mockResolvedValue([]);
      budgetPlanRepository.merge.mockReturnValue(mockBudgetPlan({ ...updateDto }));
      budgetPlanRepository.save.mockResolvedValue(mockBudgetPlan({ ...updateDto }));
      const result = await service.update('plan-uuid', updateDto);
      expect(result).toEqual({
        ...mockBudgetPlan({ ...updateDto }),
        createAt: expect.any(Date),
        deletedAt: expect.any(Date),
      });
    });
    it('should throw NotFoundException if not found', async () => {
      budgetPlanRepository.findOneBy.mockResolvedValue(undefined);
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new NotFoundException(); });
      await expect(service.update('not-exist', updateDto)).rejects.toBeInstanceOf(NotFoundException);
    });
    it('should throw BadRequestException if not latest', async () => {
      budgetPlanRepository.findOneBy.mockResolvedValue(mockBudgetPlan({ isLatest: false }));
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new BadRequestException(); });
      await expect(service.update('plan-uuid', updateDto)).rejects.toBeInstanceOf(BadRequestException);
    });
    it('should throw BadRequestException if startYear >= endYear', async () => {
      budgetPlanRepository.findOneBy.mockResolvedValue(mockBudgetPlan());
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new BadRequestException(); });
      await expect(service.update('plan-uuid', { ...updateDto, startYear: 2568, endYear: 2567 })).rejects.toBeInstanceOf(BadRequestException);
    });
    it('should throw BadRequestException if exact duplicate exists', async () => {
      budgetPlanRepository.findOneBy.mockResolvedValue(mockBudgetPlan());
      budgetPlanRepository.find.mockResolvedValue([mockBudgetPlan({ startYear: 2565, endYear: 2567 })]);
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new BadRequestException(); });
      await expect(service.update('plan-uuid', updateDto)).rejects.toBeInstanceOf(BadRequestException);
    });
    it('should throw BadRequestException if overlapping exists', async () => {
      budgetPlanRepository.findOneBy.mockResolvedValue(mockBudgetPlan());
      budgetPlanRepository.find.mockResolvedValue([mockBudgetPlan({ startYear: 2564, endYear: 2567 })]);
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new BadRequestException(); });
      await expect(service.update('plan-uuid', updateDto)).rejects.toBeInstanceOf(BadRequestException);
    });
    it('should throw InternalServerErrorException on DB error', async () => {
      budgetPlanRepository.findOneBy.mockResolvedValue(mockBudgetPlan());
      budgetPlanRepository.save.mockRejectedValue(new Error('DB error'));
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new InternalServerErrorException(); });
      await expect(service.update('plan-uuid', updateDto)).rejects.toBeInstanceOf(InternalServerErrorException);
    });
    it('should handle edge case: empty id', async () => {
      budgetPlanRepository.findOneBy.mockResolvedValue(undefined);
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new NotFoundException(); });
      await expect(service.update('', updateDto)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('remove', () => {
    it('should permanently delete a budget plan (success)', async () => {
      budgetPlanRepository.delete.mockResolvedValue({ affected: 1 });
      const result = await service.remove('plan-uuid');
      expect(budgetPlanRepository.delete).toHaveBeenCalledWith('plan-uuid');
      expect(result).toEqual({ message: 'Amphoe with ID plan-uuid has been permanently removed.' });
    });
    it('should throw NotFoundException if not found', async () => {
      budgetPlanRepository.delete.mockResolvedValue({ affected: 0 });
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new NotFoundException(); });
      await expect(service.remove('not-exist')).rejects.toBeInstanceOf(NotFoundException);
    });
    it('should throw InternalServerErrorException on DB error', async () => {
      budgetPlanRepository.delete.mockRejectedValue(new Error('DB error'));
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new InternalServerErrorException(); });
      await expect(service.remove('plan-uuid')).rejects.toBeInstanceOf(InternalServerErrorException);
    });
    it('should handle edge case: empty id', async () => {
      budgetPlanRepository.delete.mockResolvedValue({ affected: 0 });
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new NotFoundException(); });
      await expect(service.remove('')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('softRemove', () => {
    it('should soft delete a budget plan (success)', async () => {
      budgetPlanRepository.softDelete.mockResolvedValue({ affected: 1 });
      const result = await service.softRemove('plan-uuid');
      expect(budgetPlanRepository.softDelete).toHaveBeenCalledWith('plan-uuid');
      expect(result).toEqual({ message: 'Amphoe with ID plan-uuid has been soft-removed.' });
    });
    it('should throw NotFoundException if not found', async () => {
      budgetPlanRepository.softDelete.mockResolvedValue({ affected: 0 });
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new NotFoundException(); });
      await expect(service.softRemove('not-exist')).rejects.toBeInstanceOf(NotFoundException);
    });
    it('should throw InternalServerErrorException on DB error', async () => {
      budgetPlanRepository.softDelete.mockRejectedValue(new Error('DB error'));
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new InternalServerErrorException(); });
      await expect(service.softRemove('plan-uuid')).rejects.toBeInstanceOf(InternalServerErrorException);
    });
    it('should handle edge case: empty id', async () => {
      budgetPlanRepository.softDelete.mockResolvedValue({ affected: 0 });
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new NotFoundException(); });
      await expect(service.softRemove('')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('restore', () => {
    it('should restore a soft-deleted budget plan (success)', async () => {
      budgetPlanRepository.restore.mockResolvedValue({ affected: 1 });
      const result = await service.restore('plan-uuid');
      expect(budgetPlanRepository.restore).toHaveBeenCalledWith('plan-uuid');
      expect(result).toEqual({ message: 'Amphoe with ID plan-uuid has been restored.' });
    });
    it('should throw NotFoundException if not found or not deleted', async () => {
      budgetPlanRepository.restore.mockResolvedValue({ affected: 0 });
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new NotFoundException(); });
      await expect(service.restore('not-exist')).rejects.toBeInstanceOf(NotFoundException);
    });
    it('should throw InternalServerErrorException on DB error', async () => {
      budgetPlanRepository.restore.mockRejectedValue(new Error('DB error'));
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new InternalServerErrorException(); });
      await expect(service.restore('plan-uuid')).rejects.toBeInstanceOf(InternalServerErrorException);
    });
    it('should handle edge case: empty id', async () => {
      budgetPlanRepository.restore.mockResolvedValue({ affected: 0 });
      handleExceptionSpy = jest.spyOn(handleExceptionModule, 'handleException').mockImplementation(() => { throw new NotFoundException(); });
      await expect(service.restore('')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
