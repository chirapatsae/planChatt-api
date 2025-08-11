import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { TacticService } from './tactic.service';
import { Tactic } from './entities/tactic.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { CreateTacticDto } from './dto/create-tactic.dto';
import { UpdateTacticDto } from './dto/update-tactic.dto';
import {
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import * as handleExceptionModule from 'src/util/handleException';

const mockTactic = (overrides: Partial<Tactic> = {}): Tactic =>
  ({
    id: 'T001',
    name: 'Tactic Test',
    createdAt: new Date('2025-01-01T00:00:00.000Z'),
    createdBy: { id: 'user-1' } as WorkHistory,
    strategy: { id: 'S001' } as any,
    projectGroup: [],
    planTactics: [],
    ...overrides,
  }) as Tactic;

const mockWorkHistory = (overrides: Partial<WorkHistory> = {}): WorkHistory =>
  ({
    id: 'user-1',
    ...overrides,
  }) as WorkHistory;

const mockTacticRepository = () => ({
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

describe('TacticService', () => {
  let service: TacticService;
  let tacticRepo: ReturnType<typeof mockTacticRepository>;
  let workHistoryRepository: ReturnType<typeof mockWorkHistoryRepository>;
  let handleExceptionSpy: jest.SpyInstance;

  beforeEach(async () => {
    jest.clearAllMocks();
    tacticRepo = mockTacticRepository();
    workHistoryRepository = mockWorkHistoryRepository();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TacticService,
        {
          provide: getRepositoryToken(Tactic),
          useValue: tacticRepo,
        },
        {
          provide: getRepositoryToken(WorkHistory),
          useValue: workHistoryRepository,
        },
      ],
    }).compile();
    service = module.get<TacticService>(TacticService);
  });

  afterEach(() => {
    if (handleExceptionSpy) handleExceptionSpy.mockRestore();
  });

  describe('create', () => {
    const dto: CreateTacticDto = {
      id: 'T001',
      name: 'Tactic Test',
      strategyId: 'S001',
    };
    const userId = 'user-1';
    it('should create and return a tactic (success)', async () => {
      workHistoryRepository.findOne.mockResolvedValue(mockWorkHistory());
      tacticRepo.create.mockReturnValue(mockTactic());
      tacticRepo.save.mockResolvedValue(mockTactic());
      const result = await service.create(dto, userId);
      expect(workHistoryRepository.findOne).toHaveBeenCalledWith({
        where: { id: userId },
      });
      expect(tacticRepo.create).toHaveBeenCalledWith({
        id: dto.id,
        name: dto.name,
        strategy: { id: dto.strategyId },
        createdBy: expect.any(Object),
      });
      expect(tacticRepo.save).toHaveBeenCalled();
      expect(result).toEqual(mockTactic());
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
      tacticRepo.create.mockImplementation(() => {
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
      workHistoryRepository.findOne.mockResolvedValue(mockWorkHistory());
      tacticRepo.create.mockReturnValue(mockTactic());
      tacticRepo.save.mockRejectedValue(new Error('DB error'));
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new InternalServerErrorException();
        });
      await expect(service.create(dto, userId)).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });
    it('should handle edge case: empty id', async () => {
      workHistoryRepository.findOne.mockResolvedValue(mockWorkHistory());
      tacticRepo.create.mockImplementation(() => {
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

  describe('findAll', () => {
    it('should return all tactics (success)', async () => {
      tacticRepo.find.mockResolvedValue([
        mockTactic(),
        mockTactic({ id: 'T002' }),
      ]);
      const result = await service.findAll();
      expect(tacticRepo.find).toHaveBeenCalledWith({
        where: { deletedAt: undefined },
        relations: ['strategy', 'createdBy', 'deletedBy', 'planTactics'],
      });
      expect(result).toHaveLength(2);
    });
    it('should throw InternalServerErrorException', async () => {
      tacticRepo.find.mockRejectedValue(new Error('DB error'));
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
    it('should return a tactic by id (success)', async () => {
      tacticRepo.findOne.mockResolvedValue(mockTactic());
      const result = await service.findOne('T001');
      expect(tacticRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'T001' },
        relations: {
          planTactics: {
            plan: true,
          }
        }
      });
      expect(result).toEqual(mockTactic());
    });
    it('should throw NotFoundException if tactic not found', async () => {
      tacticRepo.findOne.mockResolvedValue(undefined);
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new NotFoundException();
        });
      await expect(service.findOne('not-exist')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
    it('should throw InternalServerErrorException', async () => {
      tacticRepo.findOne.mockRejectedValue(new Error('DB error'));
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new InternalServerErrorException();
        });
      await expect(service.findOne('T001')).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });
    it('should handle edge case: empty id', async () => {
      tacticRepo.findOne.mockResolvedValue(undefined);
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new NotFoundException();
        });
      await expect(service.findOne('')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('update', () => {
    const updateDto: UpdateTacticDto = { name: 'Updated Tactic' };
    it('should update and return the tactic (success)', async () => {
      tacticRepo.preload.mockResolvedValue(
        mockTactic({ name: 'Updated Tactic' }),
      );
      tacticRepo.save.mockResolvedValue(mockTactic({ name: 'Updated Tactic' }));
      const result = await service.update('T001', updateDto);
      expect(tacticRepo.preload).toHaveBeenCalledWith({
        id: 'T001',
        ...updateDto,
        strategy: undefined,
      });
      expect(tacticRepo.save).toHaveBeenCalled();
      expect(result.name).toBe('Updated Tactic');
    });
    it('should throw NotFoundException if tactic not found', async () => {
      tacticRepo.preload.mockResolvedValue(undefined);
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
      tacticRepo.preload.mockResolvedValue(mockTactic());
      tacticRepo.save.mockRejectedValue(new Error('DB error'));
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new InternalServerErrorException();
        });
      await expect(service.update('T001', updateDto)).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });
    it('should handle edge case: empty id', async () => {
      tacticRepo.preload.mockResolvedValue(undefined);
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
    it('should permanently delete a tactic (success)', async () => {
      tacticRepo.delete.mockResolvedValue({ affected: 1 });
      const result = await service.remove('T001');
      expect(tacticRepo.delete).toHaveBeenCalledWith('T001');
      expect(result).toEqual({
        message: 'Tactic with ID T001 has been permanently removed.',
      });
    });
    it('should throw NotFoundException if tactic not found', async () => {
      tacticRepo.delete.mockResolvedValue({ affected: 0 });
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
      tacticRepo.delete.mockRejectedValue(new Error('DB error'));
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new InternalServerErrorException();
        });
      await expect(service.remove('T001')).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });
    it('should handle edge case: empty id', async () => {
      tacticRepo.delete.mockResolvedValue({ affected: 0 });
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
    it('should soft delete a tactic (success)', async () => {
      workHistoryRepository.findOne.mockResolvedValueOnce(mockWorkHistory());
      tacticRepo.findOne.mockResolvedValueOnce(mockTactic());
      tacticRepo.save.mockResolvedValueOnce(mockTactic());
      tacticRepo.softRemove.mockResolvedValueOnce(mockTactic());
      const result = await service.softRemove('T001', userId);
      expect(workHistoryRepository.findOne).toHaveBeenCalledWith({
        where: { id: userId },
      });
      expect(tacticRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'T001' },
      });
      expect(tacticRepo.save).toHaveBeenCalled();
      expect(tacticRepo.softRemove).toHaveBeenCalled();
      expect(result).toEqual({
        message: 'Tactic with ID T001 has been soft-removed.',
      });
    });
    it('should throw NotFoundException if work history not found', async () => {
      workHistoryRepository.findOne.mockResolvedValueOnce(undefined);
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new NotFoundException();
        });
      await expect(service.softRemove('T001', userId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
    it('should throw NotFoundException if tactic not found', async () => {
      workHistoryRepository.findOne.mockResolvedValueOnce(mockWorkHistory());
      tacticRepo.findOne.mockResolvedValueOnce(undefined);
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
      workHistoryRepository.findOne.mockResolvedValueOnce(mockWorkHistory());
      tacticRepo.findOne.mockResolvedValueOnce(mockTactic());
      tacticRepo.save.mockResolvedValueOnce(mockTactic());
      tacticRepo.softRemove.mockRejectedValueOnce(new Error('DB error'));
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new InternalServerErrorException();
        });
      await expect(service.softRemove('T001', userId)).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });
    it('should handle edge case: empty id', async () => {
      workHistoryRepository.findOne.mockResolvedValueOnce(mockWorkHistory());
      tacticRepo.findOne.mockResolvedValueOnce(undefined);
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
    it('should restore a soft-deleted tactic (success)', async () => {
      tacticRepo.restore.mockResolvedValue({ affected: 1 });
      const result = await service.restore('T001');
      expect(tacticRepo.restore).toHaveBeenCalledWith('T001');
      expect(result).toEqual({
        message: 'Tactic with ID T001 has been restored.',
      });
    });
    it('should throw NotFoundException if tactic not found', async () => {
      tacticRepo.restore.mockResolvedValue({ affected: 0 });
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
      tacticRepo.restore.mockRejectedValue(new Error('DB error'));
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new InternalServerErrorException();
        });
      await expect(service.restore('T001')).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });
    it('should handle edge case: empty id', async () => {
      tacticRepo.restore.mockResolvedValue({ affected: 0 });
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
