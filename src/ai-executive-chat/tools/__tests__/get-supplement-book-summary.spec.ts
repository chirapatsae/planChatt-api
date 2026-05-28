/**
 * Wave AI-Exec-Chat-Book-Coverage BE-01 (2026-05-28) —
 * `getSupplementBookSummary` coverage.
 *
 * Mirrors `getRevisionBookSummary` — SPG variant: `supplementMeta`
 * carries `supplementNumber` instead of `revisionNumber/Type`.
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

const UUID_DPS = '11111111-1111-4111-8111-111111111111';
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

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

type DpsFixture = {
  id: string;
  supplementNumber: number;
  isOpen: boolean;
  isBooked: boolean;
} | null;

type StatusGroupRow = { statusname: string | null; cnt: string };

function makeDeps(opts: {
  dps: DpsFixture;
  statusRows: StatusGroupRow[];
  totalBudget: number;
}): ExecutiveToolHandlerDeps {
  const dpsQb: Record<string, unknown> = {};
  const spgQb: Record<string, unknown> = {};
  const chain = (qb: Record<string, unknown>) => () => qb;
  Object.assign(dpsQb, {
    where: chain(dpsQb),
    andWhere: chain(dpsQb),
    getOne: async () => opts.dps,
  });
  Object.assign(spgQb, {
    select: chain(spgQb),
    addSelect: chain(spgQb),
    leftJoin: chain(spgQb),
    innerJoin: chain(spgQb),
    where: chain(spgQb),
    andWhere: chain(spgQb),
    orderBy: chain(spgQb),
    addOrderBy: chain(spgQb),
    groupBy: chain(spgQb),
    addGroupBy: chain(spgQb),
    take: chain(spgQb),
    limit: chain(spgQb),
    offset: chain(spgQb),
    getRawMany: async () => opts.statusRows,
    getRawOne: async () => ({ totalbudget: String(opts.totalBudget) }),
  });
  return {
    dataSource: {
      getRepository: (target: { name?: string }) => ({
        createQueryBuilder: () => {
          const n = typeof target === 'function' ? target.name : target?.name;
          if (n === 'DevelopmentPlanSupplement') return dpsQb;
          return spgQb;
        },
      }),
    } as unknown as ExecutiveToolHandlerDeps['dataSource'],
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

describe('BE-01 / getSupplementBookSummary', () => {
  describe('registry contract', () => {
    const spec = EXECUTIVE_TOOL_REGISTRY.getSupplementBookSummary;

    it('is registered', () => {
      expect(spec).toBeDefined();
      expect(spec.name).toBe('getSupplementBookSummary');
      expect(EXECUTIVE_TOOL_NAMES).toContain('getSupplementBookSummary');
    });

    it('paramsSchema requires supplementId', () => {
      expect(spec.paramsSchema.required).toEqual(['supplementId']);
      expect(spec.paramsSchema.additionalProperties).toBe(false);
    });

    it('returnSchema mirrors revision summary keys', () => {
      expect(spec.returnSchema.required).toEqual(
        expect.arrayContaining([
          'supplementMeta',
          'totalProjects',
          'statusBreakdown',
          'executiveStatusBreakdown',
          'totalBudget',
          'averageBudget',
          'asOf',
        ]),
      );
    });

    it('description is read-only (อ่านอย่างเดียว)', () => {
      expect(spec.description).toMatch(/อ่านอย่างเดียว/);
    });
  });

  describe('handler behaviour', () => {
    const handler = EXECUTIVE_TOOL_HANDLERS.getSupplementBookSummary;

    it('is registered', () => {
      expect(typeof handler).toBe('function');
    });

    it('role guard rejects user', async () => {
      const deps = makeDeps({ dps: null, statusRows: [], totalBudget: 0 });
      await expect(
        handler(
          { supplementId: UUID_DPS },
          makeCtx({ roleName: 'user' }),
          deps,
        ),
      ).rejects.toThrow(/EXECUTIVE_ROLE_REQUIRED/);
    });

    it('invalid UUID returns nil-meta envelope', async () => {
      const deps = makeDeps({ dps: null, statusRows: [], totalBudget: 0 });
      const out = await handler(
        { supplementId: 'bad-uuid' },
        makeCtx(),
        deps,
      );
      const meta = out.supplementMeta as Record<string, unknown>;
      expect(meta.supplementId).toBe(NIL_UUID);
      assertNoPii(out);
    });

    it('missing DPS returns empty envelope', async () => {
      const deps = makeDeps({ dps: null, statusRows: [], totalBudget: 0 });
      const out = await handler({ supplementId: UUID_DPS }, makeCtx(), deps);
      expect(out.totalProjects).toBe(0);
      expect(typeof out.message).toBe('string');
    });

    it('happy path: status + budget rollup', async () => {
      const deps = makeDeps({
        dps: {
          id: UUID_DPS,
          supplementNumber: 2,
          isOpen: false,
          isBooked: true,
        },
        statusRows: [
          { statusname: 'Approved', cnt: '4' },
          { statusname: 'Pending', cnt: '2' },
        ],
        totalBudget: 600_000,
      });
      const out = await handler({ supplementId: UUID_DPS }, makeCtx(), deps);
      expect(out.totalProjects).toBe(6);
      const exec = out.executiveStatusBreakdown as Record<string, number>;
      expect(exec.approvedCount).toBe(4);
      expect(exec.pendingReviewCount).toBe(2);
      expect(out.totalBudget).toBe(600_000);
      expect(out.averageBudget).toBeCloseTo(100_000, 2);
      const meta = out.supplementMeta as Record<string, unknown>;
      expect(meta).toEqual({
        supplementId: UUID_DPS,
        supplementNumber: 2,
        isOpen: false,
        isBooked: true,
      });
      assertNoPii(out);
    });

    it('zero projects yields zero averageBudget', async () => {
      const deps = makeDeps({
        dps: {
          id: UUID_DPS,
          supplementNumber: 1,
          isOpen: false,
          isBooked: true,
        },
        statusRows: [],
        totalBudget: 0,
      });
      const out = await handler({ supplementId: UUID_DPS }, makeCtx(), deps);
      expect(out.totalProjects).toBe(0);
      expect(out.averageBudget).toBe(0);
    });
  });
});
