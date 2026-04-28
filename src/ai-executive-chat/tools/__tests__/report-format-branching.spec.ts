/**
 * BE-W54-08 — reportFormat branching spec (§17.7 + §16.5).
 *
 * Two plan fixtures:
 *   - STRATEGY_BASED: projects carry strategyId/tacticId/planLevelId/
 *     indicator; developmentIssueId is null.
 *   - ISSUE_BASED: projects carry developmentIssueId; strategy/tactic/
 *     planLevel/indicator are null (§16.5 invariant).
 *
 * Assertions:
 *   1. Strategy plan + groupBy=['strategy'] — envelope projects into the
 *      `buckets.strategy` slot, `buckets.issue` not produced.
 *   2. Issue plan + groupBy=['issue'] — `buckets.issue` present;
 *      `buckets.strategy` not produced.
 *   3. Cross-shape mismatch (Strategy plan + groupBy=['issue']
 *      OR Issue plan + groupBy=['strategy']) on getPlanOverview
 *      surfaces `missingDimensions: ['classification']` with the
 *      matching shape-specific Thai advisory.
 *
 * CLAUDE.md §17.7 — AI classification reads MUST branch on
 * `reportFormat`. Shape mismatches must surface as classification
 * advisories, not as silent data loss.
 */
import {
  CLASSIFICATION_SHAPE_ISSUE,
  CLASSIFICATION_SHAPE_STRATEGY,
} from '../../aggregation/advisory-copy';
import { EXECUTIVE_TOOL_HANDLERS } from '../handlers/executive-tool-handlers';
import {
  ExecutiveCallerContext,
  ExecutiveToolHandlerDeps,
} from '../handlers/handler-types';
import { ResilienceEnvelopeService } from '../../aggregation/resilience-envelope.service';
import type { ExecutiveEnvelope } from '../../aggregation/types';

const UUID_PLAN_STRATEGY = '11111111-1111-4111-8111-111111111111';
const UUID_PLAN_ISSUE = '22222222-2222-4222-8222-222222222222';

// Silence logger so the Nest `Logger` output does not pollute test runs.
import { Logger } from '@nestjs/common';
beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  jest.restoreAllMocks();
});

function makeCtx(): ExecutiveCallerContext {
  return {
    userId: 'u',
    workHistoryId: 'wh',
    roleName: 'staff',
    workStatusName: 'approved',
  };
}

/**
 * STRATEGY_BASED fixture — matches §16.5 invariant:
 *   strategyId != null, tacticId != null, planLevelId != null,
 *   developmentIssueId == null.
 */
function strategyFixture() {
  return [
    {
      projectKind: 'main' as const,
      projectId: 'p-s-1',
      name: 'โครงการยุทธศาสตร์ A',
      planId: UUID_PLAN_STRATEGY,
      planReportFormat: 'STRATEGY_BASED' as const,
      strategyId: 'strat-1',
      tacticId: 'tac-1',
      planLevelId: 'plan-lvl-1',
      indicator: 'ตัวชี้วัด A',
      developmentIssueId: null,
      // Wave 55 W55-BE-07 — required field; report-format branching
      // test does not branch on it so the fixture uses the safe default.
      originType: 'lao-coordinated' as const,
    },
  ];
}

/**
 * ISSUE_BASED fixture — matches §16.5 invariant:
 *   developmentIssueId != null, strategyId == null, tacticId == null,
 *   planLevelId == null, indicator == null.
 */
function issueFixture() {
  return [
    {
      projectKind: 'main' as const,
      projectId: 'p-i-1',
      name: 'โครงการประเด็น A',
      planId: UUID_PLAN_ISSUE,
      planReportFormat: 'ISSUE_BASED' as const,
      strategyId: null,
      tacticId: null,
      planLevelId: null,
      indicator: null,
      developmentIssueId: 'issue-1',
      // Wave 55 W55-BE-07 — required field; report-format branching
      // test does not branch on it so the fixture uses the safe default.
      originType: 'lao-coordinated' as const,
    },
  ];
}

type FixtureProjects =
  | ReturnType<typeof strategyFixture>
  | ReturnType<typeof issueFixture>;

function makeDeps(projects: FixtureProjects): ExecutiveToolHandlerDeps {
  return {
    dataSource: {} as never,
    unifiedProject: {
      listUnifiedProjects: jest.fn().mockResolvedValue(projects),
    } as never,
    budget: { totalsForUnifiedProjects: jest.fn().mockResolvedValue(new Map()) } as never,
    status: { latestStatusFor: jest.fn().mockResolvedValue(new Map()) } as never,
    geo: {
      annotate: jest
        .fn()
        .mockResolvedValue({ labels: new Map(), missingDimensions: [], advisories: [] }),
    } as never,
    agency: {
      annotate: jest
        .fn()
        .mockResolvedValue({ labels: new Map(), missingDimensions: [], advisories: [] }),
    } as never,
    // Use the REAL resilience service so classification failures surface
    // via the real runDimensions → missingDimensions/advisories pipeline.
    resilience: new ResilienceEnvelopeService(),
  };
}

