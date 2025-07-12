import { Test, TestingModule } from '@nestjs/testing';
import { GovernmentAgenciesService } from './government-agencies.service';

describe('GovernmentAgenciesService', () => {
  let service: GovernmentAgenciesService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [GovernmentAgenciesService],
    }).compile();

    service = module.get<GovernmentAgenciesService>(GovernmentAgenciesService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
}); 