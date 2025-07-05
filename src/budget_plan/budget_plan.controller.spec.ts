import { Test, TestingModule } from '@nestjs/testing';
import { BudgetPlanController } from './budget_plan.controller';
import { BudgetPlanService } from './budget_plan.service';

describe('BudgetPlanController', () => {
  let controller: BudgetPlanController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [BudgetPlanController],
      providers: [BudgetPlanService],
    }).compile();

    controller = module.get<BudgetPlanController>(BudgetPlanController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
