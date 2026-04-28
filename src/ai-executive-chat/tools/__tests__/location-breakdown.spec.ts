/**
 * BE-W53-04 — `getProjectLocationBreakdown` coverage.
 *
 * The handler performs TWO query passes per included scope:
 *   1. COUNT pass on the project table (ProjectGroup / RevisedProjectGroup),
 *      grouped by amphoe_id with a leftJoin to Amphoe for the name.
 *   2. SUM pass on Budget, joined through the project table to get
 *      amphoe_id.
 *
 * Scope enum: main | revised | supplement | all.
 *   - scope='supplement' returns items:[] + Thai advisory message per
 *     BE-W53-02 (SupplementProjectGroup lacks amphoe_id).
 *   - scope='all' also emits an advisory message explaining that
 *     SupplementProjectGroup is excluded.
 *   - NULL amphoe name falls back to '(ไม่ระบุ)'.
 *
 * CLAUDE.md §17.2 / §17.11 — advisory read aggregator with role guard.
 */
import {
  EXECUTIVE_TOOL_REGISTRY,
  EXECUTIVE_TOOL_NAMES,
} from '../tool-registry';
import { EXECUTIVE_TOOL_HANDLERS } from '../handlers/executive-tool-handlers';
import {
  ExecutiveCallerContext,
  ExecutiveToolHandlerDeps,
} from '../handlers/handler-types';

const UUID_PLAN = '11111111-1111-4111-8111-111111111111';

function makeCtx(
  overrides: Partial<ExecutiveCallerContext> = {},
): ExecutiveCallerContext {
  return {
    userId: 'user-1',
    workHistoryId: 'wh-1',
    roleName: 'staff',
    workStatusName: 'approved',
    ...overrides,
  };
}

type CountRow = {
  amphoeid: string | null;
  amphoename: string | null;
  cnt: string;
};
type BudgetRow = { amphoeid: string | null; sumbudget: string | null };

/**
 * Route `getRepository(ProjectGroup)` to a count QB, `getRepository(Budget)`
 * to a budget QB, and every other entity (including `RevisedProjectGroup`)
 * to an empty QB. The handler issues: ProjectGroup COUNT → Budget SUM
 * for main scope; RevisedProjectGroup COUNT → Budget SUM for revised.
 * Since tests here focus on scope='main' / 'supplement', we only need
 * ProjectGroup + Budget wired.
 */
function makeDeps(params: {
  pgCountRows?: CountRow[];
  budgetSumRows?: BudgetRow[];
  rpgCountRows?: CountRow[];
  rpgBudgetSumRows?: BudgetRow[];
}): ExecutiveToolHandlerDeps {
  const {
    pgCountRows = [],
    budgetSumRows = [],
    rpgCountRows = [],
    rpgBudgetSumRows = [],
  } = params;

  const emptyQb = (): Record<string, unknown> => {
    const qb: Record<string, unknown> = {};
    const self = () => qb;
    Object.assign(qb, {
      select: self,
      addSelect: self,
      leftJoin: self,
      leftJoinAndSelect: self,
      innerJoin: self,
      where: self,
      andWhere: self,
      groupBy: self,
      addGroupBy: self,
      orderBy: self,
      take: self,
      limit: self,
      getRawMany: async () => [] as unknown[],
      getMany: async () => [] as unknown[],
    });
    return qb;
  };

  const pgQb = emptyQb();
  pgQb.getRawMany = async () => pgCountRows;

  const rpgQb = emptyQb();
  rpgQb.getRawMany = async () => rpgCountRows;

  // Budget is the tricky one — the handler calls it TWICE (once for main,
  // once for revised). We need to tell them apart based on the innerJoin
  // relation arg. Track call order + inspect the arg.
  const budgetQb: Record<string, unknown> = {};
  let budgetJoinMode: 'main' | 'revised' | 'unknown' = 'unknown';
  const self = () => budgetQb;
  Object.assign(budgetQb, {
    select: self,
    addSelect: self,
    innerJoin: (relationOrTable: unknown, _alias?: unknown) => {
      if (typeof relationOrTable === 'string') {
        if (relationOrTable.includes('projectGroupId')) budgetJoinMode = 'main';
        if (relationOrTable.includes('revisedProjectGroupId'))
          budgetJoinMode = 'revised';
      }
      return budgetQb;
    },
    leftJoin: self,
    where: self,
    andWhere: self,
    groupBy: self,
    addGroupBy: self,
    orderBy: self,
    take: self,
    getRawMany: async () => {
      if (budgetJoinMode === 'main') return budgetSumRows;
      if (budgetJoinMode === 'revised') return rpgBudgetSumRows;
      return [];
    },
  });

  return {
    dataSource: {
      getRepository: (target: { name?: string }) => ({
        createQueryBuilder: () => {
          const n = typeof target === 'function' ? target.name : target?.name;
          if (n === 'ProjectGroup') return pgQb;
          if (n === 'RevisedProjectGroup') return rpgQb;
          if (n === 'Budget') return budgetQb;
          return emptyQb();
        },
      }),
    } as unknown as ExecutiveToolHandlerDeps['dataSource'],
    // Wave 54 Tier B — unused by Wave 53 handlers under test.
    unifiedProject: {} as never,
    budget: {} as never,
    status: {} as never,
    geo: {} as never,
    agency: {} as never,
    resilience: {} as never,
  };
}

const PII_KEYS = [
  'createdBy',
  'firstName',
  'lastName',
  'citizenId',
  'phone',
  'email',
] as const;
function assertNoPii(envelope: unknown): void {
  const json = JSON.stringify(envelope);
  for (const k of PII_KEYS) {
    expect(json).not.toMatch(new RegExp(`"${k}"`));
  }
}

