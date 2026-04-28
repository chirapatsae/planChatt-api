/**
 * BE-W44-02 — aging-tool behaviour (§17.2 advisory / §17.7 branching).
 *
 * Asserts the registry contract (whitelist) for `detectWorkflowAgingProjects`.
 * The handler itself is a thin DataSource aggregator — its query shape
 * is covered by the registry's `currentStatus` enum which pins the
 * read set to `Pending` and `Pending_Approval` ONLY.
 *
 * Status exclusion rationale:
 *   - `Returned_For_Revision` is owner-side work; not a bottleneck
 *   - `Pull_Back` is owner-triggered withdrawal; not a bottleneck
 *   - `Ready` is pre-submission; not a workflow queue
 *   - `Approved` is terminal
 */
import { EXECUTIVE_TOOL_REGISTRY } from '../tools/tool-registry';

describe('BE-W44-02 / detectWorkflowAgingProjects (§17.2)', () => {
  const spec = EXECUTIVE_TOOL_REGISTRY.detectWorkflowAgingProjects;

  it('tool is registered in the executive whitelist', () => {
    expect(spec).toBeDefined();
    expect(spec.name).toBe('detectWorkflowAgingProjects');
  });

  it('currentStatus enum contains ONLY Pending and Pending_Approval', () => {
    const items = spec.returnSchema.properties?.items;
    const itemSchema = items?.items;
    const status = itemSchema?.properties?.currentStatus;
    expect(status?.enum).toEqual(['Pending', 'Pending_Approval']);
  });

  it('currentStatus enum does NOT include Returned_For_Revision', () => {
    const items = spec.returnSchema.properties?.items;
    const status = items?.items?.properties?.currentStatus;
    expect(status?.enum).not.toContain('Returned_For_Revision');
  });

  it('currentStatus enum does NOT include Pull_Back', () => {
    const items = spec.returnSchema.properties?.items;
    const status = items?.items?.properties?.currentStatus;
    expect(status?.enum).not.toContain('Pull_Back');
  });

  it('projectKind enum covers main + revised (revised here means revised/change lineage)', () => {
    const items = spec.returnSchema.properties?.items;
    const kind = items?.items?.properties?.projectKind;
    expect(kind?.enum).toEqual(['original', 'revised']);
  });

  it('thresholdDays has a sensible clamp (1..180, default 14)', () => {
    const p = spec.paramsSchema.properties?.thresholdDays;
    expect(p?.minimum).toBe(1);
    expect(p?.maximum).toBe(180);
    expect(p?.default).toBe(14);
  });

  it('scope allows "all" and workflow-scoped slices', () => {
    const p = spec.paramsSchema.properties?.scope;
    expect(p?.enum).toEqual(['all', 'main', 'revision', 'change']);
  });
});
