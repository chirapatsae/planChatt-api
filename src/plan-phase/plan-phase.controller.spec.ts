import { Test, TestingModule } from '@nestjs/testing';
import { PlanPhaseController } from './plan-phase.controller';
import { PlanPhaseService } from './plan-phase.service';

describe('PlanPhaseController', () => {
  let controller: PlanPhaseController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PlanPhaseController],
      providers: [PlanPhaseService],
    }).compile();

    controller = module.get<PlanPhaseController>(PlanPhaseController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
