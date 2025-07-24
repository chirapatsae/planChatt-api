import { Test, TestingModule } from '@nestjs/testing';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';

const mockAiService = {
  generateProjectDetail: jest.fn(),
  regenerateField: jest.fn(),
};

describe('AiController', () => {
  let controller: AiController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AiController],
      providers: [{ provide: AiService, useValue: mockAiService }],
    }).compile();

    controller = module.get<AiController>(AiController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
