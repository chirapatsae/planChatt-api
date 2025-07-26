import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AiUsageQuotasController } from './ai-usage-quotas.controller';
import { AiUsageQuotasService } from './ai-usage-quotas.service';
import { AiUsageQuota } from './entities/ai-usage-quota.entity';
import { User } from '../users/entities/user.entity';

describe('AiUsageQuotasController', () => {
  let controller: AiUsageQuotasController;
  let service: AiUsageQuotasService;

  const mockAiUsageQuotaRepository = {
    create: jest.fn(),
    save: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    preload: jest.fn(),
    delete: jest.fn(),
    softRemove: jest.fn(),
    restore: jest.fn(),
  };

  const mockUserRepository = {
    findOne: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AiUsageQuotasController],
      providers: [
        AiUsageQuotasService,
        {
          provide: getRepositoryToken(AiUsageQuota),
          useValue: mockAiUsageQuotaRepository,
        },
        {
          provide: getRepositoryToken(User),
          useValue: mockUserRepository,
        },
      ],
    }).compile();

    controller = module.get<AiUsageQuotasController>(AiUsageQuotasController);
    service = module.get<AiUsageQuotasService>(AiUsageQuotasService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('should have service defined', () => {
    expect(service).toBeDefined();
  });
});
