import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { EquipmentProjectGroupService } from './equipment-project-group.service';
import { EquipmentProjectGroup } from './entities/equipment-project-group.entity';
import { WorkHistoryLookupService } from 'src/work-history/work-history-lookup.service';
import { ProjectClassificationValidator } from 'src/common/project-classification/project-classification.validator';
import { BookFormatResolver } from 'src/common/project-classification/book-format.resolver';
import { PreSubmitSnapshotService } from 'src/ai/pre-submit-snapshot.service';
import { UsersService } from 'src/users/users.service';
import { ReportFormat } from 'src/development-plan/types/report-format.enum';

/**
 * Wave Equipment Sidebar Counts — BE-01 (2026-05-28).
 *
 * Unit tests for `EquipmentProjectGroupService.getCountsByStatus`.
 *
 * Scope verified:
 *   - §1 / §5.3 classification gate — agency callers run the live
 *     COUNT FILTER query; LAO callers (and super-admin LAO) short-
 *     circuit to a zero envelope with NO DB hit.
 *   - §4 owner-scope — counts are filtered by `createdBy.id =
 *     currentWorkHistory.id` and never leak across WorkHistories.
 *   - §17.11 — no role bypass; only classification matters.
 *   - Envelope shape — all 5 keys always present; coercion of
 *     `pg`-driver string COUNT to integer; missing rows → 0.
 *   - Soft-deleted rows excluded (verified via the SQL `deleted_at IS
 *     NULL` clause being part of the QueryBuilder chain assertion).
 */

const AGENCY_WORK_HISTORY = {
  id: 'wh-agency-1',
  amphoe: { id: '3001' },
  localAdministrativeOrganization: { id: '3001027' },
} as any;

const LAO_WORK_HISTORY = {
  id: 'wh-lao-1',
  amphoe: { id: '3002' },
  localAdministrativeOrganization: { id: '3002099' },
} as any;

const SUPER_ADMIN_LAO_WORK_HISTORY = {
  id: 'wh-super-admin-lao-1',
  amphoe: { id: '3002' },
  localAdministrativeOrganization: { id: '3002099' },
  // Role is irrelevant — classification (§1) is the only gate per §17.11.
  user: { role: { name: 'super-admin' } },
} as any;

