import { Test, TestingModule } from '@nestjs/testing';
import { PlanController } from './plan.controller';
import { PlanService } from './plan.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Plan } from './entities/plan.entity';
import { Tactic } from 'src/tactic/entities/tactic.entity';
import { PlanTactic } from './entities/plan-tactic.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';

describe('PlanController', () => {
  let controller: PlanController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PlanController],
      providers: [
        PlanService,
        { provide: getRepositoryToken(Plan), useValue: {} },
        { provide: getRepositoryToken(Tactic), useValue: {} },
        { provide: getRepositoryToken(PlanTactic), useValue: {} },
        { provide: getRepositoryToken(WorkHistory), useValue: {} },
      ],
    }).compile();

    controller = module.get<PlanController>(PlanController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
