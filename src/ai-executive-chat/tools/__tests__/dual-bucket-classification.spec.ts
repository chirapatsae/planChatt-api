/**
 * Wave 57 W57-BE-AGG-04 — dual-bucket classification spec.
 *
 * CLAUDE.md references:
 *   - §16.4 reportFormat immutable, owned by DevelopmentPlan.
 *   - §16.5 classification shape invariant.
 *   - §17.7 AI MUST branch on reportFormat.
 *
 * The handler `getProjectClassificationBreakdown` MUST:
 *   - When `planId` is provided → branch on plan.reportFormat (covered
 *     in classification-breakdown.spec.ts).
 *   - When `planId` is OMITTED → return BOTH STRATEGY_BASED and
 *     ISSUE_BASED partitions side by side and emit the
 *     `dual-bucket-classification` advisory.
 */
import { EXECUTIVE_TOOL_HANDLERS } from '../handlers/executive-tool-handlers';
import {
  ExecutiveCallerContext,
  ExecutiveToolHandlerDeps,
} from '../handlers/handler-types';

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

type StrategyAgg = {
  strategyid: string | null;
  strategyname: string | null;
  tacticid: string | null;
  tacticname: string | null;
  planlevelid: string | null;
  planlevelname: string | null;
  projectcount: string;
};
type IssueAgg = {
  issueid: string | null;
  issuename: string | null;
  projectcount: string;
};

function makeDualDeps(opts: {
  strategyRows: StrategyAgg[];
  issueRows: IssueAgg[];
}): ExecutiveToolHandlerDeps {
  // The dual-bucket handler runs TWO QBs: one with
  // `dp.report_format = 'STRATEGY_BASED'` and one with `'ISSUE_BASED'`.
  // The stub captures the `:rf` bind value to choose which fixture to
  // return.
  function makeQb() {
    const qb: Record<string, unknown> = {};
    const self = () => qb;
    let chosen: 'strategy' | 'issue' | 'unknown' = 'unknown';
    Object.assign(qb, {
      innerJoin: self,
      leftJoin: self,
      select: self,
      addSelect: self,
      where: self,
      andWhere: (clause: string, params?: Record<string, unknown>) => {
        if (params && params.rf === 'STRATEGY_BASED') chosen = 'strategy';
        if (params && params.rf === 'ISSUE_BASED') chosen = 'issue';
        return qb;
      },
      groupBy: self,
      addGroupBy: self,
      orderBy: self,
      limit: self,
      getRawMany: async () => {
        if (chosen === 'strategy') return opts.strategyRows;
        if (chosen === 'issue') return opts.issueRows;
        return [];
      },
    });
    return qb;
  }

  return {
    dataSource: {
      getRepository: () => ({
        // findOne is only called in the planId-supplied branch; the
        // dual-bucket branch does NOT touch it.
        findOne: async () => null,
        createQueryBuilder: () => makeQb(),
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

describe('W57-BE-AGG-04 / dual-bucket classification (no planId)', () => {
  const handler = EXECUTIVE_TOOL_HANDLERS.getProjectClassificationBreakdown;

  it('returns shape="dual-bucket" with both partitions when planId is omitted', async () => {
    const deps = makeDualDeps({
      strategyRows: [
        {
          strategyid: 'S1',
          strategyname: 'Strategy 1',
          tacticid: 'T1',
          tacticname: 'Tactic 1',
          planlevelid: 'P1',
          planlevelname: 'Plan 1',
          projectcount: '5',
        },
      ],
      issueRows: [
        { issueid: 'I1', issuename: 'Issue 1', projectcount: '3' },
        { issueid: 'I2', issuename: 'Issue 2', projectcount: '2' },
      ],
    });
    const out = await handler({}, makeCtx(), deps);
    expect(out.shape).toBe('dual-bucket');
    expect(out.planId).toBeUndefined();
    const partitions = out.partitions as Array<Record<string, unknown>>;
    expect(partitions).toHaveLength(2);
    const strat = partitions.find((p) => p.reportFormat === 'STRATEGY_BASED');
    const issue = partitions.find((p) => p.reportFormat === 'ISSUE_BASED');
    expect(strat).toBeDefined();
    expect(issue).toBeDefined();
    expect((strat!.items as unknown[]).length).toBe(1);
    expect((issue!.items as unknown[]).length).toBe(2);
  });

  it('emits the dual-bucket-classification advisory', async () => {
    const deps = makeDualDeps({ strategyRows: [], issueRows: [] });
    const out = await handler({}, makeCtx(), deps);
    expect(Array.isArray(out.advisories)).toBe(true);
    expect(out.advisories as string[]).toContain('dual-bucket-classification');
  });

  it('returns empty partitions cleanly when no plans exist in either format', async () => {
    const deps = makeDualDeps({ strategyRows: [], issueRows: [] });
    const out = await handler({}, makeCtx(), deps);
    const partitions = out.partitions as Array<Record<string, unknown>>;
    expect(partitions).toHaveLength(2);
    for (const p of partitions) {
      expect(Array.isArray(p.items)).toBe(true);
      expect((p.items as unknown[]).length).toBe(0);
    }
  });

  it('blank-string planId is treated identically to omitted (still dual-bucket)', async () => {
    const deps = makeDualDeps({
      strategyRows: [
        {
          strategyid: 'S',
          strategyname: 'S',
          tacticid: 'T',
          tacticname: 'T',
          planlevelid: 'P',
          planlevelname: 'P',
          projectcount: '1',
        },
      ],
      issueRows: [],
    });
    const out = await handler({ planId: '   ' }, makeCtx(), deps);
    expect(out.shape).toBe('dual-bucket');
  });
});
