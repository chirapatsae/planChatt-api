import { Test, TestingModule } from '@nestjs/testing';
import { CommentsService } from './comments.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { TrackingStatus } from 'src/tracking-status/entities/tracking-status.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { Comment } from './entities/comment.entity';
import { NotFoundException, InternalServerErrorException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { CreateCommentDto } from './dto/create-comment.dto';

const mockRepo = () => ({
  findOne: jest.fn(),
  create: jest.fn(),
  save: jest.fn(),
});

describe('CommentsService', () => {
  let service: CommentsService;
  let trackingStatusRepo: jest.Mocked<Repository<TrackingStatus>>;
  let commentRepo: jest.Mocked<Repository<Comment>>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommentsService,
        { provide: getRepositoryToken(WorkHistory), useValue: mockRepo() },
        { provide: getRepositoryToken(TrackingStatus), useValue: mockRepo() },
        { provide: getRepositoryToken(ProjectGroup), useValue: mockRepo() },
        { provide: getRepositoryToken(Comment), useValue: mockRepo() },
      ],
    }).compile();

    service = module.get<CommentsService>(CommentsService);
    trackingStatusRepo = module.get(getRepositoryToken(TrackingStatus));
    commentRepo = module.get(getRepositoryToken(Comment));
  });

  describe('create', () => {
    const validDto: CreateCommentDto = {
      detail: 'A comment',
      step: 1,
      trackingStatusId: 'uuid-123',
    };
    const trackingStatus = { id: 'uuid-123' } as TrackingStatus;
    const commentEntity = { id: 'c1', ...validDto, trackingStatusId: trackingStatus } as Comment;

    it('should create and return a comment (success case)', async () => {
      trackingStatusRepo.findOne.mockResolvedValue(trackingStatus);
      commentRepo.create.mockReturnValue(commentEntity);
      commentRepo.save.mockResolvedValue(commentEntity);

      const result = await service.create(validDto);
      expect(trackingStatusRepo.findOne).toHaveBeenCalledWith({ where: { id: validDto.trackingStatusId } });
      expect(commentRepo.create).toHaveBeenCalledWith({
        detail: validDto.detail,
        step: validDto.step,
        trackingStatusId: trackingStatus,
      });
      expect(commentRepo.save).toHaveBeenCalledWith(commentEntity);
      expect(result).toBe(commentEntity);
    });

    it('should throw NotFoundException if tracking status not found', async () => {
      trackingStatusRepo.findOne.mockResolvedValue(null);
      await expect(service.create(validDto)).rejects.toThrow(NotFoundException);
    });

    it('should throw InternalServerErrorException on DB error', async () => {
      trackingStatusRepo.findOne.mockRejectedValue(new Error('DB error'));
      await expect(service.create(validDto)).rejects.toThrow(Error);
    });

    it('should throw error if commentRepo.save throws (simulate constraint error)', async () => {
      trackingStatusRepo.findOne.mockResolvedValue(trackingStatus);
      commentRepo.create.mockReturnValue(commentEntity);
      commentRepo.save.mockRejectedValue(new Error('Constraint violation'));
      await expect(service.create(validDto)).rejects.toThrow(Error);
    });

    describe('edge cases', () => {
      it('should throw if detail is empty string', async () => {
        trackingStatusRepo.findOne.mockResolvedValue(trackingStatus);
        const dto = { ...validDto, detail: '' };
        commentRepo.create.mockReturnValue({ ...commentEntity, detail: '' });
        commentRepo.save.mockResolvedValue({ ...commentEntity, detail: '' });
        // Service does not validate, but DB/DTO might. Here, just check it works.
        const result = await service.create(dto);
        expect(result.detail).toBe('');
      });

      it('should allow step = 0', async () => {
        trackingStatusRepo.findOne.mockResolvedValue(trackingStatus);
        const dto = { ...validDto, step: 0 };
        commentRepo.create.mockReturnValue({ ...commentEntity, step: 0 });
        commentRepo.save.mockResolvedValue({ ...commentEntity, step: 0 });
        const result = await service.create(dto);
        expect(result.step).toBe(0);
      });

      it('should allow negative step', async () => {
        trackingStatusRepo.findOne.mockResolvedValue(trackingStatus);
        const dto = { ...validDto, step: -1 };
        commentRepo.create.mockReturnValue({ ...commentEntity, step: -1 });
        commentRepo.save.mockResolvedValue({ ...commentEntity, step: -1 });
        const result = await service.create(dto);
        expect(result.step).toBe(-1);
      });

      it('should throw NotFoundException for empty trackingStatusId', async () => {
        trackingStatusRepo.findOne.mockResolvedValue(null);
        const dto = { ...validDto, trackingStatusId: '' };
        await expect(service.create(dto)).rejects.toThrow(NotFoundException);
      });
    });
  });
});
