import { Test, TestingModule } from '@nestjs/testing';
import { WorkHistoryAmphoeResponsibilityService } from './work-history-amphoe-responsibility.service';

describe('WorkHistoryAmphoeResponsibilityService', () => {
  let service: WorkHistoryAmphoeResponsibilityService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [WorkHistoryAmphoeResponsibilityService],
    }).compile();

    service = module.get<WorkHistoryAmphoeResponsibilityService>(WorkHistoryAmphoeResponsibilityService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
