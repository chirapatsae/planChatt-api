import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AiUsageLogsController } from './ai-usage-logs.controller';
import { AiUsageLogsService } from './ai-usage-logs.service';
import { AiUsageLog } from './entities/ai-usage-log.entity';

describe('AiUsageLogsController', () => {
  let controller: AiUsageLogsController;

  const mockRepository = {
    create: jest.fn(),
    save: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AiUsageLogsController],
      providers: [
        AiUsageLogsService,
        {
          provide: getRepositoryToken(AiUsageLog),
          useValue: mockRepository,
        },
      ],
    }).compile();

    controller = module.get<AiUsageLogsController>(AiUsageLogsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
