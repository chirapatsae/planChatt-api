/**
 * BE-W44-02 — tool-schema-validator unit test (§17.9).
 *
 * The custom JSON-Schema Draft-07 subset validator is the last line
 * of defense against LLM-emitted tool-call payloads. Silent coercion
 * is forbidden. Every shape mismatch MUST be surfaced as 502
 * `AI_SCHEMA_DRIFT` by the tool-loop adapter.
 */
import {
  parseToolCallArguments,
  validateAgainstSchema,
} from '../tools/tool-schema-validator';
import { EXECUTIVE_TOOL_REGISTRY } from '../tools/tool-registry';

describe('BE-W44-02 / tool-schema-validator', () => {
  it('rejects malformed JSON payload', () => {
    const res = parseToolCallArguments('{not json');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/invalid JSON/);
  });

  it('accepts well-formed JSON payload', () => {
    const res = parseToolCallArguments('{"planId":"11111111-1111-1111-1111-111111111111"}');
    expect(res.ok).toBe(true);
    expect(res.value).toEqual({ planId: '11111111-1111-1111-1111-111111111111' });
  });

  it('missing required field is an error, not a silent default', () => {
    const spec = EXECUTIVE_TOOL_REGISTRY.getDevelopmentIssues;
    const res = validateAgainstSchema(spec.paramsSchema, {});
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/missing required/);
  });

  it('wrong-type field is rejected — no string→int coercion', () => {
    const spec = EXECUTIVE_TOOL_REGISTRY.listActivePlans;
    const res = validateAgainstSchema(spec.paramsSchema, { limit: 'ten' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/expected integer/);
  });

  it('additionalProperties:false rejects extra keys', () => {
    const spec = EXECUTIVE_TOOL_REGISTRY.listActivePlans;
    const res = validateAgainstSchema(spec.paramsSchema, {
      includeClosed: false,
      injected: 'attack',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/additional property/);
  });

  it('enum violation on string field is rejected', () => {
    const spec = EXECUTIVE_TOOL_REGISTRY.getPendingCountsByScope;
    const res = validateAgainstSchema(spec.paramsSchema, { scope: 'universe' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/enum/);
  });

  it('uuid format is enforced', () => {
    const spec = EXECUTIVE_TOOL_REGISTRY.getBudgetSummaryByPlan;
    const res = validateAgainstSchema(spec.paramsSchema, { planId: 'not-a-uuid' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/UUID/);
  });

  it('valid payload passes', () => {
    const spec = EXECUTIVE_TOOL_REGISTRY.detectWorkflowAgingProjects;
    const res = validateAgainstSchema(spec.paramsSchema, {
      thresholdDays: 14,
      scope: 'main',
      limit: 5,
    });
    expect(res.ok).toBe(true);
  });

  it('return schema catches handler drift — missing required root key', () => {
    const spec = EXECUTIVE_TOOL_REGISTRY.listActivePlans;
    const res = validateAgainstSchema(spec.returnSchema, { items: [] });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/asOf/);
  });
});
