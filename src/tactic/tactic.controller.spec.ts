import { Test, TestingModule } from '@nestjs/testing';
import { TacticController } from './tactic.controller';
import { TacticService } from './tactic.service';

describe('TacticController', () => {
  let controller: TacticController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TacticController],
      providers: [TacticService],
    }).compile();

    controller = module.get<TacticController>(TacticController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
