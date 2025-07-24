import { Test, TestingModule } from '@nestjs/testing';
import { CommentsController } from './comments.controller';
import { CommentsService } from './comments.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { TrackingStatus } from 'src/tracking-status/entities/tracking-status.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { Comment } from './entities/comment.entity';

const mockRepo = () => ({
  findOne: jest.fn(),
  create: jest.fn(),
  save: jest.fn(),
});

describe('CommentsController', () => {
  let controller: CommentsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [CommentsController],
      providers: [
        CommentsService,
        { provide: getRepositoryToken(WorkHistory), useValue: mockRepo() },
        { provide: getRepositoryToken(TrackingStatus), useValue: mockRepo() },
        { provide: getRepositoryToken(ProjectGroup), useValue: mockRepo() },
        { provide: getRepositoryToken(Comment), useValue: mockRepo() },
      ],
    }).compile();

    controller = module.get<CommentsController>(CommentsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
