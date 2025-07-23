import { Test, TestingModule } from '@nestjs/testing';
import { ProjectGroupsController } from './project-groups.controller';
import { ProjectGroupsService } from './project-groups.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ProjectGroup } from './entities/project-group.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { BudgetPlan } from 'src/budget_plan/entities/budget_plan.entity';
import { TrackingStatus } from 'src/tracking-status/entities/tracking-status.entity';
import { Strategy } from 'src/strategy/entities/strategy.entity';
import { Tactic } from 'src/tactic/entities/tactic.entity';
import { Plan } from 'src/plan/entities/plan.entity';
import { Budget } from 'src/budget/entities/budget.entity';
import { DataSource } from 'typeorm';

describe('ProjectGroupsController', () => {
  let controller: ProjectGroupsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ProjectGroupsController],
      providers: [
        ProjectGroupsService,
        { provide: getRepositoryToken(ProjectGroup), useValue: {} },
        { provide: getRepositoryToken(WorkHistory), useValue: {} },
        { provide: getRepositoryToken(BudgetPlan), useValue: {} },
        { provide: getRepositoryToken(TrackingStatus), useValue: {} },
        { provide: getRepositoryToken(Strategy), useValue: {} },
        { provide: getRepositoryToken(Tactic), useValue: {} },
        { provide: getRepositoryToken(Plan), useValue: {} },
        { provide: getRepositoryToken(Budget), useValue: {} },
        { provide: DataSource, useValue: {} },
      ],
    }).compile();

    controller = module.get<ProjectGroupsController>(ProjectGroupsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
