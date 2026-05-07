/**
 * W55-QA-01 — Tier C envelope golden-fixture spec.
 *
 * Pins a representative envelope snapshot for each of the three Tier C
 * tools so that any downstream shape change trips a regression test:
 *   - `getPlanOverview`             — STRATEGY_BASED plan, all enrichments on.
 *   - `getExecutiveDashboardSnapshot` — cross-plan `groupBy = [status, originType]`.
 *   - `getCrossPlanInsights`        — mixed STRATEGY_BASED + ISSUE_BASED
 *                                     (exercises the §16 reportFormat
 *                                     branching via the plans[] roll-up).
 *
 * Implementation notes:
 *   - Each handler is invoked with a stubbed `deps` bag modelled after
 *     `plan-overview.spec.ts` / `dashboard-snapshot.spec.ts` /
 *     `cross-plan-insights.spec.ts`. The stub's `runDimensions` mirror
 *     the real ResilienceEnvelope's 2xx-with-advisories contract: it
 *     executes the caller-supplied `assemble(results)` with the canned
 *     dimension values, then returns the envelope with a stable
 *     `asOf = '2026-04-24T00:00:00.000Z'`.
 *   - Fixtures are JSON files under `__fixtures__/` (test-local, not
 *     scanned by the no-raw-SQL gate thanks to the `__tests__/` skip).
 *   - `buckets.*` and `plans` arrays are sorted deterministically so the
 *     golden comparison is order-independent.
 *
 * §17.2 / §17.3 — read-only; zero workflow writes; zero `ai_*` FK refs.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import { EXECUTIVE_TOOL_HANDLERS } from '../handlers/executive-tool-handlers';
import type {
  ExecutiveCallerContext,
  ExecutiveToolHandlerDeps,
} from '../handlers/handler-types';
import type {
  ExecutiveEnvelope,
  UnifiedProject,
} from '../../aggregation/types';
import type { LatestStatus } from '../../aggregation/interfaces';

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

const FROZEN_AS_OF = '2026-04-24T00:00:00.000Z';

const PLAN_A_ID = '22222222-2222-4222-8222-222222222222';
const PLAN_B_ID = '33333333-3333-4333-8333-333333333333';
const PLAN_OVERVIEW_ID = '11111111-1111-4111-8111-111111111111';

function makeCtx(): ExecutiveCallerContext {
  return {
    userId: 'user-1',
    workHistoryId: 'wh-1',
    roleName: 'staff',
    workStatusName: 'approved',
  };
}

interface StubSpec {
  projects: UnifiedProject[];
  budget?: Map<string, number>;
  status?: Map<string, LatestStatus>;
  geo?: {
    labels: Map<string, { amphoeId: number | null; amphoeName: string | null }>;
    missingDimensions: string[];
    advisories: string[];
  };
  agency?: {
    labels: Map<string, { agencyId: number | null; agencyName: string | null }>;
    missingDimensions: string[];
    advisories: string[];
  };
  /** Classification dimension result — shape handlers check `ok` via pickOk. */
  classification?: { ok: true };
  /**
   * W67-FIX-02 — direct-count breakdown stub for `countExecutiveStatusBreakdown`.
   * Provided by the test when the envelope is expected to carry
   * `data.executiveStatusBreakdown`. Defaults to all-zero so tests that don't
   * exercise the snapshot do not need to set it.
   */
  breakdown?: {
    pendingReviewCount: number;
    awaitingApprovalCount: number;
    approvedCount: number;
    rejectedCount: number;
  };
  /**
   * W67-FIX-B — drill-down stub for `groupedExecutiveStatusBreakdown`.
   * Provided by the test only when the envelope opts in to the drill;
   * defaults to `{ books: [] }` so tests that don't exercise the drill
   * path do not need to set it.
   */
  drill?: {
    books: Array<{
      bookKey: string;
      bookKind: 'main' | 'revised' | 'supplement';
      bookLabel: string;
      planLabel: string;
      roundLabel: string | null;
      statuses: Array<{
        group: 'pending_review' | 'awaiting_approval' | 'approved' | 'rejected';
        groupLabel: string;
        count: number;
        projects: Array<{
          projectId: string;
          projectKind: 'main' | 'revised' | 'supplement';
          name: string;
        }>;
        truncatedRemainder: number;
      }>;
    }>;
  };
}

