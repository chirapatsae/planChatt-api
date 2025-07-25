import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { PlanService } from './plan.service';
import { Plan } from './entities/plan.entity';
import { Tactic } from 'src/tactic/entities/tactic.entity';
import { PlanTactic } from './entities/plan-tactic.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { CreatePlanDto } from './dto/create-plan.dto';
import { UpdatePlanDto } from './dto/update-plan.dto';
import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import * as handleExceptionModule from 'src/util/handleException';
import { Logger } from '@nestjs/common';

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
});

const mockPlan = (overrides: Partial<Plan> = {}): Plan =>
  ({
    id: 'P001',
    name: 'Plan Test',
    createdAt: new Date('2025-01-01T00:00:00.000Z'),
    createdBy: { id: 'user-1' } as WorkHistory,
    planTactics: [],
    projectGroup: [],
    ...overrides,
  }) as Plan;

const mockWorkHistory = (overrides: Partial<WorkHistory> = {}): WorkHistory =>
  ({
    id: 'user-1',
    ...overrides,
  }) as WorkHistory;

const mockPlanRepository = () => ({
  create: jest.fn(),
  save: jest.fn(),
  find: jest.fn(),
  findOne: jest.fn(),
  preload: jest.fn(),
  delete: jest.fn(),
  softRemove: jest.fn(),
  restore: jest.fn(),
});
const mockTacticRepository = () => ({
  findOne: jest.fn(),
});
const mockPlanTacticRepository = () => ({
  findOne: jest.fn(),
});
const mockWorkHistoryRepository = () => ({
  findOne: jest.fn(),
});

