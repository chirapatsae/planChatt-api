import { Test, TestingModule } from '@nestjs/testing';
import { TacticController } from './tactic.controller';
import { TacticService } from './tactic.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Tactic } from './entities/tactic.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';

describe('TacticController', () => {
  let controller: TacticController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TacticController],
      providers: [
        TacticService,
        {
          provide: getRepositoryToken(Tactic),
          useValue: {},
        },
        {
          provide: getRepositoryToken(WorkHistory),
          useValue: {},
        },
      ],
    }).compile();

    controller = module.get<TacticController>(TacticController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
