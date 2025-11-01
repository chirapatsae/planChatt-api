import { Test, TestingModule } from '@nestjs/testing';
import { PlanPhaseService } from './plan-phase.service';

describe('PlanPhaseService', () => {
  let service: PlanPhaseService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PlanPhaseService],
    }).compile();

    service = module.get<PlanPhaseService>(PlanPhaseService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
