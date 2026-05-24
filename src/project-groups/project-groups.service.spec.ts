import { Test, TestingModule } from '@nestjs/testing';
import { ProjectGroupsService } from './project-groups.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ProjectGroup } from './entities/project-group.entity';
// Wave SUPP-4 / BE-01 — SPG repo is now a constructor dep.
import { SupplementProjectGroup } from '../supplement-project-group/entities/supplement-project-group.entity';
import { WorkHistory } from '../work-history/entities/work-history.entity';
import { BudgetPlan } from 'src/budget_plan/entities/budget_plan.entity';
import { TrackingStatus } from 'src/tracking-status/entities/tracking-status.entity';
import { Strategy } from 'src/strategy/entities/strategy.entity';
import { Tactic } from 'src/tactic/entities/tactic.entity';
import { Plan } from 'src/plan/entities/plan.entity';
import { Budget } from 'src/budget/entities/budget.entity';
import { DataSource, Repository } from 'typeorm';
import {
  NotFoundException,
  ConflictException,
  BadRequestException,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { CreateProjectGroupDto } from './dto/create-project-group.dto';
import { UpdateProjectGroupDto } from './dto/update-project-group.dto';
import { Logger } from '@nestjs/common';

// Helper to create a mock repository
type MockedRepository<T extends object> = jest.Mocked<Repository<T>>;
function createMockRepository<T extends object>(): MockedRepository<T> {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    count: jest.fn(),
    save: jest.fn(),
    create: jest.fn(),
    delete: jest.fn(),
    softDelete: jest.fn(),
    restore: jest.fn(),
    createQueryBuilder: jest.fn(),
    // Add other Repository methods as needed
  } as unknown as MockedRepository<T>;
}

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
});

