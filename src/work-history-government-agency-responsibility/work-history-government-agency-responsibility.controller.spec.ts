import { Test, TestingModule } from '@nestjs/testing';
import { WorkHistoryGovernmentAgencyResponsibilityController } from './work-history-government-agency-responsibility.controller';
import { WorkHistoryGovernmentAgencyResponsibilityService } from './work-history-government-agency-responsibility.service';

describe('WorkHistoryGovernmentAgencyResponsibilityController', () => {
  let controller: WorkHistoryGovernmentAgencyResponsibilityController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [WorkHistoryGovernmentAgencyResponsibilityController],
      providers: [WorkHistoryGovernmentAgencyResponsibilityService],
    }).compile();

    controller = module.get<WorkHistoryGovernmentAgencyResponsibilityController>(WorkHistoryGovernmentAgencyResponsibilityController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