describe('EquipmentProjectGroupService.getCountsByStatus', () => {
  let service: EquipmentProjectGroupService;
  let workHistoryLookup: { getCurrent: jest.Mock; assertWorkStatusApproved: jest.Mock };
  let queryBuilderChain: {
    innerJoin: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    select: jest.Mock;
    addSelect: jest.Mock;
    getRawOne: jest.Mock;
  };
  let createQueryBuilder: jest.Mock;
  let lastWhereParams: Record<string, unknown> | undefined;
  let lastAndWhereCalls: Array<{ sql: string; params?: Record<string, unknown> }>;

  const buildQueryBuilderMock = (
    rawResult: Record<string, string | number | null> | undefined,
  ) => {
    lastWhereParams = undefined;
    lastAndWhereCalls = [];
    const chain: any = {
      innerJoin: jest.fn().mockImplementation(() => chain),
      where: jest.fn().mockImplementation((_sql: string, params?: Record<string, unknown>) => {
        lastWhereParams = params;
        return chain;
      }),
      andWhere: jest.fn().mockImplementation((sql: string, params?: Record<string, unknown>) => {
        lastAndWhereCalls.push({ sql, params });
        return chain;
      }),
      select: jest.fn().mockImplementation(() => chain),
      addSelect: jest.fn().mockImplementation(() => chain),
      getRawOne: jest.fn().mockResolvedValue(rawResult),
    };
    return chain;
  };

  beforeEach(async () => {
    workHistoryLookup = {
      getCurrent: jest.fn(),
      assertWorkStatusApproved: jest.fn(),
    };

    queryBuilderChain = buildQueryBuilderMock(undefined);
    createQueryBuilder = jest.fn().mockReturnValue(queryBuilderChain);

    const equipmentRepoMock = {
      manager: {} as any,
      createQueryBuilder,
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EquipmentProjectGroupService,
        {
          provide: getRepositoryToken(EquipmentProjectGroup),
          useValue: equipmentRepoMock,
        },
        { provide: WorkHistoryLookupService, useValue: workHistoryLookup },
        { provide: ProjectClassificationValidator, useValue: { validate: jest.fn() } },
        { provide: BookFormatResolver, useValue: { resolveByPlan: jest.fn() } },
        { provide: PreSubmitSnapshotService, useValue: { createSnapshot: jest.fn() } },
        // DataSource is not consulted by getCountsByStatus (read-only,
        // no transaction) — stub satisfies DI only.
        { provide: DataSource, useValue: {} as DataSource },
      ],
    }).compile();

    service = module.get<EquipmentProjectGroupService>(
      EquipmentProjectGroupService,
    );
  });

  describe('agency caller', () => {
    beforeEach(() => {
      workHistoryLookup.getCurrent.mockResolvedValue(AGENCY_WORK_HISTORY);
    });

    it('returns live counts for a mixed equipment portfolio', async () => {
      queryBuilderChain.getRawOne.mockResolvedValue({
        ready_count: '2',
        pending_count: '1',
        verified_count: '1',
        returned_for_revision_count: '0',
        pull_back_count: '0',
      });

      const result = await service.getCountsByStatus('user-agency-1');

      expect(result).toEqual({
        ready: 2,
        pending: 1,
        verified: 1,
        returnedForRevision: 0,
        pullBack: 0,
      });
      // Owner-scope predicate uses workHistory.id, NOT raw userId.
      expect(lastWhereParams).toEqual({ workHistoryId: 'wh-agency-1' });
      // Soft-delete exclusion present in the chain.
      expect(
        lastAndWhereCalls.some((c) =>
          c.sql.includes('equipment.deleted_at IS NULL'),
        ),
      ).toBe(true);
      // §2 workStatus gate fired.
      expect(workHistoryLookup.assertWorkStatusApproved).toHaveBeenCalledWith(
        AGENCY_WORK_HISTORY,
      );
    });

    it('returns the zero envelope when the caller owns zero equipment', async () => {
      queryBuilderChain.getRawOne.mockResolvedValue({
        ready_count: '0',
        pending_count: '0',
        verified_count: '0',
        returned_for_revision_count: '0',
        pull_back_count: '0',
      });

      const result = await service.getCountsByStatus('user-agency-1');

      expect(result).toEqual({
        ready: 0,
        pending: 0,
        verified: 0,
        returnedForRevision: 0,
        pullBack: 0,
      });
      // DB WAS still hit (live query path).
      expect(createQueryBuilder).toHaveBeenCalledTimes(1);
    });

    it('coerces numeric COUNT values returned by the pg driver as strings', async () => {
      // Real pg driver returns COUNT as string; defensively accept number too.
      queryBuilderChain.getRawOne.mockResolvedValue({
        ready_count: 5,
        pending_count: '3',
        verified_count: null,
        returned_for_revision_count: undefined as any,
        pull_back_count: 'not-a-number',
      });

      const result = await service.getCountsByStatus('user-agency-1');

      expect(result).toEqual({
        ready: 5,
        pending: 3,
        verified: 0,
        returnedForRevision: 0,
        pullBack: 0,
      });
    });

    it('owner-scope predicate isolates one WorkHistory from another', async () => {
      // Simulate caller B asking for counts; their workHistory.id MUST
      // be the only param passed to the WHERE clause — there is no path
      // by which caller A's rows could leak in.
      const callerB = {
        ...AGENCY_WORK_HISTORY,
        id: 'wh-agency-2',
      };
      workHistoryLookup.getCurrent.mockResolvedValue(callerB);
      queryBuilderChain.getRawOne.mockResolvedValue({
        ready_count: '0',
        pending_count: '0',
        verified_count: '0',
        returned_for_revision_count: '0',
        pull_back_count: '0',
      });

      await service.getCountsByStatus('user-agency-2');

      expect(lastWhereParams).toEqual({ workHistoryId: 'wh-agency-2' });
      expect(lastWhereParams).not.toEqual({ workHistoryId: 'wh-agency-1' });
    });
  });

  describe('non-agency callers', () => {
    it('LAO caller — returns zero envelope WITHOUT hitting the DB', async () => {
      workHistoryLookup.getCurrent.mockResolvedValue(LAO_WORK_HISTORY);

      const result = await service.getCountsByStatus('user-lao-1');

      expect(result).toEqual({
        ready: 0,
        pending: 0,
        verified: 0,
        returnedForRevision: 0,
        pullBack: 0,
      });
      // §17.11 no role bypass — short-circuit by classification only.
      expect(createQueryBuilder).not.toHaveBeenCalled();
      // §2 workStatus gate STILL fired before the short-circuit.
      expect(workHistoryLookup.assertWorkStatusApproved).toHaveBeenCalledWith(
        LAO_WORK_HISTORY,
      );
    });

    it('super-admin LAO — returns zero envelope (no role bypass)', async () => {
      workHistoryLookup.getCurrent.mockResolvedValue(
        SUPER_ADMIN_LAO_WORK_HISTORY,
      );

      const result = await service.getCountsByStatus('user-super-admin-lao');

      expect(result).toEqual({
        ready: 0,
        pending: 0,
        verified: 0,
        returnedForRevision: 0,
        pullBack: 0,
      });
      // CRITICAL — even super-admin classification gate stops here.
      expect(createQueryBuilder).not.toHaveBeenCalled();
    });

    it('LAO caller — does not consult the equipment table at all', async () => {
      workHistoryLookup.getCurrent.mockResolvedValue(LAO_WORK_HISTORY);

      await service.getCountsByStatus('user-lao-1');

      expect(queryBuilderChain.getRawOne).not.toHaveBeenCalled();
      expect(queryBuilderChain.innerJoin).not.toHaveBeenCalled();
      expect(queryBuilderChain.where).not.toHaveBeenCalled();
    });
  });
});

