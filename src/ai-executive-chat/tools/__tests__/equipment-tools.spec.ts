/**
 * Wave AI-Exec-Chat-Equipment-ผ.03 — registry + handler spec for the
 * seven equipment (ผ.03) tools
 * (docs/tasks/AI_EXEC_CHAT_EQUIPMENT_P03_COVERAGE.md §3.6).
 *
 * Coverage:
 *   - registry: all 7 specs present, whitelisted, handler-mapped
 *   - §17.9 round-trip: every handler result validates against its
 *     canonical `returnSchema` (happy path + graceful paths)
 *   - handler-owned UUID validation → friendly-hint envelope (never
 *     AI_SCHEMA_DRIFT), aggregator NOT called
 *   - deps-absent graceful envelope (optional-dep convention)
 *   - §17.11 role assertion inside every handler
 *   - params schemas: `additionalProperties: false` enforced
 */
import {
  EXECUTIVE_TOOL_NAMES,
  EXECUTIVE_TOOL_REGISTRY,
} from '../tool-registry';
import { EXECUTIVE_TOOL_HANDLERS } from '../handlers/executive-tool-handlers';
import type {
  ExecutiveCallerContext,
  ExecutiveToolHandlerDeps,
} from '../handlers/handler-types';
import { validateAgainstSchema } from '../tool-schema-validator';
import type { UnifiedEquipmentAggregatorService } from '../../aggregation/services/unified-equipment-aggregator.service';

const EQUIPMENT_TOOL_NAMES = [
  'searchEquipmentByKeyword',
  'listEquipmentInPlan',
  'getEquipmentBudgetSummary',
  'getEquipmentStatusBreakdown',
  'getEquipmentCategoryBreakdown',
  'listEquipmentInRevisionBook',
  'listEquipmentInSupplementBook',
] as const;

const PLAN_A = '11111111-1111-4111-8111-111111111111';
const DPR_1 = '22222222-2222-4222-8222-222222222222';
const DPS_1 = '33333333-3333-4333-8333-333333333333';

const CTX: ExecutiveCallerContext = {
  userId: 'user-1',
  workHistoryId: 'wh-1',
  roleName: 'c-level',
  workStatusName: 'approved',
};

const ITEM = {
  equipmentId: 'aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  equipmentKind: 'equipment',
  bookLabel: 'เล่มหลัก',
  name: 'เครื่องคอมพิวเตอร์',
  categoryCode: 1,
  categoryName: 'ครุภัณฑ์คอมพิวเตอร์',
  planId: PLAN_A,
  planName: 'แผนพัฒนาท้องถิ่น พ.ศ. 2566-2570',
  currentStatus: 'Approved',
  statusTh: 'อนุมัติ',
  executiveStatus: 'approved',
  responsibleAgencyName: 'สำนักปลัด',
  totalBudget: 50000,
  isBooked: true,
  pageNumber: 5,
  createdAt: '2026-07-01T00:00:00.000Z',
};

function makeAggregatorStub(): Record<
  | 'search'
  | 'listInPlan'
  | 'budgetSummary'
  | 'statusBreakdown'
  | 'categoryBreakdown'
  | 'listInRevisionBook'
  | 'listInSupplementBook',
  jest.Mock
> {
  return {
    search: jest.fn().mockResolvedValue({ items: [ITEM], totalMatched: 1 }),
    listInPlan: jest.fn().mockResolvedValue({
      items: [ITEM],
      totalCount: 1,
      limit: 50,
      offset: 0,
      nextOffset: null,
    }),
    budgetSummary: jest.fn().mockResolvedValue({
      headItemCount: 2,
      totalBudget: 80000,
      averageBudget: 40000,
      byYear: [{ year: 2567, headItemCount: 2, totalBudget: 80000 }],
      byBook: {
        main: { headItemCount: 2, totalBudget: 80000 },
        edit: { headItemCount: 0, totalBudget: 0 },
        change: { headItemCount: 0, totalBudget: 0 },
        supplement: { headItemCount: 0, totalBudget: 0 },
      },
    }),
    statusBreakdown: jest.fn().mockResolvedValue({
      totalCount: 2,
      items: [{ status: 'Approved', statusTh: 'อนุมัติ', count: 2 }],
      executiveStatusBreakdown: {
        pendingReviewCount: 0,
        awaitingApprovalCount: 0,
        approvedCount: 2,
        rejectedCount: 0,
      },
    }),
    categoryBreakdown: jest.fn().mockResolvedValue({
      totalCount: 2,
      items: [
        {
          categoryCode: 1,
          categoryName: 'ครุภัณฑ์คอมพิวเตอร์',
          itemCount: 2,
          totalBudget: 80000,
        },
      ],
    }),
    listInRevisionBook: jest.fn().mockResolvedValue({
      items: [
        { ...ITEM, equipmentKind: 'revised-equipment', bookLabel: 'เล่มแก้ไขครุภัณฑ์ ครั้งที่ 1' },
      ],
      totalCount: 1,
      limit: 50,
      offset: 0,
      nextOffset: null,
      revisionMeta: {
        revisionId: DPR_1,
        revisionNumber: 1,
        revisionTypeName: 'แก้ไข',
        isOpen: true,
        isBooked: false,
      },
    }),
    listInSupplementBook: jest.fn().mockResolvedValue({
      items: [
        {
          ...ITEM,
          equipmentKind: 'supplement-equipment',
          bookLabel: 'เล่มเพิ่มเติมครุภัณฑ์ ครั้งที่ 2',
        },
      ],
      totalCount: 1,
      limit: 50,
      offset: 0,
      nextOffset: null,
      supplementMeta: {
        supplementId: DPS_1,
        supplementNumber: 2,
        isOpen: false,
        isBooked: true,
      },
    }),
  };
}

