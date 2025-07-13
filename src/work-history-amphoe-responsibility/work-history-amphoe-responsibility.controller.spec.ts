import { Test, TestingModule } from '@nestjs/testing';
import { WorkHistoryAmphoeResponsibilityController } from './work-history-amphoe-responsibility.controller';
import { WorkHistoryAmphoeResponsibilityService } from './work-history-amphoe-responsibility.service';

describe('WorkHistoryAmphoeResponsibilityController', () => {
  let controller: WorkHistoryAmphoeResponsibilityController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [WorkHistoryAmphoeResponsibilityController],
      providers: [WorkHistoryAmphoeResponsibilityService],
    }).compile();

    controller = module.get<WorkHistoryAmphoeResponsibilityController>(WorkHistoryAmphoeResponsibilityController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
