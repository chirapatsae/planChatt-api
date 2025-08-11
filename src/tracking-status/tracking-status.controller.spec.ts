import { Test, TestingModule } from '@nestjs/testing';
import { TrackingStatusController } from './tracking-status.controller';
import { TrackingStatusService } from './tracking-status.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { TrackingStatus } from './entities/tracking-status.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { Status } from 'src/status/entities/status.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { Comment } from 'src/comments/entities/comment.entity';
import { DataSource } from 'typeorm';
import { JwtAuthGuard } from 'src/auth/auth.guard';
import { CreateTrackingStatusDto } from './dto/create-tracking-status.dto';
import { UpdateTrackingStatusDto } from './dto/update-tracking-status.dto';

describe('TrackingStatusController', () => {
  let controller: TrackingStatusController;
  let service: TrackingStatusService;

  const mockTrackingStatusService = {
    create: jest.fn(),
    findAll: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
    softRemove: jest.fn(),
    restore: jest.fn(),
  };

  const mockUser = {
    userId: 'test-user-id',
  };

  const mockRequest = {
    user: mockUser,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TrackingStatusController],
      providers: [
        {
          provide: TrackingStatusService,
          useValue: mockTrackingStatusService,
        },
        { provide: getRepositoryToken(TrackingStatus), useValue: {} },
        { provide: getRepositoryToken(ProjectGroup), useValue: {} },
        { provide: getRepositoryToken(Status), useValue: {} },
        { provide: getRepositoryToken(WorkHistory), useValue: {} },
        { provide: getRepositoryToken(Comment), useValue: {} },
        { provide: DataSource, useValue: {} },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<TrackingStatusController>(TrackingStatusController);
    service = module.get<TrackingStatusService>(TrackingStatusService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('create', () => {
    it('should create a tracking status', async () => {
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

      const expectedResult = { id: 'test-id', ...createDto };
      mockTrackingStatusService.create.mockResolvedValue(expectedResult);

      const result = await controller.create(createDto, mockRequest as any);

      expect(service.create).toHaveBeenCalledWith(createDto, mockUser.userId);
      expect(result).toEqual(expectedResult);
    });
  });

  describe('findAll', () => {
    it('should return all tracking statuses', async () => {
      const expectedResult = [
        { id: '1', projectId: 'project-1' },
        { id: '2', projectId: 'project-2' },
      ];
      mockTrackingStatusService.findAll.mockResolvedValue(expectedResult);

      const result = await controller.findAll();

      expect(service.findAll).toHaveBeenCalled();
      expect(result).toEqual(expectedResult);
    });
  });

  describe('findOne', () => {
    it('should return a tracking status by id', async () => {
      const id = 'test-id';
      const expectedResult = { id, projectId: 'test-project' };
      mockTrackingStatusService.findOne.mockResolvedValue(expectedResult);

      const result = await controller.findOne(id);

      expect(service.findOne).toHaveBeenCalledWith(id);
      expect(result).toEqual(expectedResult);
    });
  });

  describe('update', () => {
    it('should update a tracking status', async () => {
      const id = 'test-id';
      const updateDto: UpdateTrackingStatusDto = {
        statusId: 'new-status-id',
      };
      const expectedResult = {
        message: 'Tracking status updated successfully',
        data: { id, ...updateDto },
      };
      mockTrackingStatusService.update.mockResolvedValue(expectedResult);

      const result = await controller.update(id, updateDto);

      expect(service.update).toHaveBeenCalledWith(id, updateDto);
      expect(result).toEqual(expectedResult);
    });
  });

  describe('remove', () => {
    it('should remove a tracking status with soft delete by default', async () => {
      const id = 'test-id';
      const expectedResult = { message: `Tracking status ${id} removed successfully` };
      mockTrackingStatusService.softRemove.mockResolvedValue(expectedResult);

      const result = await controller.remove(id, 'soft', mockRequest as any);

      expect(service.softRemove).toHaveBeenCalledWith(id);
      expect(result).toEqual(expectedResult);
    });

    it('should remove a tracking status with hard delete when specified', async () => {
      const id = 'test-id';
      const expectedResult = { message: `Tracking status ${id} removed successfully` };
      mockTrackingStatusService.softRemove.mockResolvedValue(expectedResult);

      const result = await controller.remove(id, 'hard', mockRequest as any);

      expect(service.softRemove).toHaveBeenCalledWith(id);
      expect(result).toEqual(expectedResult);
    });
  });

  describe('restore', () => {
    it('should restore a tracking status', async () => {
      const id = 'test-id';
      const expectedResult = {
        message: `Tracking status ${id} restored successfully`,
        data: { id, projectId: 'test-project' },
      };
      mockTrackingStatusService.restore.mockResolvedValue(expectedResult);

      const result = await controller.restore(id);

      expect(service.restore).toHaveBeenCalledWith(id);
      expect(result).toEqual(expectedResult);
    });
  });
});
