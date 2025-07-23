import { Test, TestingModule } from '@nestjs/testing';
import { StrategyController } from './strategy.controller';
import { StrategyService } from './strategy.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Strategy } from './entities/strategy.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';

describe('StrategyController', () => {
  let controller: StrategyController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [StrategyController],
      providers: [
        StrategyService,
        {
          provide: getRepositoryToken(Strategy),
          useValue: {},
        },
        {
          provide: getRepositoryToken(WorkHistory),
          useValue: {},
        },
      ],
    }).compile();

    controller = module.get<StrategyController>(StrategyController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