/**
 * EQ-BE-VERIFY (wave-equipment-edit-bug, 2026-05-30) — `update()` guard
 * coverage. Self-contained test module (provides every constructor dep,
 * including `UsersService` and a `DataSource.transaction` shim) so it does
 * NOT depend on the `getCountsByStatus` suite above. Test-only addition —
 * no production logic changed.
 *
 * Verifies the seven EQ-BE-VERIFY points:
 *   1. §5.3 agency-only — lao caller rejected.
 *   2. §4 ownership — non-owner agency caller rejected.
 *   3. missing row → NotFound.
 *   4/5. EQUIPMENT_PLAN_IMMUTABLE trips only on a DIFFERENT plan id.
 *   6. §16.5 shape validation runs; §5.1 responsibleAgency never in patch.
 *   7. no AI snapshot fired on update.
 */
describe('EquipmentProjectGroupService.update', () => {
  const AGENCY_WH = {
    id: 'wh-agency-1',
    amphoe: { id: '3001' },
    localAdministrativeOrganization: { id: '3001027' },
  } as any;

  const LAO_WH = {
    id: 'wh-lao-1',
    amphoe: { id: '3002' },
    localAdministrativeOrganization: { id: '3002099' },
  } as any;

  let service: EquipmentProjectGroupService;
  let workHistoryLookup: {
    getCurrent: jest.Mock;
    assertWorkStatusApproved: jest.Mock;
  };
  let classificationValidator: { validate: jest.Mock };
  let bookFormatResolver: { resolveByPlan: jest.Mock };
  let preSubmitSnapshot: { createSnapshot: jest.Mock };
  let mockManager: {
    findOne: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
  };

  const makeExisting = (overrides: Record<string, any> = {}): any => ({
    id: 'eq-1',
    equipmentName: 'เครื่องเดิม',
    developmentPlan: { id: 'plan-1' },
    createdBy: { id: 'wh-agency-1' },
    equipmentCategory: { id: 'cat-1', code: 'ค.01' },
    strategy: { id: 'str-1' },
    tactic: { id: 'tac-1' },
    plan: { id: 'pl-1' },
    developmentIssue: null,
    ...overrides,
  });

  // Route manager.findOne by entity so the STRATEGY_BASED update path
  // resolves: existing row → category → strategy/tactic/plan → scope →
  // findOneInternal final read.
  const routeFindOne = (existing: any): jest.Mock =>
    jest.fn().mockImplementation((entity: any) => {
      const name = entity?.name ?? entity;
      if (name === 'EquipmentProjectGroup') return Promise.resolve(existing);
      if (name === 'EquipmentCategory')
        return Promise.resolve({ id: 'cat-1', code: 'ค.01' });
      if (name === 'Strategy') return Promise.resolve({ id: 'str-1' });
      if (name === 'Tactic') return Promise.resolve({ id: 'tac-1' });
      if (name === 'Plan') return Promise.resolve({ id: 'pl-1' });
      if (name === 'EquipmentCategoryScope')
        return Promise.resolve({ id: 'scope-1' });
      return Promise.resolve(null);
    });

  beforeEach(async () => {
    workHistoryLookup = {
      getCurrent: jest.fn(),
      assertWorkStatusApproved: jest.fn(),
    };
    classificationValidator = { validate: jest.fn() };
    bookFormatResolver = {
      resolveByPlan: jest.fn().mockResolvedValue(ReportFormat.STRATEGY_BASED),
    };
    preSubmitSnapshot = { createSnapshot: jest.fn() };
    mockManager = {
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
      save: jest.fn().mockResolvedValue(undefined),
      create: jest.fn().mockImplementation((_e, v) => v),
    };

    const dataSourceMock = {
      transaction: jest.fn().mockImplementation((cb: any) => cb(mockManager)),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EquipmentProjectGroupService,
        {
          provide: getRepositoryToken(EquipmentProjectGroup),
          useValue: { manager: {} as any, createQueryBuilder: jest.fn() },
        },
        { provide: DataSource, useValue: dataSourceMock },
        { provide: WorkHistoryLookupService, useValue: workHistoryLookup },
        {
          provide: ProjectClassificationValidator,
          useValue: classificationValidator,
        },
        { provide: BookFormatResolver, useValue: bookFormatResolver },
        { provide: PreSubmitSnapshotService, useValue: preSubmitSnapshot },
        {
          provide: UsersService,
          useValue: { decryptUserPii: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();

    service = module.get(EquipmentProjectGroupService);
  });

  it('rejects a lao caller with ForbiddenException (§5.3)', async () => {
    workHistoryLookup.getCurrent.mockResolvedValue(LAO_WH);
    await expect(
      service.update('eq-1', {} as any, 'user-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(mockManager.update).not.toHaveBeenCalled();
  });

  it('rejects a non-owner agency caller with ForbiddenException (§4)', async () => {
    workHistoryLookup.getCurrent.mockResolvedValue({
      ...AGENCY_WH,
      id: 'wh-agency-OTHER',
    });
    mockManager.findOne.mockResolvedValue(
      makeExisting({ createdBy: { id: 'wh-agency-1' } }),
    );
    await expect(
      service.update('eq-1', {} as any, 'user-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(mockManager.update).not.toHaveBeenCalled();
  });

  it('throws NotFound when the equipment row is missing', async () => {
    workHistoryLookup.getCurrent.mockResolvedValue(AGENCY_WH);
    mockManager.findOne.mockResolvedValue(null);
    await expect(
      service.update('missing', {} as any, 'user-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('trips EQUIPMENT_PLAN_IMMUTABLE only when developmentPlanId re-points to a DIFFERENT plan', async () => {
    workHistoryLookup.getCurrent.mockResolvedValue(AGENCY_WH);
    mockManager.findOne.mockResolvedValue(
      makeExisting({ developmentPlan: { id: 'plan-1' } }),
    );
    await expect(
      service.update(
        'eq-1',
        { developmentPlanId: 'plan-DIFFERENT' } as any,
        'user-1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(mockManager.update).not.toHaveBeenCalled();
  });

  it('does NOT trip EQUIPMENT_PLAN_IMMUTABLE when developmentPlanId is the SAME plan', async () => {
    const existing = makeExisting({ developmentPlan: { id: 'plan-1' } });
    workHistoryLookup.getCurrent.mockResolvedValue(AGENCY_WH);
    mockManager.findOne = routeFindOne(existing);
    await expect(
      service.update(
        'eq-1',
        { developmentPlanId: 'plan-1', equipmentName: 'แก้ชื่อ' } as any,
        'user-1',
      ),
    ).resolves.toBeDefined();
    expect(mockManager.update).toHaveBeenCalledTimes(1);
  });

  it('accepts a same-plan agency-owner edit, runs §16.5 validation, and never patches responsibleAgency (§5.1)', async () => {
    const existing = makeExisting();
    workHistoryLookup.getCurrent.mockResolvedValue(AGENCY_WH);
    mockManager.findOne = routeFindOne(existing);

    await service.update(
      'eq-1',
      { equipmentName: 'เครื่องใหม่' } as any,
      'user-1',
    );

    // §16.5 — classification validator ran on update.
    expect(classificationValidator.validate).toHaveBeenCalledTimes(1);
    // §5.1 — the patch must not carry server-derived / immutable fields.
    const patchArg = mockManager.update.mock.calls[0]?.[2] ?? {};
    expect(patchArg).not.toHaveProperty('responsibleAgency');
    expect(patchArg).not.toHaveProperty('createdBy');
    expect(patchArg).not.toHaveProperty('developmentPlan');
    expect(patchArg).not.toHaveProperty('isBooked');
    expect(patchArg).toHaveProperty('equipmentName', 'เครื่องใหม่');
  });

  it('does not fire an AI snapshot on update', async () => {
    const existing = makeExisting();
    workHistoryLookup.getCurrent.mockResolvedValue(AGENCY_WH);
    mockManager.findOne = routeFindOne(existing);

    await service.update(
      'eq-1',
      { equipmentName: 'เครื่องใหม่' } as any,
      'user-1',
    );

    expect(preSubmitSnapshot.createSnapshot).not.toHaveBeenCalled();
  });
});
