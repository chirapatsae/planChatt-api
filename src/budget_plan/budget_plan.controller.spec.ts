import { Test, TestingModule } from '@nestjs/testing';
import { BudgetPlanController } from './budget_plan.controller';
import { BudgetPlanService } from './budget_plan.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BudgetPlan } from './entities/budget_plan.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { DataSource } from 'typeorm';

describe('BudgetPlanController', () => {
  let controller: BudgetPlanController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [BudgetPlanController],
      providers: [
        BudgetPlanService,
        { provide: getRepositoryToken(BudgetPlan), useValue: {} },
        { provide: getRepositoryToken(WorkHistory), useValue: {} },
        { provide: DataSource, useValue: {} },
      ],
    }).compile();

    controller = module.get<BudgetPlanController>(BudgetPlanController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