function makeDeps(spec: StubSpec): ExecutiveToolHandlerDeps {
  const listUnifiedProjects = jest.fn().mockResolvedValue(spec.projects);
  const countExecutiveStatusBreakdown = jest.fn().mockResolvedValue(
    spec.breakdown ?? {
      pendingReviewCount: 0,
      awaitingApprovalCount: 0,
      approvedCount: 0,
      rejectedCount: 0,
    },
  );
  const groupedExecutiveStatusBreakdown = jest
    .fn()
    .mockResolvedValue(spec.drill ?? { books: [] });
  const totalsForUnifiedProjects = jest
    .fn()
    .mockResolvedValue(spec.budget ?? new Map<string, number>());
  const latestStatusFor = jest
    .fn()
    .mockResolvedValue(spec.status ?? new Map<string, LatestStatus>());
  const geoAnnotate = jest
    .fn()
    .mockResolvedValue(
      spec.geo ?? { labels: new Map(), missingDimensions: [], advisories: [] },
    );
  const agencyAnnotate = jest.fn().mockResolvedValue(
    spec.agency ?? {
      labels: new Map(),
      missingDimensions: [],
      advisories: [],
    },
  );

  // Deterministic runDimensions:
  //   - Invokes each task.run() (mirrors the real implementation).
  //   - Wraps each result into `ResilienceDimensionResult { ok: true, value }`.
  //   - Calls the assembler with the collected results.
  //   - Returns an envelope with a FROZEN asOf for snapshot stability.
  const runDimensions = jest.fn(
    async (
      tasks: Array<{ dimension: string; run: () => Promise<unknown> }>,
      assemble: (results: unknown[]) => unknown,
      options: { shape: string },
    ) => {
      const results = [] as Array<{
        dimension: string;
        ok: boolean;
        value?: unknown;
      }>;
      for (const t of tasks) {
        const value = await t.run();
        results.push({ dimension: t.dimension, ok: true, value });
      }
      const data = assemble(results);
      return {
        shape: options.shape,
        data,
        asOf: FROZEN_AS_OF,
        missingDimensions: [],
        advisories: [],
        partial: false,
      } as unknown as ExecutiveEnvelope<unknown>;
    },
  );

  return {
    dataSource: {} as never,
    unifiedProject: {
      listUnifiedProjects,
      countExecutiveStatusBreakdown,
      groupedExecutiveStatusBreakdown,
    } as never,
    budget: { totalsForUnifiedProjects } as never,
    status: { latestStatusFor } as never,
    geo: { annotate: geoAnnotate } as never,
    agency: { annotate: agencyAnnotate } as never,
    resilience: { runDimensions } as never,
  };
}

function p(
  projectKind: 'main' | 'revised' | 'supplement',
  projectId: string,
  overrides: Partial<UnifiedProject> = {},
): UnifiedProject {
  return {
    projectKind,
    projectId,
    name: `proj-${projectId}`,
    planId: PLAN_A_ID,
    planReportFormat: 'STRATEGY_BASED',
    originType: 'lao-coordinated',
    ...overrides,
  };
}

