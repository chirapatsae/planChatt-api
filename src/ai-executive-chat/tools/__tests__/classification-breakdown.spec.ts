/**
 * BE-W53-04 — `getProjectClassificationBreakdown` coverage.
 *
 * CRITICAL §17.7 + §16.5 branching:
 *   - STRATEGY_BASED plan → group by Strategy → Tactic → Plan; items
 *     carry strategyId/tacticId/planLevelId/projectCount (no issueId).
 *   - ISSUE_BASED plan → group by DevelopmentIssue; items carry
 *     issueId/issueName/projectCount (no strategy/tactic/plan/indicator).
 *   - Missing plan (findOne returns null) → items:[] + Thai advisory +
 *     default reportFormat STRATEGY_BASED per handler fallback.
 *
 * The handler calls:
 *   1. `getRepository(DevelopmentPlan).findOne({ where: { id } })`
 *   2. `getRepository(ProjectGroup).createQueryBuilder('pg')...getRawMany()`
 *
 * We stub both to inject the desired fixture.
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
import { ReportFormat } from 'src/development-plan/types/report-format.enum';

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

type StrategyRow = {
  strategyid: string | null;
  strategyname: string | null;
  tacticid: string | null;
  tacticname: string | null;
  planlevelid: string | null;
  planlevelname: string | null;
  projectcount: string;
  sampleindicator: string | null;
};

type IssueRow = {
  issueid: string | null;
  issuename: string | null;
  projectcount: string;
};

function makeDeps(params: {
  plan: { id: string; reportFormat: ReportFormat } | null;
  strategyRows?: StrategyRow[];
  issueRows?: IssueRow[];
}): ExecutiveToolHandlerDeps {
  const { plan, strategyRows = [], issueRows = [] } = params;

  const pgQb: Record<string, unknown> = {};
  const self = () => pgQb;
  // The handler chooses ONE of two QB pipelines based on plan.reportFormat.
  // Branch selection is done by inspecting `.andWhere` args — in both
  // branches the chain terminates at getRawMany. The stub returns whichever
  // fixture was provided; handlers call the right branch for the given
  // plan.reportFormat so only ONE fixture actually flows back per test.
  let branchUsed: 'strategy' | 'issue' | 'unknown' = 'unknown';
  Object.assign(pgQb, {
    select: self,
    addSelect: self,
    leftJoin: self,
    innerJoin: self,
    where: self,
    andWhere: (cond: unknown) => {
      if (typeof cond === 'string') {
        if (cond.includes('development_issue_id IS NOT NULL')) {
          branchUsed = 'issue';
        } else if (cond.includes('strategy_id IS NOT NULL')) {
          branchUsed = 'strategy';
        }
      }
      return pgQb;
    },
    groupBy: self,
    addGroupBy: self,
    orderBy: self,
    take: self,
    limit: self,
    getRawMany: async () => {
      if (branchUsed === 'issue') return issueRows;
      if (branchUsed === 'strategy') return strategyRows;
      // Default fallthrough: whichever list is non-empty.
      return strategyRows.length ? strategyRows : issueRows;
    },
    getMany: async () => [],
  });

  return {
    dataSource: {
      getRepository: (target: { name?: string }) => {
        const n = typeof target === 'function' ? target.name : target?.name;
        if (n === 'DevelopmentPlan') {
          return {
            findOne: async (_opts: unknown) => plan,
            createQueryBuilder: () => pgQb,
          };
        }
        return { createQueryBuilder: () => pgQb };
      },
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

describe('BE-W53-04 / getProjectClassificationBreakdown (§17.7 + §16.5)', () => {
  describe('registry contract', () => {
    const spec = EXECUTIVE_TOOL_REGISTRY.getProjectClassificationBreakdown;

    it('is registered', () => {
      expect(spec).toBeDefined();
      expect(spec.name).toBe('getProjectClassificationBreakdown');
      expect(EXECUTIVE_TOOL_NAMES).toContain(
        'getProjectClassificationBreakdown',
      );
    });

    it('paramsSchema accepts planId as uuid (optional after Wave 57 W57-BE-AGG-04)', () => {
      // Wave 57 W57-BE-AGG-04 — `planId` became OPTIONAL to support
      // dual-bucket fallback. The schema still narrows the shape to
      // uuid format when supplied.
      expect(spec.paramsSchema.properties?.planId?.format).toBe('uuid');
      // No `required` array OR `required` is missing/empty.
      expect(spec.paramsSchema.required ?? []).not.toContain('planId');
    });

    it('returnSchema requires shape and supports dual-bucket', () => {
      expect(spec.returnSchema.required).toEqual(
        expect.arrayContaining(['shape']),
      );
      expect(spec.returnSchema.properties?.reportFormat?.enum).toEqual([
        'STRATEGY_BASED',
        'ISSUE_BASED',
      ]);
      // Wave 57 W57-BE-AGG-04 — adds `'dual-bucket'` to the shape enum.
      expect(spec.returnSchema.properties?.shape?.enum).toEqual([
        'strategy',
        'issue',
        'dual-bucket',
      ]);
    });

    it('description mentions both formats', () => {
      expect(spec.description).toMatch(/STRATEGY_BASED/);
      expect(spec.description).toMatch(/ISSUE_BASED/);
    });
  });

  describe('handler branching', () => {
    const handler = EXECUTIVE_TOOL_HANDLERS.getProjectClassificationBreakdown;

    it('role guard: user role throws EXECUTIVE_ROLE_REQUIRED', async () => {
      const deps = makeDeps({
        plan: { id: UUID_PLAN, reportFormat: ReportFormat.STRATEGY_BASED },
      });
      await expect(
        handler({ planId: UUID_PLAN }, makeCtx({ roleName: 'user' }), deps),
      ).rejects.toThrow(/EXECUTIVE_ROLE_REQUIRED/);
    });

    it('STRATEGY_BASED fixture: three strategy rows → shape="strategy", reportFormat="STRATEGY_BASED"', async () => {
      const deps = makeDeps({
        plan: { id: UUID_PLAN, reportFormat: ReportFormat.STRATEGY_BASED },
        strategyRows: [
          {
            strategyid: 's1',
            strategyname: 'ยุทธศาสตร์ 1',
            tacticid: 't1',
            tacticname: 'กลยุทธ์ 1',
            planlevelid: 'p1',
            planlevelname: 'แผนงาน 1',
            projectcount: '10',
            sampleindicator: 'KPI-1',
          },
          {
            strategyid: 's2',
            strategyname: 'ยุทธศาสตร์ 2',
            tacticid: 't2',
            tacticname: 'กลยุทธ์ 2',
            planlevelid: 'p2',
            planlevelname: 'แผนงาน 2',
            projectcount: '5',
            sampleindicator: null,
          },
          {
            strategyid: 's3',
            strategyname: 'ยุทธศาสตร์ 3',
            tacticid: 't3',
            tacticname: 'กลยุทธ์ 3',
            planlevelid: 'p3',
            planlevelname: 'แผนงาน 3',
            projectcount: '2',
            sampleindicator: 'KPI-3',
          },
        ],
      });
      const out = await handler({ planId: UUID_PLAN }, makeCtx(), deps);
      expect(out.shape).toBe('strategy');
      expect(out.reportFormat).toBe('STRATEGY_BASED');
      const items = out.items as Array<Record<string, unknown>>;
      expect(items).toHaveLength(3);
      for (const it of items) {
        expect(it.strategyId).toBeDefined();
        expect(it.tacticId).toBeDefined();
        expect(it.planLevelId).toBeDefined();
        expect(typeof it.projectCount).toBe('number');
        // §16.5 — ISSUE_BASED keys MUST NOT appear.
        expect('issueId' in it).toBe(false);
        expect('issueName' in it).toBe(false);
      }
      assertNoPii(out);
    });

    it('ISSUE_BASED fixture: two issue rows → shape="issue", reportFormat="ISSUE_BASED"', async () => {
      const deps = makeDeps({
        plan: { id: UUID_PLAN, reportFormat: ReportFormat.ISSUE_BASED },
        issueRows: [
          {
            issueid: 'i1',
            issuename: 'ประเด็นการพัฒนา 1',
            projectcount: '8',
          },
          {
            issueid: 'i2',
            issuename: 'ประเด็นการพัฒนา 2',
            projectcount: '3',
          },
        ],
      });
      const out = await handler({ planId: UUID_PLAN }, makeCtx(), deps);
      expect(out.shape).toBe('issue');
      expect(out.reportFormat).toBe('ISSUE_BASED');
      const items = out.items as Array<Record<string, unknown>>;
      expect(items).toHaveLength(2);
      for (const it of items) {
        expect(it.issueId).toBeDefined();
        expect(typeof it.issueName).toBe('string');
        expect(typeof it.projectCount).toBe('number');
        // §16.5 — STRATEGY_BASED keys MUST NOT appear.
        expect('strategyId' in it).toBe(false);
        expect('tacticId' in it).toBe(false);
        expect('planLevelId' in it).toBe(false);
        expect('indicator' in it).toBe(false);
        expect('sampleIndicator' in it).toBe(false);
      }
      assertNoPii(out);
    });

    it('missing plan: findOne returns null → items:[] + "ไม่พบแผนที่ระบุ" + default STRATEGY_BASED', async () => {
      const deps = makeDeps({ plan: null });
      const out = await handler({ planId: UUID_PLAN }, makeCtx(), deps);
      expect(out.items).toEqual([]);
      expect((out as { message?: unknown }).message).toBe('ไม่พบแผนที่ระบุ');
      expect(out.reportFormat).toBe('STRATEGY_BASED');
      expect(out.shape).toBe('strategy');
      expect(typeof (out as { asOf?: unknown }).asOf).toBe('string');
      assertNoPii(out);
    });
  });
});
