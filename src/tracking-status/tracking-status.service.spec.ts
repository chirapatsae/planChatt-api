import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { TrackingStatusService } from './tracking-status.service';
import { TrackingStatus } from './entities/tracking-status.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { Status } from 'src/status/entities/status.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { Comment } from 'src/comments/entities/comment.entity';
import { ProjectGroupsService } from 'src/project-groups/project-groups.service';
import { SupplementProjectGroupService } from 'src/supplement-project-group/supplement-project-group.service';
import { CreateTrackingStatusDto } from './dto/create-tracking-status.dto';
import { UpdateTrackingStatusDto } from './dto/update-tracking-status.dto';
import { NotFoundException, BadRequestException } from '@nestjs/common';

describe('TrackingStatusService', () => {
  let service: TrackingStatusService;
  let trackingStatusRepo: Repository<TrackingStatus>;
  let projectGroupRepo: Repository<ProjectGroup>;
  let statusRepo: Repository<Status>;
  let workHistoryRepo: Repository<WorkHistory>;
  let commentRepo: Repository<Comment>;
  let dataSource: DataSource;

  const mockTrackingStatusRepo = {
    find: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn(),
    update: jest.fn(),
    softRemove: jest.fn(),
    restore: jest.fn(),
    create: jest.fn(),
  };

  const mockProjectGroupRepo = {
    findOne: jest.fn(),
  };

  const mockStatusRepo = {
    findOne: jest.fn(),
  };

  const mockWorkHistoryRepo = {
    findOne: jest.fn(),
  };

  const mockCommentRepo = {
    create: jest.fn(),
    save: jest.fn(),
  };

  const mockDataSource = {
    transaction: jest.fn(),
  };

  // Wave wave-print-merge-scale-statuschange / BE-01 — shared list-finder
  // predicate reused by `promoteVerifiedProjectGroupsByScope`.
  const mockProjectGroupsService = {
    findVerifiedProjectGroupIdsByScope: jest.fn(),
  };

  // Wave wave-print-merge-scale-statuschange / BE-03 — verified-supplement
  // list finder reused by `promoteVerifiedSupplementProjectGroupsByScope`.
  const mockSupplementProjectGroupService = {
    findByStatusForStaff: jest.fn(),
  };

  const mockTransactionManager = {
    findOne: jest.fn(),
    update: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TrackingStatusService,
        {
          provide: getRepositoryToken(TrackingStatus),
          useValue: mockTrackingStatusRepo,
        },
        {
          provide: getRepositoryToken(ProjectGroup),
          useValue: mockProjectGroupRepo,
        },
        {
          provide: getRepositoryToken(Status),
          useValue: mockStatusRepo,
        },
        {
          provide: getRepositoryToken(WorkHistory),
          useValue: mockWorkHistoryRepo,
        },
        {
          provide: getRepositoryToken(Comment),
          useValue: mockCommentRepo,
        },
        {
          provide: DataSource,
          useValue: mockDataSource,
        },
        {
          provide: ProjectGroupsService,
          useValue: mockProjectGroupsService,
        },
        {
          provide: SupplementProjectGroupService,
          useValue: mockSupplementProjectGroupService,
        },
      ],
    }).compile();

    service = module.get<TrackingStatusService>(TrackingStatusService);
    trackingStatusRepo = module.get<Repository<TrackingStatus>>(
      getRepositoryToken(TrackingStatus),
    );
    projectGroupRepo = module.get<Repository<ProjectGroup>>(
      getRepositoryToken(ProjectGroup),
    );
    statusRepo = module.get<Repository<Status>>(getRepositoryToken(Status));
    workHistoryRepo = module.get<Repository<WorkHistory>>(
      getRepositoryToken(WorkHistory),
    );
    commentRepo = module.get<Repository<Comment>>(getRepositoryToken(Comment));
    dataSource = module.get<DataSource>(DataSource);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    const createDto: CreateTrackingStatusDto = {
      projectId: 'test-project-id',
      statusId: 'test-status-id',
      comments: [
        {
          step: 1,
          detail: 'Test comment',
        },
      ],
    };

    const mockWorkHistory = {
      id: 'work-history-id',
      user: { id: 'user-id' },
    };

    const mockProjectGroup = {
      id: 'test-project-id',
    };

    const mockStatus = {
      id: 'test-status-id',
    };

    const mockTrackingStatus = {
      id: 'tracking-status-id',
      createdBy: mockWorkHistory,
      projectGroupId: mockProjectGroup,
      statusId: mockStatus,
      isLatest: true,
    };

    const mockComment = {
      step: 1,
      detail: 'Test comment',
      trackingStatusId: mockTrackingStatus,
    };

    beforeEach(() => {
      mockDataSource.transaction.mockImplementation(async (callback) => {
        return await callback(mockTransactionManager);
      });
    });

    it('should create a tracking status successfully', async () => {
      mockTransactionManager.findOne
        .mockResolvedValueOnce(mockWorkHistory) // workHistory
        .mockResolvedValueOnce(mockProjectGroup) // projectGroup
        .mockResolvedValueOnce(mockStatus); // status

      mockTransactionManager.update.mockResolvedValue({ affected: 1 });
      mockTransactionManager.create
        .mockReturnValueOnce(mockTrackingStatus) // tracking status
        .mockReturnValueOnce(mockComment); // comment
      mockTransactionManager.save
        .mockResolvedValueOnce(mockTrackingStatus) // tracking status
        .mockResolvedValueOnce([mockComment]); // comments

      const result = await service.create(createDto, 'user-id');

      expect(mockDataSource.transaction).toHaveBeenCalled();
      expect(mockTransactionManager.findOne).toHaveBeenCalledTimes(3);
      expect(mockTransactionManager.update).toHaveBeenCalledWith(
        TrackingStatus,
        { projectGroupId: mockProjectGroup },
        { isLatest: false },
      );
      // staffRemark: null because mockWorkHistory has no role, so strip logic resolves to null.
      // comment: undefined because createDto does not include comment field.
      expect(mockTransactionManager.create).toHaveBeenCalledWith(
        TrackingStatus,
        expect.objectContaining({
          createdBy: mockWorkHistory,
          projectGroupId: mockProjectGroup,
          statusId: mockStatus,
          isLatest: true,
          staffRemark: null,
        }),
      );
      expect(mockTransactionManager.save).toHaveBeenCalledTimes(2);
      expect(result).toEqual(mockTrackingStatus);
    });

    it('should throw NotFoundException when workHistory not found', async () => {
      mockTransactionManager.findOne.mockResolvedValueOnce(null); // workHistory not found

      await expect(service.create(createDto, 'user-id')).rejects.toThrow(
        NotFoundException,
      );
      expect(mockTransactionManager.findOne).toHaveBeenCalledWith(
        WorkHistory,
        { where: { user: { id: 'user-id' } } },
      );
    });

    it('should throw NotFoundException when projectGroup not found', async () => {
      mockTransactionManager.findOne
        .mockResolvedValueOnce(mockWorkHistory) // workHistory found
        .mockResolvedValueOnce(null); // projectGroup not found

      await expect(service.create(createDto, 'user-id')).rejects.toThrow(
        NotFoundException,
      );
      expect(mockTransactionManager.findOne).toHaveBeenCalledWith(
        ProjectGroup,
        { where: { id: createDto.projectId } },
      );
    });

    it('should throw NotFoundException when status not found', async () => {
      mockTransactionManager.findOne
        .mockResolvedValueOnce(mockWorkHistory) // workHistory found
        .mockResolvedValueOnce(mockProjectGroup) // projectGroup found
        .mockResolvedValueOnce(null); // status not found

      await expect(service.create(createDto, 'user-id')).rejects.toThrow(
        NotFoundException,
      );
      expect(mockTransactionManager.findOne).toHaveBeenCalledWith(
        Status,
        { where: { id: createDto.statusId } },
      );
    });

    it('should create tracking status without comments when comments array is empty', async () => {
      const createDtoWithoutComments = { ...createDto, comments: [] };

      mockTransactionManager.findOne
        .mockResolvedValueOnce(mockWorkHistory)
        .mockResolvedValueOnce(mockProjectGroup)
        .mockResolvedValueOnce(mockStatus);

      mockTransactionManager.update.mockResolvedValue({ affected: 1 });
      mockTransactionManager.create.mockReturnValueOnce(mockTrackingStatus);
      mockTransactionManager.save.mockResolvedValueOnce(mockTrackingStatus);

      const result = await service.create(createDtoWithoutComments, 'user-id');

      expect(mockTransactionManager.create).toHaveBeenCalledTimes(1); // Only tracking status
      expect(mockTransactionManager.save).toHaveBeenCalledTimes(1); // Only tracking status
      expect(result).toEqual(mockTrackingStatus);
    });
  });

  describe('findAll', () => {
    it('should return all tracking statuses with relations', async () => {
      const mockTrackingStatuses = [
        { id: '1', projectGroupId: { id: 'project-1' } },
        { id: '2', projectGroupId: { id: 'project-2' } },
      ];

      mockTrackingStatusRepo.find.mockResolvedValue(mockTrackingStatuses);

      const result = await service.findAll();

      expect(mockTrackingStatusRepo.find).toHaveBeenCalledWith({
        relations: [
          'createdBy',
          'deletedBy',
          'projectGroupId',
          'statusId',
          'comments',
        ],
      });
      expect(result).toEqual(mockTrackingStatuses);
    });
  });

  describe('findOne', () => {
    it('should return a tracking status by id with relations', async () => {
      const id = 'test-id';
      const mockTrackingStatus = {
        id,
        projectGroupId: { id: 'project-1' },
      };

      mockTrackingStatusRepo.findOne.mockResolvedValue(mockTrackingStatus);

      const result = await service.findOne(id);

      expect(mockTrackingStatusRepo.findOne).toHaveBeenCalledWith({
        where: { id },
        relations: [
          'createdBy',
          'deletedBy',
          'projectGroupId',
          'statusId',
          'comments',
        ],
      });
      expect(result).toEqual(mockTrackingStatus);
    });

    it('should throw NotFoundException when tracking status not found', async () => {
      const id = 'test-id';

      mockTrackingStatusRepo.findOne.mockResolvedValue(null);

      await expect(service.findOne(id)).rejects.toThrow(NotFoundException);
      expect(mockTrackingStatusRepo.findOne).toHaveBeenCalledWith({
        where: { id },
        relations: [
          'createdBy',
          'deletedBy',
          'projectGroupId',
          'statusId',
          'comments',
        ],
      });
    });
  });

  describe('update', () => {
    it('should update a tracking status successfully', async () => {
      const id = 'test-id';
      const updateDto: UpdateTrackingStatusDto = {
        statusId: 'new-status-id',
      };

      const existingTrackingStatus = {
        id,
        statusId: { id: 'old-status-id' },
      };

      const newStatus = { id: 'new-status-id' };

      const updatedTrackingStatus = {
        ...existingTrackingStatus,
        statusId: newStatus,
      };

      mockTrackingStatusRepo.findOne.mockResolvedValue(existingTrackingStatus);
      mockStatusRepo.findOne.mockResolvedValue(newStatus);
      mockTrackingStatusRepo.save.mockResolvedValue(updatedTrackingStatus);

      const result = await service.update(id, updateDto);

      expect(mockTrackingStatusRepo.findOne).toHaveBeenCalledWith({ where: { id } });
      expect(mockStatusRepo.findOne).toHaveBeenCalledWith({
        where: { id: updateDto.statusId },
      });
      expect(mockTrackingStatusRepo.save).toHaveBeenCalledWith(updatedTrackingStatus);
      expect(result).toEqual({
        message: 'Tracking status updated successfully',
        data: updatedTrackingStatus,
      });
    });

    it('should throw NotFoundException when tracking status not found', async () => {
      const id = 'test-id';
      const updateDto: UpdateTrackingStatusDto = { statusId: 'new-status-id' };

      mockTrackingStatusRepo.findOne.mockResolvedValue(null);

      await expect(service.update(id, updateDto)).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException when status not found', async () => {
      const id = 'test-id';
      const updateDto: UpdateTrackingStatusDto = { statusId: 'new-status-id' };

      const existingTrackingStatus = { id, statusId: { id: 'old-status-id' } };

      mockTrackingStatusRepo.findOne.mockResolvedValue(existingTrackingStatus);
      mockStatusRepo.findOne.mockResolvedValue(null);

      await expect(service.update(id, updateDto)).rejects.toThrow(NotFoundException);
    });

    it('should update tracking status without statusId when not provided', async () => {
      const id = 'test-id';
      const updateDto: UpdateTrackingStatusDto = {};

      const existingTrackingStatus = {
        id,
        statusId: { id: 'old-status-id' },
      };

      mockTrackingStatusRepo.findOne.mockResolvedValue(existingTrackingStatus);
      mockTrackingStatusRepo.save.mockResolvedValue(existingTrackingStatus);

      const result = await service.update(id, updateDto);

      expect(mockStatusRepo.findOne).not.toHaveBeenCalled();
      expect(mockTrackingStatusRepo.save).toHaveBeenCalledWith(existingTrackingStatus);
      expect(result).toEqual({
        message: 'Tracking status updated successfully',
        data: existingTrackingStatus,
      });
    });
  });

  describe('softRemove', () => {
    it('should soft remove a tracking status successfully', async () => {
      const id = 'test-id';
      const userId = 'user-id';

      const existingTrackingStatus = {
        id,
        deletedBy: null,
      };

      const mockWorkHistory = { id: 'work-history-id' };

      mockTrackingStatusRepo.findOne.mockResolvedValue(existingTrackingStatus);
      mockWorkHistoryRepo.findOne.mockResolvedValue(mockWorkHistory);
      mockTrackingStatusRepo.save.mockResolvedValue({
        ...existingTrackingStatus,
        deletedBy: mockWorkHistory,
      });
      mockTrackingStatusRepo.softRemove.mockResolvedValue({ affected: 1 });

      const result = await service.softRemove(id, userId);

      expect(mockTrackingStatusRepo.findOne).toHaveBeenCalledWith({ where: { id } });
      expect(mockWorkHistoryRepo.findOne).toHaveBeenCalledWith({
        where: { user: { id: userId } },
      });
      expect(mockTrackingStatusRepo.save).toHaveBeenCalledWith({
        ...existingTrackingStatus,
        deletedBy: mockWorkHistory,
      });
      expect(mockTrackingStatusRepo.softRemove).toHaveBeenCalledWith(existingTrackingStatus);
      expect(result).toEqual({
        message: `Tracking status ${id} removed successfully`,
      });
    });

    it('should soft remove without setting deletedBy when workHistory not found', async () => {
      const id = 'test-id';
      const userId = 'user-id';

      const existingTrackingStatus = {
        id,
        deletedBy: null,
      };

      mockTrackingStatusRepo.findOne.mockResolvedValue(existingTrackingStatus);
      mockWorkHistoryRepo.findOne.mockResolvedValue(null);
      mockTrackingStatusRepo.save.mockResolvedValue(existingTrackingStatus);
      mockTrackingStatusRepo.softRemove.mockResolvedValue({ affected: 1 });

      const result = await service.softRemove(id, userId);

      expect(mockTrackingStatusRepo.save).toHaveBeenCalledWith(existingTrackingStatus);
      expect(mockTrackingStatusRepo.softRemove).toHaveBeenCalledWith(existingTrackingStatus);
      expect(result).toEqual({
        message: `Tracking status ${id} removed successfully`,
      });
    });

    it('should throw NotFoundException when tracking status not found', async () => {
      const id = 'test-id';
      const userId = 'user-id';

      mockTrackingStatusRepo.findOne.mockResolvedValue(null);

      await expect(service.softRemove(id, userId)).rejects.toThrow(NotFoundException);
    });
  });

  describe('restore', () => {
    it('should restore a tracking status successfully', async () => {
      const id = 'test-id';

      const restoredTrackingStatus = {
        id,
        projectGroupId: { id: 'project-1' },
      };

      mockTrackingStatusRepo.restore.mockResolvedValue({ affected: 1 });
      mockTrackingStatusRepo.findOne.mockResolvedValue(restoredTrackingStatus);

      const result = await service.restore(id);

      expect(mockTrackingStatusRepo.restore).toHaveBeenCalledWith(id);
      expect(mockTrackingStatusRepo.findOne).toHaveBeenCalledWith({
        where: { id },
        relations: [
          'createdBy',
          'deletedBy',
          'projectGroupId',
          'statusId',
          'comments',
        ],
      });
      expect(result).toEqual({
        message: `Tracking status ${id} restored successfully`,
        data: restoredTrackingStatus,
      });
    });

    it('should throw NotFoundException when tracking status not found after restore', async () => {
      const id = 'test-id';

      mockTrackingStatusRepo.restore.mockResolvedValue({ affected: 1 });
      mockTrackingStatusRepo.findOne.mockResolvedValue(null);

      await expect(service.restore(id)).rejects.toThrow(NotFoundException);
    });
  });
});