describe('PlanService', () => {
  let service: PlanService;
  let planRepo: ReturnType<typeof mockPlanRepository>;
  let tacticRepo: ReturnType<typeof mockTacticRepository>;
  let planTacticRepo: ReturnType<typeof mockPlanTacticRepository>;
  let workHistoryRepository: ReturnType<typeof mockWorkHistoryRepository>;
  let handleExceptionSpy: jest.SpyInstance;

  beforeEach(async () => {
    jest.clearAllMocks();
    planRepo = mockPlanRepository();
    tacticRepo = mockTacticRepository();
    planTacticRepo = mockPlanTacticRepository();
    workHistoryRepository = mockWorkHistoryRepository();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlanService,
        {
          provide: getRepositoryToken(Plan),
          useValue: planRepo,
        },
        {
          provide: getRepositoryToken(Tactic),
          useValue: tacticRepo,
        },
        {
          provide: getRepositoryToken(PlanTactic),
          useValue: planTacticRepo,
        },
        {
          provide: getRepositoryToken(WorkHistory),
          useValue: workHistoryRepository,
        },
      ],
    }).compile();
    service = module.get<PlanService>(PlanService);
  });

  afterEach(() => {
    if (handleExceptionSpy) handleExceptionSpy.mockRestore();
  });

  describe('findAll', () => {
    it('should return all plans (success)', async () => {
      planRepo.find.mockResolvedValue([mockPlan(), mockPlan({ id: 'P002' })]);
      const result = await service.findAll();
      expect(planRepo.find).toHaveBeenCalledWith({
        relations: [
          'planTactics',
          'planTactics.tactic',
          'planTactics.tactic.strategy',
        ],
      });
      expect(result).toHaveLength(2);
    });
    it('should throw InternalServerErrorException', async () => {
      planRepo.find.mockRejectedValue(new Error('DB error'));
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new InternalServerErrorException();
        });
      await expect(service.findAll()).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });
  });

  describe('findOne', () => {
    it('should return a plan by id (success)', async () => {
      planRepo.findOne.mockResolvedValue(mockPlan());
      const result = await service.findOne('P001');
      expect(planRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'P001' },
        relations: [
          'planTactics',
          'planTactics.tactic',
          'planTactics.tactic.strategy',
        ],
      });
      expect(result).toEqual(mockPlan());
    });
    it('should throw NotFoundException if plan not found', async () => {
      planRepo.findOne.mockResolvedValue(undefined);
      await expect(service.findOne('not-exist')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
    it('should handle edge case: empty id', async () => {
      planRepo.findOne.mockResolvedValue(undefined);
      await expect(service.findOne('')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('create', () => {
    const dto: CreatePlanDto = { id: 'P001', name: 'Plan Test' };
    const userId = 'user-1';
    it('should create and return a plan (success)', async () => {
      workHistoryRepository.findOne.mockResolvedValue(mockWorkHistory());
      planRepo.create.mockReturnValue(mockPlan());
      planRepo.save.mockResolvedValue(mockPlan());
      const result = await service.create(dto, userId);
      expect(workHistoryRepository.findOne).toHaveBeenCalledWith({
        where: { id: userId },
      });
      expect(planRepo.create).toHaveBeenCalledWith({
        id: dto.id,
        name: dto.name,
        createdBy: expect.any(Object),
      });
      expect(planRepo.save).toHaveBeenCalled();
      expect(result).toEqual(mockPlan());
    });
    it('should throw NotFoundException if work history not found', async () => {
      workHistoryRepository.findOne.mockResolvedValue(undefined);
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new NotFoundException();
        });
      await expect(service.create(dto, userId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
    it('should throw BadRequestException (invalid input)', async () => {
      workHistoryRepository.findOne.mockResolvedValue(mockWorkHistory());
      planRepo.create.mockImplementation(() => {
        throw new BadRequestException();
      });
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new BadRequestException();
        });
      await expect(
        service.create({ ...dto, id: '' }, userId),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
    it('should throw InternalServerErrorException (other DB error)', async () => {
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new InternalServerErrorException();
        });
      workHistoryRepository.findOne.mockResolvedValue(mockWorkHistory());
      planRepo.create.mockReturnValue(mockPlan());
      planRepo.save.mockRejectedValue(new Error('DB error'));
      await expect(service.create(dto, userId)).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });
    it('should handle edge case: empty id', async () => {
      workHistoryRepository.findOne.mockResolvedValue(mockWorkHistory());
      planRepo.create.mockImplementation(() => {
        throw new BadRequestException();
      });
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new BadRequestException();
        });
      await expect(
        service.create({ ...dto, id: '' }, userId),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('update', () => {
    const updateDto: UpdatePlanDto = { name: 'Updated Plan' };
    it('should update and return the plan (success)', async () => {
      planRepo.preload.mockResolvedValue(mockPlan({ name: 'Updated Plan' }));
      planRepo.save.mockResolvedValue(mockPlan({ name: 'Updated Plan' }));
      const result = await service.update('P001', updateDto);
      expect(planRepo.preload).toHaveBeenCalledWith({
        id: 'P001',
        ...updateDto,
      });
      expect(planRepo.save).toHaveBeenCalled();
      expect(result.name).toBe('Updated Plan');
    });
    it('should throw NotFoundException if plan not found', async () => {
      planRepo.preload.mockResolvedValue(undefined);
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new NotFoundException();
        });
      await expect(
        service.update('not-exist', updateDto),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
    it('should throw InternalServerErrorException', async () => {
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new InternalServerErrorException();
        });
      planRepo.preload.mockResolvedValue(mockPlan());
      planRepo.save.mockRejectedValue(new Error('DB error'));
      await expect(service.update('P001', updateDto)).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });
    it('should handle edge case: empty id', async () => {
      planRepo.preload.mockResolvedValue(undefined);
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new NotFoundException();
        });
      await expect(service.update('', updateDto)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('remove', () => {
    it('should permanently delete a plan (success)', async () => {
      planRepo.delete.mockResolvedValue({ affected: 1 });
      const result = await service.remove('P001');
      expect(planRepo.delete).toHaveBeenCalledWith('P001');
      expect(result).toEqual({
        message: 'Plan with ID P001 has been permanently removed.',
      });
    });
    it('should throw NotFoundException if plan not found', async () => {
      planRepo.delete.mockResolvedValue({ affected: 0 });
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new NotFoundException();
        });
      await expect(service.remove('not-exist')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
    it('should throw InternalServerErrorException', async () => {
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new InternalServerErrorException();
        });
      planRepo.delete.mockRejectedValue(new Error('DB error'));
      await expect(service.remove('P001')).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });
    it('should handle edge case: empty id', async () => {
      planRepo.delete.mockResolvedValue({ affected: 0 });
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new NotFoundException();
        });
      await expect(service.remove('')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('softRemove', () => {
    const userId = 'user-1';
    it('should soft delete a plan (success)', async () => {
      workHistoryRepository.findOne.mockResolvedValueOnce(mockWorkHistory());
      planRepo.findOne.mockResolvedValueOnce(mockPlan());
      planRepo.save.mockResolvedValueOnce(mockPlan());
      planRepo.softRemove.mockResolvedValueOnce(mockPlan());
      const result = await service.softRemove('P001', userId);
      expect(workHistoryRepository.findOne).toHaveBeenCalledWith({
        where: { id: userId },
      });
      expect(planRepo.findOne).toHaveBeenCalledWith({ where: { id: 'P001' } });
      expect(planRepo.save).toHaveBeenCalled();
      expect(planRepo.softRemove).toHaveBeenCalled();
      expect(result).toEqual({
        message: 'Plan with ID P001 has been soft-removed.',
      });
    });
    it('should throw NotFoundException if work history not found', async () => {
      workHistoryRepository.findOne.mockResolvedValueOnce(undefined);
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new NotFoundException();
        });
      await expect(service.softRemove('P001', userId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
    it('should throw NotFoundException if plan not found', async () => {
      workHistoryRepository.findOne.mockResolvedValueOnce(mockWorkHistory());
      planRepo.findOne.mockResolvedValueOnce(undefined);
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new NotFoundException();
        });
      await expect(
        service.softRemove('not-exist', userId),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
    it('should throw InternalServerErrorException', async () => {
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new InternalServerErrorException();
        });
      workHistoryRepository.findOne.mockResolvedValueOnce(mockWorkHistory());
      planRepo.findOne.mockResolvedValueOnce(mockPlan());
      planRepo.save.mockResolvedValueOnce(mockPlan());
      planRepo.softRemove.mockRejectedValueOnce(new Error('DB error'));
      await expect(service.softRemove('P001', userId)).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });
    it('should handle edge case: empty id', async () => {
      workHistoryRepository.findOne.mockResolvedValueOnce(mockWorkHistory());
      planRepo.findOne.mockResolvedValueOnce(undefined);
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new NotFoundException();
        });
      await expect(service.softRemove('', userId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('restore', () => {
    it('should restore a soft-deleted plan (success)', async () => {
      planRepo.restore.mockResolvedValue({ affected: 1 });
      const result = await service.restore('P001');
      expect(planRepo.restore).toHaveBeenCalledWith('P001');
      expect(result).toEqual({
        message: 'Plan with ID P001 has been restored.',
      });
    });
    it('should throw NotFoundException if plan not found', async () => {
      planRepo.restore.mockResolvedValue({ affected: 0 });
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new NotFoundException();
        });
      await expect(service.restore('not-exist')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
    it('should throw InternalServerErrorException', async () => {
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new InternalServerErrorException();
        });
      planRepo.restore.mockRejectedValue(new Error('DB error'));
      await expect(service.restore('P001')).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });
    it('should handle edge case: empty id', async () => {
      planRepo.restore.mockResolvedValue({ affected: 0 });
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new NotFoundException();
        });
      await expect(service.restore('')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
