/**
 * BE-W54-08 — `getPlanOverview` Tier C handler spec.
 *
 * Covers:
 *   - Dual-registration: tool present in BOTH `EXECUTIVE_TOOL_REGISTRY`
 *     and `EXECUTIVE_TOOL_HANDLERS`.
 *   - `paramsSchema.required` includes `'planId'`.
 *   - Envelope shape invariants: `shape === 'planOverview'`, `asOf`
 *     parses as ISO-8601, `partial` is a boolean, `missingDimensions`
 *     and `advisories` are arrays.
 *   - `assertExecutiveRole` runs BEFORE any Tier B dep is touched
 *     (verified via role-rejection + non-call of mocks).
 *   - `deps.resilience.runDimensions` is invoked with the correct
 *     envelope shape and the composed `assemble` function.
 *
 * CLAUDE.md §17.11 — role check is a belt-and-braces tripwire inside
 * every handler regardless of controller-level guard.
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

function makeDeps(): {
  deps: ExecutiveToolHandlerDeps;
  spies: {
    listUnifiedProjects: jest.Mock;
    budgetTotals: jest.Mock;
    statusLatest: jest.Mock;
    geoAnnotate: jest.Mock;
    agencyAnnotate: jest.Mock;
    runDimensions: jest.Mock;
  };
} {
  const listUnifiedProjects = jest.fn().mockResolvedValue([
    {
      projectKind: 'main',
      projectId: 'p1',
      name: 'โครงการ A',
      planId: UUID_PLAN,
      planReportFormat: 'STRATEGY_BASED',
      // Wave 55 W55-BE-07 — required field; plan-overview handler does
      // not branch on it so the fixture uses the safe default.
      originType: 'lao-coordinated',
    },
  ]);
  const budgetTotals = jest.fn().mockResolvedValue(new Map());
  const statusLatest = jest.fn().mockResolvedValue(new Map());
  const geoAnnotate = jest.fn().mockResolvedValue({
    labels: new Map(),
    missingDimensions: [],
    advisories: [],
  });
  const agencyAnnotate = jest.fn().mockResolvedValue({
    labels: new Map(),
    missingDimensions: [],
    advisories: [],
  });
  const runDimensions = jest.fn(
    async (
      _tasks: unknown[],
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
      } as ExecutiveEnvelope<unknown>;
    },
  );

  const deps = {
    dataSource: {} as never,
    unifiedProject: {
      listUnifiedProjects,
    } as never,
    budget: {
      totalsForUnifiedProjects: budgetTotals,
    } as never,
    status: {
      latestStatusFor: statusLatest,
    } as never,
    geo: { annotate: geoAnnotate } as never,
    agency: { annotate: agencyAnnotate } as never,
    resilience: { runDimensions } as never,
  } satisfies ExecutiveToolHandlerDeps;

  return {
    deps,
    spies: {
      listUnifiedProjects,
      budgetTotals,
      statusLatest,
      geoAnnotate,
      agencyAnnotate,
      runDimensions,
    },
  };
}

describe('BE-W54-08 / getPlanOverview', () => {
  describe('dual-registration', () => {
    it('is registered in EXECUTIVE_TOOL_REGISTRY', () => {
      expect(EXECUTIVE_TOOL_REGISTRY.getPlanOverview).toBeDefined();
      expect(EXECUTIVE_TOOL_REGISTRY.getPlanOverview.name).toBe(
        'getPlanOverview',
      );
    });

    it('is present in EXECUTIVE_TOOL_NAMES', () => {
      expect(EXECUTIVE_TOOL_NAMES).toContain('getPlanOverview');
    });

    it('is registered in EXECUTIVE_TOOL_HANDLERS', () => {
      expect(EXECUTIVE_TOOL_HANDLERS.getPlanOverview).toBeDefined();
      expect(typeof EXECUTIVE_TOOL_HANDLERS.getPlanOverview).toBe('function');
    });
  });

  describe('schema contract', () => {
    const spec = EXECUTIVE_TOOL_REGISTRY.getPlanOverview;

    it('paramsSchema.required includes planId', () => {
      expect(spec.paramsSchema.required).toContain('planId');
    });

    it('paramsSchema.additionalProperties is false (root)', () => {
      expect(spec.paramsSchema.additionalProperties).toBe(false);
    });

    it('returnSchema.shape enum is [planOverview]', () => {
      expect(spec.returnSchema.properties?.shape?.enum).toEqual([
        'planOverview',
      ]);
    });

    it('returnSchema requires advisories array (§17 advisory envelope)', () => {
      expect(spec.returnSchema.required).toContain('advisories');
      expect(spec.returnSchema.properties?.advisories?.type).toBe('array');
    });
  });

  describe('assertExecutiveRole first-line guard (§17.11)', () => {
    it('throws EXECUTIVE_ROLE_REQUIRED for non-executive role BEFORE Tier B calls', async () => {
      const { deps, spies } = makeDeps();
      await expect(
        EXECUTIVE_TOOL_HANDLERS.getPlanOverview(
          { planId: UUID_PLAN, scope: ['all'] },
          makeCtx({ roleName: 'user' }),
          deps,
        ),
      ).rejects.toThrow('EXECUTIVE_ROLE_REQUIRED');
      expect(spies.listUnifiedProjects).not.toHaveBeenCalled();
      expect(spies.runDimensions).not.toHaveBeenCalled();
    });

    it('throws EXECUTIVE_ROLE_REQUIRED for non-approved workStatus', async () => {
      const { deps, spies } = makeDeps();
      await expect(
        EXECUTIVE_TOOL_HANDLERS.getPlanOverview(
          { planId: UUID_PLAN, scope: ['all'] },
          makeCtx({ workStatusName: 'pending' }),
          deps,
        ),
      ).rejects.toThrow('EXECUTIVE_ROLE_REQUIRED');
      expect(spies.listUnifiedProjects).not.toHaveBeenCalled();
    });
  });

  describe('envelope shape invariants', () => {
    it('returns an envelope with shape = planOverview, iso asOf, boolean partial, array dims + advisories', async () => {
      const { deps } = makeDeps();
      const env = (await EXECUTIVE_TOOL_HANDLERS.getPlanOverview(
        { planId: UUID_PLAN, scope: ['all'] },
        makeCtx(),
        deps,
      )) as unknown as ExecutiveEnvelope<unknown>;

      expect(env.shape).toBe('planOverview');
      expect(typeof env.asOf).toBe('string');
      expect(new Date(env.asOf).toISOString()).toBe(env.asOf);
      expect(typeof env.partial).toBe('boolean');
      expect(Array.isArray(env.missingDimensions)).toBe(true);
      expect(Array.isArray(env.advisories)).toBe(true);
    });

    it('calls deps.resilience.runDimensions with planOverview shape', async () => {
      const { deps, spies } = makeDeps();
      await EXECUTIVE_TOOL_HANDLERS.getPlanOverview(
        { planId: UUID_PLAN, scope: ['all'], includeBudget: true },
        makeCtx(),
        deps,
      );
      expect(spies.runDimensions).toHaveBeenCalledTimes(1);
      const [, , options] = spies.runDimensions.mock.calls[0];
      expect(options.shape).toBe('planOverview');
    });
  });
});
