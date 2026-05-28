/**
 * Wave AI-Exec-Chat-Book-Coverage BE-01 (2026-05-28) —
 * `getRevisionBookSummary` coverage.
 *
 * Covers:
 *   - Registry contract — required envelope keys, no `additionalProperties` leak
 *   - §17.11 role guard
 *   - Invalid UUID + missing DPR friendly envelopes
 *   - Happy path — statusBreakdown sums to totalProjects,
 *     executiveStatusBreakdown matches 4-group rollup,
 *     averageBudget = totalBudget / totalProjects rounded to 2dp
 *   - PII discipline
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

const UUID_DPR = '11111111-1111-4111-8111-111111111111';
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

type DprFixture = {
  id: string;
  revisionNumber: number;
  isOpen: boolean;
  isBooked: boolean;
  revisionType: { name: string } | null;
} | null;

type StatusGroupRow = { statusname: string | null; cnt: string };

function makeDeps(opts: {
  dpr: DprFixture;
  statusRows: StatusGroupRow[];
  totalBudget: number;
}): ExecutiveToolHandlerDeps {
  const dprQb: Record<string, unknown> = {};
  // Two RPG QBs are issued: one for status-group and one for budget.
  // We sequence the getRawMany / getRawOne returns per-call.
  let rawManyCallCount = 0;
  const rpgQb: Record<string, unknown> = {};
  const chain = (qb: Record<string, unknown>) => () => qb;
  Object.assign(dprQb, {
    leftJoinAndSelect: chain(dprQb),
    where: chain(dprQb),
    andWhere: chain(dprQb),
    getOne: async () => opts.dpr,
  });
  Object.assign(rpgQb, {
    select: chain(rpgQb),
    addSelect: chain(rpgQb),
    leftJoin: chain(rpgQb),
    innerJoin: chain(rpgQb),
    where: chain(rpgQb),
    andWhere: chain(rpgQb),
    orderBy: chain(rpgQb),
    addOrderBy: chain(rpgQb),
    groupBy: chain(rpgQb),
    addGroupBy: chain(rpgQb),
    take: chain(rpgQb),
    limit: chain(rpgQb),
    offset: chain(rpgQb),
    getRawMany: async () => {
      rawManyCallCount += 1;
      return opts.statusRows;
    },
    getRawOne: async () => ({ totalbudget: String(opts.totalBudget) }),
  });
  return {
    dataSource: {
      getRepository: (target: { name?: string }) => ({
        createQueryBuilder: () => {
          const n = typeof target === 'function' ? target.name : target?.name;
          if (n === 'DevelopmentPlanRevision') return dprQb;
          return rpgQb;
        },
      }),
    } as unknown as ExecutiveToolHandlerDeps['dataSource'],
    unifiedProject: {} as never,
    budget: {} as never,
    status: {} as never,
    geo: {} as never,
    agency: {} as never,
    resilience: {} as never,
    // For test traceability — `rawManyCallCount` not exposed, but the
    // `rawManyCallCount` variable is captured in the closure.
    ...({} as Record<string, never>),
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

describe('BE-01 / getRevisionBookSummary', () => {
  describe('registry contract', () => {
    const spec = EXECUTIVE_TOOL_REGISTRY.getRevisionBookSummary;

    it('is registered', () => {
      expect(spec).toBeDefined();
      expect(spec.name).toBe('getRevisionBookSummary');
      expect(EXECUTIVE_TOOL_NAMES).toContain('getRevisionBookSummary');
    });

    it('paramsSchema requires revisionId; no additionalProperties', () => {
      expect(spec.paramsSchema.required).toEqual(['revisionId']);
      expect(spec.paramsSchema.additionalProperties).toBe(false);
    });

    it('returnSchema declares the canonical aggregate keys', () => {
      expect(spec.returnSchema.required).toEqual(
        expect.arrayContaining([
          'revisionMeta',
          'totalProjects',
          'statusBreakdown',
          'executiveStatusBreakdown',
          'totalBudget',
          'averageBudget',
          'asOf',
        ]),
      );
      const status = spec.returnSchema.properties?.statusBreakdown;
      // 8 canonical status keys per CLAUDE.md "Core Status Machine"
      expect(status?.required).toEqual(
        expect.arrayContaining([
          'Ready',
          'Pending',
          'Verified',
          'Pending_Approval',
          'Approved',
          'Pull_Back',
          'Returned_For_Revision',
          'Rejected',
        ]),
      );
      const exec = spec.returnSchema.properties?.executiveStatusBreakdown;
      expect(exec?.required).toEqual(
        expect.arrayContaining([
          'pendingReviewCount',
          'awaitingApprovalCount',
          'approvedCount',
          'rejectedCount',
        ]),
      );
    });

    it('description is read-only (อ่านอย่างเดียว)', () => {
      expect(spec.description).toMatch(/อ่านอย่างเดียว/);
    });
  });

  describe('handler behaviour', () => {
    const handler = EXECUTIVE_TOOL_HANDLERS.getRevisionBookSummary;

    it('is registered', () => {
      expect(typeof handler).toBe('function');
    });

    it('role guard rejects user', async () => {
      const deps = makeDeps({ dpr: null, statusRows: [], totalBudget: 0 });
      await expect(
        handler({ revisionId: UUID_DPR }, makeCtx({ roleName: 'user' }), deps),
      ).rejects.toThrow(/EXECUTIVE_ROLE_REQUIRED/);
    });

    it('invalid UUID returns nil-meta envelope', async () => {
      const deps = makeDeps({ dpr: null, statusRows: [], totalBudget: 0 });
      const out = await handler(
        { revisionId: 'bad-uuid' },
        makeCtx(),
        deps,
      );
      const meta = out.revisionMeta as Record<string, unknown>;
      expect(meta.revisionId).toBe(NIL_UUID);
      expect(out.totalProjects).toBe(0);
      expect(out.totalBudget).toBe(0);
      expect(out.averageBudget).toBe(0);
      assertNoPii(out);
    });

    it('missing DPR returns empty envelope with message', async () => {
      const deps = makeDeps({ dpr: null, statusRows: [], totalBudget: 0 });
      const out = await handler({ revisionId: UUID_DPR }, makeCtx(), deps);
      expect(out.totalProjects).toBe(0);
      expect(typeof out.message).toBe('string');
    });

    it('happy path: statusBreakdown sums to totalProjects + 4-group rollup correct', async () => {
      const deps = makeDeps({
        dpr: {
          id: UUID_DPR,
          revisionNumber: 1,
          isOpen: true,
          isBooked: false,
          revisionType: { name: 'แก้ไข' },
        },
        statusRows: [
          { statusname: 'Pending', cnt: '3' }, // pending_review
          { statusname: 'Verified', cnt: '2' }, // awaiting_approval
          { statusname: 'Pending_Approval', cnt: '1' }, // awaiting_approval
          { statusname: 'Approved', cnt: '5' }, // approved
          { statusname: 'Rejected', cnt: '1' }, // rejected
          { statusname: 'Ready', cnt: '2' }, // not in exec rollup
        ],
        totalBudget: 1_000_000,
      });
      const out = await handler({ revisionId: UUID_DPR }, makeCtx(), deps);

      expect(out.totalProjects).toBe(14);

      const status = out.statusBreakdown as Record<string, number>;
      expect(status.Pending).toBe(3);
      expect(status.Verified).toBe(2);
      expect(status.Pending_Approval).toBe(1);
      expect(status.Approved).toBe(5);
      expect(status.Rejected).toBe(1);
      expect(status.Ready).toBe(2);
      // 8-key sum equals totalProjects
      const sum = Object.values(status).reduce((a, b) => a + b, 0);
      expect(sum).toBe(out.totalProjects);

      const exec = out.executiveStatusBreakdown as Record<string, number>;
      expect(exec.pendingReviewCount).toBe(3);
      expect(exec.awaitingApprovalCount).toBe(3); // Verified + Pending_Approval
      expect(exec.approvedCount).toBe(5);
      expect(exec.rejectedCount).toBe(1);

      expect(out.totalBudget).toBe(1_000_000);
      // averageBudget = 1_000_000 / 14 ≈ 71428.5714... rounded to 2dp
      expect(out.averageBudget).toBeCloseTo(71428.57, 2);

      const meta = out.revisionMeta as Record<string, unknown>;
      expect(meta.revisionTypeName).toBe('แก้ไข');
      assertNoPii(out);
    });

    it('zero projects: averageBudget is 0 (no divide-by-zero)', async () => {
      const deps = makeDeps({
        dpr: {
          id: UUID_DPR,
          revisionNumber: 1,
          isOpen: false,
          isBooked: true,
          revisionType: { name: 'แก้ไข' },
        },
        statusRows: [],
        totalBudget: 0,
      });
      const out = await handler({ revisionId: UUID_DPR }, makeCtx(), deps);
      expect(out.totalProjects).toBe(0);
      expect(out.averageBudget).toBe(0);
    });
  });
});
