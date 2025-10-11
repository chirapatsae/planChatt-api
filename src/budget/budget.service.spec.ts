import { Test, TestingModule } from '@nestjs/testing';
import { BudgetService } from './budget.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Budget } from './entities/budget.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { Repository } from 'typeorm';
import {
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { CreateBudgetDto } from './dto/create-budget.dto';
import { UpdateBudgetDto } from './dto/update-budget.dto';
import * as handleExceptionModule from 'src/util/handleException';

// Utility to mock repository methods
const mockRepo = () => ({
  findOne: jest.fn(),
  find: jest.fn(),
  create: jest.fn(),
  save: jest.fn(),
  preload: jest.fn(),
  delete: jest.fn(),
  softDelete: jest.fn(),
  restore: jest.fn(),
});

describe('BudgetService', () => {
  let service: BudgetService;
  let budgetRepo: jest.Mocked<Repository<Budget>>;
  let projectGroupRepo: jest.Mocked<Repository<ProjectGroup>>;
  let handleExceptionSpy: jest.SpyInstance;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BudgetService,
        { provide: getRepositoryToken(Budget), useValue: mockRepo() },
        { provide: getRepositoryToken(ProjectGroup), useValue: mockRepo() },
      ],
    }).compile();

    service = module.get<BudgetService>(BudgetService);
    budgetRepo = module.get(getRepositoryToken(Budget));
    projectGroupRepo = module.get(getRepositoryToken(ProjectGroup));
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
    if (handleExceptionSpy) handleExceptionSpy.mockRestore();
  });

  describe('create', () => {
    const dto: CreateBudgetDto = {
      projectGroupId: 'group-uuid',
      year: 2024,
      quantity: 1000,
    };
    const plan = { id: 'plan-uuid', startYear: 2020, endYear: 2025 };
    const projectGroup = { id: 'group-uuid', budgetPlan: plan };
    const createdBudget = {
      id: 'budget-uuid',
      ...dto,
      projectGroupId: { id: dto.projectGroupId },
    };

    it('should create and return a budget (success)', async () => {
      projectGroupRepo.findOne.mockResolvedValue(projectGroup as any);
      budgetRepo.create.mockReturnValue(createdBudget as any);
      budgetRepo.save.mockResolvedValue(createdBudget as any);
      const result = await service.create(dto);
      expect(result).toEqual(createdBudget);
      expect(projectGroupRepo.findOne).toHaveBeenCalledWith({
        where: { id: dto.projectGroupId },
      });
      expect(budgetRepo.create).toHaveBeenCalled();
      expect(budgetRepo.save).toHaveBeenCalledWith(createdBudget);
    });

    it('should throw NotFoundException if project group not found', async () => {
      projectGroupRepo.findOne.mockResolvedValue(null as any);
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new NotFoundException();
        });
      await expect(service.create(dto)).rejects.toThrow(NotFoundException);
    });


    it('should throw InternalServerErrorException on DB error', async () => {
      projectGroupRepo.findOne.mockRejectedValue(new Error('DB error'));
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new InternalServerErrorException();
        });
      await expect(service.create(dto)).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('should handle edge cases (empty/invalid input)', async () => {
      projectGroupRepo.findOne.mockResolvedValue(null as any);
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new NotFoundException();
        });
      await expect(
        service.create({ ...dto, projectGroupId: '' }),
      ).rejects.toThrow(NotFoundException);
      await expect(service.create({ ...dto, year: 0 })).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.create({ ...dto, year: -1 })).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('findAll', () => {
    beforeEach(() => {
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new InternalServerErrorException();
        });
    });
    it('should return all budgets (success)', async () => {
      const budgets = [{ id: '1' }, { id: '2' }];
      budgetRepo.find.mockResolvedValue(budgets as any);
      const result = await service.findAll();
      expect(result).toEqual(budgets);
      expect(budgetRepo.find).toHaveBeenCalledWith({
        where: {},
        relations: ['projectGroupId', 'revisedProjectGroupId'],
      });
    });

    it('should filter by groupId', async () => {
      const budgets = [{ id: '1' }];
      budgetRepo.find.mockResolvedValue(budgets as any);
      const result = await service.findAll('group-uuid');
      expect(result).toEqual(budgets);
      expect(budgetRepo.find).toHaveBeenCalledWith({
        where: { projectGroupId: { id: 'group-uuid' } },
        relations: ['projectGroupId', 'revisedProjectGroupId'],
      });
    });

    it('should throw InternalServerErrorException on DB error', async () => {
      budgetRepo.find.mockImplementation(async () => {
        throw new Error('DB error');
      });
      await expect(service.findAll()).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('findOne', () => {
    it('should return a budget by id (success)', async () => {
      const budget = { id: 'budget-uuid' };
      budgetRepo.findOne.mockResolvedValue(budget as any);
      const result = await service.findOne('budget-uuid');
      expect(result).toEqual(budget);
      expect(budgetRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'budget-uuid' },
        relations: ['projectGroupId', 'revisedProjectGroupId'],
      });
    });

    it('should throw NotFoundException if not found', async () => {
      budgetRepo.findOne.mockResolvedValue(null as any);
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new NotFoundException();
        });
      await expect(service.findOne('not-exist')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw InternalServerErrorException on DB error', async () => {
      budgetRepo.findOne.mockRejectedValue(new Error('DB error'));
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new InternalServerErrorException();
        });
      await expect(service.findOne('budget-uuid')).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('should handle edge cases (empty/invalid id)', async () => {
      budgetRepo.findOne.mockResolvedValue(null as any);
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new NotFoundException();
        });
      await expect(service.findOne('')).rejects.toThrow(NotFoundException);
      await expect(service.findOne('0')).rejects.toThrow(NotFoundException);
      await expect(service.findOne('-1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('update', () => {
    const updateDto: UpdateBudgetDto = { quantity: 2000 };
    const budget = { id: 'budget-uuid', quantity: 1000 };
    it('should update and return the budget (success)', async () => {
      budgetRepo.preload.mockResolvedValue(budget as any);
      budgetRepo.save.mockResolvedValue({ ...budget, ...updateDto } as any);
      const result = await service.update('budget-uuid', updateDto);
      expect(result).toEqual({ ...budget, ...updateDto });
      expect(budgetRepo.preload).toHaveBeenCalledWith({
        id: 'budget-uuid',
        quantity: updateDto.quantity,
      });
      expect(budgetRepo.save).toHaveBeenCalledWith(budget);
    });

    it('should throw NotFoundException if budget not found', async () => {
      budgetRepo.preload.mockResolvedValue(null as any);
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new NotFoundException();
        });
      await expect(service.update('not-exist', updateDto)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw InternalServerErrorException on DB error', async () => {
      budgetRepo.preload.mockRejectedValue(new Error('DB error'));
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new InternalServerErrorException();
        });
      await expect(service.update('budget-uuid', updateDto)).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('should handle edge cases (empty/invalid id)', async () => {
      budgetRepo.preload.mockResolvedValue(null as any);
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new NotFoundException();
        });
      await expect(service.update('', updateDto)).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.update('0', updateDto)).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.update('-1', updateDto)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('remove', () => {
    it('should remove a budget (success)', async () => {
      budgetRepo.delete.mockResolvedValue({ affected: 1 } as any);
      const result = await service.remove('budget-uuid');
      expect(result).toEqual({
        message: 'Budget with ID budget-uuid has been removed successfully.',
      });
      expect(budgetRepo.delete).toHaveBeenCalledWith('budget-uuid');
    });

    it('should throw NotFoundException if not found', async () => {
      budgetRepo.delete.mockResolvedValue({ affected: 0 } as any);
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new NotFoundException();
        });
      await expect(service.remove('not-exist')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw InternalServerErrorException on DB error', async () => {
      budgetRepo.delete.mockRejectedValue(new Error('DB error'));
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new InternalServerErrorException();
        });
      await expect(service.remove('budget-uuid')).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('should handle edge cases (empty/invalid id)', async () => {
      budgetRepo.delete.mockResolvedValue({ affected: 0 } as any);
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new NotFoundException();
        });
      await expect(service.remove('')).rejects.toThrow(NotFoundException);
      await expect(service.remove('0')).rejects.toThrow(NotFoundException);
      await expect(service.remove('-1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('softRemove', () => {
    it('should soft remove a budget (success)', async () => {
      budgetRepo.softDelete.mockResolvedValue({ affected: 1 } as any);
      const result = await service.softRemove('budget-uuid');
      expect(result).toEqual({
        message: 'budet with ID budget-uuid has been soft-removed.',
      });
      expect(budgetRepo.softDelete).toHaveBeenCalledWith('budget-uuid');
    });

    it('should throw NotFoundException if not found', async () => {
      budgetRepo.softDelete.mockResolvedValue({ affected: 0 } as any);
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new NotFoundException();
        });
      await expect(service.softRemove('not-exist')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw InternalServerErrorException on DB error', async () => {
      budgetRepo.softDelete.mockRejectedValue(new Error('DB error'));
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new InternalServerErrorException();
        });
      await expect(service.softRemove('budget-uuid')).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('should handle edge cases (empty/invalid id)', async () => {
      budgetRepo.softDelete.mockResolvedValue({ affected: 0 } as any);
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new NotFoundException();
        });
      await expect(service.softRemove('')).rejects.toThrow(NotFoundException);
      await expect(service.softRemove('0')).rejects.toThrow(NotFoundException);
      await expect(service.softRemove('-1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('restore', () => {
    it('should restore a budget (success)', async () => {
      budgetRepo.restore.mockResolvedValue({ affected: 1 } as any);
      const result = await service.restore('budget-uuid');
      expect(result).toEqual({
        message: 'budet with ID budget-uuid has been restored.',
      });
      expect(budgetRepo.restore).toHaveBeenCalledWith('budget-uuid');
    });

    it('should throw NotFoundException if not found or not deleted', async () => {
      budgetRepo.restore.mockResolvedValue({ affected: 0 } as any);
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new NotFoundException();
        });
      await expect(service.restore('not-exist')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw InternalServerErrorException on DB error', async () => {
      budgetRepo.restore.mockRejectedValue(new Error('DB error'));
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new InternalServerErrorException();
        });
      await expect(service.restore('budget-uuid')).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('should handle edge cases (empty/invalid id)', async () => {
      budgetRepo.restore.mockResolvedValue({ affected: 0 } as any);
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new NotFoundException();
        });
      await expect(service.restore('')).rejects.toThrow(NotFoundException);
      await expect(service.restore('0')).rejects.toThrow(NotFoundException);
      await expect(service.restore('-1')).rejects.toThrow(NotFoundException);
    });
  });
});