function readGolden(name: string): unknown {
  const path = join(__dirname, '__fixtures__', name);
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Sort `buckets[*]` and `plans` arrays in-place so the golden comparison
 * is order-independent. The real handler emission order is Map-iteration
 * order, which is stable but implementation-dependent; sorting canonicalises.
 */
function canonicalise(envelope: ExecutiveEnvelope<unknown>): unknown {
  // Deep-clone via JSON to strip `undefined` fields (JSON cannot carry them,
  // matching the fixture's explicit-key shape).
  const cloned = JSON.parse(JSON.stringify(envelope));
  const data = cloned.data as Record<string, unknown>;
  const buckets = data?.buckets as
    | Record<string, Array<{ key: string }>>
    | undefined;
  if (buckets) {
    for (const k of Object.keys(buckets)) {
      buckets[k] = [...buckets[k]].sort((a, b) =>
        a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
      );
    }
  }
  const plans = data?.plans as
    | Array<{ projectCount: number; planId: string }>
    | undefined;
  if (plans) {
    plans.sort(
      (a, b) =>
        b.projectCount - a.projectCount || (a.planId < b.planId ? -1 : 1),
    );
  }
  const statusBreakdown = data?.statusBreakdown as
    | Array<{ statusName: string }>
    | undefined;
  if (statusBreakdown) {
    statusBreakdown.sort((a, b) =>
      a.statusName < b.statusName ? -1 : a.statusName > b.statusName ? 1 : 0,
    );
  }
  return cloned;
}

// ─────────────────────────────────────────────────────────────────────

describe('W55-QA-01 / Tier C envelope golden fixtures', () => {
  describe('getPlanOverview — STRATEGY_BASED plan, all enrichments on', () => {
    it('matches the golden fixture', async () => {
      const projects: UnifiedProject[] = [
        p('main', 'p-approved-500k', {
          planId: PLAN_OVERVIEW_ID,
          planReportFormat: 'STRATEGY_BASED',
          originType: 'agency-normal',
        }),
        p('main', 'p-pending-1M', {
          planId: PLAN_OVERVIEW_ID,
          planReportFormat: 'STRATEGY_BASED',
          originType: 'lao-coordinated',
        }),
      ];
      const budget = new Map<string, number>([
        ['main:p-approved-500k', 500000],
        ['main:p-pending-1M', 1000000],
      ]);
      // W67-FIX-01 — `statusName` is canonical English; `statusNameTh`
      // is the Thai display label sibling. Both required.
      const status = new Map<string, LatestStatus>([
        [
          'main:p-approved-500k',
          {
            statusName: 'Approved',
            statusNameTh: 'อนุมัติ',
            createdAt: FROZEN_AS_OF,
            isLatest: true,
          },
        ],
        [
          'main:p-pending-1M',
          {
            statusName: 'Pending',
            statusNameTh: 'รอตรวจสอบ',
            createdAt: FROZEN_AS_OF,
            isLatest: true,
          },
        ],
      ]);
      const geo = {
        labels: new Map([
          [
            'p-approved-500k',
            { amphoeId: 3001, amphoeName: 'เมืองนครราชสีมา' },
          ],
          ['p-pending-1M', { amphoeId: 3002, amphoeName: 'ครบุรี' }],
        ]),
        missingDimensions: [],
        advisories: [],
      };
      const agency = {
        labels: new Map([
          [
            'p-approved-500k',
            { agencyId: 101, agencyName: 'สำนักงานพัฒนาเมือง' },
          ],
        ]),
        missingDimensions: [],
        advisories: [],
      };

      const deps = makeDeps({
        projects,
        budget,
        status,
        geo,
        agency,
      });
      const envelope = (await EXECUTIVE_TOOL_HANDLERS.getPlanOverview(
        {
          planId: PLAN_OVERVIEW_ID,
          scope: ['main'],
          includeBudget: true,
          includeStatus: true,
          includeGeo: true,
          includeAgency: true,
        },
        makeCtx(),
        deps,
      )) as unknown as ExecutiveEnvelope<unknown>;

      const observed = canonicalise(envelope);
      const golden = readGolden('plan-overview.envelope.golden.json');
      expect(observed).toEqual(golden);
    });
  });

  describe('getExecutiveDashboardSnapshot — groupBy=[status, originType]', () => {
    it('matches the golden fixture', async () => {
      const projects: UnifiedProject[] = [
        p('main', 'd1', {
          planId: PLAN_A_ID,
          planReportFormat: 'STRATEGY_BASED',
          originType: 'agency-normal',
        }),
        p('main', 'd2', {
          planId: PLAN_A_ID,
          planReportFormat: 'STRATEGY_BASED',
          originType: 'lao-coordinated',
        }),
        p('revised', 'd3', {
          planId: PLAN_A_ID,
          planReportFormat: 'STRATEGY_BASED',
          originType: 'lao-coordinated',
        }),
      ];
      const budget = new Map<string, number>([
        ['main:d1', 500000],
        ['main:d2', 400000],
        ['revised:d3', 200000],
      ]);
      // W67-FIX-01 — `statusName` is canonical English; `statusNameTh`
      // is the Thai display label sibling. Both required so the
      // `groupBy: ['status']` bucket builder (keys on `statusNameTh`)
      // and the executive 4-group rollup (keys on `statusName`) both
      // resolve correctly.
      const status = new Map<string, LatestStatus>([
        [
          'main:d1',
          {
            statusName: 'Approved',
            statusNameTh: 'อนุมัติ',
            createdAt: FROZEN_AS_OF,
            isLatest: true,
          },
        ],
        [
          'main:d2',
          {
            statusName: 'Approved',
            statusNameTh: 'อนุมัติ',
            createdAt: FROZEN_AS_OF,
            isLatest: true,
          },
        ],
        [
          'revised:d3',
          {
            statusName: 'Pending',
            statusNameTh: 'รอตรวจสอบ',
            createdAt: FROZEN_AS_OF,
            isLatest: true,
          },
        ],
      ]);

      // W67-FIX-02 — direct-count breakdown matches the golden fixture's
      // `executiveStatusBreakdown` (1 Pending + 2 Approved across the 3
      // visible projects in this seed). Stubbed independently of `status`
      // map per W67-FIX-02 contract — the count helper queries the DB
      // directly, NOT the limit-capped project list.
      const breakdown = {
        pendingReviewCount: 1,
        awaitingApprovalCount: 0,
        approvedCount: 2,
        rejectedCount: 0,
      };
      const deps = makeDeps({ projects, budget, status, breakdown });
      const envelope =
        (await EXECUTIVE_TOOL_HANDLERS.getExecutiveDashboardSnapshot(
          {
            scope: ['all'],
            groupBy: ['status', 'originType'],
            includeBudget: true,
            includeStatus: true,
          },
          makeCtx(),
          deps,
        )) as unknown as ExecutiveEnvelope<unknown>;

      const observed = canonicalise(envelope);
      const golden = readGolden('dashboard-snapshot.envelope.golden.json');
      expect(observed).toEqual(golden);
    });
  });

  describe('getCrossPlanInsights — mixed STRATEGY_BASED + ISSUE_BASED', () => {
    it('matches the golden fixture (exercises §16 reportFormat branching in plans[])', async () => {
      const projects: UnifiedProject[] = [
        p('main', 'x1', {
          planId: PLAN_A_ID,
          planReportFormat: 'STRATEGY_BASED',
          originType: 'agency-normal',
        }),
        p('main', 'x2', {
          planId: PLAN_A_ID,
          planReportFormat: 'STRATEGY_BASED',
          originType: 'lao-coordinated',
        }),
        p('main', 'x3', {
          planId: PLAN_B_ID,
          planReportFormat: 'ISSUE_BASED',
          originType: 'lao-coordinated',
          developmentIssueId: 'issue-1',
        }),
      ];
      const budget = new Map<string, number>([
        ['main:x1', 500000],
        ['main:x2', 300000],
        ['main:x3', 250000],
      ]);

      const deps = makeDeps({ projects, budget });
      const envelope = (await EXECUTIVE_TOOL_HANDLERS.getCrossPlanInsights(
        {
          scope: ['all'],
          groupBy: ['originType'],
          includeBudget: true,
        },
        makeCtx(),
        deps,
      )) as unknown as ExecutiveEnvelope<unknown>;

      const observed = canonicalise(envelope);
      const golden = readGolden('cross-plan-insights.envelope.golden.json');
      expect(observed).toEqual(golden);
    });
  });

  describe('fixture-level invariants', () => {
    it.each([
      'plan-overview.envelope.golden.json',
      'dashboard-snapshot.envelope.golden.json',
      'cross-plan-insights.envelope.golden.json',
    ])('%s has the required top-level envelope keys', (name) => {
      const g = readGolden(name) as Record<string, unknown>;
      for (const k of [
        'shape',
        'data',
        'asOf',
        'partial',
        'missingDimensions',
        'advisories',
      ]) {
        expect(g).toHaveProperty(k);
      }
      expect(g.asOf).toBe(FROZEN_AS_OF);
      expect(Array.isArray(g.missingDimensions)).toBe(true);
      expect(Array.isArray(g.advisories)).toBe(true);
      expect(typeof g.partial).toBe('boolean');
    });

    it('getPlanOverview golden shape is planOverview', () => {
      const g = readGolden('plan-overview.envelope.golden.json') as {
        shape: string;
      };
      expect(g.shape).toBe('planOverview');
    });

    it('getExecutiveDashboardSnapshot golden shape is dashboardSnapshot', () => {
      const g = readGolden('dashboard-snapshot.envelope.golden.json') as {
        shape: string;
      };
      expect(g.shape).toBe('dashboardSnapshot');
    });

    it('getCrossPlanInsights golden shape is crossPlanInsights', () => {
      const g = readGolden('cross-plan-insights.envelope.golden.json') as {
        shape: string;
      };
      expect(g.shape).toBe('crossPlanInsights');
    });
  });
});
