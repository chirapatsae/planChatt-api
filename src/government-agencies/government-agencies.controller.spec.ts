import { Test, TestingModule } from '@nestjs/testing';
import { GovernmentAgenciesController } from './government-agencies.controller';
import { GovernmentAgenciesService } from './government-agencies.service';

describe('GovernmentAgenciesController', () => {
  let controller: GovernmentAgenciesController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [GovernmentAgenciesController],
      providers: [GovernmentAgenciesService],
    }).compile();

    controller = module.get<GovernmentAgenciesController>(GovernmentAgenciesController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
}); 