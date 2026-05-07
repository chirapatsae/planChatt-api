/**
 * BE-W54-08 — `getCrossPlanInsights` Tier C handler spec.
 *
 * Covers:
 *   - Dual-registration (registry + handler map).
 *   - Envelope shape = `crossPlanInsights`.
 *   - Schema FORBIDS `planId` via `properties.planId = { not: {} }`.
 *     - Supplying `planId` fails the schema validator (returns 400-shape).
 *     - Omitting `planId` passes the schema validator.
 *   - `assertExecutiveRole` first-line guard; Tier B mocks never touched
 *     on role rejection.
 *
 * CLAUDE.md §17.9 — schema is the input-validation gate; invalid payloads
 * are rejected with a structured 400 before any handler runs.
 */
import {
  EXECUTIVE_TOOL_REGISTRY,
  EXECUTIVE_TOOL_NAMES,
} from '../tool-registry';
import { EXECUTIVE_TOOL_HANDLERS } from '../handlers/executive-tool-handlers';
import { validateAgainstSchema } from '../tool-schema-validator';
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
    roleName: 'super-admin',
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
  const runDimensions = jest.fn(
    async (
      _tasks: unknown[],
      assemble: (r: unknown[]) => unknown,
      options: { shape: string },
    ) =>
      ({
        shape: options.shape,
        data: assemble([]),
        asOf: new Date().toISOString(),
        missingDimensions: [],
        advisories: [],
        partial: false,
      }) as unknown as ExecutiveEnvelope<unknown>,
  );
  const deps: ExecutiveToolHandlerDeps = {
    dataSource: {} as never,
    unifiedProject: { listUnifiedProjects } as never,
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

describe('BE-W54-08 / getCrossPlanInsights', () => {
  describe('dual-registration', () => {
    it('is registered in registry + handler map', () => {
      expect(EXECUTIVE_TOOL_REGISTRY.getCrossPlanInsights).toBeDefined();
      expect(EXECUTIVE_TOOL_NAMES).toContain('getCrossPlanInsights');
      expect(typeof EXECUTIVE_TOOL_HANDLERS.getCrossPlanInsights).toBe(
        'function',
      );
    });
  });

  describe('schema contract', () => {
    const spec = EXECUTIVE_TOOL_REGISTRY.getCrossPlanInsights;

    it('paramsSchema.properties.planId declares { not: {} }', () => {
      const planIdSchema = spec.paramsSchema.properties?.planId;
      expect(planIdSchema).toBeDefined();
      expect(planIdSchema?.not).toEqual({});
    });

    it('payload WITH planId is rejected by the schema validator (400-shape)', () => {
      const res = validateAgainstSchema(spec.paramsSchema, {
        scope: ['all'],
        planId: '11111111-1111-4111-8111-111111111111',
      });
      expect(res.ok).toBe(false);
      expect(typeof res.error).toBe('string');
    });

    it('payload WITHOUT planId is accepted by the schema validator', () => {
      const res = validateAgainstSchema(spec.paramsSchema, { scope: ['all'] });
      expect(res.ok).toBe(true);
    });

    it('returnSchema.shape enum is [crossPlanInsights]', () => {
      expect(spec.returnSchema.properties?.shape?.enum).toEqual([
        'crossPlanInsights',
      ]);
    });
  });

  describe('assertExecutiveRole first-line guard (§17.11)', () => {
    it('rejects non-executive BEFORE Tier B calls', async () => {
      const { deps, listUnifiedProjects, runDimensions } = makeDeps();
      await expect(
        EXECUTIVE_TOOL_HANDLERS.getCrossPlanInsights(
          { scope: ['all'] },
          makeCtx({ roleName: 'user' }),
          deps,
        ),
      ).rejects.toThrow('EXECUTIVE_ROLE_REQUIRED');
      expect(listUnifiedProjects).not.toHaveBeenCalled();
      expect(runDimensions).not.toHaveBeenCalled();
    });
  });

  describe('envelope shape invariants', () => {
    it('emits shape=crossPlanInsights with array fields', async () => {
      const { deps } = makeDeps();
      const env = (await EXECUTIVE_TOOL_HANDLERS.getCrossPlanInsights(
        { scope: ['all'] },
        makeCtx(),
        deps,
      )) as unknown as ExecutiveEnvelope<unknown>;
      expect(env.shape).toBe('crossPlanInsights');
      expect(typeof env.asOf).toBe('string');
      expect(Array.isArray(env.missingDimensions)).toBe(true);
      expect(Array.isArray(env.advisories)).toBe(true);
      expect(typeof env.partial).toBe('boolean');
    });
  });
});
