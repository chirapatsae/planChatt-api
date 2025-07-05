import { Test, TestingModule } from '@nestjs/testing';
import { TacticService } from './tactic.service';

describe('TacticService', () => {
  let service: TacticService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [TacticService],
    }).compile();

    service = module.get<TacticService>(TacticService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
