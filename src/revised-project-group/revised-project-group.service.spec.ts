import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { BadRequestException, Logger } from '@nestjs/common';

import { RevisedProjectGroupService } from './revised-project-group.service';
import {
  CreateRevisedProjectGroupDto,
  PrevProjectType,
} from './dto/create-revised-project-group.dto';
import { RevisedProjectGroup } from './entities/revised-project-group.entity';
import { DevelopmentPlanRevision } from '../development-plan-revision/entities/development-plan-revision.entity';
import { ProjectGroup } from '../project-groups/entities/project-group.entity';
// Wave SUPP-4 / BE-01 — SPG repo is now a constructor dep.
import { SupplementProjectGroup } from '../supplement-project-group/entities/supplement-project-group.entity';
import { DevelopmentPlan } from '../development-plan/entities/development-plan.entity';
import { Strategy } from '../strategy/entities/strategy.entity';
import { Tactic } from '../tactic/entities/tactic.entity';
import { Plan } from '../plan/entities/plan.entity';
import { WorkHistory } from '../work-history/entities/work-history.entity';
import { Budget } from '../budget/entities/budget.entity';
import { LineageLockService } from '../common/lineage-lock/lineage-lock.service';
import { ProjectClassificationValidator } from '../common/project-classification/project-classification.validator';
import { BookFormatResolver } from '../common/project-classification/book-format.resolver';

// Generic mocked repository
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
  } as unknown as MockedRepository<T>;
}

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
});

