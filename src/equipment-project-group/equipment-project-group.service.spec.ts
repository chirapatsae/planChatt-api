import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { EquipmentProjectGroupService } from './equipment-project-group.service';
import { EquipmentProjectGroup } from './entities/equipment-project-group.entity';
import { WorkHistoryLookupService } from 'src/work-history/work-history-lookup.service';
import { ProjectClassificationValidator } from 'src/common/project-classification/project-classification.validator';
import { BookFormatResolver } from 'src/common/project-classification/book-format.resolver';
import { PreSubmitSnapshotService } from 'src/ai/pre-submit-snapshot.service';

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
