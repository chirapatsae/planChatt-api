// W74-BE-INTEGRATION-SPEC — CLAUDE.md §14.1 / §14.2 / §14.9
//
// Verifies that `RevisedProjectGroupService.create` persists BOTH lineage FK
// columns (`prev_project_id` and `prev_project_type`) end-to-end, and that the
// §14.2 immutability invariant kicks in immediately after a new descendant is
// inserted — i.e. calling `LineageLockService.assertEditable` on the parent
// row throws `ConflictException` with prefix `PROJECT_HAS_DESCENDANT`.
//
// Cases:
//   1. positive — `prev_project_type='original'` (forking from main plan)
//   2. positive — `prev_project_type='revised'`  (forking from a prior revision)
//   3. negative — missing `prevProjectId` triggers the W74 BE-GUARDRAIL
//                  `LINEAGE_FK_REQUIRED` BadRequestException
//   4. negative — invalid `prevProjectType` triggers the same guard rail
//
// Implementation note: the existing test harness in this repo (see W72's
// `development-plan.service.w72.spec.ts`) is a NestJS `Test.createTestingModule`
// pattern with a fake `EntityManager`. We mirror that pattern here. The fake
// EntityManager maintains an in-memory `revisedRows[]` so that the REAL
// `LineageLockService` (wired as a real provider, NOT mocked) can run
// `manager.exists(RevisedProjectGroup, ...)` against the post-create state and
// give us a faithful §14.2 assertion. This is the closest thing to a "real DB"
// integration spec that the existing harness supports without bringing up
// Postgres.

// ---------------------------------------------------------------------------
// Encryption-util env shim — must run BEFORE any backend import that
// transitively pulls in `src/util/encryption.util` (e.g. via UsersService).
// Required because the loader validates SALT/SECRET_KEY/ALGORITHM at module
// load time and Jest's `NODE_ENV='test'` does not match the project's
// `.env.development` / `.env.production` files. This spec exercises no
// encryption path. Same pattern as W72.
// ---------------------------------------------------------------------------
jest.mock('src/util/encryption.util', () => ({
  encryption: jest.fn(async (v: string) => v),
  decryption: jest.fn(async (v: string) => v),
  hashPii: jest.fn((v: string) => v),
}));

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { RevisedProjectGroupService } from '../revised-project-group.service';
import { RevisedProjectGroup } from '../entities/revised-project-group.entity';
import {
  CreateRevisedProjectGroupDto,
  PrevProjectType,
} from '../dto/create-revised-project-group.dto';
import { DevelopmentPlanRevision } from 'src/development-plan-revision/entities/development-plan-revision.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { Strategy } from 'src/strategy/entities/strategy.entity';
import { Tactic } from 'src/tactic/entities/tactic.entity';
import { Plan } from 'src/plan/entities/plan.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { Budget } from 'src/budget/entities/budget.entity';
// Wave SUPP-4 / BE-01 — SPG repo is now a constructor dependency of
// RevisedProjectGroupService for the supplement-source fork path. The
// existing 'original'/'revised' cases don't exercise it, but the DI
// container needs a stub so module compile does not fail.
import { SupplementProjectGroup } from 'src/supplement-project-group/entities/supplement-project-group.entity';
import { TrackingStatus } from 'src/tracking-status/entities/tracking-status.entity';
import { GovernmentAgency } from 'src/government-agencies/entities/government-agency.entity';
import {
  LineageLockService,
  PROJECT_HAS_DESCENDANT,
} from 'src/common/lineage-lock/lineage-lock.service';
import { ProjectClassificationValidator } from 'src/common/project-classification/project-classification.validator';
import { BookFormatResolver } from 'src/common/project-classification/book-format.resolver';
import { ReportFormat } from 'src/development-plan/types/report-format.enum';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const PG_PARENT_ID = '11111111-1111-1111-1111-111111111111'; // ProjectGroup P1
const RPG_R1_ID = '22222222-2222-2222-2222-222222222222';    // RevisedProjectGroup R1
const REVISION_ID = '33333333-3333-3333-3333-333333333333';
const PLAN_ID = '44444444-4444-4444-4444-444444444444';
const WORK_HISTORY_ID = '55555555-5555-5555-5555-555555555555';
const USER_ID = '66666666-6666-6666-6666-666666666666';

function buildBaseDto(
  overrides: Partial<CreateRevisedProjectGroupDto> = {},
): CreateRevisedProjectGroupDto {
  return {
    developmentPlanRevisionId: REVISION_ID,
    title: 'โครงการทดสอบ W74',
    objective: 'objective',
    goal: 'goal',
    indicator: 'indicator-kpi',
    expected: 'expected',
    projectYear: 2570,
    strategyId: 'strategy-id',
    tacticId: 'tactic-id',
    planId: 'plan-id',
    prevProjectId: PG_PARENT_ID,
    prevProjectType: PrevProjectType.ORIGINAL,
    responsibleAgency: 'agency-id',
    ...overrides,
  } as CreateRevisedProjectGroupDto;
}

