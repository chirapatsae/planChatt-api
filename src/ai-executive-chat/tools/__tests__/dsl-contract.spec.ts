/**
 * BE-W54-08 — `ExecutiveQuery` DSL contract spec.
 *
 * Locked decision 2026-04-24 §11.5 — the `ExecutiveQuery` JSON-Schema
 * fragment is declared ONCE as a shared TypeScript constant
 * (`EXECUTIVE_QUERY_SCHEMA`) and INLINED into each of the three Tier C
 * tools' `paramsSchema`. Byte-identity of the inlined fragment across
 * all three tools MUST be asserted here.
 *
 * Per-tool `planId` forks (§7 locked 2026-04-24):
 *   - `getPlanOverview`              → `required` += 'planId'
 *   - `getExecutiveDashboardSnapshot`→ planId optional (no override)
 *   - `getCrossPlanInsights`         → `properties.planId = { not: {} }`
 *
 * Contract assertions:
 *   - The shared fragment (with per-tool forks stripped) is
 *     byte-identical (JSON.stringify) across all three tools.
 *   - `additionalProperties: false` at every object level (root,
 *     `filters`, `filters.budgetRange`, `filters.dateRange`).
 *   - Each fork's per-tool override is present AS DOCUMENTED.
 *
 * CLAUDE.md §17.9 — schema defense relies on this contract being
 * uniform; any drift is a prompt-injection risk.
 */
import type { ToolJsonSchema } from '../executive-tool.types';
import {
  EXECUTIVE_QUERY_SCHEMA,
  EXECUTIVE_TOOL_REGISTRY,
} from '../tool-registry';

/**
 * Deep-clone a schema and strip the per-tool `planId` forks so the
 * remaining fragment can be compared byte-for-byte across tools.
 */
function stripPerToolForks(
  schema: ToolJsonSchema,
  { hadRequiredPlanId }: { hadRequiredPlanId: boolean },
): ToolJsonSchema {
  const clone = JSON.parse(JSON.stringify(schema)) as ToolJsonSchema;
  // Strip `required: [..., 'planId']` if the tool added it.
  if (hadRequiredPlanId && Array.isArray(clone.required)) {
    clone.required = clone.required.filter((k) => k !== 'planId');
  }
  // Strip a `not`-only planId shape and restore the canonical one.
  if (
    clone.properties &&
    clone.properties.planId &&
    clone.properties.planId.not !== undefined
  ) {
    clone.properties.planId = { type: 'string', format: 'uuid' };
  }
  return clone;
}

