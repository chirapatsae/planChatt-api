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
// wave-team-dashboard-scope-window — round-window source repos (§8 / §9).
import { PlanPhase } from '../plan-phase/entities/plan-phase.entity';
import { DevelopmentPlanRevision } from '../development-plan-revision/entities/development-plan-revision.entity';
import { DevelopmentPlanSupplement } from '../development-plan-supplement/entities/development-plan-supplement.entity';

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
  // wave-team-dashboard-scope-window — §8 / §9 round-window source repos.
  let planPhaseRepo: jest.Mocked<Repository<PlanPhase>>;
  let developmentPlanRevisionRepo: jest.Mocked<Repository<DevelopmentPlanRevision>>;
  let developmentPlanSupplementRepo: jest.Mocked<Repository<DevelopmentPlanSupplement>>;

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
    // wave-team-dashboard-scope-window — round-window source repos. Defaults
    // return empty so the §8/§9 window derivation no-ops (scopeWindow=null)
    // and the existing assertions stay unchanged unless a test wires them.
    planPhaseRepo = {
      find: jest.fn().mockResolvedValue([]),
    } as any;
    developmentPlanRevisionRepo = {
      createQueryBuilder: jest.fn().mockImplementation(() => makeQueryBuilder(null)),
    } as any;
    developmentPlanSupplementRepo = {
      createQueryBuilder: jest.fn().mockImplementation(() => makeQueryBuilder(null)),
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
        { provide: getRepositoryToken(PlanPhase), useValue: planPhaseRepo },
        {
          provide: getRepositoryToken(DevelopmentPlanRevision),
          useValue: developmentPlanRevisionRepo,
        },
        {
          provide: getRepositoryToken(DevelopmentPlanSupplement),
          useValue: developmentPlanSupplementRepo,
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

      // wave-team-dashboard-equipment-folded — the main path now folds EPG
      // into the agency bucket. Wire an empty EPG builder so the loader
      // no-ops and the PG-only numbers stay byte-identical.
      const epgBuilder = makeQueryBuilder(null);
      equipmentProjectGroupRepo.createQueryBuilder.mockReturnValue(epgBuilder as any);
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

      // wave-team-dashboard-equipment-folded — the union path now ALSO loads
      // the matching equipment sub-type (RELPG / SEPG) per scope, and the
      // main path loads EPG. Wire empty builders so those loaders no-op here.
      const epgBuilder = makeQueryBuilder(null);
      equipmentProjectGroupRepo.createQueryBuilder.mockReturnValue(epgBuilder as any);

      const relpgBuilder = makeQueryBuilder(null);
      revisedEquipmentProjectGroupRepo.createQueryBuilder.mockReturnValue(
        relpgBuilder as any,
      );

      const sepgBuilder = makeQueryBuilder(null);
      supplementEquipmentProjectGroupRepo.createQueryBuilder.mockReturnValue(
        sepgBuilder as any,
      );
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
      // wave-team-dashboard-equipment-folded — empty EPG builder (no
      // equipment in this fixture; PG-only numbers must stay unchanged).
      const epgBuilder = makeQueryBuilder(null);
      equipmentProjectGroupRepo.createQueryBuilder.mockReturnValue(epgBuilder as any);
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
      // wave-team-dashboard-equipment-folded — main now folds EPG in; give an
      // empty equipment builder so loadEquipmentProjectGroupsByAgency returns
      // an empty map and the PG-only count assertions below stay valid.
      equipmentProjectGroupRepo.createQueryBuilder.mockReturnValue(
        makeQueryBuilder(null) as any,
      );

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
   * wave-team-dashboard-equipment-folded (2026-06-18) — equipment is FOLDED
   * INTO each book scope, not exposed as a standalone scope.
   *
   * Equipment (ครุภัณฑ์ ผ.03) is PART of every book, like projects. The
   * former standalone `scope=equipment` (which lumped ALL equipment across
   * ALL book types into one tab) has been REMOVED. Each scope now merges its
   * matching equipment sub-type into the SAME per-staff `responsibleAgency`
   * bucket alongside the ผ.02 project rows:
   *   main            → PG  + EPG   (equipment-main)
   *   revision-edit   → RPG + RELPG (equipment-revision-edit)
   *   revision-change → RPG + RELPG (equipment-revision-change)
   *   supplement      → SPG + SEPG  (equipment-supplement)
   *
   * §5.3 — equipment is agency-origin only, so it only lands in the agency
   * bucket. §17.2 READ-ONLY. §16.5 shape-agnostic.
   */
  describe('getTeamDashboard — equipment folded into book scopes', () => {
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
     * Wire the legacy preamble plus getMany-returning builders for the ผ.02
     * union repos (RPG / SPG) AND the three equipment repos. The agency
     * bucket on the staff row is built EMPTY here so the merged result is
     * driven entirely by the loader fixtures (clean assertion surface).
     */
    const wireFolded = (opts: {
      pgRows?: any[]; // raw agency-origin main PG rows (stashed by legacy)
      rpgRows?: any[];
      spgRows?: any[];
      epgRows?: any[];
      relpgRows?: any[];
      sepgRows?: any[];
    }) => {
      // Staff row whose agency bucket starts with the supplied raw PG rows
      // (the legacy join result that gets stashed on __rawMainProjectGroups).
      const staffRow = {
        id: STAFF_WH_ID,
        user: {
          id: STAFF_USER_ID,
          prefix: 'นาย',
          firstname: 'Test',
          lastname: 'Staff',
        },
        role: { name: 'staff' },
        workHistoryResponsibleAmphoe: [
          { amphoe: { id: AMPHOE_ID, projectGroups: [] } },
        ],
        workHistoryResponsibleGovernmentAgency: [
          {
            governmentAgency: {
              id: AGENCY_ID,
              responsibleAgencyProjectGroup: opts.pgRows ?? [],
            },
          },
        ],
      };

      const mainBuilder = makeQueryBuilder(staffRow);
      const scopeBuilder = makeQueryBuilder(null);
      workHistoryRepo.createQueryBuilder
        .mockReturnValueOnce(mainBuilder as any)
        .mockReturnValue(scopeBuilder as any);

      const pgBuilder = makeQueryBuilder(null);
      projectGroupRepo.createQueryBuilder.mockReturnValue(pgBuilder as any);

      const rpgBuilder = makeQueryBuilder(null);
      rpgBuilder.getMany = jest.fn().mockResolvedValue(opts.rpgRows ?? []);
      revisedProjectGroupRepo.createQueryBuilder.mockReturnValue(rpgBuilder as any);

      const spgBuilder = makeQueryBuilder(null);
      spgBuilder.getMany = jest.fn().mockResolvedValue(opts.spgRows ?? []);
      supplementProjectGroupRepo.createQueryBuilder.mockReturnValue(spgBuilder as any);

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

    it('main scope folds EPG into the agency bucket alongside PG', async () => {
      wireFolded({
        pgRows: [buildEquipmentRow('pg-1', 'PG', 'Pending')],
        epgRows: [buildEquipmentRow('epg-1', 'EPG', 'Verified')],
      });
      const result = await service.getTeamDashboard(STAFF_USER_ID, 'main');
      const agency = getAgencyBucket(result);

      const byId: Record<string, any> = {};
      for (const p of agency.responsibleAgencyProjectGroup) byId[p.id] = p;
      expect(byId['pg-1'].sourceType).toBe('main');
      expect(byId['epg-1'].sourceType).toBe('equipment-main');
      expect(agency.statusCounts.Pending).toBe(1); // pg-1
      expect(agency.statusCounts.Verified).toBe(1); // epg-1
      // main payload does NOT echo a scope key (byte-identical contract).
      expect((result as any).scope).toBeUndefined();
    });

    it('main scope with ZERO equipment is byte-identical to legacy PG-only output', async () => {
      wireFolded({
        pgRows: [
          buildEquipmentRow('pg-pending', 'PG pending', 'Pending'),
          buildEquipmentRow('pg-ready', 'PG ready', 'Ready'),
        ],
        epgRows: [],
      });
      const result = await service.getTeamDashboard(STAFF_USER_ID, 'main');
      const agency = getAgencyBucket(result);

      // Ready dropped from the executive array; Pending survives.
      expect(agency.responsibleAgencyProjectGroup).toHaveLength(1);
      expect(agency.responsibleAgencyProjectGroup[0].id).toBe('pg-pending');
      expect(agency.statusCounts.Pending).toBe(1);
      // internal stash never leaks into the response
      expect(agency.__rawMainProjectGroups).toBeUndefined();
    });

    it('revision-edit scope folds RELPG (edit) alongside RPG (edit)', async () => {
      wireFolded({
        rpgRows: [],
        relpgRows: [
          buildEquipmentRow('relpg-edit', 'RELPG edit', 'Verified', 'แก้ไข'),
          buildEquipmentRow('relpg-change', 'RELPG change', 'Verified', 'เปลี่ยนแปลง'),
        ],
      });
      const result = await service.getTeamDashboard(
        STAFF_USER_ID,
        'revision-edit',
      );
      const agency = getAgencyBucket(result);

      const ids = agency.responsibleAgencyProjectGroup.map((p: any) => p.id);
      // change-type RELPG is filtered OUT of the edit scope.
      expect(ids).toEqual(['relpg-edit']);
      expect(agency.responsibleAgencyProjectGroup[0].sourceType).toBe(
        'equipment-revision-edit',
      );
      expect(agency.statusCounts.Verified).toBe(1);
      expect((result as any).scope).toBe('revision-edit');
    });

    it('revision-change scope folds RELPG (change) alongside RPG (change)', async () => {
      wireFolded({
        relpgRows: [
          buildEquipmentRow('relpg-edit', 'RELPG edit', 'Verified', 'แก้ไข'),
          buildEquipmentRow('relpg-change', 'RELPG change', 'Pending', 'เปลี่ยนแปลง'),
        ],
      });
      const result = await service.getTeamDashboard(
        STAFF_USER_ID,
        'revision-change',
      );
      const agency = getAgencyBucket(result);

      const ids = agency.responsibleAgencyProjectGroup.map((p: any) => p.id);
      // edit-type RELPG is filtered OUT of the change scope.
      expect(ids).toEqual(['relpg-change']);
      expect(agency.responsibleAgencyProjectGroup[0].sourceType).toBe(
        'equipment-revision-change',
      );
      expect(agency.statusCounts.Pending).toBe(1);
      expect((result as any).scope).toBe('revision-change');
    });

    it('supplement scope folds SEPG alongside SPG', async () => {
      wireFolded({
        sepgRows: [buildEquipmentRow('sepg-1', 'SEPG', 'Pending_Approval')],
      });
      const result = await service.getTeamDashboard(STAFF_USER_ID, 'supplement');
      const agency = getAgencyBucket(result);

      expect(agency.responsibleAgencyProjectGroup).toHaveLength(1);
      expect(agency.responsibleAgencyProjectGroup[0].id).toBe('sepg-1');
      expect(agency.responsibleAgencyProjectGroup[0].sourceType).toBe(
        'equipment-supplement',
      );
      expect(agency.statusCounts.Pending_Approval).toBe(1);
      expect((result as any).scope).toBe('supplement');
    });

    it('is READ-ONLY — no .save() / .insert() on any equipment repo (§17.2)', async () => {
      wireFolded({
        pgRows: [buildEquipmentRow('pg-1', 'PG', 'Pending')],
        epgRows: [buildEquipmentRow('epg-1', 'EPG', 'Pending')],
      });

      // Attach spies the service would call ONLY if it tried to write.
      (equipmentProjectGroupRepo as any).save = jest.fn();
      (equipmentProjectGroupRepo as any).insert = jest.fn();
      (revisedEquipmentProjectGroupRepo as any).save = jest.fn();
      (revisedEquipmentProjectGroupRepo as any).insert = jest.fn();
      (supplementEquipmentProjectGroupRepo as any).save = jest.fn();
      (supplementEquipmentProjectGroupRepo as any).insert = jest.fn();

      await service.getTeamDashboard(STAFF_USER_ID, 'main');

      expect((equipmentProjectGroupRepo as any).save).not.toHaveBeenCalled();
      expect((equipmentProjectGroupRepo as any).insert).not.toHaveBeenCalled();
      expect((revisedEquipmentProjectGroupRepo as any).save).not.toHaveBeenCalled();
      expect((revisedEquipmentProjectGroupRepo as any).insert).not.toHaveBeenCalled();
      expect((supplementEquipmentProjectGroupRepo as any).save).not.toHaveBeenCalled();
      expect((supplementEquipmentProjectGroupRepo as any).insert).not.toHaveBeenCalled();
    });
  });

  /**
   * wave-team-dashboard-equipment-folded — the standalone `equipment` scope
   * has been REMOVED. The controller validates against TEAM_DASHBOARD_SCOPES;
   * `'equipment'` is no longer a member, so it is rejected as an invalid
   * scope (controller throws 400 BAD_SCOPE). The service type no longer
   * accepts it.
   */
  describe('getTeamDashboard — standalone equipment scope removed', () => {
    const { TEAM_DASHBOARD_SCOPES } = jest.requireActual('./executive.service');

    it('TEAM_DASHBOARD_SCOPES no longer contains equipment', () => {
      expect(TEAM_DASHBOARD_SCOPES).not.toContain('equipment');
      expect(TEAM_DASHBOARD_SCOPES).toEqual([
        'main',
        'revision-edit',
        'revision-change',
        'supplement',
      ]);
    });
  });

  /**
   * wave-team-dashboard-scope-window (2026-06-19) — the response carries a
   * `scopeWindow` for the Team Status Calendar round-clock overlay. DISPLAY-ONLY
   * (§17.2): derived via PURE READS, never gates a transition. `main` derives
   * from the active §8 `PlanPhase`; the non-main scopes derive from their §9
   * `DevelopmentPlanRevision` / `DevelopmentPlanSupplement`.
   */
  describe('getTeamDashboard — scopeWindow round-window overlay (§8/§9)', () => {
    /** Minimal staff-scan + count + union builders so getTeamDashboard runs. */
    const wireForWindow = () => {
      const mainBuilder = makeQueryBuilder(buildStaffRow(STATUS_NAMES.PENDING));
      const scopeBuilder = makeQueryBuilder(null);
      workHistoryRepo.createQueryBuilder
        .mockReturnValueOnce(mainBuilder as any)
        .mockReturnValue(scopeBuilder as any);
      projectGroupRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder(null) as any);
      equipmentProjectGroupRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder(null) as any);
      revisedProjectGroupRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder(null) as any);
      supplementProjectGroupRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder(null) as any);
      revisedEquipmentProjectGroupRepo.createQueryBuilder.mockReturnValue(
        makeQueryBuilder(null) as any,
      );
      supplementEquipmentProjectGroupRepo.createQueryBuilder.mockReturnValue(
        makeQueryBuilder(null) as any,
      );
    };

    it('main → derives from the active PlanPhase (prefers open + latest openDate)', async () => {
      wireForWindow();
      const olderClosed = {
        phaseType: 'LAO',
        isOpen: false,
        openDate: new Date('2026-01-01T00:00:00Z'),
        closeDate: new Date('2026-01-31T00:00:00Z'),
      };
      const currentOpen = {
        phaseType: 'AGENCY',
        isOpen: true,
        openDate: new Date('2026-06-01T00:00:00Z'),
        closeDate: new Date('2026-06-30T00:00:00Z'),
      };
      planPhaseRepo.find.mockResolvedValue([olderClosed, currentOpen] as any);

      const result = (await service.getTeamDashboard(STAFF_USER_ID, 'main')) as any;
      expect(result.scopeWindow).toEqual({
        phaseType: 'AGENCY',
        openDate: new Date('2026-06-01T00:00:00Z').toISOString(),
        closeDate: new Date('2026-06-30T00:00:00Z').toISOString(),
        isOpen: true,
      });
    });

    it('main → scopeWindow is null when the plan has no PlanPhase', async () => {
      wireForWindow();
      planPhaseRepo.find.mockResolvedValue([]);
      const result = (await service.getTeamDashboard(STAFF_USER_ID, 'main')) as any;
      expect(result.scopeWindow).toBeNull();
    });

    it('revision-edit → derives from the matching (edit) DevelopmentPlanRevision; phaseType null', async () => {
      wireForWindow();
      const dprBuilder = makeQueryBuilder(null);
      dprBuilder.getMany = jest.fn().mockResolvedValue([
        {
          isOpen: true,
          revisionNumber: 2,
          startDate: new Date('2026-05-01T00:00:00Z'),
          endDate: new Date('2026-05-20T00:00:00Z'),
          bookedAt: null,
          revisionType: { name: 'แก้ไข' },
        },
        {
          isOpen: false,
          revisionNumber: 1,
          startDate: new Date('2026-03-01T00:00:00Z'),
          endDate: new Date('2026-03-20T00:00:00Z'),
          bookedAt: null,
          revisionType: { name: 'เปลี่ยนแปลง' }, // change — filtered OUT of edit scope
        },
      ]);
      developmentPlanRevisionRepo.createQueryBuilder.mockReturnValue(dprBuilder as any);

      const result = (await service.getTeamDashboard(STAFF_USER_ID, 'revision-edit')) as any;
      expect(result.scope).toBe('revision-edit');
      expect(result.scopeWindow).toEqual({
        phaseType: null,
        openDate: new Date('2026-05-01T00:00:00Z').toISOString(),
        closeDate: new Date('2026-05-20T00:00:00Z').toISOString(),
        isOpen: true,
      });
    });

    it('supplement → close falls back to bookedAt when endDate is null', async () => {
      wireForWindow();
      const dpsBuilder = makeQueryBuilder(null);
      dpsBuilder.getMany = jest.fn().mockResolvedValue([
        {
          isOpen: false,
          supplementNumber: 1,
          startDate: new Date('2026-04-01T00:00:00Z'),
          endDate: null,
          bookedAt: new Date('2026-04-15T00:00:00Z'),
        },
      ]);
      developmentPlanSupplementRepo.createQueryBuilder.mockReturnValue(dpsBuilder as any);

      const result = (await service.getTeamDashboard(STAFF_USER_ID, 'supplement')) as any;
      expect(result.scopeWindow).toEqual({
        phaseType: null,
        openDate: new Date('2026-04-01T00:00:00Z').toISOString(),
        closeDate: new Date('2026-04-15T00:00:00Z').toISOString(),
        isOpen: false,
      });
    });
  });
});
