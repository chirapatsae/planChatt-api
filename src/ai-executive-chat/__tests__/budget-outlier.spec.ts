/**
 * BE-W44-02 — budget-outlier behaviour (§17.2 / §17.7).
 *
 * The outlier tool is intentionally intra-plan: we compare a project's
 * budget against the distribution of projects in the SAME plan, not
 * against a global baseline or against "what the budget ought to be".
 * This avoids producing pseudo-normative recommendations and keeps
 * §17.2 advisory framing honest.
 */
import { EXECUTIVE_TOOL_REGISTRY } from '../tools/tool-registry';

describe('BE-W44-02 / highlightBudgetOutliers (§17.2 / §17.7)', () => {
  const spec = EXECUTIVE_TOOL_REGISTRY.highlightBudgetOutliers;

  it('tool is registered', () => {
    expect(spec).toBeDefined();
    expect(spec.name).toBe('highlightBudgetOutliers');
  });

  it('requires planId — outlier analysis is INTRA-PLAN only', () => {
    expect(spec.paramsSchema.required).toEqual(['planId']);
    const p = spec.paramsSchema.properties?.planId;
    expect(p?.type).toBe('string');
    expect(p?.format).toBe('uuid');
  });

  it('exposes both percentile (default) and stddev methods', () => {
    const p = spec.paramsSchema.properties?.method;
    expect(p?.enum).toEqual(['percentile', 'stddev']);
    expect(p?.default).toBe('percentile');
  });

  it('does NOT leak originAgency / createdBy / owner identity on the result', () => {
    const items = spec.returnSchema.properties?.items;
    const itemProps = items?.items?.properties ?? {};
    const forbiddenKeys = [
      'createdBy',
      'originAgencyId',
      'ownerWorkHistoryId',
      'firstName',
      'lastName',
      'citizenId',
      'email',
      'phone',
    ];
    for (const key of forbiddenKeys) {
      expect({ key, present: key in itemProps }).toEqual({
        key,
        present: false,
      });
    }
  });

  it('includes a `reason` field so the LLM can cite the tool output', () => {
    const items = spec.returnSchema.properties?.items;
    const itemSchema = items?.items;
    expect(itemSchema?.required).toContain('reason');
    expect(itemSchema?.properties?.reason?.type).toBe('string');
  });

  it('return carries method + threshold so §17.2 cite-the-tool framing works', () => {
    expect(spec.returnSchema.required).toEqual(
      expect.arrayContaining(['items', 'planId', 'method', 'asOf']),
    );
  });

  it('projectKind enum supports all three project lineages', () => {
    const items = spec.returnSchema.properties?.items;
    const kind = items?.items?.properties?.projectKind;
    expect(kind?.enum).toEqual(['original', 'revised', 'supplement']);
  });
});
