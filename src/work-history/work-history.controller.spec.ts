import { Test, TestingModule } from '@nestjs/testing';
import { WorkHistoryController } from './work-history.controller';
import { WorkHistoryService } from './work-history.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { WorkHistory } from './entities/work-history.entity';
import { Amphoe } from 'src/amphoes/entities/amphoe.entity';
import { LocalAdministrativeOrganization } from 'src/local-administrative-organizations/entities/local-administrative-organization.entity';
import { User } from 'src/users/entities/user.entity';
import { WorkStatus } from 'src/work-status/entities/work-status.entity';
import { Role } from 'src/roles/entities/role.entity';
import { GovernmentAgency } from 'src/government-agencies/entities/government-agency.entity';
import { Position } from 'src/positions/entities/position.entity';

describe('WorkHistoryController', () => {
  let controller: WorkHistoryController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [WorkHistoryController],
      providers: [
        WorkHistoryService,
        { provide: getRepositoryToken(WorkHistory), useValue: {} },
        { provide: getRepositoryToken(Amphoe), useValue: {} },
        { provide: getRepositoryToken(LocalAdministrativeOrganization), useValue: {} },
        { provide: getRepositoryToken(User), useValue: {} },
        { provide: getRepositoryToken(WorkStatus), useValue: {} },
        { provide: getRepositoryToken(Role), useValue: {} },
        { provide: getRepositoryToken(GovernmentAgency), useValue: {} },
        { provide: getRepositoryToken(Position), useValue: {} },
      ],
    }).compile();

    controller = module.get<WorkHistoryController>(WorkHistoryController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
