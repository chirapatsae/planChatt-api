import { Test, TestingModule } from '@nestjs/testing';
import { AmphoesController } from './amphoes.controller';
import { AmphoesService } from './amphoes.service';

describe('AmphoesController', () => {
  let controller: AmphoesController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AmphoesController],
      providers: [AmphoesService],
    }).compile();

    controller = module.get<AmphoesController>(AmphoesController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
