import { Test, TestingModule } from '@nestjs/testing';
import { BudgetPlanService } from './budget_plan.service';

describe('BudgetPlanService', () => {
  let service: BudgetPlanService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [BudgetPlanService],
    }).compile();

    service = module.get<BudgetPlanService>(BudgetPlanService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
