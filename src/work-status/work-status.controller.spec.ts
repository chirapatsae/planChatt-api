import { Test, TestingModule } from '@nestjs/testing';
import { WorkStatusController } from './work-status.controller';
import { WorkStatusService } from './work-status.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { WorkStatus } from './entities/work-status.entity';

describe('WorkStatusController', () => {
  let controller: WorkStatusController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [WorkStatusController],
      providers: [
        WorkStatusService,
        { provide: getRepositoryToken(WorkStatus), useValue: {} },
      ],
    }).compile();

    controller = module.get<WorkStatusController>(WorkStatusController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
