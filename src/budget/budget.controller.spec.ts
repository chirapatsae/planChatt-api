import { Test, TestingModule } from '@nestjs/testing';
import { BudgetController } from './budget.controller';
import { BudgetService } from './budget.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Budget } from './entities/budget.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';

describe('BudgetController', () => {
  let controller: BudgetController;

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
      controllers: [BudgetController],
      providers: [
        BudgetService,
        { provide: getRepositoryToken(Budget), useFactory: mockRepo },
        { provide: getRepositoryToken(ProjectGroup), useFactory: mockRepo },
      ],
    }).compile();

    controller = module.get<BudgetController>(BudgetController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
