import { Test, TestingModule } from '@nestjs/testing';
import { WorkHistoryAmphoeResponsibilityController } from './work-history-amphoe-responsibility.controller';
import { WorkHistoryAmphoeResponsibilityService } from './work-history-amphoe-responsibility.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { WorkHistoryAmphoeResponsibility } from './entities/work-history-amphoe-responsibility.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { Amphoe } from 'src/amphoes/entities/amphoe.entity';
import { User } from 'src/users/entities/user.entity';

describe('WorkHistoryAmphoeResponsibilityController', () => {
  let controller: WorkHistoryAmphoeResponsibilityController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [WorkHistoryAmphoeResponsibilityController],
      providers: [
        WorkHistoryAmphoeResponsibilityService,
        {
          provide: getRepositoryToken(WorkHistoryAmphoeResponsibility),
          useValue: {},
        },
        { provide: getRepositoryToken(WorkHistory), useValue: {} },
        { provide: getRepositoryToken(Amphoe), useValue: {} },
        { provide: getRepositoryToken(User), useValue: {} },
      ],
    }).compile();

    controller = module.get<WorkHistoryAmphoeResponsibilityController>(
      WorkHistoryAmphoeResponsibilityController,
    );
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
