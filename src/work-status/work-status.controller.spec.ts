import { Test, TestingModule } from '@nestjs/testing';
import { WorkStatusController } from './work-status.controller';
import { WorkStatusService } from './work-status.service';

describe('WorkStatusController', () => {
  let controller: WorkStatusController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [WorkStatusController],
      providers: [WorkStatusService],
    }).compile();

    controller = module.get<WorkStatusController>(WorkStatusController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
