import { Test, TestingModule } from '@nestjs/testing';
import { TrackingStatusController } from './tracking-status.controller';
import { TrackingStatusService } from './tracking-status.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { TrackingStatus } from './entities/tracking-status.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { Status } from 'src/status/entities/status.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { Comment } from 'src/comments/entities/comment.entity';

describe('TrackingStatusController', () => {
  let controller: TrackingStatusController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TrackingStatusController],
      providers: [
        TrackingStatusService,
        { provide: getRepositoryToken(TrackingStatus), useValue: {} },
        { provide: getRepositoryToken(ProjectGroup), useValue: {} },
        { provide: getRepositoryToken(Status), useValue: {} },
        { provide: getRepositoryToken(WorkHistory), useValue: {} },
        { provide: getRepositoryToken(Comment), useValue: {} },
      ],
    }).compile();

    controller = module.get<TrackingStatusController>(TrackingStatusController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