// In-memory store row shape, mirrors the columns the §14.2 lock predicate cares
// about: `prev_project_id`, `prev_project_type`, `deleted_at` and `id`.
interface FakeRpgRow {
  id: string;
  prevProjectId: string | null;
  prevProjectType: PrevProjectType | null;
  deletedAt: Date | null;
  // Capture the full "saved entity" so we can assert on the persisted shape,
  // not just on the in-memory object returned by `manager.create`.
  raw: any;
}

// ---------------------------------------------------------------------------
// Fake EntityManager builder
// ---------------------------------------------------------------------------

function buildFakeManager(seed: { revisedRows: FakeRpgRow[] }) {
  // Stable references for entity fixtures returned by `findOne`.
  const developmentPlan: Partial<DevelopmentPlan> = {
    id: PLAN_ID,
    startYear: 2566,
    endYear: 2570,
    reportFormat: ReportFormat.STRATEGY_BASED,
  };

  const developmentPlanRevision: Partial<DevelopmentPlanRevision> = {
    id: REVISION_ID,
    isOpen: true,
    revisionType: { id: 'rt-id', name: 'แก้ไข' } as any,
    developmentPlan: developmentPlan as DevelopmentPlan,
  };

  const projectGroup: Partial<ProjectGroup> = { id: PG_PARENT_ID };
  const governmentAgency: Partial<GovernmentAgency> = { id: 'agency-id' };
  const strategy: Partial<Strategy> = { id: 'strategy-id' };
  const tactic: Partial<Tactic> = { id: 'tactic-id' };
  const plan: Partial<Plan> = { id: 'plan-id' };

  const workHistory: any = {
    id: WORK_HISTORY_ID,
    user: { id: USER_ID },
    isCurrent: true,
    role: { id: 'role-id', name: 'user' },
    workStatus: { id: 'ws-id', name: 'approved' },
    amphoe: { id: '3001' },
    localAdministrativeOrganization: { id: '3001027' },
    governmentAgencies: { id: 'agency-id' },
  };

  const findOne = jest
    .fn()
    .mockImplementation(async (entity: any, _opts: any) => {
      if (entity === DevelopmentPlanRevision) return developmentPlanRevision;
      if (entity === ProjectGroup) return projectGroup;
      if (entity === GovernmentAgency) return governmentAgency;
      if (entity === DevelopmentPlan) return developmentPlan;
      if (entity === Strategy) return strategy;
      if (entity === Tactic) return tactic;
      if (entity === Plan) return plan;
      if (entity === WorkHistory) return workHistory;
      if (entity === TrackingStatus) return null;
      return null;
    });

  // The service's validateForeignKeys uses a tuple via Promise.all of two
  // findOne calls; both go through the same mock. For the strategy/tactic/plan
  // it likewise calls findOne three times — already handled above.

  const create = jest.fn().mockImplementation((_entity: any, payload: any) => {
    // Mirror TypeORM's create() — return the merged payload as-is.
    return { ...payload };
  });

  // `save` may receive either a single entity or an array (the budgets
  // branch). In all cases we assign an id where missing and return what was
  // passed. For RevisedProjectGroup we ALSO push into the in-memory store so
  // the lineage-lock query downstream can see it.
  const save = jest.fn().mockImplementation(async (input: any) => {
    if (Array.isArray(input)) {
      return input.map((r) => ({ id: r.id ?? cryptoRandomUuid(), ...r }));
    }
    // Detect a RevisedProjectGroup-shaped payload by the lineage FK.
    const isRpgShape =
      input &&
      typeof input === 'object' &&
      ('prevProjectId' in input || 'prevProjectType' in input) &&
      'developmentPlanRevision' in input;

    if (isRpgShape) {
      const id = input.id ?? cryptoRandomUuid();
      const persisted = { id, ...input };
      seed.revisedRows.push({
        id,
        prevProjectId: persisted.prevProjectId ?? null,
        prevProjectType: persisted.prevProjectType ?? null,
        deletedAt: null,
        raw: persisted,
      });
      return persisted;
    }

    // Tracking status / budgets / etc — just echo back with an id.
    return { id: input.id ?? cryptoRandomUuid(), ...input };
  });

  // The real LineageLockService uses `manager.exists(RevisedProjectGroup, ...)`
  // — implement it against our in-memory store, honouring `deleted_at IS NULL`
  // (TypeORM's exists honours @DeleteDateColumn by default — §14.2 wording).
  const exists = jest
    .fn()
    .mockImplementation(async (entity: any, opts: any) => {
      if (entity !== RevisedProjectGroup) return false;
      const where = opts?.where ?? {};
      return seed.revisedRows.some(
        (row) =>
          row.deletedAt === null &&
          (where.prevProjectId === undefined ||
            row.prevProjectId === where.prevProjectId) &&
          (where.prevProjectType === undefined ||
            row.prevProjectType === where.prevProjectType),
      );
    });

  // The service's `bookFormatResolver` is mocked separately, so we do NOT
  // need a working `getRepository` for the resolver path. Provide a minimal
  // stub so any incidental getRepository call returns an object with the
  // methods used by the rest of the service surface.
  const getRepository = jest.fn().mockReturnValue({
    findOne,
    createQueryBuilder: jest.fn(),
  });

  const fakeManager = {
    findOne,
    create,
    save,
    exists,
    getRepository,
  } as unknown as EntityManager;

  return { fakeManager, developmentPlanRevision, workHistory };
}

