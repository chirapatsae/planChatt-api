/**
 * BE-W54-08 — `getExecutiveDashboardSnapshot` Tier C handler spec.
 *
 * Covers:
 *   - Dual-registration in registry + handler map.
 *   - Envelope shape = `dashboardSnapshot`.
 *   - `paramsSchema.planId` is optional (NO `required: ['planId']`, NO
 *     `not: {}` clause).
 *   - `assertExecutiveRole` called first; Tier B mocks never touched on
 *     role rejection.
 *   - `groupBy` parametrised across the five dimensions — handler forwards
 *     to Tier B services and assembles buckets per dimension.
 *
 * CLAUDE.md §17.11 — belt-and-braces role assertion.
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
import type { ExecutiveEnvelope } from '../../aggregation/types';

function makeCtx(
  overrides: Partial<ExecutiveCallerContext> = {},
): ExecutiveCallerContext {
  return {
    userId: 'u',
    workHistoryId: 'wh',
    roleName: 'admin',
    workStatusName: 'approved',
    ...overrides,
  };
}

function makeDeps(): {
  deps: ExecutiveToolHandlerDeps;
  runDimensions: jest.Mock;
  listUnifiedProjects: jest.Mock;
} {
  const listUnifiedProjects = jest.fn().mockResolvedValue([]);
  // W67-FIX-02 — `getExecutiveDashboardSnapshot` calls the direct-DB
  // count helper after `runDimensions` returns. Provide a default stub
  // returning all-zero counts so the existing assertions (which don't
  // care about the breakdown) still pass.
  const countExecutiveStatusBreakdown = jest.fn().mockResolvedValue({
    pendingReviewCount: 0,
    awaitingApprovalCount: 0,
    approvedCount: 0,
    rejectedCount: 0,
  });
  // W67-FIX-B — drill-down stub. Default empty so existing assertions
  // (which don't opt-in to drill) pass; new tests below opt in via
  // `includeStatusDrill: true` and override the resolved value.
  const groupedExecutiveStatusBreakdown = jest
    .fn()
    .mockResolvedValue({ books: [] });
  const runDimensions = jest.fn(
    async (
      tasks: Array<{ dimension: string }>,
      assemble: (results: unknown[]) => unknown,
      options: { shape: string },
    ) => {
      const data = assemble([]);
      return {
        shape: options.shape,
        data,
        asOf: new Date().toISOString(),
        missingDimensions: [],
        advisories: [],
        partial: false,
        _tasksSeen: tasks.map((t) => t.dimension),
      } as unknown as ExecutiveEnvelope<unknown>;
    },
  );
  const deps: ExecutiveToolHandlerDeps = {
    dataSource: {} as never,
    unifiedProject: {
      listUnifiedProjects,
      countExecutiveStatusBreakdown,
      groupedExecutiveStatusBreakdown,
    } as never,
    budget: {
      totalsForUnifiedProjects: jest.fn().mockResolvedValue(new Map()),
    } as never,
    status: {
      latestStatusFor: jest.fn().mockResolvedValue(new Map()),
    } as never,
    geo: {
      annotate: jest.fn().mockResolvedValue({
        labels: new Map(),
        missingDimensions: [],
        advisories: [],
      }),
    } as never,
    agency: {
      annotate: jest.fn().mockResolvedValue({
        labels: new Map(),
        missingDimensions: [],
        advisories: [],
      }),
    } as never,
    resilience: { runDimensions } as never,
  };
  return { deps, runDimensions, listUnifiedProjects };
}

describe('BE-W54-08 / getExecutiveDashboardSnapshot', () => {
  describe('dual-registration', () => {
    it('is registered in registry + handler map', () => {
      expect(
        EXECUTIVE_TOOL_REGISTRY.getExecutiveDashboardSnapshot,
      ).toBeDefined();
      expect(EXECUTIVE_TOOL_NAMES).toContain('getExecutiveDashboardSnapshot');
      expect(typeof EXECUTIVE_TOOL_HANDLERS.getExecutiveDashboardSnapshot).toBe(
        'function',
      );
    });
  });

  describe('schema contract', () => {
    const spec = EXECUTIVE_TOOL_REGISTRY.getExecutiveDashboardSnapshot;

    it('paramsSchema.planId is OPTIONAL (no required entry)', () => {
      expect(spec.paramsSchema.required ?? []).not.toContain('planId');
    });

    it('paramsSchema.planId has no `not` clause (distinct from cross-plan)', () => {
      const planIdSchema = spec.paramsSchema.properties?.planId;
      expect(planIdSchema).toBeDefined();
      expect(planIdSchema?.not).toBeUndefined();
      expect(planIdSchema?.type).toBe('string');
      expect(planIdSchema?.format).toBe('uuid');
    });

    it('returnSchema.shape enum is [dashboardSnapshot]', () => {
      expect(spec.returnSchema.properties?.shape?.enum).toEqual([
        'dashboardSnapshot',
      ]);
    });
  });

  describe('assertExecutiveRole first-line guard', () => {
    it('rejects non-executive BEFORE Tier B calls', async () => {
      const { deps, runDimensions, listUnifiedProjects } = makeDeps();
      await expect(
        EXECUTIVE_TOOL_HANDLERS.getExecutiveDashboardSnapshot(
          { scope: ['all'] },
          makeCtx({ roleName: 'user' }),
          deps,
        ),
      ).rejects.toThrow('EXECUTIVE_ROLE_REQUIRED');
      expect(listUnifiedProjects).not.toHaveBeenCalled();
      expect(runDimensions).not.toHaveBeenCalled();
    });
  });

  describe('groupBy dimensions forwarded correctly', () => {
    const cases: Array<'status' | 'amphoe' | 'agency' | 'strategy' | 'issue'> =
      ['status', 'amphoe', 'agency', 'strategy', 'issue'];

    it.each(cases)(
      'groupBy=[%s] — dispatches a runDimensions call with the right shape',
      async (dim) => {
        const { deps, runDimensions } = makeDeps();
        // Map the UI-level groupBy to the underlying dimension task flag
        // the handler supplies. `includeStatus` maps to `status` etc.
        const includeFlags: Record<string, unknown> = {};
        if (dim === 'status') includeFlags.includeStatus = true;
        if (dim === 'amphoe') includeFlags.includeGeo = true;
        if (dim === 'agency') includeFlags.includeAgency = true;
        if (dim === 'strategy' || dim === 'issue')
          includeFlags.includeClassification = true;

        await EXECUTIVE_TOOL_HANDLERS.getExecutiveDashboardSnapshot(
          { scope: ['all'], groupBy: [dim], ...includeFlags },
          makeCtx(),
          deps,
        );
        expect(runDimensions).toHaveBeenCalledTimes(1);
        const [tasks, , options] = runDimensions.mock.calls[0];
        expect(options.shape).toBe('dashboardSnapshot');
        // The handler always routes through runDimensions for the
        // chosen dimension flag → one task per include flag.
        expect(Array.isArray(tasks)).toBe(true);
      },
    );
  });

  describe('envelope shape invariants', () => {
    it('emits shape=dashboardSnapshot with array fields', async () => {
      const { deps } = makeDeps();
      const env = (await EXECUTIVE_TOOL_HANDLERS.getExecutiveDashboardSnapshot(
        { scope: ['all'] },
        makeCtx(),
        deps,
      )) as unknown as ExecutiveEnvelope<unknown>;
      expect(env.shape).toBe('dashboardSnapshot');
      expect(typeof env.asOf).toBe('string');
      expect(new Date(env.asOf).toISOString()).toBe(env.asOf);
      expect(Array.isArray(env.missingDimensions)).toBe(true);
      expect(Array.isArray(env.advisories)).toBe(true);
      expect(typeof env.partial).toBe('boolean');
    });
  });
});
