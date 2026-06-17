import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ExecutiveService } from './executive.service';
import { STATUS_NAMES } from '../common/status-names';
import { WorkHistory } from '../work-history/entities/work-history.entity';
import { ProjectGroup } from '../project-groups/entities/project-group.entity';
import { DevelopmentPlan } from '../development-plan/entities/development-plan.entity';
import { RevisedProjectGroup } from '../revised-project-group/entities/revised-project-group.entity';
import { SupplementProjectGroup } from '../supplement-project-group/entities/supplement-project-group.entity';
import { EquipmentProjectGroup } from '../equipment-project-group/entities/equipment-project-group.entity';
import { RevisedEquipmentProjectGroup } from '../revised-equipment-project-group/entities/revised-equipment-project-group.entity';
import { SupplementEquipmentProjectGroup } from '../supplement-equipment-project-group/entities/supplement-equipment-project-group.entity';

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
  let revisedProjectGroupRepo: jest.Mocked<Repository<RevisedProjectGroup>>;
  let supplementProjectGroupRepo: jest.Mocked<Repository<SupplementProjectGroup>>;
  let equipmentProjectGroupRepo: jest.Mocked<Repository<EquipmentProjectGroup>>;
  let revisedEquipmentProjectGroupRepo: jest.Mocked<Repository<RevisedEquipmentProjectGroup>>;
  let supplementEquipmentProjectGroupRepo: jest.Mocked<Repository<SupplementEquipmentProjectGroup>>;

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
      getMany: jest.fn().mockResolvedValue([]),
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
    revisedProjectGroupRepo = {
      createQueryBuilder: jest.fn(),
    } as any;
    supplementProjectGroupRepo = {
      createQueryBuilder: jest.fn(),
    } as any;
    equipmentProjectGroupRepo = {
      createQueryBuilder: jest.fn(),
    } as any;
    revisedEquipmentProjectGroupRepo = {
      createQueryBuilder: jest.fn(),
    } as any;
    supplementEquipmentProjectGroupRepo = {
      createQueryBuilder: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExecutiveService,
        { provide: getRepositoryToken(WorkHistory), useValue: workHistoryRepo },
        { provide: getRepositoryToken(ProjectGroup), useValue: projectGroupRepo },
        { provide: getRepositoryToken(DevelopmentPlan), useValue: developmentPlanRepo },
        { provide: getRepositoryToken(RevisedProjectGroup), useValue: revisedProjectGroupRepo },
        { provide: getRepositoryToken(SupplementProjectGroup), useValue: supplementProjectGroupRepo },
        { provide: getRepositoryToken(EquipmentProjectGroup), useValue: equipmentProjectGroupRepo },
        {
          provide: getRepositoryToken(RevisedEquipmentProjectGroup),
          useValue: revisedEquipmentProjectGroupRepo,
        },
        {
          provide: getRepositoryToken(SupplementEquipmentProjectGroup),
          useValue: supplementEquipmentProjectGroupRepo,
        },
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

      const result = await service.getTeamDashboard(STAFF_USER_ID, 'main');
      const amphoe = result.staffWithTotalLao[0].workHistoryResponsibleAmphoe[0]
        .amphoe as any;

      expect(amphoe.statusAging.Returned_For_Revision.details).toHaveLength(1);
      expect(amphoe.statusAging.Returned_For_Revision.details[0]).toMatchObject({
        id: 'pg-a-1',
        title: 'Amphoe project',
      });
    });
  });

  /**
   * Wave 43 + post-dispatch refactor — Team Dashboard scope extension.
   *
   * Scope enum is now 4 PURE values (no union):
   *   'main' | 'revision-edit' | 'revision-change' | 'supplement'
   *
   * These tests guarantee:
   *   - `scope=main` / default returns byte-identical keys to the
   *     pre-Wave-43 shape (no `scope` key).
   *   - Non-main scopes echo the requested `scope` at top-level.
   *   - `byScope` breakdown has been REMOVED (each scope is pure, so
   *     the summary row is redundant).
   */
  describe('getTeamDashboard — scope param (Wave 43)', () => {
    const wireBuildersFor = (statusName: string) => {
      const mainBuilder = makeQueryBuilder(buildStaffRow(statusName));
      const scopeBuilder = makeQueryBuilder(null);
      workHistoryRepo.createQueryBuilder
        .mockReturnValueOnce(mainBuilder as any)
        .mockReturnValue(scopeBuilder as any);

      const pgBuilder = makeQueryBuilder(null);
      projectGroupRepo.createQueryBuilder.mockReturnValue(pgBuilder as any);

      const rpgBuilder = makeQueryBuilder(null);
      revisedProjectGroupRepo.createQueryBuilder.mockReturnValue(rpgBuilder as any);

      const spgBuilder = makeQueryBuilder(null);
      supplementProjectGroupRepo.createQueryBuilder.mockReturnValue(spgBuilder as any);
    };

    it('scope=main → response has NO scope key (byte-identical legacy)', async () => {
      wireBuildersFor(STATUS_NAMES.PENDING);
      const result = await service.getTeamDashboard(STAFF_USER_ID, 'main');
      expect((result as any).scope).toBeUndefined();
      expect((result as any).byScope).toBeUndefined();
    });

    it('default (no arg) delegates to scope=main (byte-identical legacy)', async () => {
      wireBuildersFor(STATUS_NAMES.PENDING);
      const result = (await service.getTeamDashboard(STAFF_USER_ID)) as any;
      expect(result.scope).toBeUndefined();
      expect(result.byScope).toBeUndefined();
    });

    it('scope=revision-edit → echoes scope and has no byScope key', async () => {
      wireBuildersFor(STATUS_NAMES.PENDING);
      const result = (await service.getTeamDashboard(
        STAFF_USER_ID,
        'revision-edit',
      )) as any;
      expect(result.scope).toBe('revision-edit');
      expect(result.byScope).toBeUndefined();
    });

    it('scope=revision-change → echoes scope and has no byScope key', async () => {
      wireBuildersFor(STATUS_NAMES.PENDING);
      const result = (await service.getTeamDashboard(
        STAFF_USER_ID,
        'revision-change',
      )) as any;
      expect(result.scope).toBe('revision-change');
      expect(result.byScope).toBeUndefined();
    });

    it('scope=supplement → echoes scope and has no byScope key', async () => {
      wireBuildersFor(STATUS_NAMES.PENDING);
      const result = (await service.getTeamDashboard(
        STAFF_USER_ID,
        'supplement',
      )) as any;
      expect(result.scope).toBe('supplement');
      expect(result.byScope).toBeUndefined();
    });
  });

  /**
   * Wave 24 — Pull_Back / Returned_For_Revision leakage fix (BE-24-02).
   *
   * Two-prong invariant:
   *   1. Per-staff Returned_For_Revision TILE remains populated (intentional
   *      retention per FIX_EXECUTIVE_STATUS_COUNTS_RETURNED_FOR_REVISION).
   *   2. The FE-shipped projectGroups array, the per-staff projectCount, and
   *      the executive-wide global counters DROP Ready / Pull_Back /
   *      Returned_For_Revision per §3 W67.
   */
  describe('getTeamDashboard — Wave 24 executive exclusion', () => {
    /**
     * Build a staff row whose amphoe + agency each carry a mixed bag of
     * statuses: 1 Ready + 1 Pull_Back + 1 Returned_For_Revision + 1 Pending.
     * Expected post-fix:
     *   - tile RFR count = 1 (preserved)
     *   - tile Pending count = 1
     *   - shipped projectCount = 1 (only Pending survives the executive set)
     *   - shipped projectGroups.length = 1
     */
    const buildMixedStaffRow = () => ({
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
            projectGroups: [
              buildProject('pg-a-ready', 'Ready proj', 'Ready'),
              buildProject('pg-a-pb', 'PullBack proj', 'Pull_Back'),
              buildProject(
                'pg-a-rfr',
                'RFR proj',
                STATUS_NAMES.RETURNED_FOR_REVISION,
              ),
              buildProject('pg-a-pending', 'Pending proj', 'Pending'),
            ],
          },
        },
      ],
      workHistoryResponsibleGovernmentAgency: [
        {
          governmentAgency: {
            id: AGENCY_ID,
            responsibleAgencyProjectGroup: [
              buildProject('pg-g-ready', 'Ready proj', 'Ready'),
              buildProject('pg-g-pb', 'PullBack proj', 'Pull_Back'),
              buildProject(
                'pg-g-rfr',
                'RFR proj',
                STATUS_NAMES.RETURNED_FOR_REVISION,
              ),
              buildProject('pg-g-pending', 'Pending proj', 'Pending'),
            ],
          },
        },
      ],
    });

    const wireMixed = () => {
      const mainBuilder = makeQueryBuilder(buildMixedStaffRow());
      const scopeBuilder = makeQueryBuilder(null);
      workHistoryRepo.createQueryBuilder
        .mockReturnValueOnce(mainBuilder as any)
        .mockReturnValue(scopeBuilder as any);
      const pgBuilder = makeQueryBuilder(null);
      projectGroupRepo.createQueryBuilder.mockReturnValue(pgBuilder as any);
    };

    it('preserves Returned_For_Revision tile while excluding RFR + Pull_Back from amphoe projectCount', async () => {
      wireMixed();
      const result = await service.getTeamDashboard(STAFF_USER_ID, 'main');
      const amphoe = result.staffWithTotalLao[0].workHistoryResponsibleAmphoe[0]
        .amphoe as any;

      // Tile preserved (predecessor task contract)
      expect(amphoe.statusCounts.Returned_For_Revision).toBe(1);
      expect(amphoe.statusCounts.Pending).toBe(1);

      // Wave 24 — shipped array + count exclude Ready / Pull_Back / RFR
      expect(amphoe.projectCount).toBe(1);
      expect(amphoe.projectGroups).toHaveLength(1);
      expect(amphoe.projectGroups[0].id).toBe('pg-a-pending');
    });

    it('preserves Returned_For_Revision tile while excluding RFR + Pull_Back from agency projectCount', async () => {
      wireMixed();
      const result = await service.getTeamDashboard(STAFF_USER_ID, 'main');
      const agency = result.staffWithTotalLao[0]
        .workHistoryResponsibleGovernmentAgency[0].governmentAgency as any;

      expect(agency.statusCounts.Returned_For_Revision).toBe(1);
      expect(agency.statusCounts.Pending).toBe(1);
      expect(agency.projectCount).toBe(1);
      expect(agency.responsibleAgencyProjectGroup).toHaveLength(1);
      expect(agency.responsibleAgencyProjectGroup[0].id).toBe('pg-g-pending');
    });

    it('global projectGroupCount SQL excludes Ready / Pull_Back / Returned_For_Revision', async () => {
      // Capture parameter values handed to the repo .andWhere() calls.
      const mainBuilder = makeQueryBuilder(buildMixedStaffRow());
      const scopeBuilder = makeQueryBuilder(null);
      workHistoryRepo.createQueryBuilder
        .mockReturnValueOnce(mainBuilder as any)
        .mockReturnValue(scopeBuilder as any);

      const pgBuilder: any = {
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(0),
      };
      projectGroupRepo.createQueryBuilder.mockReturnValue(pgBuilder as any);

      await service.getTeamDashboard(STAFF_USER_ID, 'main');

      // The first count query (projectGroupCount) interpolates an
      // `excludedStatusNames` parameter that MUST contain all three
      // Wave-24 excluded statuses.
      const calls = pgBuilder.andWhere.mock.calls;
      const excludedCall = calls.find(
        (c: any[]) =>
          typeof c[1] === 'object' &&
          c[1] &&
          Array.isArray((c[1] as any).excludedStatusNames),
      );
      expect(excludedCall).toBeDefined();
      const excluded = excludedCall![1].excludedStatusNames as string[];
      expect(excluded).toEqual(
        expect.arrayContaining(['Ready', 'Pull_Back', 'Returned_For_Revision']),
      );

      // The third count query (projectGroupInprogressCount) interpolates
      // `excludeStatuses` which MUST contain Approved + the three Wave-24 set.
      const inProgressCall = calls.find(
        (c: any[]) =>
          typeof c[1] === 'object' &&
          c[1] &&
          Array.isArray((c[1] as any).excludeStatuses),
      );
      expect(inProgressCall).toBeDefined();
      const inProgressExcluded = inProgressCall![1].excludeStatuses as string[];
      expect(inProgressExcluded).toEqual(
        expect.arrayContaining([
          'Approved',
          'Ready',
          'Pull_Back',
          'Returned_For_Revision',
        ]),
      );
    });
  });

  /**
   * wave-team-dashboard-equipment-coverage (BE-01) — equipment scope.
   *
   * The new `scope=equipment` path aggregates EPG + RELPG (edit + change) +
   * SEPG under the staff member's `responsibleAgency` §7 partition, on a
   * DEDICATED path so the ผ.02 union/legacy code is untouched.
   *
   * Invariants asserted:
   *   - each of EPG / RELPG-edit / RELPG-change / SEPG appears tagged with
   *     the correct equipment `sourceType`.
   *   - status buckets count correctly (tile drops Ready only).
   *   - the amphoe (LAO) bucket is emptied (equipment is agency-origin only).
   *   - no write methods (.save / .insert) are called anywhere (§17.2).
   *   - scope=main stays byte-identical (existing specs above unchanged).
   */
  describe('getTeamDashboard — equipment scope (wave-team-dashboard-equipment-coverage)', () => {
    /**
     * Build an equipment-shaped fixture row. Equipment status lives entirely
     * in `tracking_status` (shape-agnostic §16.5) — the row carries no
     * classification fields, only the §7 `responsibleAgency` partition key
     * and the latest tracking status.
     */
    const buildEquipmentRow = (
      id: string,
      title: string,
      statusName: string,
      revisionTypeName?: string,
    ) => ({
      id,
      title,
      deletedAt: null,
      responsibleAgency: { id: AGENCY_ID },
      developmentPlanRevision: revisionTypeName
        ? { revisionType: { name: revisionTypeName } }
        : undefined,
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
     * Wire the legacy preamble (workHistory main + scope builders, pg counter
     * builder) plus a getMany-returning builder for each of the three
     * equipment repos. `epgRows` / `relpgRows` / `sepgRows` are the fixture
     * rows each equipment loader's `.getMany()` resolves to.
     */
    const wireEquipment = (opts: {
      epgRows?: any[];
      relpgRows?: any[];
      sepgRows?: any[];
    }) => {
      const mainBuilder = makeQueryBuilder(buildStaffRow(STATUS_NAMES.PENDING));
      const scopeBuilder = makeQueryBuilder(null);
      workHistoryRepo.createQueryBuilder
        .mockReturnValueOnce(mainBuilder as any)
        .mockReturnValue(scopeBuilder as any);

      const pgBuilder = makeQueryBuilder(null);
      projectGroupRepo.createQueryBuilder.mockReturnValue(pgBuilder as any);

      const epgBuilder = makeQueryBuilder(null);
      epgBuilder.getMany = jest.fn().mockResolvedValue(opts.epgRows ?? []);
      equipmentProjectGroupRepo.createQueryBuilder.mockReturnValue(epgBuilder as any);

      const relpgBuilder = makeQueryBuilder(null);
      relpgBuilder.getMany = jest.fn().mockResolvedValue(opts.relpgRows ?? []);
      revisedEquipmentProjectGroupRepo.createQueryBuilder.mockReturnValue(
        relpgBuilder as any,
      );

      const sepgBuilder = makeQueryBuilder(null);
      sepgBuilder.getMany = jest.fn().mockResolvedValue(opts.sepgRows ?? []);
      supplementEquipmentProjectGroupRepo.createQueryBuilder.mockReturnValue(
        sepgBuilder as any,
      );
    };

    const getAgencyBucket = (result: any) =>
      result.staffWithTotalLao[0].workHistoryResponsibleGovernmentAgency[0]
        .governmentAgency as any;

    it('echoes scope=equipment at top-level', async () => {
      wireEquipment({ epgRows: [buildEquipmentRow('epg-1', 'EPG', 'Pending')] });
      const result = (await service.getTeamDashboard(
        STAFF_USER_ID,
        'equipment',
      )) as any;
      expect(result.scope).toBe('equipment');
      expect(result.byScope).toBeUndefined();
    });

    it('tags EPG as equipment-main and counts it', async () => {
      wireEquipment({ epgRows: [buildEquipmentRow('epg-1', 'EPG', 'Pending')] });
      const result = await service.getTeamDashboard(STAFF_USER_ID, 'equipment');
      const agency = getAgencyBucket(result);

      expect(agency.responsibleAgencyProjectGroup).toHaveLength(1);
      expect(agency.responsibleAgencyProjectGroup[0].id).toBe('epg-1');
      expect(agency.responsibleAgencyProjectGroup[0].sourceType).toBe('equipment-main');
      expect(agency.statusCounts.Pending).toBe(1);
    });

    it('tags RELPG edit vs change from revisionType.name', async () => {
      wireEquipment({
        relpgRows: [
          buildEquipmentRow('relpg-edit', 'RELPG edit', 'Verified', 'แก้ไข'),
          buildEquipmentRow('relpg-change', 'RELPG change', 'Verified', 'เปลี่ยนแปลง'),
        ],
      });
      const result = await service.getTeamDashboard(STAFF_USER_ID, 'equipment');
      const agency = getAgencyBucket(result);

      const byId: Record<string, any> = {};
      for (const p of agency.responsibleAgencyProjectGroup) byId[p.id] = p;
      expect(byId['relpg-edit'].sourceType).toBe('equipment-revision-edit');
      expect(byId['relpg-change'].sourceType).toBe('equipment-revision-change');
      // both Verified → tile count = 2
      expect(agency.statusCounts.Verified).toBe(2);
    });

    it('tags SEPG as equipment-supplement', async () => {
      wireEquipment({
        sepgRows: [buildEquipmentRow('sepg-1', 'SEPG', 'Pending_Approval')],
      });
      const result = await service.getTeamDashboard(STAFF_USER_ID, 'equipment');
      const agency = getAgencyBucket(result);

      expect(agency.responsibleAgencyProjectGroup).toHaveLength(1);
      expect(agency.responsibleAgencyProjectGroup[0].id).toBe('sepg-1');
      expect(agency.responsibleAgencyProjectGroup[0].sourceType).toBe(
        'equipment-supplement',
      );
      expect(agency.statusCounts.Pending_Approval).toBe(1);
    });

    it('unions all three equipment sub-types under one scope', async () => {
      wireEquipment({
        epgRows: [buildEquipmentRow('epg-1', 'EPG', 'Pending')],
        relpgRows: [
          buildEquipmentRow('relpg-edit', 'RELPG edit', 'Verified', 'แก้ไข'),
          buildEquipmentRow('relpg-change', 'RELPG change', 'Pending', 'เปลี่ยนแปลง'),
        ],
        sepgRows: [buildEquipmentRow('sepg-1', 'SEPG', 'Approved')],
      });
      const result = await service.getTeamDashboard(STAFF_USER_ID, 'equipment');
      const agency = getAgencyBucket(result);

      const ids = agency.responsibleAgencyProjectGroup.map((p: any) => p.id).sort();
      expect(ids).toEqual(['epg-1', 'relpg-change', 'relpg-edit', 'sepg-1']);
      expect(agency.statusCounts.Pending).toBe(2); // epg-1 + relpg-change
      expect(agency.statusCounts.Verified).toBe(1); // relpg-edit
      expect(agency.statusCounts.Approved).toBe(1); // sepg-1
    });

    it('empties the amphoe (LAO) bucket for the equipment scope', async () => {
      wireEquipment({ epgRows: [buildEquipmentRow('epg-1', 'EPG', 'Pending')] });
      const result = await service.getTeamDashboard(STAFF_USER_ID, 'equipment');
      const amphoe = result.staffWithTotalLao[0].workHistoryResponsibleAmphoe[0]
        .amphoe as any;

      expect(amphoe.projectGroups).toHaveLength(0);
      expect(amphoe.projectCount).toBe(0);
      expect(amphoe.statusCounts.Pending).toBe(0);
      expect(amphoe.statusCounts.Verified).toBe(0);
      expect(amphoe.statusCounts.Approved).toBe(0);
    });

    it('drops Ready-status equipment rows from the tile (draft exclusion)', async () => {
      wireEquipment({
        epgRows: [
          buildEquipmentRow('epg-ready', 'EPG ready', 'Ready'),
          buildEquipmentRow('epg-pending', 'EPG pending', 'Pending'),
        ],
      });
      const result = await service.getTeamDashboard(STAFF_USER_ID, 'equipment');
      const agency = getAgencyBucket(result);

      // Ready dropped from both tile counts and the shipped executive array.
      expect(agency.responsibleAgencyProjectGroup).toHaveLength(1);
      expect(agency.responsibleAgencyProjectGroup[0].id).toBe('epg-pending');
      expect(agency.statusCounts.Pending).toBe(1);
    });

    it('is READ-ONLY — no .save() / .insert() on any equipment repo (§17.2)', async () => {
      wireEquipment({
        epgRows: [buildEquipmentRow('epg-1', 'EPG', 'Pending')],
        relpgRows: [buildEquipmentRow('relpg-1', 'RELPG', 'Verified', 'แก้ไข')],
        sepgRows: [buildEquipmentRow('sepg-1', 'SEPG', 'Approved')],
      });

      // Attach spies the service would call ONLY if it tried to write.
      (equipmentProjectGroupRepo as any).save = jest.fn();
      (equipmentProjectGroupRepo as any).insert = jest.fn();
      (revisedEquipmentProjectGroupRepo as any).save = jest.fn();
      (revisedEquipmentProjectGroupRepo as any).insert = jest.fn();
      (supplementEquipmentProjectGroupRepo as any).save = jest.fn();
      (supplementEquipmentProjectGroupRepo as any).insert = jest.fn();

      await service.getTeamDashboard(STAFF_USER_ID, 'equipment');

      expect((equipmentProjectGroupRepo as any).save).not.toHaveBeenCalled();
      expect((equipmentProjectGroupRepo as any).insert).not.toHaveBeenCalled();
      expect((revisedEquipmentProjectGroupRepo as any).save).not.toHaveBeenCalled();
      expect((revisedEquipmentProjectGroupRepo as any).insert).not.toHaveBeenCalled();
      expect((supplementEquipmentProjectGroupRepo as any).save).not.toHaveBeenCalled();
      expect((supplementEquipmentProjectGroupRepo as any).insert).not.toHaveBeenCalled();
    });
  });
});