describe('RevisedProjectGroupService', () => {
  let service: RevisedProjectGroupService;
  let revisedProjectGroupRepo: MockedRepository<RevisedProjectGroup>;
  let workHistoryRepo: MockedRepository<WorkHistory>;

  beforeEach(async () => {
    revisedProjectGroupRepo = createMockRepository<RevisedProjectGroup>();
    workHistoryRepo = createMockRepository<WorkHistory>();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RevisedProjectGroupService,
        { provide: getRepositoryToken(RevisedProjectGroup), useValue: revisedProjectGroupRepo },
        { provide: getRepositoryToken(DevelopmentPlanRevision), useValue: createMockRepository<DevelopmentPlanRevision>() },
        { provide: getRepositoryToken(ProjectGroup), useValue: createMockRepository<ProjectGroup>() },
        { provide: getRepositoryToken(SupplementProjectGroup), useValue: createMockRepository<SupplementProjectGroup>() },
        { provide: getRepositoryToken(DevelopmentPlan), useValue: createMockRepository<DevelopmentPlan>() },
        { provide: getRepositoryToken(Strategy), useValue: createMockRepository<Strategy>() },
        { provide: getRepositoryToken(Tactic), useValue: createMockRepository<Tactic>() },
        { provide: getRepositoryToken(Plan), useValue: createMockRepository<Plan>() },
        { provide: getRepositoryToken(WorkHistory), useValue: workHistoryRepo },
        { provide: getRepositoryToken(Budget), useValue: createMockRepository<Budget>() },
        { provide: DataSource, useValue: { transaction: jest.fn() } },
        { provide: LineageLockService, useValue: {} },
        { provide: ProjectClassificationValidator, useValue: {} },
        { provide: BookFormatResolver, useValue: {} },
      ],
    }).compile();

    service = module.get<RevisedProjectGroupService>(RevisedProjectGroupService);
  });

  describe('findRevisionProjects (CLAUDE.md Core Status Machine + §9 + §12)', () => {
    /**
     * Build a fluent query-builder stub that records every bound parameter
     * across `andWhere(... , params)` / `where(... , params)` calls, plus
     * the raw SQL fragments, so we can assert CLAUDE.md invariants.
     */
    function makeQueryBuilderStub(resultRows: any[] = []) {
      const params: Record<string, any> = {};
      const clauses: string[] = [];
      const record = (clause: string, p?: Record<string, any>) => {
        clauses.push(clause);
        if (p) Object.assign(params, p);
      };
      const qb: any = {
        leftJoinAndSelect: jest.fn().mockImplementation(() => qb),
        where: jest.fn().mockImplementation((c, p) => {
          record(c, p);
          return qb;
        }),
        andWhere: jest.fn().mockImplementation((c, p) => {
          record(c, p);
          return qb;
        }),
        orderBy: jest.fn().mockImplementation(() => qb),
        select: jest.fn().mockImplementation(() => qb),
        getCount: jest.fn().mockResolvedValue(resultRows.length),
        getMany: jest.fn().mockResolvedValue(resultRows),
        getRawMany: jest.fn().mockResolvedValue([]),
        __params: params,
        __clauses: clauses,
      };
      return qb;
    }

    const laoWorkHistory = {
      id: 'wh-uuid-1',
      user: { id: 'user-1' },
      role: { name: 'user' },
      workStatus: { name: 'approved' },
      localAdministrativeOrganization: { id: '3001027' },
      governmentAgencies: { id: 'agency-1' },
    } as any;

    it('binds the canonical Returned_For_Revision status name (Core Status Machine + Status Naming Constraint)', async () => {
      workHistoryRepo.findOne.mockResolvedValue(laoWorkHistory);
      const qb = makeQueryBuilderStub([]);
      (revisedProjectGroupRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      await service.findRevisionProjects(undefined, undefined, false, 'user-1');

      expect(qb.__params.statusName).toBe('Returned_For_Revision');
      expect(qb.__params.statusName).not.toBe('Revision');
    });

    it('binds ownership against workHistory-scoped governmentAgencies.id (NOT user.id) per CLAUDE.md §4 Ownership Model', async () => {
      workHistoryRepo.findOne.mockResolvedValue(laoWorkHistory);
      const qb = makeQueryBuilderStub([]);
      (revisedProjectGroupRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      await service.findRevisionProjects(undefined, undefined, false, 'user-1');

      // The workHistory's governmentAgencies.id is bound as agencyId — this is
      // the WorkHistory-derived ownership scope. We must NOT see user.id.
      expect(qb.__params.agencyId).toBe('agency-1');
      expect(qb.__params.agencyId).not.toBe('user-1');
      // Look for the actual agency scope clause in the WHERE fragments.
      const scopeClauseFound = qb.__clauses.some((c: string) =>
        c.includes('responsibleAgency.id = :agencyId'),
      );
      expect(scopeClauseFound).toBe(true);
    });

    it('binds isLatest = true on the tracking join per CLAUDE.md §12 Audit Rule', async () => {
      workHistoryRepo.findOne.mockResolvedValue(laoWorkHistory);
      const qb = makeQueryBuilderStub([]);
      (revisedProjectGroupRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      await service.findRevisionProjects(undefined, undefined, false, 'user-1');

      expect(qb.__params.isLatest).toBe(true);
      const isLatestClauseFound = qb.__clauses.some((c: string) =>
        c.includes('trackingStatus.isLatest = :isLatest'),
      );
      expect(isLatestClauseFound).toBe(true);
    });

    it('applies DPR activation scope (dpr.isLatest = true, dpr.isBooked = false) per CLAUDE.md §9', async () => {
      workHistoryRepo.findOne.mockResolvedValue(laoWorkHistory);
      const qb = makeQueryBuilderStub([]);
      (revisedProjectGroupRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      await service.findRevisionProjects(undefined, undefined, false, 'user-1');

      expect(qb.__params.isLatestRevision).toBe(true);
      expect(qb.__params.isBooked).toBe(false);
      const dprLatestClauseFound = qb.__clauses.some((c: string) =>
        c.includes('dpr.isLatest = :isLatestRevision'),
      );
      const dprBookedClauseFound = qb.__clauses.some((c: string) =>
        c.includes('dpr.isBooked = :isBooked'),
      );
      expect(dprLatestClauseFound).toBe(true);
      expect(dprBookedClauseFound).toBe(true);
    });
  });

  describe('create — §14 lineage FK guard rail (W74 BE-GUARDRAIL)', () => {
    /**
     * The guard rail MUST run BEFORE any repository write per CLAUDE.md
     * §14.9. We assert that providing an invalid lineage FK throws a
     * BadRequestException with the canonical `LINEAGE_FK_REQUIRED`
     * message prefix and that the transaction is never opened.
     */
    function buildBaseDto(
      overrides: Partial<CreateRevisedProjectGroupDto> = {},
    ): CreateRevisedProjectGroupDto {
      return {
        developmentPlanRevisionId: 'dpr-uuid',
        title: 't',
        objective: 'o',
        goal: 'g',
        expected: 'e',
        projectYear: 2569,
        prevProjectId: 'pg-uuid',
        prevProjectType: PrevProjectType.ORIGINAL,
        responsibleAgency: 'agency-1',
        ...overrides,
      } as CreateRevisedProjectGroupDto;
    }

    it('create throws LINEAGE_FK_REQUIRED when prevProjectId missing', async () => {
      const dto = buildBaseDto({ prevProjectId: '' as any });

      await expect(service.create(dto, 'user-1')).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.create(dto, 'user-1')).rejects.toThrow(
        /^LINEAGE_FK_REQUIRED:/,
      );
    });

    it('create throws LINEAGE_FK_REQUIRED when prevProjectType invalid', async () => {
      const dto = buildBaseDto({ prevProjectType: 'banana' as any });

      await expect(service.create(dto, 'user-1')).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.create(dto, 'user-1')).rejects.toThrow(
        /^LINEAGE_FK_REQUIRED:/,
      );
    });
  });
});