describe('BE-W53-04 / getProjectLocationBreakdown', () => {
  describe('registry contract', () => {
    const spec = EXECUTIVE_TOOL_REGISTRY.getProjectLocationBreakdown;

    it('is registered', () => {
      expect(spec).toBeDefined();
      expect(spec.name).toBe('getProjectLocationBreakdown');
      expect(EXECUTIVE_TOOL_NAMES).toContain('getProjectLocationBreakdown');
    });

    it('paramsSchema requires planId as uuid', () => {
      expect(spec.paramsSchema.required).toContain('planId');
      expect(spec.paramsSchema.properties?.planId?.format).toBe('uuid');
    });

    it('scope enum is ["main","revised","supplement","all"]', () => {
      expect(spec.paramsSchema.properties?.scope?.enum).toEqual([
        'main',
        'revised',
        'supplement',
        'all',
      ]);
    });

    it('returnSchema.items[] requires amphoeId, amphoeName, projectCount, totalBudget', () => {
      const item = spec.returnSchema.properties?.items?.items;
      expect(item?.required).toEqual(
        expect.arrayContaining([
          'amphoeId',
          'amphoeName',
          'projectCount',
          'totalBudget',
        ]),
      );
      expect(item?.properties?.totalBudget?.type).toBe('number');
    });

    it('description mentions the supplement-exclusion caveat', () => {
      expect(spec.description).toMatch(/amphoe/);
      // Thai-language caveat present somewhere in description.
      expect(spec.description.length).toBeGreaterThan(0);
    });
  });

  describe('handler behaviour', () => {
    const handler = EXECUTIVE_TOOL_HANDLERS.getProjectLocationBreakdown;

    it('is registered in EXECUTIVE_TOOL_HANDLERS', () => {
      expect(typeof handler).toBe('function');
    });

    it('role guard: user role throws EXECUTIVE_ROLE_REQUIRED', async () => {
      const deps = makeDeps({});
      await expect(
        handler(
          { planId: UUID_PLAN, scope: 'main' },
          makeCtx({ roleName: 'user' }),
          deps,
        ),
      ).rejects.toThrow(/EXECUTIVE_ROLE_REQUIRED/);
    });

    it('scope=main happy path: three canned amphoe rows → amphoeName strings + totalBudget numbers', async () => {
      const deps = makeDeps({
        pgCountRows: [
          { amphoeid: '1', amphoename: 'อำเภอเมือง', cnt: '5' },
          { amphoeid: '2', amphoename: 'ปากช่อง', cnt: '3' },
          { amphoeid: '3', amphoename: 'สีคิ้ว', cnt: '1' },
        ],
        budgetSumRows: [
          { amphoeid: '1', sumbudget: '100000' },
          { amphoeid: '2', sumbudget: '50000' },
          { amphoeid: '3', sumbudget: '10000' },
        ],
      });
      const out = await handler(
        { planId: UUID_PLAN, scope: 'main' },
        makeCtx(),
        deps,
      );
      expect(out.planId).toBe(UUID_PLAN);
      expect(out.scope).toBe('main');
      const items = out.items as Array<Record<string, unknown>>;
      expect(items).toHaveLength(3);
      for (const it of items) {
        expect(typeof it.amphoeName).toBe('string');
        expect(typeof it.totalBudget).toBe('number');
      }
      // Ordering: highest projectCount first.
      expect(items[0].amphoeName).toBe('อำเภอเมือง');
      expect(items[0].projectCount).toBe(5);
      expect(items[0].totalBudget).toBe(100000);
      expect(items[2].amphoeName).toBe('สีคิ้ว');
      assertNoPii(out);
    });

    it('NULL amphoe name yields "(ไม่ระบุ)"', async () => {
      const deps = makeDeps({
        pgCountRows: [{ amphoeid: null, amphoename: null, cnt: '4' }],
        budgetSumRows: [{ amphoeid: null, sumbudget: '4000' }],
      });
      const out = await handler(
        { planId: UUID_PLAN, scope: 'main' },
        makeCtx(),
        deps,
      );
      const items = out.items as Array<Record<string, unknown>>;
      expect(items).toHaveLength(1);
      expect(items[0].amphoeName).toBe('(ไม่ระบุ)');
      // Null amphoeid is mapped to 0 per the handler's __null__ key.
      expect(items[0].amphoeId).toBe(0);
    });

    it('scope=supplement returns items:[] + Thai advisory message (BE-W53-02 exclusion)', async () => {
      const deps = makeDeps({});
      const out = await handler(
        { planId: UUID_PLAN, scope: 'supplement' },
        makeCtx(),
        deps,
      );
      expect(out.items).toEqual([]);
      expect(out.scope).toBe('supplement');
      expect(typeof (out as { message?: unknown }).message).toBe('string');
      // Thai advisory explicitly mentions amphoe_id missing from SPG.
      expect((out as { message: string }).message).toMatch(/amphoe_id/);
      assertNoPii(out);
    });

    it('scope=all emits a soft advisory note about supplement exclusion', async () => {
      const deps = makeDeps({
        pgCountRows: [{ amphoeid: '1', amphoename: 'เมือง', cnt: '2' }],
        budgetSumRows: [{ amphoeid: '1', sumbudget: '500' }],
      });
      const out = await handler(
        { planId: UUID_PLAN, scope: 'all' },
        makeCtx(),
        deps,
      );
      expect(out.scope).toBe('all');
      expect(typeof (out as { message?: unknown }).message).toBe('string');
      expect((out as { message: string }).message).toMatch(/amphoe_id/);
    });
  });
});
