import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ExecutiveService } from './executive.service';
import { STATUS_NAMES } from '../common/status-names';
import { WorkHistory } from '../work-history/entities/work-history.entity';
import { ProjectGroup } from '../project-groups/entities/project-group.entity';
import { DevelopmentPlan } from '../development-plan/entities/development-plan.entity';

/**
 * Test suite for ExecutiveService.getTeamDashboard — specifically the rename
 * of the stale `Revision` key in the `counts` and `aging` dictionaries to
 * the canonical `Returned_For_Revision` per CLAUDE.md Status Naming Constraint.
 *
 * Background (docs/reports/AUDIT_RESIDUAL_REVISION_STATUS_LITERALS.md):
 *   The DB seeds a single active status row named `Returned_For_Revision`.
 *   The service's `counts[statusName]++` / `aging[statusName].total += diffDays`
 *   loops key by the DB-sourced `statusName` string, so a dictionary keyed
 *   by the obsolete `'Revision'` name never matches and returned-for-revision
 *   projects silently drop out of executive dashboards' totals.
 */
describe('ExecutiveService', () => {
  let service: ExecutiveService;
  let workHistoryRepo: jest.Mocked<Repository<WorkHistory>>;
  let projectGroupRepo: jest.Mocked<Repository<ProjectGroup>>;
  let developmentPlanRepo: jest.Mocked<Repository<DevelopmentPlan>>;

  const STAFF_USER_ID = 'staff-user-1';
  const STAFF_WH_ID = 'wh-staff-1';
  const DEV_PLAN_ID = 'dev-plan-1';
  const AMPHOE_ID = 'amphoe-1';
  const AGENCY_ID = 'agency-1';

  const currentUserWH = {
    id: STAFF_WH_ID,
    isCurrent: true,
    role: { name: 'staff' },
    localAdministrativeOrganization: null,
    governmentAgencies: null,
    user: { id: STAFF_USER_ID },
  } as any;

  const developmentPlan = { id: DEV_PLAN_ID, isLatest: true, isBooked: false } as any;

  /**
   * Build a fixture project whose latest tracking status name is `statusName`.
   * The aging math uses `latest.createAt` relative to `new Date()` so we
   * anchor `createAt` to 2 days ago for determinism.
   */
  const twoDaysAgo = () => {
    const d = new Date();
    d.setDate(d.getDate() - 2);
    return d;
  };

  const buildProject = (id: string, title: string, statusName: string) => ({
    id,
    title,
    isDraft: false,
    deletedAt: null,
    trackingStatus: [
      {
        isLatest: true,
        createAt: twoDaysAgo(),
        statusId: { name: statusName },
      },
    ],
    createdBy: { user: { id: STAFF_USER_ID, firstname: 'S', lastname: 'U' } },
  });

  /**
   * Build the staff row returned by the main QueryBuilder chain so that both
   * scopes (amphoe + agency) have exactly one project with the supplied
   * status name. The counting loops under test walk both arrays.
   */
  const buildStaffRow = (statusName: string) => ({
    id: STAFF_WH_ID,
    user: {
      id: STAFF_USER_ID,
      prefix: 'นาย',
      firstname: 'Test',
      lastname: 'Staff',
    },
    role: { name: 'staff' },
    workHistoryResponsibleAmphoe: [
      {
        amphoe: {
          id: AMPHOE_ID,
          projectGroups: [buildProject('pg-a-1', 'Amphoe project', statusName)],
        },
      },
    ],
    workHistoryResponsibleGovernmentAgency: [
      {
        governmentAgency: {
          id: AGENCY_ID,
          responsibleAgencyProjectGroup: [
            buildProject('pg-g-1', 'Agency project', statusName),
          ],
        },
      },
    ],
  });

  /**
   * Minimal stub of the TypeORM query builder chain used by
   * getTeamDashboard. Every chainable method returns the same builder;
   * `getManyAndCount` returns the fixture staff row.
   */
  const makeQueryBuilder = (staffRow: any) => {
    const qb: any = {
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      loadRelationCountAndMap: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      setParameters: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[staffRow], 1]),
      getCount: jest.fn().mockResolvedValue(0),
    };
    return qb;
  };

  beforeEach(async () => {
    workHistoryRepo = {
      findOne: jest.fn().mockResolvedValue(currentUserWH),
      createQueryBuilder: jest.fn(),
    } as any;
    projectGroupRepo = {
      createQueryBuilder: jest.fn(),
    } as any;
    developmentPlanRepo = {
      findOne: jest.fn().mockResolvedValue(developmentPlan),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExecutiveService,
        { provide: getRepositoryToken(WorkHistory), useValue: workHistoryRepo },
        { provide: getRepositoryToken(ProjectGroup), useValue: projectGroupRepo },
        { provide: getRepositoryToken(DevelopmentPlan), useValue: developmentPlanRepo },
      ],
    }).compile();

    service = module.get<ExecutiveService>(ExecutiveService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getTeamDashboard — counts/aging key shape', () => {
    /**
     * Wire the query builders so that
     *   - the first workHistoryRepo.createQueryBuilder call (main staff scan)
     *     returns a builder whose getManyAndCount yields one staff row with
     *     a single project at status Returned_For_Revision
     *   - the second workHistoryRepo.createQueryBuilder call (scope filter)
     *     returns a trivial builder
     *   - projectGroupRepo.createQueryBuilder returns a trivial counter builder
     */
    const wireBuilders = (statusName: string) => {
      const mainBuilder = makeQueryBuilder(buildStaffRow(statusName));
      const scopeBuilder = makeQueryBuilder(null);
      workHistoryRepo.createQueryBuilder
        .mockReturnValueOnce(mainBuilder as any)
        .mockReturnValue(scopeBuilder as any);

      const pgBuilder = makeQueryBuilder(null);
      projectGroupRepo.createQueryBuilder.mockReturnValue(pgBuilder as any);
    };

    it('exposes Returned_For_Revision key on amphoe statusCounts (not Revision)', async () => {
      wireBuilders(STATUS_NAMES.RETURNED_FOR_REVISION);

      const result = await service.getTeamDashboard(STAFF_USER_ID);
      const amphoe = result.staffWithTotalLao[0].workHistoryResponsibleAmphoe[0]
        .amphoe as any;

      expect(amphoe.statusCounts).toBeDefined();
      expect(amphoe.statusCounts).toHaveProperty('Returned_For_Revision');
      expect(amphoe.statusCounts).not.toHaveProperty('Revision');
    });

    it('exposes Returned_For_Revision key on amphoe statusAging (not Revision)', async () => {
      wireBuilders(STATUS_NAMES.RETURNED_FOR_REVISION);

      const result = await service.getTeamDashboard(STAFF_USER_ID);
      const amphoe = result.staffWithTotalLao[0].workHistoryResponsibleAmphoe[0]
        .amphoe as any;

      expect(amphoe.statusAging).toBeDefined();
      expect(amphoe.statusAging).toHaveProperty('Returned_For_Revision');
      expect(amphoe.statusAging).not.toHaveProperty('Revision');
    });

    it('exposes Returned_For_Revision key on agency statusCounts (not Revision)', async () => {
      wireBuilders(STATUS_NAMES.RETURNED_FOR_REVISION);

      const result = await service.getTeamDashboard(STAFF_USER_ID);
      const agency = result.staffWithTotalLao[0]
        .workHistoryResponsibleGovernmentAgency[0].governmentAgency as any;

      expect(agency.statusCounts).toBeDefined();
      expect(agency.statusCounts).toHaveProperty('Returned_For_Revision');
      expect(agency.statusCounts).not.toHaveProperty('Revision');
    });

    it('exposes Returned_For_Revision key on agency statusAging (not Revision)', async () => {
      wireBuilders(STATUS_NAMES.RETURNED_FOR_REVISION);

      const result = await service.getTeamDashboard(STAFF_USER_ID);
      const agency = result.staffWithTotalLao[0]
        .workHistoryResponsibleGovernmentAgency[0].governmentAgency as any;

      expect(agency.statusAging).toBeDefined();
      expect(agency.statusAging).toHaveProperty('Returned_For_Revision');
      expect(agency.statusAging).not.toHaveProperty('Revision');
    });

    it('increments counts.Returned_For_Revision === 1 for amphoe scope when DB emits Returned_For_Revision', async () => {
      wireBuilders(STATUS_NAMES.RETURNED_FOR_REVISION);

      const result = await service.getTeamDashboard(STAFF_USER_ID);
      const amphoe = result.staffWithTotalLao[0].workHistoryResponsibleAmphoe[0]
        .amphoe as any;

      expect(amphoe.statusCounts.Returned_For_Revision).toBe(1);
      // sanity: other buckets stay zero
      expect(amphoe.statusCounts.Pending).toBe(0);
      expect(amphoe.statusCounts.Verified).toBe(0);
      expect(amphoe.statusCounts.Approved).toBe(0);
    });

    it('increments counts.Returned_For_Revision === 1 for agency scope when DB emits Returned_For_Revision', async () => {
      wireBuilders(STATUS_NAMES.RETURNED_FOR_REVISION);

      const result = await service.getTeamDashboard(STAFF_USER_ID);
      const agency = result.staffWithTotalLao[0]
        .workHistoryResponsibleGovernmentAgency[0].governmentAgency as any;

      expect(agency.statusCounts.Returned_For_Revision).toBe(1);
      expect(agency.statusCounts.Pending).toBe(0);
      expect(agency.statusCounts.Verified).toBe(0);
      expect(agency.statusCounts.Approved).toBe(0);
    });

    it('records aging details under the Returned_For_Revision key', async () => {
      wireBuilders(STATUS_NAMES.RETURNED_FOR_REVISION);

      const result = await service.getTeamDashboard(STAFF_USER_ID);
      const amphoe = result.staffWithTotalLao[0].workHistoryResponsibleAmphoe[0]
        .amphoe as any;

      expect(amphoe.statusAging.Returned_For_Revision.details).toHaveLength(1);
      expect(amphoe.statusAging.Returned_For_Revision.details[0]).toMatchObject({
        id: 'pg-a-1',
        title: 'Amphoe project',
      });
    });
  });
});