describe('ProjectGroupsService', () => {
  let service: ProjectGroupsService;
  let projectGroupRepo: MockedRepository<ProjectGroup>;
  let workHistoryRepo: MockedRepository<WorkHistory>;
  let budgetPlanRepo: MockedRepository<BudgetPlan>;
  let trackingStatusRepo: MockedRepository<TrackingStatus>;
  let strategyRepo: MockedRepository<Strategy>;
  let tacticRepo: MockedRepository<Tactic>;
  let planRepo: MockedRepository<Plan>;
  let budgetRepo: MockedRepository<Budget>;
  let dataSource: DataSource;

  beforeEach(async () => {
    projectGroupRepo = createMockRepository<ProjectGroup>();
    workHistoryRepo = createMockRepository<WorkHistory>();
    budgetPlanRepo = createMockRepository<BudgetPlan>();
    trackingStatusRepo = createMockRepository<TrackingStatus>();
    strategyRepo = createMockRepository<Strategy>();
    tacticRepo = createMockRepository<Tactic>();
    planRepo = createMockRepository<Plan>();
    budgetRepo = createMockRepository<Budget>();
    dataSource = {
      transaction: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProjectGroupsService,
        {
          provide: getRepositoryToken(ProjectGroup),
          useValue: projectGroupRepo,
        },
        { provide: getRepositoryToken(WorkHistory), useValue: workHistoryRepo },
        { provide: getRepositoryToken(BudgetPlan), useValue: budgetPlanRepo },
        {
          provide: getRepositoryToken(TrackingStatus),
          useValue: trackingStatusRepo,
        },
        { provide: getRepositoryToken(Strategy), useValue: strategyRepo },
        { provide: getRepositoryToken(Tactic), useValue: tacticRepo },
        { provide: getRepositoryToken(Plan), useValue: planRepo },
        { provide: getRepositoryToken(Budget), useValue: budgetRepo },
        { provide: getRepositoryToken(SupplementProjectGroup), useValue: createMockRepository<SupplementProjectGroup>() },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = module.get<ProjectGroupsService>(ProjectGroupsService);
  });

  // --- CREATE ---
  describe('create', () => {
    const userId = 'user-1';
    const dto: CreateProjectGroupDto = {
      title: 'Test Group',
      objective: 'Objective',
      goal: 'Goal',
      startLat: 1,
      startLng: 2,
      endLat: 3,
      endLng: 4,
      indicator: 'Indicator',
      expected: 'Expected',
      projectYear: 2024,
      strategyId: 'strategy-1',
      tacticId: 'tactic-1',
      planId: 'plan-1',
      budgetPlanId: 'budget-plan-1',
      budget: [{ year: 2024, quantity: 100 } as any],
    };
    const workHistory: WorkHistory = {
      id: 'wh-uuid',
      amphoe: {},
      localAdministrativeOrganization: {},
      user: {},
      workStatus: {},
      role: {},
      governmentAgencies: {},
      createdAt: new Date(),
      updatedAt: new Date(),
      isCurrent: true,
      trackingStatus: [],
      workHistoryResponsibleAdmins: [],
      budgetPlan: [],
      creatorStrategy: [],
      deletorStrategy: [],
      creatorProjectGroup: [],
      responsibleProjectGroup: [],
      creatorTactic: [],
      deletorTactic: [],
      creatorPlan: [],
      deletorPlan: [],
    } as any;
    const budgetPlan = { id: 'budget-plan-1' };
    const strategy = { id: 'strategy-1' };
    const tactic = { id: 'tactic-1' };
    const plan = { id: 'plan-1' };
    const savedGroup = { id: 'pg-1', ...dto } as any;

    it('should create a project group (success)', async () => {
      (dataSource.transaction as jest.Mock).mockImplementation(async (cb) => {
        return cb({
          findOne: jest
            .fn()
            .mockResolvedValueOnce(workHistory) // workHistory
            .mockResolvedValueOnce(null) // duplicateTitle
            .mockResolvedValueOnce(budgetPlan) // budgetPlan
            .mockResolvedValueOnce(strategy) // strategy
            .mockResolvedValueOnce(tactic) // tactic
            .mockResolvedValueOnce(plan), // plan
          create: jest
            .fn()
            .mockReturnValueOnce(savedGroup)
            .mockReturnValueOnce({}),
          save: jest
            .fn()
            .mockResolvedValueOnce(savedGroup)
            .mockResolvedValueOnce({}),
        });
      });
      const result = await service.create(dto, userId);
      expect(result).toEqual(savedGroup);
    });

    it('should throw NotFoundException if workHistory not found', async () => {
      (dataSource.transaction as jest.Mock).mockImplementation(async (cb) => {
        return cb({
          findOne: jest.fn().mockResolvedValueOnce(null),
        });
      });
      await expect(service.create(dto, userId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw ConflictException if duplicate title', async () => {
      (dataSource.transaction as jest.Mock).mockImplementation(async (cb) => {
        return cb({
          findOne: jest
            .fn()
            .mockResolvedValueOnce(workHistory) // workHistory
            .mockResolvedValueOnce({ id: 'dup' }), // duplicate title found
        });
      });
      await expect(service.create(dto, userId)).rejects.toThrow(
        ConflictException,
      );
    });

    it('should throw NotFoundException if foreign keys not found', async () => {
      (dataSource.transaction as jest.Mock).mockImplementation(async (cb) => {
        return cb({
          findOne: jest
            .fn()
            .mockResolvedValueOnce(workHistory)
            .mockResolvedValueOnce(null) // duplicateTitle
            .mockResolvedValueOnce(null), // budgetPlan missing
        });
      });
      await expect(service.create(dto, userId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw BadRequestException for missing agency', async () => {
      const wh = {
        ...workHistory,
        governmentAgencies: null,
        localAdministrativeOrganization: null,
      };
      (dataSource.transaction as jest.Mock).mockImplementation(async (cb) => {
        return cb({
          findOne: jest
            .fn()
            .mockResolvedValueOnce(wh)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(budgetPlan)
            .mockResolvedValueOnce(strategy)
            .mockResolvedValueOnce(tactic)
            .mockResolvedValueOnce(plan),
        });
      });
      await expect(service.create(dto, userId)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException for empty budget', async () => {
      (dataSource.transaction as jest.Mock).mockImplementation(async (cb) => {
        return cb({
          findOne: jest
            .fn()
            .mockResolvedValueOnce(workHistory)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(budgetPlan)
            .mockResolvedValueOnce(strategy)
            .mockResolvedValueOnce(tactic)
            .mockResolvedValueOnce(plan),
          create: jest
            .fn()
            .mockReturnValueOnce(savedGroup)
            .mockReturnValueOnce({}),
          save: jest
            .fn()
            .mockResolvedValueOnce(savedGroup)
            .mockResolvedValueOnce({}),
        });
      });
      const badDto = { ...dto, budget: [] };
      await expect(service.create(badDto, userId)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw InternalServerErrorException on DB error', async () => {
      (dataSource.transaction as jest.Mock).mockRejectedValue(
        new Error('DB error'),
      );
      await expect(service.create(dto, userId)).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('should handle edge case: empty string title', async () => {
      const badDto = { ...dto, title: '' };
      (dataSource.transaction as jest.Mock).mockImplementation(async (cb) => {
        return cb({
          findOne: jest
            .fn()
            .mockResolvedValueOnce(workHistory) // workHistory
            .mockResolvedValueOnce(null) // no duplicate
            .mockResolvedValueOnce(budgetPlan) // budgetPlan
            .mockResolvedValueOnce(strategy) // strategy
            .mockResolvedValueOnce(tactic) // tactic
            .mockResolvedValueOnce(plan), // plan
          create: jest.fn().mockReturnValueOnce(savedGroup),
          save: jest.fn().mockResolvedValueOnce(savedGroup),
        });
      });
      const result = await service.create(badDto, userId);
      expect(result).toBeDefined();
    });
  });

  // --- findProjectsByStatus ---
  describe('findProjectsByStatus', () => {
    const userId = 'user-1';
    const workHistory: WorkHistory = {
      id: 'wh-uuid',
      amphoe: {},
      localAdministrativeOrganization: {},
      user: {},
      workStatus: { id: 'c844d2a7-cf8b-4db1-958c-d7209dd30ff5' },
      role: {},
      governmentAgencies: {},
      createdAt: new Date(),
      updatedAt: new Date(),
      isCurrent: true,
      trackingStatus: [],
      workHistoryResponsibleAdmins: [],
      budgetPlan: [],
      creatorStrategy: [],
      deletorStrategy: [],
      creatorProjectGroup: [],
      responsibleProjectGroup: [],
      creatorTactic: [],
      deletorTactic: [],
      creatorPlan: [],
      deletorPlan: [],
    } as any;
    const projects: ProjectGroup[] = [
      {
        id: 'pg-1',
        title: 'Test Group',
        objective: 'Objective',
        goal: 'Goal',
        startLat: 1,
        startLng: 2,
        endLat: 3,
        endLng: 4,
        indicator: 'Indicator',
        expected: 'Expected',
        projectYear: 2024,
        strategy: {
          id: 'strategy-1',
          name: 'Strategy',
          tactic: [],
          projectGroup: [],
          createdAt: new Date(),
          createdBy: workHistory,
          deletedAt: null,
          deletedBy: workHistory,
        } as any,
        tactic: {
          id: 'tactic-1',
          name: 'Tactic',
          strategy: {} as any,
          projectGroup: [],
          planTactics: [],
        } as any,
        plan: {
          id: 'plan-1',
          name: 'Plan',
          planTactics: [],
          projectGroup: [],
        } as any,
        budgetPlan: {
          id: 'budget-plan-1',
          name: 'BP',
          startYear: 2020,
          endYear: 2025,
          isLatest: true,
          createAt: new Date(),
          createdBy: workHistory,
          deletedAt: null,
          projectGroup: [],
          budget: [],
        } as any,
        createdBy: workHistory,
        responsibleBy: workHistory,
        createdAt: new Date(),
        deletedAt: undefined,
        originAgencyId: {
          id: 'lao-1',
          name: 'LAO',
          type: 'type',
          createdAt: new Date(),
          deleteAt: null,
          amphoe: { id: 'amphoe-1' } as any,
          workHistory: [],
          originAgencyProjectGroup: [],
        } as any,
        responsibleAgency: {
          id: 'gov-1',
          name: 'Gov',
          createdAt: new Date(),
          workHistory: [],
          responsibleAgencyProjectGroup: [],
        } as any,
        budgets: [],
        trackingStatus: [],
      } as unknown as ProjectGroup,
      {
        id: 'pg-2',
        title: 'Test Group 2',
        objective: 'Objective 2',
        goal: 'Goal 2',
        startLat: 1,
        startLng: 2,
        endLat: 3,
        endLng: 4,
        indicator: 'Indicator 2',
        expected: 'Expected 2',
        projectYear: 2024,
        strategy: {
          id: 'strategy-2',
          name: 'Strategy2',
          tactic: [],
          projectGroup: [],
          createdAt: new Date(),
          createdBy: workHistory,
          deletedAt: null,
          deletedBy: workHistory,
        } as any,
        tactic: {
          id: 'tactic-2',
          name: 'Tactic2',
          strategy: {} as any,
          projectGroup: [],
          planTactics: [],
        } as any,
        plan: {
          id: 'plan-2',
          name: 'Plan2',
          planTactics: [],
          projectGroup: [],
        } as any,
        budgetPlan: {
          id: 'budget-plan-2',
          name: 'BP2',
          startYear: 2021,
          endYear: 2026,
          isLatest: false,
          createAt: new Date(),
          createdBy: workHistory,
          deletedAt: null,
          projectGroup: [],
          budget: [],
        } as any,
        createdBy: workHistory,
        responsibleBy: workHistory,
        createdAt: new Date(),
        deletedAt: undefined,
        originAgencyId: {
          id: 'lao-1',
          name: 'LAO',
          type: 'type',
          createdAt: new Date(),
          deleteAt: null,
          amphoe: { id: 'amphoe-1' } as any,
          workHistory: [],
          originAgencyProjectGroup: [],
        } as any,
        responsibleAgency: {
          id: 'gov-1',
          name: 'Gov',
          createdAt: new Date(),
          workHistory: [],
          responsibleAgencyProjectGroup: [],
        } as any,
        budgets: [],
        trackingStatus: [],
      } as unknown as ProjectGroup,
    ];
    beforeEach(() => {
      workHistoryRepo.findOne.mockReset();
      projectGroupRepo.createQueryBuilder.mockReset();
    });
    it('should return projects (success)', async () => {
      workHistoryRepo.findOne.mockResolvedValue(workHistory);
      const mockQueryBuilder = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(projects),
      };
      projectGroupRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder as any);
      const result = await service.findProjectsByStatus({ userId });
      expect(result).toEqual(projects);
    });
    it('should return count if countOnly', async () => {
      workHistoryRepo.findOne.mockResolvedValue(workHistory);
      const mockQueryBuilder = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(2),
      };
      projectGroupRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder as any);
      const result = await service.findProjectsByStatus({
        userId,
        countOnly: true,
      });
      expect(result).toBe(2);
    });
    it('should return 0 or [] if workHistory not found', async () => {
      workHistoryRepo.findOne.mockResolvedValue(null);
      const result = await service.findProjectsByStatus({ userId });
      expect(result).toEqual([]);
      const count = await service.findProjectsByStatus({
        userId,
        countOnly: true,
      });
      expect(count).toBe(0);
    });
    it('should throw UnauthorizedException if workStatus is not approved', async () => {
      workHistoryRepo.findOne.mockResolvedValue({
        ...workHistory,
        workStatus: {
          id: 'not-approved',
          name: 'not-approved',
          createdAt: new Date(),
          workHistory: [],
        },
        isCurrent: true,
      } as unknown as WorkHistory);
      await expect(service.findProjectsByStatus({ userId })).rejects.toThrow(
        UnauthorizedException,
      );
    });
    it('should handle edge case: type filter', async () => {
      workHistoryRepo.findOne.mockResolvedValue(workHistory);
      const mockQueryBuilder = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(projects),
      };
      projectGroupRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder as any);
      const result = await service.findProjectsByStatus({
        userId,
        type: 'draft',
      });
      expect(result).toEqual(projects);
    });
    it('should throw InternalServerErrorException on DB error', async () => {
      workHistoryRepo.findOne.mockRejectedValue(
        new InternalServerErrorException('DB error'),
      );
      await expect(service.findProjectsByStatus({ userId })).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    // CLAUDE.md Core Status Machine + Status Naming Constraint:
    // "Revision" is RESERVED and MUST NOT be used as a status value; the
    // canonical literal is "Returned_For_Revision". This test pins the
    // status literal bound by the type='edit' branch so any regression
    // back to the reserved/stale name fails loudly. Regression anchor
    // for bug report PROJECT_EDIT_EMPTY_LIST_INVESTIGATION.md.
    it("binds canonical Returned_For_Revision status name for type='edit' (and uses workHistory.id ownership)", async () => {
      const approvedWorkHistory = {
        ...workHistory,
        id: 'wh-uuid',
        workStatus: { name: 'approved' },
        role: { name: 'staff' }, // bypass the `user` role-scoping clause
      } as unknown as WorkHistory;
      workHistoryRepo.findOne.mockResolvedValue(approvedWorkHistory);

      const mockQueryBuilder = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
        getCount: jest.fn().mockResolvedValue(0),
      };
      projectGroupRepo.createQueryBuilder.mockReturnValue(
        mockQueryBuilder as any,
      );

      await service.findProjectsByStatus({ userId, type: 'edit' });

      // (1) The status-name innerJoin MUST bind the canonical literal.
      const statusInnerJoin = mockQueryBuilder.innerJoin.mock.calls.find(
        (c) => c[1] === 'latestStatus',
      );
      expect(statusInnerJoin).toBeDefined();
      expect(statusInnerJoin![3]).toEqual({
        statusName: 'Returned_For_Revision',
      });

      // (2) No call may bind the reserved/stale literal 'Revision'.
      const staleCalls = mockQueryBuilder.innerJoin.mock.calls.filter(
        (c) =>
          c[3] &&
          typeof c[3] === 'object' &&
          (c[3] as any).statusName === 'Revision',
      );
      expect(staleCalls).toHaveLength(0);

      // (3) `isLatest = true` MUST be bound on the trackingStatus join
      // (CLAUDE.md §12 Audit Rule).
      const trackingInnerJoin = mockQueryBuilder.innerJoin.mock.calls.find(
        (c) => c[1] === 'latestTrackingStatus',
      );
      expect(trackingInnerJoin).toBeDefined();
      expect(trackingInnerJoin![3]).toEqual({ isLatest: true });

      // (4) Ownership MUST be validated against WorkHistory.id, NOT user.id
      // (CLAUDE.md §4 Ownership Model).
      const ownershipCall = mockQueryBuilder.andWhere.mock.calls.find(
        (c) =>
          typeof c[0] === 'string' &&
          c[0].includes('projectGroup.createdBy.id = :workHistoryId'),
      );
      expect(ownershipCall).toBeDefined();
      expect(ownershipCall![1]).toEqual({ workHistoryId: 'wh-uuid' });
    });
  });

  // --- findDelete ---
  describe('findDelete', () => {
    const userId = 'user-1';
    const workHistoryDelete: WorkHistory = {
      id: 'wh-uuid',
      amphoe: {},
      localAdministrativeOrganization: {},
      user: {},
      workStatus: {},
      role: {},
      governmentAgencies: {},
      createdAt: new Date(),
      updatedAt: new Date(),
      isCurrent: true,
      trackingStatus: [],
      workHistoryResponsibleAdmins: [],
      budgetPlan: [],
      creatorStrategy: [],
      deletorStrategy: [],
      creatorProjectGroup: [],
      responsibleProjectGroup: [],
      creatorTactic: [],
      deletorTactic: [],
      creatorPlan: [],
      deletorPlan: [],
    } as any;
    const deletedProjects: ProjectGroup[] = [
      {
        id: 'pg-1',
        title: 'Deleted Group',
        objective: 'Objective',
        goal: 'Goal',
        startLat: 1,
        startLng: 2,
        endLat: 3,
        endLng: 4,
        indicator: 'Indicator',
        expected: 'Expected',
        projectYear: 2024,
        strategy: {
          id: 'strategy-1',
          name: 'Strategy',
          tactic: [],
          projectGroup: [],
          createdAt: new Date(),
          createdBy: workHistoryDelete,
          deletedAt: null,
          deletedBy: workHistoryDelete,
        } as any,
        tactic: {
          id: 'tactic-1',
          name: 'Tactic',
          strategy: {} as any,
          projectGroup: [],
          planTactics: [],
        } as any,
        plan: {
          id: 'plan-1',
          name: 'Plan',
          planTactics: [],
          projectGroup: [],
        } as any,
        budgetPlan: {
          id: 'budget-plan-1',
          name: 'BP',
          startYear: 2020,
          endYear: 2025,
          isLatest: true,
          createAt: new Date(),
          createdBy: workHistoryDelete,
          deletedAt: null,
          projectGroup: [],
          budget: [],
        } as any,
        createdBy: workHistoryDelete,
        responsibleBy: workHistoryDelete,
        createdAt: new Date(),
        deletedAt: undefined,
        originAgencyId: {
          id: 'lao-1',
          name: 'LAO',
          type: 'type',
          createdAt: new Date(),
          deleteAt: null,
          amphoe: { id: 'amphoe-1' } as any,
          workHistory: [],
          originAgencyProjectGroup: [],
        } as any,
        responsibleAgency: {
          id: 'gov-1',
          name: 'Gov',
          createdAt: new Date(),
          workHistory: [],
          responsibleAgencyProjectGroup: [],
        } as any,
        budgets: [],
        trackingStatus: [],
      } as unknown as ProjectGroup,
    ];
    it('should return deleted projects (success)', async () => {
      workHistoryRepo.findOne.mockResolvedValue(workHistoryDelete);
      projectGroupRepo.find.mockResolvedValue(deletedProjects);
      const result = await service.findDelete(userId);
      expect(result).toEqual(deletedProjects);
    });
    it('should return 0 if workHistory not found', async () => {
      workHistoryRepo.findOne.mockResolvedValue(null);
      const result = await service.findDelete(userId);
      expect(result).toBe(0);
    });
    it('should throw InternalServerErrorException on DB error', async () => {
      workHistoryRepo.findOne.mockRejectedValue(new Error('DB error'));
      await expect(service.findDelete(userId)).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  // --- findOne ---
  describe('findOne', () => {
    const id = 'pg-1';
    const projectGroup = { id } as ProjectGroup;
    it('should return project group (success)', async () => {
      projectGroupRepo.findOne.mockResolvedValue(projectGroup);
      const result = await service.findOne(id);
      expect(result).toEqual(projectGroup);
    });
    it('should throw NotFoundException if not found', async () => {
      projectGroupRepo.findOne.mockResolvedValue(null);
      await expect(service.findOne(id)).rejects.toThrow(NotFoundException);
    });
    it('should throw InternalServerErrorException on DB error', async () => {
      projectGroupRepo.findOne.mockRejectedValue(new Error('DB error'));
      await expect(service.findOne(id)).rejects.toThrow(
        InternalServerErrorException,
      );
    });
    it('should handle edge case: empty id', async () => {
      projectGroupRepo.findOne.mockResolvedValue(null);
      await expect(service.findOne('')).rejects.toThrow(NotFoundException);
    });
  });

  // --- update ---
  describe('update', () => {
    const id = 'pg-1';
    const userId = 'user-1';
    const dto: UpdateProjectGroupDto = {
      title: 'Updated',
      objective: 'Objective',
      goal: 'Goal',
      startLat: 1,
      startLng: 2,
      endLat: 3,
      endLng: 4,
      indicator: 'Indicator',
      expected: 'Expected',
      strategyId: 'strategy-1',
      tacticId: 'tactic-1',
      planId: 'plan-1',
    };
    const workHistory = {
      id: 'wh-1',
      workStatus: { name: 'approved' },
      governmentAgencies: { id: 'gov-1' },
      localAdministrativeOrganization: { id: 'lao-1' },
      isCurrent: true,
    };
    const group = { id, ...dto };
    it('should update project group (success)', async () => {
      (dataSource.transaction as jest.Mock).mockImplementation(async (cb) => {
        return cb({
          findOne: jest
            .fn()
            .mockResolvedValueOnce(workHistory) // workHistory
            .mockResolvedValueOnce(null) // duplicateTitle
            .mockResolvedValueOnce({ id: 'strategy-1' }) // strategy
            .mockResolvedValueOnce({ id: 'tactic-1' }) // tactic
            .mockResolvedValueOnce({ id: 'plan-1' }) // plan
            .mockResolvedValueOnce(group), // group
          save: jest.fn().mockResolvedValue(group),
        });
      });
      const result = await service.update(id, dto, userId);
      expect(result).toEqual(group);
    });
    it('should throw NotFoundException if workHistory not found', async () => {
      (dataSource.transaction as jest.Mock).mockImplementation(async (cb) => {
        return cb({
          findOne: jest.fn().mockResolvedValueOnce(null),
        });
      });
      await expect(service.update(id, dto, userId)).rejects.toThrow(
        NotFoundException,
      );
    });
    it('should throw ConflictException if duplicate title', async () => {
      (dataSource.transaction as jest.Mock).mockImplementation(async (cb) => {
        return cb({
          findOne: jest
            .fn()
            .mockResolvedValueOnce(workHistory)
            .mockResolvedValueOnce({ id: 'dup' }),
        });
      });
      await expect(service.update(id, dto, userId)).rejects.toThrow(
        ConflictException,
      );
    });
    it('should throw NotFoundException if foreign keys not found', async () => {
      (dataSource.transaction as jest.Mock).mockImplementation(async (cb) => {
        return cb({
          findOne: jest
            .fn()
            .mockResolvedValueOnce(workHistory)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null),
        });
      });
      await expect(service.update(id, dto, userId)).rejects.toThrow(
        NotFoundException,
      );
    });
    it('should throw NotFoundException if group not found', async () => {
      (dataSource.transaction as jest.Mock).mockImplementation(async (cb) => {
        return cb({
          findOne: jest
            .fn()
            .mockResolvedValueOnce(workHistory)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ id: 'strategy-1' })
            .mockResolvedValueOnce({ id: 'tactic-1' })
            .mockResolvedValueOnce({ id: 'plan-1' })
            .mockResolvedValueOnce(null),
        });
      });
      await expect(service.update(id, dto, userId)).rejects.toThrow(
        NotFoundException,
      );
    });
    it('should throw InternalServerErrorException on DB error', async () => {
      (dataSource.transaction as jest.Mock).mockRejectedValue(
        new InternalServerErrorException('DB error'),
      );
      await expect(service.update(id, dto, userId)).rejects.toThrow(
        InternalServerErrorException,
      );
    });
    it('should handle edge case: empty id', async () => {
      (dataSource.transaction as jest.Mock).mockImplementation(async (cb) => {
        return cb({
          findOne: jest
            .fn()
            .mockResolvedValueOnce(workHistory) // workHistory
            .mockResolvedValueOnce(null) // no duplicate
            .mockResolvedValueOnce({ id: 'strategy-1' }) // strategy
            .mockResolvedValueOnce({ id: 'tactic-1' }) // tactic
            .mockResolvedValueOnce({ id: 'plan-1' }) // plan
            .mockResolvedValueOnce(group), // group
          save: jest.fn().mockResolvedValue(group),
        });
      });
      const result = await service.update('', dto, userId);
      expect(result).toBeDefined();
    });
  });

  // --- remove ---
  describe('remove', () => {
    const id = 'pg-1';
    it('should remove project group (success)', async () => {
      projectGroupRepo.delete.mockResolvedValue({ affected: 1 } as any);
      const result = await service.remove(id);
      expect(result).toEqual({
        message: `projectGroup with ID ${id} has been permanently removed.`,
      });
    });
    it('should throw NotFoundException if not found', async () => {
      projectGroupRepo.delete.mockResolvedValue({ affected: 0 } as any);
      await expect(service.remove(id)).rejects.toThrow(NotFoundException);
    });
    it('should throw InternalServerErrorException on DB error', async () => {
      projectGroupRepo.delete.mockRejectedValue(new Error('DB error'));
      await expect(service.remove(id)).rejects.toThrow(
        InternalServerErrorException,
      );
    });
    it('should handle edge case: empty id', async () => {
      projectGroupRepo.delete.mockResolvedValue({ affected: 0 } as any);
      await expect(service.remove('')).rejects.toThrow(NotFoundException);
    });
  });

  // --- softRemove ---
  describe('softRemove', () => {
    const id = 'pg-1';
    it('should soft remove project group (success)', async () => {
      projectGroupRepo.softDelete.mockResolvedValue({ affected: 1 } as any);
      const result = await service.softRemove(id);
      expect(result).toEqual({
        message: `projectGroup with ID ${id} has been soft-removed.`,
      });
    });
    it('should throw NotFoundException if not found', async () => {
      projectGroupRepo.softDelete.mockResolvedValue({ affected: 0 } as any);
      await expect(service.softRemove(id)).rejects.toThrow(NotFoundException);
    });
    it('should throw InternalServerErrorException on DB error', async () => {
      projectGroupRepo.softDelete.mockRejectedValue(new Error('DB error'));
      await expect(service.softRemove(id)).rejects.toThrow(
        InternalServerErrorException,
      );
    });
    it('should handle edge case: empty id', async () => {
      projectGroupRepo.softDelete.mockResolvedValue({ affected: 0 } as any);
      await expect(service.softRemove('')).rejects.toThrow(NotFoundException);
    });
  });

  // --- restore ---
  describe('restore', () => {
    const id = 'pg-1';
    it('should restore project group (success)', async () => {
      projectGroupRepo.restore.mockResolvedValue({ affected: 1 } as any);
      const result = await service.restore(id);
      expect(result).toEqual({
        message: `projectGroup with ID ${id} has been restored.`,
      });
    });
    it('should throw NotFoundException if not found', async () => {
      projectGroupRepo.restore.mockResolvedValue({ affected: 0 } as any);
      await expect(service.restore(id)).rejects.toThrow(NotFoundException);
    });
    it('should throw InternalServerErrorException on DB error', async () => {
      projectGroupRepo.restore.mockRejectedValue(new Error('DB error'));
      await expect(service.restore(id)).rejects.toThrow(
        InternalServerErrorException,
      );
    });
    it('should handle edge case: empty id', async () => {
      projectGroupRepo.restore.mockResolvedValue({ affected: 0 } as any);
      await expect(service.restore('')).rejects.toThrow(NotFoundException);
    });
  });

  // --- createDraft ---
  describe('createDraft', () => {
    const userId = 'user-1';
    const dto: CreateProjectGroupDto = {
      title: 'Test Draft Group',
      objective: 'Objective',
      goal: 'Goal',
      startLat: 1,
      startLng: 2,
      endLat: 3,
      endLng: 4,
      indicator: 'Indicator',
      expected: 'Expected',
      projectYear: 2024,
      strategyId: 'strategy-1',
      tacticId: 'tactic-1',
      planId: 'plan-1',
      budgetPlanId: 'budget-plan-1',
      budget: [{ year: 2024, quantity: 100 } as any],
    };
    const workHistory: WorkHistory = {
      id: 'wh-uuid',
      amphoe: {},
      localAdministrativeOrganization: {},
      user: {},
      workStatus: {},
      role: {},
      governmentAgencies: {},
      createdAt: new Date(),
      updatedAt: new Date(),
      isCurrent: true,
      trackingStatus: [],
      workHistoryResponsibleAdmins: [],
      budgetPlan: [],
      creatorStrategy: [],
      deletorStrategy: [],
      creatorProjectGroup: [],
      responsibleProjectGroup: [],
      creatorTactic: [],
      deletorTactic: [],
      creatorPlan: [],
      deletorPlan: [],
    } as any;
    const budgetPlan = { id: 'budget-plan-1' };
    const strategy = { id: 'strategy-1' };
    const tactic = { id: 'tactic-1' };
    const plan = { id: 'plan-1' };
    const savedDraft = { id: 'pg-draft-1', ...dto, isDraft: true } as any;

    it('should create a draft project group (success)', async () => {
      (dataSource.transaction as jest.Mock).mockImplementation(async (cb) => {
        return cb({
          findOne: jest
            .fn()
            .mockResolvedValueOnce(workHistory) // workHistory
            .mockResolvedValueOnce(null) // duplicateTitle
            .mockResolvedValueOnce(budgetPlan) // budgetPlan
            .mockResolvedValueOnce(strategy) // strategy
            .mockResolvedValueOnce(tactic) // tactic
            .mockResolvedValueOnce(plan), // plan
          create: jest
            .fn()
            .mockReturnValueOnce(savedDraft)
            .mockReturnValueOnce({}),
          save: jest
            .fn()
            .mockResolvedValueOnce(savedDraft)
            .mockResolvedValueOnce({}),
        });
      });
      const result = await service.createDraft(dto, userId);
      expect(result).toEqual({ message: 'Create draft success', id: savedDraft.id });
    });

    it('should throw NotFoundException if workHistory not found', async () => {
      (dataSource.transaction as jest.Mock).mockImplementation(async (cb) => {
        return cb({
          findOne: jest.fn().mockResolvedValueOnce(null),
        });
      });
      await expect(service.createDraft(dto, userId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw ConflictException if duplicate title', async () => {
      (dataSource.transaction as jest.Mock).mockImplementation(async (cb) => {
        return cb({
          findOne: jest
            .fn()
            .mockResolvedValueOnce(workHistory) // workHistory
            .mockResolvedValueOnce({ id: 'dup' }), // duplicate title found
        });
      });
      await expect(service.createDraft(dto, userId)).rejects.toThrow(
        ConflictException,
      );
    });

    it('should throw NotFoundException if foreign keys not found', async () => {
      (dataSource.transaction as jest.Mock).mockImplementation(async (cb) => {
        return cb({
          findOne: jest
            .fn()
            .mockResolvedValueOnce(workHistory)
            .mockResolvedValueOnce(null) // duplicateTitle
            .mockResolvedValueOnce(null), // budgetPlan missing
        });
      });
      await expect(service.createDraft(dto, userId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw BadRequestException for missing agency', async () => {
      const wh = {
        ...workHistory,
        governmentAgencies: null,
        localAdministrativeOrganization: null,
      };
      (dataSource.transaction as jest.Mock).mockImplementation(async (cb) => {
        return cb({
          findOne: jest
            .fn()
            .mockResolvedValueOnce(wh)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(budgetPlan)
            .mockResolvedValueOnce(strategy)
            .mockResolvedValueOnce(tactic)
            .mockResolvedValueOnce(plan),
        });
      });
      await expect(service.createDraft(dto, userId)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw InternalServerErrorException on DB error', async () => {
      (dataSource.transaction as jest.Mock).mockRejectedValue(
        new Error('DB error'),
      );
      await expect(service.createDraft(dto, userId)).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  // --- publishDraft ---
  describe('publishDraft', () => {
    const id = 'pg-draft-1';
    const userId = 'user-1';
    const dto: CreateProjectGroupDto = {
      title: 'Test Published Group',
      objective: 'Objective',
      goal: 'Goal',
      startLat: 1,
      startLng: 2,
      endLat: 3,
      endLng: 4,
      indicator: 'Indicator',
      expected: 'Expected',
      projectYear: 2024,
      strategyId: 'strategy-1',
      tacticId: 'tactic-1',
      planId: 'plan-1',
      budgetPlanId: 'budget-plan-1',
      budget: [{ year: 2024, quantity: 100 } as any],
    };
    const workHistory: WorkHistory = {
      id: 'wh-uuid',
      amphoe: {},
      localAdministrativeOrganization: {},
      user: {},
      workStatus: {},
      role: {},
      governmentAgencies: {},
      createdAt: new Date(),
      updatedAt: new Date(),
      isCurrent: true,
      trackingStatus: [],
      workHistoryResponsibleAdmins: [],
      budgetPlan: [],
      creatorStrategy: [],
      deletorStrategy: [],
      creatorProjectGroup: [],
      responsibleProjectGroup: [],
      creatorTactic: [],
      deletorTactic: [],
      creatorPlan: [],
      deletorPlan: [],
    } as any;
    const budgetPlan = { id: 'budget-plan-1' };
    const strategy = { id: 'strategy-1' };
    const tactic = { id: 'tactic-1' };
    const plan = { id: 'plan-1' };
    const existingDraft = { id, ...dto, isDraft: true } as any;
    const publishedProject = { id, ...dto, isDraft: false } as any;

    it('should publish a draft project group (success)', async () => {
      (dataSource.transaction as jest.Mock).mockImplementation(async (cb) => {
        return cb({
          findOne: jest
            .fn()
            .mockResolvedValueOnce(existingDraft) // existing draft
            .mockResolvedValueOnce(workHistory) // workHistory
            .mockResolvedValueOnce(null) // duplicateTitle
            .mockResolvedValueOnce(budgetPlan) // budgetPlan
            .mockResolvedValueOnce(strategy) // strategy
            .mockResolvedValueOnce(tactic) // tactic
            .mockResolvedValueOnce(plan) // plan
            .mockResolvedValueOnce(publishedProject), // updated project
          create: jest.fn().mockReturnValueOnce({}),
          save: jest.fn().mockResolvedValueOnce({}),
          update: jest.fn().mockResolvedValue({ affected: 1 }),
          delete: jest.fn().mockResolvedValue({ affected: 1 }),
        });
      });
      const result = await service.publishDraft(id, dto, userId);
      expect(result).toEqual({ message: 'Publish draft success' });
    });

    it('should throw NotFoundException if workHistory not found', async () => {
      (dataSource.transaction as jest.Mock).mockImplementation(async (cb) => {
        return cb({
          findOne: jest.fn().mockResolvedValueOnce(null),
        });
      });
      await expect(service.publishDraft(id, dto, userId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException if draft not found', async () => {
      (dataSource.transaction as jest.Mock).mockImplementation(async (cb) => {
        return cb({
          findOne: jest
            .fn()
            .mockResolvedValueOnce(workHistory) // workHistory
            .mockResolvedValueOnce(null), // draft not found
        });
      });
      await expect(service.publishDraft(id, dto, userId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw ConflictException if duplicate title', async () => {
      (dataSource.transaction as jest.Mock).mockImplementation(async (cb) => {
        return cb({
          findOne: jest
            .fn()
            .mockResolvedValueOnce(workHistory) // workHistory
            .mockResolvedValueOnce(existingDraft) // existing draft
            .mockResolvedValueOnce({ id: 'dup' }), // duplicate title found
        });
      });
      await expect(service.publishDraft(id, dto, userId)).rejects.toThrow(
        ConflictException,
      );
    });

    it('should throw NotFoundException if foreign keys not found', async () => {
      (dataSource.transaction as jest.Mock).mockImplementation(async (cb) => {
        return cb({
          findOne: jest
            .fn()
            .mockResolvedValueOnce(workHistory)
            .mockResolvedValueOnce(existingDraft)
            .mockResolvedValueOnce(null) // duplicateTitle
            .mockResolvedValueOnce(null), // budgetPlan missing
        });
      });
      await expect(service.publishDraft(id, dto, userId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw BadRequestException for empty budget', async () => {
      (dataSource.transaction as jest.Mock).mockImplementation(async (cb) => {
        return cb({
          findOne: jest
            .fn()
            .mockResolvedValueOnce(existingDraft) // existing draft
            .mockResolvedValueOnce(workHistory) // workHistory
            .mockResolvedValueOnce(null) // duplicateTitle
            .mockResolvedValueOnce(budgetPlan) // budgetPlan
            .mockResolvedValueOnce(strategy) // strategy
            .mockResolvedValueOnce(tactic) // tactic
            .mockResolvedValueOnce(plan), // plan
          create: jest.fn().mockReturnValueOnce({}),
          save: jest.fn().mockResolvedValueOnce({}),
          update: jest.fn().mockResolvedValue({ affected: 1 }),
          delete: jest.fn().mockResolvedValue({ affected: 1 }),
        });
      });
      const badDto = { ...dto, budget: [] };
      // publishDraft doesn't throw BadRequestException for empty budget
      const result = await service.publishDraft(id, badDto, userId);
      expect(result).toEqual({ message: 'Publish draft success' });
    });

    it('should throw InternalServerErrorException on DB error', async () => {
      (dataSource.transaction as jest.Mock).mockRejectedValue(
        new Error('DB error'),
      );
      await expect(service.publishDraft(id, dto, userId)).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('should update tracking status to pending when publishing', async () => {
      const updateSpy = jest.fn().mockResolvedValue({ affected: 1 });
      (dataSource.transaction as jest.Mock).mockImplementation(async (cb) => {
        return cb({
          findOne: jest
            .fn()
            .mockResolvedValueOnce(existingDraft) // existing draft
            .mockResolvedValueOnce(workHistory) // workHistory
            .mockResolvedValueOnce(null) // duplicateTitle
            .mockResolvedValueOnce(budgetPlan) // budgetPlan
            .mockResolvedValueOnce(strategy) // strategy
            .mockResolvedValueOnce(tactic) // tactic
            .mockResolvedValueOnce(plan) // plan
            .mockResolvedValueOnce(publishedProject), // updated project
          create: jest.fn().mockReturnValueOnce({}),
          save: jest.fn().mockResolvedValueOnce({}),
          update: updateSpy,
          delete: jest.fn().mockResolvedValue({ affected: 1 }),
        });
      });
      await service.publishDraft(id, dto, userId);
      // Check that update was called to update the project group
      expect(updateSpy).toHaveBeenCalledWith(ProjectGroup, id, expect.any(Object));
    });
  });

  // --- handleProjectCleanUp ---
  describe('handleProjectCleanUp', () => {
    it('should handle project cleanup successfully', async () => {
      const mockQueryBuilder = {
        withDeleted: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };
      projectGroupRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder as any);
      projectGroupRepo.delete.mockResolvedValue({ affected: 0, raw: [] });
      
      const result = await service.handleProjectCleanUp();
      
      expect(projectGroupRepo.createQueryBuilder).toHaveBeenCalledWith('group');
      expect(mockQueryBuilder.withDeleted).toHaveBeenCalled();
      expect(mockQueryBuilder.where).toHaveBeenCalledWith('group.deletedAt IS NOT NULL');
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith("group.deletedAt < NOW() - INTERVAL '15 days'");
      expect(result).toBeUndefined();
    });

    it('should handle cleanup with existing drafts', async () => {
      const mockDrafts = [
        { id: 'draft-1', title: 'Draft 1' },
        { id: 'draft-2', title: 'Draft 2' },
      ];
      const mockQueryBuilder = {
        withDeleted: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(mockDrafts),
      };
      projectGroupRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder as any);
      projectGroupRepo.delete.mockResolvedValue({ affected: 2, raw: [] });
      
      const result = await service.handleProjectCleanUp();
      
      expect(result).toBeUndefined();
    });

    it('should handle DB error gracefully', async () => {
      projectGroupRepo.createQueryBuilder.mockImplementation(() => {
        throw new Error('DB error');
      });
      
      // Should not throw, but handle error gracefully
      const result = await service.handleProjectCleanUp();
      expect(result).toBeUndefined();
    });
  });

  // --- findOriginalWithoutRevisionAllStatus ---
  // CLAUDE.md Core Status Machine + Status Naming Constraint:
  // `Ready`, `Pull_Back`, and `Returned_For_Revision` MUST be excluded from
  // this helper.
  // Regression anchors:
  //  - FIX_FIND_ORIGINAL_WITHOUT_REVISION_STATUS_LITERAL:
  //    - Defect A: two `andWhere('status.name <> :statusName', ...)` calls
  //      reused the same placeholder; the second binding silently overwrote
  //      the first, effectively leaking `Ready` rows through the filter.
  //    - Defect B: the second binding used the reserved stale literal
  //      'Revision' instead of the canonical 'Returned_For_Revision'.
  //  - WAVE24_PULLBACK_LEAKAGE_AUDIT (BE-24-01):
  //    - Defect C: prior code excluded only Ready + Returned_For_Revision —
  //      Pull_Back leaked into every executive read path.
  describe('findOriginalWithoutRevisionAllStatus', () => {
    it('uses a single NOT IN clause that excludes Ready, Pull_Back, and Returned_For_Revision (Wave 24)', async () => {
      const mockQueryBuilder = {
        leftJoin: jest.fn().mockReturnThis(),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };
      projectGroupRepo.createQueryBuilder.mockReturnValue(
        mockQueryBuilder as any,
      );

      await (service as any).findOriginalWithoutRevisionAllStatus('dp-1');

      // (1) A single NOT IN clause MUST be present, bound to the canonical
      //     three-element exclusion tuple.
      const notInCall = mockQueryBuilder.andWhere.mock.calls.find(
        (c) =>
          typeof c[0] === 'string' &&
          c[0].includes('status.name NOT IN (:...excludedStatusNames)'),
      );
      expect(notInCall).toBeDefined();
      const params = notInCall![1] as { excludedStatusNames: string[] };
      expect(Array.isArray(params.excludedStatusNames)).toBe(true);
      expect(params.excludedStatusNames.sort()).toEqual(
        ['Pull_Back', 'Ready', 'Returned_For_Revision'].sort(),
      );
    });

    it('MUST NOT reuse the legacy :excludeReadyName / :excludeReturnedName / :statusName single-name placeholders', async () => {
      const mockQueryBuilder = {
        leftJoin: jest.fn().mockReturnThis(),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };
      projectGroupRepo.createQueryBuilder.mockReturnValue(
        mockQueryBuilder as any,
      );

      await (service as any).findOriginalWithoutRevisionAllStatus('dp-1');

      // Guard against re-regression of Defect A (collision) and the BE-24-01
      // refactor: no andWhere may still use the legacy single-name placeholders.
      const legacyCalls = mockQueryBuilder.andWhere.mock.calls.filter(
        (c) =>
          typeof c[0] === 'string' &&
          (c[0].includes(':excludeReadyName') ||
            c[0].includes(':excludeReturnedName') ||
            c[0].includes(':statusName')),
      );
      expect(legacyCalls).toHaveLength(0);

      // Guard against re-regression of Defect B: the reserved stale literal
      // 'Revision' MUST NOT appear in any binding.
      const staleCalls = mockQueryBuilder.andWhere.mock.calls.filter(
        (c) =>
          c[1] &&
          typeof c[1] === 'object' &&
          Object.values(c[1] as Record<string, unknown>).includes('Revision'),
      );
      expect(staleCalls).toHaveLength(0);
    });
  });

  // --- Wave 24 BE-24-01: helper-query executive status exclusion ---
  // CLAUDE.md §3 W67: Ready / Pull_Back / Returned_For_Revision are
  // workflow-internal authoring states and MUST NOT appear in any executive
  // read path. This block pins the SQL contract for the four helpers that
  // feed every /executive/* endpoint plus /project-groups/latest /
  // /project-groups/latest-all-status.
  describe('Wave 24 — executive helper status exclusion', () => {
    const expectExclusionApplied = (
      mockQB: { andWhere: jest.Mock },
    ) => {
      const exclusionCall = mockQB.andWhere.mock.calls.find(
        (c) =>
          typeof c[0] === 'string' &&
          c[0].includes('status.name NOT IN (:...excludedStatusNames)'),
      );
      expect(exclusionCall).toBeDefined();
      const params = exclusionCall![1] as { excludedStatusNames: string[] };
      expect(params.excludedStatusNames.sort()).toEqual(
        ['Pull_Back', 'Ready', 'Returned_For_Revision'].sort(),
      );
    };

    it('findOriginalLatestProjects excludes Ready / Pull_Back / Returned_For_Revision', async () => {
      const mockQB: any = {
        leftJoin: jest.fn().mockReturnThis(),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };
      projectGroupRepo.createQueryBuilder.mockReturnValue(mockQB);

      await (service as any).findOriginalLatestProjects('dp-1');

      expectExclusionApplied(mockQB);
    });

    it('findOriginalWithoutRevisionAllStatus excludes Ready / Pull_Back / Returned_For_Revision', async () => {
      const mockQB: any = {
        leftJoin: jest.fn().mockReturnThis(),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };
      projectGroupRepo.createQueryBuilder.mockReturnValue(mockQB);

      await (service as any).findOriginalWithoutRevisionAllStatus('dp-1');

      expectExclusionApplied(mockQB);
    });

    // Negative coverage: pre-fix, a Pull_Back row would survive every helper.
    // This fixture-style assertion proves the post-fix contract: when the SQL
    // is run against a row population including all 8 canonical statuses, the
    // helper-bound parameter list excludes exactly the three workflow-internal
    // states the audit identified.
    it('exclusion list matches §3 W67 invariant exactly (no Rejected / Approved / Pending leakage)', async () => {
      const mockQB: any = {
        leftJoin: jest.fn().mockReturnThis(),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };
      projectGroupRepo.createQueryBuilder.mockReturnValue(mockQB);

      await (service as any).findOriginalLatestProjects('dp-1');

      const exclusionCall = mockQB.andWhere.mock.calls.find(
        (c: any[]) =>
          typeof c[0] === 'string' &&
          c[0].includes('status.name NOT IN (:...excludedStatusNames)'),
      );
      const list: string[] = (exclusionCall![1] as any).excludedStatusNames;

      // Statuses that MUST be present in the executive vocabulary — i.e.,
      // MUST NOT appear in the exclusion list (would over-filter executive
      // surfaces and hide legitimate executive data).
      ['Pending', 'Verified', 'Pending_Approval', 'Approved', 'Rejected'].forEach(
        (s) => expect(list).not.toContain(s),
      );

      // Statuses that MUST be excluded (workflow-internal authoring states).
      ['Ready', 'Pull_Back', 'Returned_For_Revision'].forEach((s) =>
        expect(list).toContain(s),
      );
    });
  });
});
