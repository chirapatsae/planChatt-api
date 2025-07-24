import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { TrackingStatusService } from './tracking-status.service';
import { TrackingStatus } from './entities/tracking-status.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { Status } from 'src/status/entities/status.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { Comment } from 'src/comments/entities/comment.entity';
import { CreateTrackingStatusDto } from './dto/create-tracking-status.dto';
import { UpdateTrackingStatusDto } from './dto/update-tracking-status.dto';
import {
  NotFoundException,
  ConflictException,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import * as handleExceptionModule from 'src/util/handleException';

const mockTrackingStatus = (
  overrides: Partial<TrackingStatus> = {},
): TrackingStatus =>
  ({
    id: 'track-1',
    comment: undefined,
    deletedAt: undefined,
    deletedBy: undefined,
    createAt: new Date('2024-01-01T00:00:00.000Z'),
    createdBy: { id: 'work-1' } as WorkHistory,
    projectGroupId: { id: 'proj-1' } as ProjectGroup,
    statusId: { id: 'status-1' } as Status,
    isLatest: true,
    comments: [],
    ...overrides,
  }) as TrackingStatus;

const mockWorkHistory = (overrides: Partial<WorkHistory> = {}): WorkHistory =>
  ({
    id: 'work-1',
    ...overrides,
  }) as WorkHistory;

const mockProjectGroup = (
  overrides: Partial<ProjectGroup> = {},
): ProjectGroup =>
  ({
    id: 'proj-1',
    ...overrides,
  }) as ProjectGroup;

const mockStatus = (overrides: Partial<Status> = {}): Status =>
  ({
    id: 'status-1',
    ...overrides,
  }) as Status;

const mockTrackingStatusRepository = () => ({
  create: jest.fn(),
  save: jest.fn(),
  find: jest.fn(),
  findOne: jest.fn(),
  update: jest.fn(),
  softRemove: jest.fn(),
  restore: jest.fn(),
});
const mockProjectGroupRepository = () => ({
  findOne: jest.fn(),
});
const mockStatusRepository = () => ({
  findOne: jest.fn(),
});
const mockWorkHistoryRepository = () => ({
  findOne: jest.fn(),
});
const mockCommentRepository = () => ({
  findOne: jest.fn(),
});

describe('TrackingStatusService', () => {
  let service: TrackingStatusService;
  let trackingStatusRepo: ReturnType<typeof mockTrackingStatusRepository>;
  let projectGroupRepo: ReturnType<typeof mockProjectGroupRepository>;
  let statusRepo: ReturnType<typeof mockStatusRepository>;
  let workHistoryRepo: ReturnType<typeof mockWorkHistoryRepository>;
  let commentRepo: ReturnType<typeof mockCommentRepository>;
  let handleExceptionSpy: jest.SpyInstance;

  beforeEach(async () => {
    jest.clearAllMocks();
    trackingStatusRepo = mockTrackingStatusRepository();
    projectGroupRepo = mockProjectGroupRepository();
    statusRepo = mockStatusRepository();
    workHistoryRepo = mockWorkHistoryRepository();
    commentRepo = mockCommentRepository();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TrackingStatusService,
        {
          provide: getRepositoryToken(TrackingStatus),
          useValue: trackingStatusRepo,
        },
        {
          provide: getRepositoryToken(ProjectGroup),
          useValue: projectGroupRepo,
        },
        { provide: getRepositoryToken(Status), useValue: statusRepo },
        { provide: getRepositoryToken(WorkHistory), useValue: workHistoryRepo },
        { provide: getRepositoryToken(Comment), useValue: commentRepo },
      ],
    }).compile();
    service = module.get<TrackingStatusService>(TrackingStatusService);
  });

  afterEach(() => {
    if (handleExceptionSpy) handleExceptionSpy.mockRestore();
  });

  describe('create', () => {
    const dto: CreateTrackingStatusDto = {
      projectId: 'proj-1',
      statusId: 'status-1',
    };
    const userId = 'user-1';
    it('should create and return a tracking status (success)', async () => {
      workHistoryRepo.findOne.mockResolvedValue(mockWorkHistory());
      projectGroupRepo.findOne.mockResolvedValue(mockProjectGroup());
      statusRepo.findOne.mockResolvedValue(mockStatus());
      trackingStatusRepo.update.mockResolvedValue(undefined);
      trackingStatusRepo.create.mockReturnValue(mockTrackingStatus());
      trackingStatusRepo.save.mockResolvedValue(mockTrackingStatus());
      const result = await service.create(dto, userId);
      expect(workHistoryRepo.findOne).toHaveBeenCalledWith({
        where: { user: { id: userId } },
      });
      expect(projectGroupRepo.findOne).toHaveBeenCalledWith({
        where: { id: dto.projectId },
      });
      expect(statusRepo.findOne).toHaveBeenCalledWith({
        where: { id: dto.statusId },
      });
      expect(trackingStatusRepo.update).toHaveBeenCalled();
      expect(trackingStatusRepo.create).toHaveBeenCalled();
      expect(trackingStatusRepo.save).toHaveBeenCalled();
      expect(result).toEqual(mockTrackingStatus());
    });
    it('should throw NotFoundException if work history not found', async () => {
      workHistoryRepo.findOne.mockResolvedValue(undefined);
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new NotFoundException();
        });
      await expect(service.create(dto, userId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
    it('should throw NotFoundException if project group not found', async () => {
      workHistoryRepo.findOne.mockResolvedValue(mockWorkHistory());
      projectGroupRepo.findOne.mockResolvedValue(undefined);
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new NotFoundException();
        });
      await expect(service.create(dto, userId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
    it('should throw NotFoundException if status not found', async () => {
      workHistoryRepo.findOne.mockResolvedValue(mockWorkHistory());
      projectGroupRepo.findOne.mockResolvedValue(mockProjectGroup());
      statusRepo.findOne.mockResolvedValue(undefined);
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new NotFoundException();
        });
      await expect(service.create(dto, userId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
    it('should throw ConflictException (DB unique violation)', async () => {
      workHistoryRepo.findOne.mockResolvedValue(mockWorkHistory());
      projectGroupRepo.findOne.mockResolvedValue(mockProjectGroup());
      statusRepo.findOne.mockResolvedValue(mockStatus());
      trackingStatusRepo.update.mockResolvedValue(undefined);
      trackingStatusRepo.create.mockReturnValue(mockTrackingStatus());
      trackingStatusRepo.save.mockRejectedValue({ code: '23505' });
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new ConflictException();
        });
      await expect(service.create(dto, userId)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
    it('should throw BadRequestException (invalid input)', async () => {
      workHistoryRepo.findOne.mockResolvedValue(mockWorkHistory());
      projectGroupRepo.findOne.mockResolvedValue(mockProjectGroup());
      statusRepo.findOne.mockResolvedValue(mockStatus());
      trackingStatusRepo.create.mockImplementation(() => {
        throw new BadRequestException();
      });
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new BadRequestException();
        });
      await expect(
        service.create({ ...dto, projectId: '' }, userId),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
    it('should throw InternalServerErrorException (other DB error)', async () => {
      workHistoryRepo.findOne.mockResolvedValue(mockWorkHistory());
      projectGroupRepo.findOne.mockResolvedValue(mockProjectGroup());
      statusRepo.findOne.mockResolvedValue(mockStatus());
      trackingStatusRepo.update.mockResolvedValue(undefined);
      trackingStatusRepo.create.mockReturnValue(mockTrackingStatus());
      trackingStatusRepo.save.mockRejectedValue(new Error('DB error'));
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new InternalServerErrorException();
        });
      await expect(service.create(dto, userId)).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });
    it('should handle edge case: empty projectId', async () => {
      workHistoryRepo.findOne.mockResolvedValue(mockWorkHistory());
      projectGroupRepo.findOne.mockResolvedValue(undefined);
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new NotFoundException();
        });
      await expect(
        service.create({ ...dto, projectId: '' }, userId),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('findAll', () => {
    it('should return all tracking statuses (success)', async () => {
      trackingStatusRepo.find.mockResolvedValue([
        mockTrackingStatus(),
        mockTrackingStatus({ id: 'track-2' }),
      ]);
      const result = await service.findAll();
      expect(trackingStatusRepo.find).toHaveBeenCalledWith({
        relations: [
          'createdBy',
          'deletedBy',
          'projectGroupId',
          'statusId',
          'comments',
        ],
      });
      expect(result).toHaveLength(2);
    });
    it('should throw InternalServerErrorException', async () => {
      trackingStatusRepo.find.mockRejectedValue(new Error('DB error'));
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
    it('should return a tracking status by id (success)', async () => {
      trackingStatusRepo.findOne.mockResolvedValue(mockTrackingStatus());
      const result = await service.findOne('track-1');
      expect(trackingStatusRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'track-1' },
        relations: [
          'createdBy',
          'deletedBy',
          'projectGroupId',
          'statusId',
          'comments',
        ],
      });
      expect(result).toEqual(mockTrackingStatus());
    });
    it('should throw NotFoundException if tracking status not found', async () => {
      trackingStatusRepo.findOne.mockResolvedValue(undefined);
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
      trackingStatusRepo.findOne.mockRejectedValue(new Error('DB error'));
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new InternalServerErrorException();
        });
      await expect(service.findOne('track-1')).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });
    it('should handle edge case: empty id', async () => {
      trackingStatusRepo.findOne.mockResolvedValue(undefined);
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
    const updateDto: UpdateTrackingStatusDto = { statusId: 'status-2' };
    it('should update and return the tracking status (success)', async () => {
      trackingStatusRepo.findOne.mockResolvedValue(mockTrackingStatus());
      statusRepo.findOne.mockResolvedValue(mockStatus({ id: 'status-2' }));
      trackingStatusRepo.save.mockResolvedValue(
        mockTrackingStatus({ statusId: mockStatus({ id: 'status-2' }) }),
      );
      const result = await service.update('track-1', updateDto);
      expect(trackingStatusRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'track-1' },
      });
      expect(statusRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'status-2' },
      });
      expect(trackingStatusRepo.save).toHaveBeenCalled();
      expect(result).toEqual({
        message: 'Tracking status updated successfully',
        data: mockTrackingStatus({ statusId: mockStatus({ id: 'status-2' }) }),
      });
    });
    it('should throw NotFoundException if tracking status not found', async () => {
      trackingStatusRepo.findOne.mockResolvedValue(undefined);
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new NotFoundException();
        });
      await expect(
        service.update('not-exist', updateDto),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
    it('should throw NotFoundException if status not found', async () => {
      trackingStatusRepo.findOne.mockResolvedValue(mockTrackingStatus());
      statusRepo.findOne.mockResolvedValue(undefined);
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new NotFoundException();
        });
      await expect(service.update('track-1', updateDto)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
    it('should throw InternalServerErrorException', async () => {
      trackingStatusRepo.findOne.mockResolvedValue(mockTrackingStatus());
      statusRepo.findOne.mockResolvedValue(mockStatus({ id: 'status-2' }));
      trackingStatusRepo.save.mockRejectedValue(new Error('DB error'));
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new InternalServerErrorException();
        });
      await expect(service.update('track-1', updateDto)).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });
    it('should handle edge case: empty id', async () => {
      trackingStatusRepo.findOne.mockResolvedValue(undefined);
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

  describe('softRemove', () => {
    const userId = 'user-1';
    it('should soft delete a tracking status (success, with userId)', async () => {
      trackingStatusRepo.findOne.mockResolvedValue(mockTrackingStatus());
      workHistoryRepo.findOne.mockResolvedValue(mockWorkHistory());
      trackingStatusRepo.save.mockResolvedValue(mockTrackingStatus());
      trackingStatusRepo.softRemove.mockResolvedValue(mockTrackingStatus());
      const result = await service.softRemove('track-1', userId);
      expect(trackingStatusRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'track-1' },
      });
      expect(workHistoryRepo.findOne).toHaveBeenCalledWith({
        where: { user: { id: userId } },
      });
      expect(trackingStatusRepo.save).toHaveBeenCalled();
      expect(trackingStatusRepo.softRemove).toHaveBeenCalled();
      expect(result).toEqual({
        message: 'Tracking status track-1 removed successfully',
      });
    });
    it('should soft delete a tracking status (success, without userId)', async () => {
      trackingStatusRepo.findOne.mockResolvedValue(mockTrackingStatus());
      trackingStatusRepo.softRemove.mockResolvedValue(mockTrackingStatus());
      const result = await service.softRemove('track-1');
      expect(trackingStatusRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'track-1' },
      });
      expect(trackingStatusRepo.softRemove).toHaveBeenCalled();
      expect(result).toEqual({
        message: 'Tracking status track-1 removed successfully',
      });
    });
    it('should throw NotFoundException if tracking status not found', async () => {
      trackingStatusRepo.findOne.mockResolvedValue(undefined);
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
      trackingStatusRepo.findOne.mockResolvedValue(mockTrackingStatus());
      trackingStatusRepo.softRemove.mockRejectedValue(new Error('DB error'));
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new InternalServerErrorException();
        });
      await expect(
        service.softRemove('track-1', userId),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
    });
    it('should handle edge case: empty id', async () => {
      trackingStatusRepo.findOne.mockResolvedValue(undefined);
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
    it('should restore a tracking status (success)', async () => {
      trackingStatusRepo.restore.mockResolvedValue(undefined);
      trackingStatusRepo.findOne.mockResolvedValue(mockTrackingStatus());
      const result = await service.restore('track-1');
      expect(trackingStatusRepo.restore).toHaveBeenCalledWith('track-1');
      expect(trackingStatusRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'track-1' },
        relations: [
          'createdBy',
          'deletedBy',
          'projectGroupId',
          'statusId',
          'comments',
        ],
      });
      expect(result).toEqual({
        message: 'Tracking status track-1 restored successfully',
        data: mockTrackingStatus(),
      });
    });
    it('should throw NotFoundException if tracking status not found after restore', async () => {
      trackingStatusRepo.restore.mockResolvedValue(undefined);
      trackingStatusRepo.findOne.mockResolvedValue(undefined);
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
      trackingStatusRepo.restore.mockRejectedValue(new Error('DB error'));
      handleExceptionSpy = jest
        .spyOn(handleExceptionModule, 'handleException')
        .mockImplementation(() => {
          throw new InternalServerErrorException();
        });
      await expect(service.restore('track-1')).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });
    it('should handle edge case: empty id', async () => {
      trackingStatusRepo.restore.mockResolvedValue(undefined);
      trackingStatusRepo.findOne.mockResolvedValue(undefined);
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