describe('BE-W54-08 / DSL contract — EXECUTIVE_QUERY_SCHEMA byte-identity', () => {
  const planOverview = EXECUTIVE_TOOL_REGISTRY.getPlanOverview.paramsSchema;
  const dashboardSnapshot =
    EXECUTIVE_TOOL_REGISTRY.getExecutiveDashboardSnapshot.paramsSchema;
  const crossPlanInsights =
    EXECUTIVE_TOOL_REGISTRY.getCrossPlanInsights.paramsSchema;

  describe('shared fragment is byte-identical across the three tools', () => {
    it('planOverview vs dashboardSnapshot', () => {
      const a = stripPerToolForks(planOverview, { hadRequiredPlanId: true });
      const b = stripPerToolForks(dashboardSnapshot, {
        hadRequiredPlanId: false,
      });
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });

    it('dashboardSnapshot vs crossPlanInsights', () => {
      const a = stripPerToolForks(dashboardSnapshot, {
        hadRequiredPlanId: false,
      });
      const b = stripPerToolForks(crossPlanInsights, {
        hadRequiredPlanId: false,
      });
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });

    it('planOverview vs crossPlanInsights', () => {
      const a = stripPerToolForks(planOverview, { hadRequiredPlanId: true });
      const b = stripPerToolForks(crossPlanInsights, {
        hadRequiredPlanId: false,
      });
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });

    it('stripped fragment equals the canonical EXECUTIVE_QUERY_SCHEMA', () => {
      const canonical = JSON.stringify(EXECUTIVE_QUERY_SCHEMA);
      const a = stripPerToolForks(planOverview, { hadRequiredPlanId: true });
      const b = stripPerToolForks(dashboardSnapshot, {
        hadRequiredPlanId: false,
      });
      const c = stripPerToolForks(crossPlanInsights, {
        hadRequiredPlanId: false,
      });
      expect(JSON.stringify(a)).toBe(canonical);
      expect(JSON.stringify(b)).toBe(canonical);
      expect(JSON.stringify(c)).toBe(canonical);
    });
  });

  describe('additionalProperties: false at every object level', () => {
    function walkObjects(
      node: ToolJsonSchema,
      path: string,
      acc: Array<{ path: string; additionalProperties: unknown }>,
    ) {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'object') {
        acc.push({
          path,
          additionalProperties: node.additionalProperties,
        });
      }
      if (node.properties) {
        for (const [k, child] of Object.entries(node.properties)) {
          walkObjects(child, `${path}.${k}`, acc);
        }
      }
      if (node.items) {
        walkObjects(node.items, `${path}[]`, acc);
      }
      if (node.not && typeof node.not === 'object') {
        // The `{ not: {} }` clause is a 0-key schema — does NOT need
        // additionalProperties. Skip.
      }
    }

    it.each([
      ['getPlanOverview', planOverview],
      ['getExecutiveDashboardSnapshot', dashboardSnapshot],
      ['getCrossPlanInsights', crossPlanInsights],
    ])(
      '%s — every inner `type: object` declares additionalProperties: false',
      (_name, schema) => {
        const acc: Array<{ path: string; additionalProperties: unknown }> = [];
        walkObjects(schema, '$', acc);
        // At least the root + `filters` + `filters.budgetRange` +
        // `filters.dateRange` must appear.
        const paths = acc.map((x) => x.path);
        expect(paths).toContain('$');
        expect(paths.some((p) => p.endsWith('.filters'))).toBe(true);
        expect(paths.some((p) => p.endsWith('.filters.budgetRange'))).toBe(
          true,
        );
        expect(paths.some((p) => p.endsWith('.filters.dateRange'))).toBe(true);
        for (const entry of acc) {
          expect({
            path: entry.path,
            additionalProperties: entry.additionalProperties,
          }).toEqual({
            path: entry.path,
            additionalProperties: false,
          });
        }
      },
    );
  });

  describe('per-tool planId forks', () => {
    it('getPlanOverview.required includes planId', () => {
      expect(planOverview.required).toEqual(
        expect.arrayContaining(['planId']),
      );
    });

    it('getExecutiveDashboardSnapshot.planId is { type: uuid } without required/not override', () => {
      const planIdSchema = dashboardSnapshot.properties?.planId;
      expect(planIdSchema).toEqual({ type: 'string', format: 'uuid' });
      expect(dashboardSnapshot.required ?? []).not.toContain('planId');
    });

    it('getCrossPlanInsights.properties.planId.not equals {}', () => {
      expect(crossPlanInsights.properties?.planId?.not).toEqual({});
      expect(crossPlanInsights.required ?? []).not.toContain('planId');
    });
  });

  describe('W67 hotfix-3 — includeStatus.default = true on every executive Tier-C tool', () => {
    it('planOverview.includeStatus default is true', () => {
      expect(planOverview.properties?.includeStatus).toEqual({
        type: 'boolean',
        default: true,
      });
    });

    it('dashboardSnapshot.includeStatus default is true', () => {
      expect(dashboardSnapshot.properties?.includeStatus).toEqual({
        type: 'boolean',
        default: true,
      });
    });

    it('crossPlanInsights.includeStatus default is true', () => {
      expect(crossPlanInsights.properties?.includeStatus).toEqual({
        type: 'boolean',
        default: true,
      });
    });
  });

  describe('W67-FIX-B — includeStatusDrill.default = false on every executive Tier-C tool', () => {
    it('planOverview.includeStatusDrill default is false', () => {
      expect(planOverview.properties?.includeStatusDrill).toEqual({
        type: 'boolean',
        default: false,
      });
    });

    it('dashboardSnapshot.includeStatusDrill default is false', () => {
      expect(dashboardSnapshot.properties?.includeStatusDrill).toEqual({
        type: 'boolean',
        default: false,
      });
    });

    it('crossPlanInsights.includeStatusDrill default is false', () => {
      expect(crossPlanInsights.properties?.includeStatusDrill).toEqual({
        type: 'boolean',
        default: false,
      });
    });
  });

  describe("W67-LAO-RESOLVER — groupBy enum + filters.laoIds shared across Tier-C tools", () => {
    it.each([
      ['getPlanOverview', planOverview],
      ['getExecutiveDashboardSnapshot', dashboardSnapshot],
      ['getCrossPlanInsights', crossPlanInsights],
    ])("%s.groupBy.enum includes 'lao'", (_name, schema) => {
      const enumVals = schema.properties?.groupBy?.items?.enum;
      expect(Array.isArray(enumVals)).toBe(true);
      expect(enumVals).toContain('lao');
    });

    it.each([
      ['getPlanOverview', planOverview],
      ['getExecutiveDashboardSnapshot', dashboardSnapshot],
      ['getCrossPlanInsights', crossPlanInsights],
    ])(
      '%s.filters.properties.laoIds is { type: array, items: { type: string } }',
      (_name, schema) => {
        const laoIdsSchema = schema.properties?.filters?.properties?.laoIds;
        expect(laoIdsSchema).toEqual({
          type: 'array',
          items: { type: 'string' },
        });
      },
    );
  });

  describe('W67-PAO-EXEC-STAGE — filters.hasResponsibleAgency + filters.isBooked shared across Tier-C tools', () => {
    it.each([
      ['getPlanOverview', planOverview],
      ['getExecutiveDashboardSnapshot', dashboardSnapshot],
      ['getCrossPlanInsights', crossPlanInsights],
    ])(
      '%s.filters.properties.hasResponsibleAgency is { type: boolean }',
      (_name, schema) => {
        const fieldSchema =
          schema.properties?.filters?.properties?.hasResponsibleAgency;
        expect(fieldSchema).toEqual({ type: 'boolean' });
      },
    );

    it.each([
      ['getPlanOverview', planOverview],
      ['getExecutiveDashboardSnapshot', dashboardSnapshot],
      ['getCrossPlanInsights', crossPlanInsights],
    ])(
      '%s.filters.properties.isBooked is { type: boolean }',
      (_name, schema) => {
        const fieldSchema = schema.properties?.filters?.properties?.isBooked;
        expect(fieldSchema).toEqual({ type: 'boolean' });
      },
    );

    it('both fields live inside the byte-identical shared fragment (cross-tool stability)', () => {
      // The byte-identity assertion above already covers this transitively
      // — but pin it explicitly so a future regression that drifts ONE
      // tool surfaces immediately rather than via the (less-specific)
      // top-level byte-identity fail.
      const a = stripPerToolForks(planOverview, { hadRequiredPlanId: true });
      const b = stripPerToolForks(dashboardSnapshot, {
        hadRequiredPlanId: false,
      });
      const c = stripPerToolForks(crossPlanInsights, {
        hadRequiredPlanId: false,
      });
      const aField = a.properties?.filters?.properties?.hasResponsibleAgency;
      const bField = b.properties?.filters?.properties?.hasResponsibleAgency;
      const cField = c.properties?.filters?.properties?.hasResponsibleAgency;
      expect(JSON.stringify(aField)).toBe(JSON.stringify(bField));
      expect(JSON.stringify(bField)).toBe(JSON.stringify(cField));

      const aBooked = a.properties?.filters?.properties?.isBooked;
      const bBooked = b.properties?.filters?.properties?.isBooked;
      const cBooked = c.properties?.filters?.properties?.isBooked;
      expect(JSON.stringify(aBooked)).toBe(JSON.stringify(bBooked));
      expect(JSON.stringify(bBooked)).toBe(JSON.stringify(cBooked));
    });
  });
});