function makeDeps(withAggregator: boolean): {
  deps: ExecutiveToolHandlerDeps;
  aggregator: ReturnType<typeof makeAggregatorStub>;
} {
  const aggregator = makeAggregatorStub();
  const deps = {
    dataSource: {} as never,
    unifiedProject: {} as never,
    budget: {} as never,
    status: {} as never,
    geo: {} as never,
    agency: {} as never,
    resilience: {} as never,
    ...(withAggregator
      ? { unifiedEquipment: aggregator as unknown as UnifiedEquipmentAggregatorService }
      : {}),
  } as ExecutiveToolHandlerDeps;
  return { deps, aggregator };
}

const HAPPY_PARAMS: Record<(typeof EQUIPMENT_TOOL_NAMES)[number], Record<string, unknown>> = {
  searchEquipmentByKeyword: { keyword: 'เครื่อง' },
  listEquipmentInPlan: { planId: PLAN_A },
  getEquipmentBudgetSummary: { planId: PLAN_A },
  getEquipmentStatusBreakdown: {},
  getEquipmentCategoryBreakdown: { scope: 'main' },
  listEquipmentInRevisionBook: { revisionId: DPR_1 },
  listEquipmentInSupplementBook: { supplementId: DPS_1 },
};

describe('equipment (ผ.03) executive tools', () => {
  describe('registry', () => {
    it('whitelists all 7 equipment tools with params + return schemas', () => {
      for (const name of EQUIPMENT_TOOL_NAMES) {
        expect(EXECUTIVE_TOOL_NAMES).toContain(name);
        const spec = EXECUTIVE_TOOL_REGISTRY[name];
        expect(spec).toBeDefined();
        expect(spec.name).toBe(name);
        expect(spec.paramsSchema.additionalProperties).toBe(false);
        expect(spec.returnSchema.type).toBe('object');
        expect(spec.description).toContain('อ่านอย่างเดียว');
      }
    });

    it('maps every equipment tool to a handler', () => {
      for (const name of EQUIPMENT_TOOL_NAMES) {
        expect(typeof EXECUTIVE_TOOL_HANDLERS[name]).toBe('function');
      }
    });

    it('params schemas reject additional properties (§17.9)', () => {
      for (const name of EQUIPMENT_TOOL_NAMES) {
        const spec = EXECUTIVE_TOOL_REGISTRY[name];
        const res = validateAgainstSchema(spec.paramsSchema, {
          ...HAPPY_PARAMS[name],
          evilExtra: 'x',
        });
        expect(res.ok).toBe(false);
      }
    });

    it('params schemas accept the canonical happy-path params', () => {
      for (const name of EQUIPMENT_TOOL_NAMES) {
        const spec = EXECUTIVE_TOOL_REGISTRY[name];
        const res = validateAgainstSchema(spec.paramsSchema, HAPPY_PARAMS[name]);
        expect(res.ok).toBe(true);
      }
    });
  });

  describe('handlers — §17.9 return-schema round trip', () => {
    it.each(EQUIPMENT_TOOL_NAMES)(
      '%s happy path validates against returnSchema',
      async (name) => {
        const { deps } = makeDeps(true);
        const result = await EXECUTIVE_TOOL_HANDLERS[name](
          HAPPY_PARAMS[name],
          CTX,
          deps,
        );
        const res = validateAgainstSchema(
          EXECUTIVE_TOOL_REGISTRY[name].returnSchema,
          result,
        );
        expect(res).toEqual({ ok: true });
      },
    );

    it.each(EQUIPMENT_TOOL_NAMES)(
      '%s deps-absent path is graceful AND schema-valid',
      async (name) => {
        const { deps } = makeDeps(false);
        const result = await EXECUTIVE_TOOL_HANDLERS[name](
          HAPPY_PARAMS[name],
          CTX,
          deps,
        );
        expect(result.message).toBeDefined();
        const res = validateAgainstSchema(
          EXECUTIVE_TOOL_REGISTRY[name].returnSchema,
          result,
        );
        expect(res).toEqual({ ok: true });
      },
    );
  });

  describe('handler-owned UUID validation (friendly hint, no drift)', () => {
    it('listEquipmentInPlan rejects a Thai plan name without calling the aggregator', async () => {
      const { deps, aggregator } = makeDeps(true);
      const result = await EXECUTIVE_TOOL_HANDLERS.listEquipmentInPlan(
        { planId: 'แผนพัฒนาท้องถิ่น' },
        CTX,
        deps,
      );
      expect(result.totalCount).toBe(0);
      expect(String(result.message)).toContain('listActivePlans');
      expect(aggregator.listInPlan).not.toHaveBeenCalled();
      expect(
        validateAgainstSchema(
          EXECUTIVE_TOOL_REGISTRY.listEquipmentInPlan.returnSchema,
          result,
        ),
      ).toEqual({ ok: true });
    });

    // Wave FOLLOWUP-CONTINUITY (2026-07-18) — a MISSING planId is NOT an
    // error. It defaults to a WHOLE-MUNICIPALITY listing (aggregator called
    // with planId `undefined`, scope 'all'), symmetric with
    // searchEquipmentByKeyword / getEquipmentBudgetSummary. Fixes the
    // follow-up-continuity bug: turn-2 "ขอดูรายละเอียดทั้งสามรายการ" after a
    // plan-less turn still returns items. Wave WHOLE-PLAN-EQUIPMENT-LISTING-
    // HEAD-CONSISTENCY (2026-07-19) — with scope 'all' the aggregator now
    // sources HEAD rows (distinct latest) so this whole-plan listing agrees
    // with the whole-plan count; the handler contract (forwards scope 'all')
    // is unchanged.
    it('listEquipmentInPlan defaults to whole-municipality when planId is omitted', async () => {
      const { deps, aggregator } = makeDeps(true);
      const result = await EXECUTIVE_TOOL_HANDLERS.listEquipmentInPlan(
        {},
        CTX,
        deps,
      );
      expect(aggregator.listInPlan).toHaveBeenCalledWith(undefined, {
        scope: 'all',
        status: undefined,
        limit: 50,
        offset: 0,
      });
      expect(result.totalCount).toBe(1);
      expect((result as { message?: unknown }).message).toBeUndefined();
      expect(
        validateAgainstSchema(
          EXECUTIVE_TOOL_REGISTRY.listEquipmentInPlan.returnSchema,
          result,
        ),
      ).toEqual({ ok: true });
    });

    it('listEquipmentInRevisionBook rejects a non-UUID revisionId', async () => {
      const { deps, aggregator } = makeDeps(true);
      const result = await EXECUTIVE_TOOL_HANDLERS.listEquipmentInRevisionBook(
        { revisionId: 'เล่มแก้ไขครั้งที่ 1' },
        CTX,
        deps,
      );
      expect(result.totalCount).toBe(0);
      expect(String(result.message)).toContain('listDevelopmentPlanRevisions');
      expect(aggregator.listInRevisionBook).not.toHaveBeenCalled();
    });

    it('listEquipmentInSupplementBook rejects a non-UUID supplementId', async () => {
      const { deps, aggregator } = makeDeps(true);
      const result =
        await EXECUTIVE_TOOL_HANDLERS.listEquipmentInSupplementBook(
          { supplementId: 'not-a-uuid' },
          CTX,
          deps,
        );
      expect(result.totalCount).toBe(0);
      expect(aggregator.listInSupplementBook).not.toHaveBeenCalled();
    });

    it('searchEquipmentByKeyword drops a malformed planId instead of failing', async () => {
      const { deps, aggregator } = makeDeps(true);
      await EXECUTIVE_TOOL_HANDLERS.searchEquipmentByKeyword(
        { keyword: 'เครื่อง', planId: 'ไม่ใช่ uuid' },
        CTX,
        deps,
      );
      expect(aggregator.search).toHaveBeenCalledWith('เครื่อง', {
        scope: 'all',
        planId: undefined,
        limit: 10,
      });
    });
  });

  describe('§17.11 role assertion (no role exemption)', () => {
    it.each(EQUIPMENT_TOOL_NAMES)('%s rejects a plain user role', async (name) => {
      const { deps } = makeDeps(true);
      await expect(
        EXECUTIVE_TOOL_HANDLERS[name](
          HAPPY_PARAMS[name],
          { ...CTX, roleName: 'user' },
          deps,
        ),
      ).rejects.toThrow('EXECUTIVE_ROLE_REQUIRED');
    });

    it.each(EQUIPMENT_TOOL_NAMES)(
      '%s rejects an unapproved workStatus',
      async (name) => {
        const { deps } = makeDeps(true);
        await expect(
          EXECUTIVE_TOOL_HANDLERS[name](
            HAPPY_PARAMS[name],
            { ...CTX, workStatusName: 'pending' },
            deps,
          ),
        ).rejects.toThrow('EXECUTIVE_ROLE_REQUIRED');
      },
    );
  });

  describe('PII discipline (§17.3)', () => {
    it('happy-path envelopes never carry creator fields', async () => {
      const { deps } = makeDeps(true);
      for (const name of EQUIPMENT_TOOL_NAMES) {
        const result = await EXECUTIVE_TOOL_HANDLERS[name](
          HAPPY_PARAMS[name],
          CTX,
          deps,
        );
        const json = JSON.stringify(result);
        expect(json).not.toContain('createdBy');
        expect(json).not.toContain('firstName');
        expect(json).not.toContain('lastName');
        expect(json).not.toContain('profileImageUrl');
      }
    });
  });
});