describe('BE-W54-08 / reportFormat branching (§17.7 / §16.5)', () => {
  describe('STRATEGY_BASED plan', () => {
    it('groupBy=[strategy] — buckets.strategy populated, buckets.issue absent', async () => {
      const deps = makeDeps(strategyFixture());
      const env = (await EXECUTIVE_TOOL_HANDLERS.getExecutiveDashboardSnapshot(
        {
          planId: UUID_PLAN_STRATEGY,
          scope: ['main'],
          groupBy: ['strategy'],
          includeClassification: true,
        },
        makeCtx(),
        deps,
      )) as unknown as ExecutiveEnvelope<{
        buckets: Record<string, Array<{ key: string; count: number }>>;
      }>;

      expect(env.shape).toBe('dashboardSnapshot');
      expect(env.data.buckets.strategy).toBeDefined();
      // W68-FIX-06 (2026-04-28): bucket key now resolves to Strategy.name
      // via fetchClassificationLabelsForUnifiedProjects. The mock deps in
      // this contract test don't stub `getRepository`, so the defensive
      // guard returns an empty label map and the bucket falls back to
      // '(ไม่ระบุ)'. The shape-routing intent of this test (strategy
      // bucket populated, issue bucket absent) is preserved; the exact
      // key value is no longer the ID 'strat-1'.
      expect(env.data.buckets.strategy?.length).toBeGreaterThan(0);
      expect(env.data.buckets.strategy?.[0]?.count).toBeGreaterThan(0);
      expect(env.data.buckets.issue).toBeUndefined();
    });

    it('cross-shape: groupBy=[issue] on Strategy plan via getPlanOverview → classification advisory', async () => {
      const deps = makeDeps(strategyFixture());
      const env = (await EXECUTIVE_TOOL_HANDLERS.getPlanOverview(
        {
          planId: UUID_PLAN_STRATEGY,
          scope: ['main'],
          groupBy: ['issue'],
          includeClassification: true,
        },
        makeCtx(),
        deps,
      )) as unknown as ExecutiveEnvelope<unknown>;

      expect(env.missingDimensions).toContain('classification');
      expect(env.advisories).toContain(CLASSIFICATION_SHAPE_STRATEGY);
      expect(env.partial).toBe(true);
    });
  });

  describe('ISSUE_BASED plan', () => {
    it('groupBy=[issue] — buckets.issue populated, buckets.strategy absent', async () => {
      const deps = makeDeps(issueFixture());
      const env = (await EXECUTIVE_TOOL_HANDLERS.getExecutiveDashboardSnapshot(
        {
          planId: UUID_PLAN_ISSUE,
          scope: ['main'],
          groupBy: ['issue'],
          includeClassification: true,
        },
        makeCtx(),
        deps,
      )) as unknown as ExecutiveEnvelope<{
        buckets: Record<string, Array<{ key: string; count: number }>>;
      }>;

      expect(env.shape).toBe('dashboardSnapshot');
      expect(env.data.buckets.issue).toBeDefined();
      // W68-FIX-06 (2026-04-28): bucket key now resolves to
      // DevelopmentIssue.name via fetchClassificationLabelsForUnifiedProjects.
      // Same defensive-guard fallback as the strategy test above.
      expect(env.data.buckets.issue?.length).toBeGreaterThan(0);
      expect(env.data.buckets.issue?.[0]?.count).toBeGreaterThan(0);
      expect(env.data.buckets.strategy).toBeUndefined();
    });

    it('cross-shape: groupBy=[strategy] on Issue plan via getPlanOverview → classification advisory', async () => {
      const deps = makeDeps(issueFixture());
      const env = (await EXECUTIVE_TOOL_HANDLERS.getPlanOverview(
        {
          planId: UUID_PLAN_ISSUE,
          scope: ['main'],
          groupBy: ['strategy'],
          includeClassification: true,
        },
        makeCtx(),
        deps,
      )) as unknown as ExecutiveEnvelope<unknown>;

      expect(env.missingDimensions).toContain('classification');
      expect(env.advisories).toContain(CLASSIFICATION_SHAPE_ISSUE);
      expect(env.partial).toBe(true);
    });
  });

  describe('§16.5 shape invariant — fixtures', () => {
    it('STRATEGY_BASED fixture satisfies exactly-one-shape', () => {
      const row = strategyFixture()[0];
      expect(row.strategyId).not.toBeNull();
      expect(row.tacticId).not.toBeNull();
      expect(row.planLevelId).not.toBeNull();
      expect(row.indicator).not.toBeNull();
      expect(row.developmentIssueId).toBeNull();
    });

    it('ISSUE_BASED fixture satisfies exactly-one-shape', () => {
      const row = issueFixture()[0];
      expect(row.strategyId).toBeNull();
      expect(row.tacticId).toBeNull();
      expect(row.planLevelId).toBeNull();
      expect(row.indicator).toBeNull();
      expect(row.developmentIssueId).not.toBeNull();
    });
  });
});
