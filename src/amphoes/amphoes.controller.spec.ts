import { Test, TestingModule } from '@nestjs/testing';
import { AmphoesController } from './amphoes.controller';
import { AmphoesService } from './amphoes.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Amphoe } from './entities/amphoe.entity';

describe('AmphoesController', () => {
  let controller: AmphoesController;

  const mockRepo = () => ({
    findOne: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    find: jest.fn(),
    preload: jest.fn(),
    delete: jest.fn(),
    softDelete: jest.fn(),
    restore: jest.fn(),
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AmphoesController],
      providers: [
        AmphoesService,
        { provide: getRepositoryToken(Amphoe), useFactory: mockRepo },
      ],
    }).compile();

    controller = module.get<AmphoesController>(AmphoesController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
