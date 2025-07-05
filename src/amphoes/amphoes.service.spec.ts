import { Test, TestingModule } from '@nestjs/testing';
import { AmphoesService } from './amphoes.service';

describe('AmphoesService', () => {
  let service: AmphoesService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [AmphoesService],
    }).compile();

    service = module.get<AmphoesService>(AmphoesService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