function cryptoRandomUuid(): string {
  // Lightweight pseudo-uuid for in-memory rows. We don't need cryptographic
  // strength — just uniqueness within the test process.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('crypto').randomUUID();
}

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------

describe('RevisedProjectGroupService — W74 lineage FK end-to-end (CLAUDE.md §14.1 / §14.2 / §14.9)', () => {
  let service: RevisedProjectGroupService;
  let lineageLockService: LineageLockService;
  let dataSource: { transaction: jest.Mock };
  let seed: { revisedRows: FakeRpgRow[] };
  let fakeManager: EntityManager;

  beforeEach(async () => {
    seed = { revisedRows: [] };
    const built = buildFakeManager(seed);
    fakeManager = built.fakeManager;

    dataSource = {
      transaction: jest
        .fn()
        .mockImplementation(async (cb: (m: EntityManager) => unknown) =>
          cb(fakeManager),
        ),
    };

    // BookFormatResolver is mocked — STRATEGY_BASED keeps the test
    // deterministic (the task explicitly scopes ISSUE_BASED OUT, see §10
    // acceptance bullet "issue-based coverage is OUT OF SCOPE for W74").
    const bookFormatResolver = {
      resolveByRevision: jest.fn().mockResolvedValue(ReportFormat.STRATEGY_BASED),
    };
    const classificationValidator = { validate: jest.fn() };

    const repoStub = () => ({
      find: jest.fn(),
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(),
      exists: jest.fn(),
      exist: jest.fn(),
      update: jest.fn(),
      save: jest.fn(),
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RevisedProjectGroupService,
        // Real LineageLockService — this is the value-add of the spec: the
        // post-create §14.2 assertion runs through the production code path.
        LineageLockService,
        {
          provide: getRepositoryToken(RevisedProjectGroup),
          useValue: repoStub(),
        },
        {
          provide: getRepositoryToken(DevelopmentPlanRevision),
          useValue: repoStub(),
        },
        { provide: getRepositoryToken(ProjectGroup), useValue: repoStub() },
        { provide: getRepositoryToken(SupplementProjectGroup), useValue: repoStub() },
        { provide: getRepositoryToken(DevelopmentPlan), useValue: repoStub() },
        { provide: getRepositoryToken(Strategy), useValue: repoStub() },
        { provide: getRepositoryToken(Tactic), useValue: repoStub() },
        { provide: getRepositoryToken(Plan), useValue: repoStub() },
        { provide: getRepositoryToken(WorkHistory), useValue: repoStub() },
        { provide: getRepositoryToken(Budget), useValue: repoStub() },
        { provide: DataSource, useValue: dataSource },
        { provide: ProjectClassificationValidator, useValue: classificationValidator },
        { provide: BookFormatResolver, useValue: bookFormatResolver },
      ],
    }).compile();

    service = module.get<RevisedProjectGroupService>(RevisedProjectGroupService);
    lineageLockService = module.get<LineageLockService>(LineageLockService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Case 1 — positive: prev_project_type='original'
  // -------------------------------------------------------------------------
  it('Case 1 — persists prev_project_id and prev_project_type=original, then locks the parent ProjectGroup per §14.2', async () => {
    const dto = buildBaseDto({
      prevProjectId: PG_PARENT_ID,
      prevProjectType: PrevProjectType.ORIGINAL,
    });

    const result = await service.create(dto, USER_ID);

    // The created row carries the FK on the in-memory entity.
    expect(result).toBeDefined();
    expect(result.prevProjectId).toBe(PG_PARENT_ID);
    expect(result.prevProjectType).toBe(PrevProjectType.ORIGINAL);

    // The persisted row (what hit `manager.save`) is non-null on both columns.
    expect(seed.revisedRows).toHaveLength(1);
    const persisted = seed.revisedRows[0];
    expect(persisted.prevProjectId).toBe(PG_PARENT_ID);
    expect(persisted.prevProjectType).toBe(PrevProjectType.ORIGINAL);
    expect(persisted.prevProjectId).not.toBeNull();
    expect(persisted.prevProjectType).not.toBeNull();

    // §14.2 invariant — the parent ProjectGroup is locked the moment a draft
    // descendant is created. assertEditable MUST throw ConflictException with
    // PROJECT_HAS_DESCENDANT prefix.
    await expect(
      lineageLockService.assertEditable(PG_PARENT_ID, 'original', fakeManager),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      lineageLockService.assertEditable(PG_PARENT_ID, 'original', fakeManager),
    ).rejects.toMatchObject({
      message: expect.stringContaining(PROJECT_HAS_DESCENDANT),
    });
  });

  // -------------------------------------------------------------------------
  // Case 2 — positive: prev_project_type='revised'
  // -------------------------------------------------------------------------
  it('Case 2 — persists prev_project_id and prev_project_type=revised, locks the parent RevisedProjectGroup, and the upstream ProjectGroup remains locked (§14.2 ANY-descendant predicate)', async () => {
    // Pre-seed R1 as an existing RevisedProjectGroup descendant of P1.
    seed.revisedRows.push({
      id: RPG_R1_ID,
      prevProjectId: PG_PARENT_ID,
      prevProjectType: PrevProjectType.ORIGINAL,
      deletedAt: null,
      raw: { id: RPG_R1_ID },
    });

    // Pre-condition: P1 is already locked by R1 — sanity check before R2 lands.
    await expect(
      lineageLockService.assertEditable(PG_PARENT_ID, 'original', fakeManager),
    ).rejects.toBeInstanceOf(ConflictException);

    const dto = buildBaseDto({
      prevProjectId: RPG_R1_ID,
      prevProjectType: PrevProjectType.REVISION,
    });

    const result = await service.create(dto, USER_ID);

    // Newly inserted R2 carries the correct FKs.
    expect(result.prevProjectId).toBe(RPG_R1_ID);
    expect(result.prevProjectType).toBe(PrevProjectType.REVISION);

    // R2 was actually persisted on top of the R1 seed → 2 rows total.
    expect(seed.revisedRows).toHaveLength(2);
    const r2 = seed.revisedRows.find((r) => r.id !== RPG_R1_ID)!;
    expect(r2.prevProjectId).toBe(RPG_R1_ID);
    expect(r2.prevProjectType).toBe(PrevProjectType.REVISION);

    // §14.2 — R1 itself is now locked because R2 references it.
    await expect(
      lineageLockService.assertEditable(RPG_R1_ID, 'revised', fakeManager),
    ).rejects.toMatchObject({
      message: expect.stringContaining(PROJECT_HAS_DESCENDANT),
    });

    // §14.2 — P1 is STILL locked. The lock predicate is "any non-soft-deleted
    // descendant", so R1 alone is sufficient and the addition of R2 (whose
    // direct parent is R1, not P1) does not change P1's lock state.
    await expect(
      lineageLockService.assertEditable(PG_PARENT_ID, 'original', fakeManager),
    ).rejects.toMatchObject({
      message: expect.stringContaining(PROJECT_HAS_DESCENDANT),
    });
  });

  // -------------------------------------------------------------------------
  // Case 3 — negative: missing prevProjectId
  // -------------------------------------------------------------------------
  it('Case 3 — throws BadRequestException(LINEAGE_FK_REQUIRED) and persists nothing when prevProjectId is missing', async () => {
    const dto = buildBaseDto();
    // Force the field absent post-construction, mirroring a payload that
    // bypassed the global ValidationPipe (the failure mode the W74 guard
    // rail is designed to catch).
    delete (dto as any).prevProjectId;

    await expect(service.create(dto, USER_ID)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.create(dto, USER_ID)).rejects.toMatchObject({
      message: expect.stringContaining('LINEAGE_FK_REQUIRED'),
    });

    // No row was persisted — guard rail fires before the transaction opens.
    expect(seed.revisedRows).toHaveLength(0);
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Case 4 — negative: invalid prevProjectType
  // -------------------------------------------------------------------------
  it('Case 4 — throws BadRequestException(LINEAGE_FK_REQUIRED) and persists nothing when prevProjectType is not in the enum', async () => {
    const dto = buildBaseDto();
    (dto as any).prevProjectType = 'invalid_kind';

    await expect(service.create(dto, USER_ID)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.create(dto, USER_ID)).rejects.toMatchObject({
      message: expect.stringContaining('LINEAGE_FK_REQUIRED'),
    });

    expect(seed.revisedRows).toHaveLength(0);
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });
});
