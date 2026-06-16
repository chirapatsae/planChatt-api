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
    const res = parseToolCallArguments(
      '{"planId":"11111111-1111-1111-1111-111111111111"}',
    );
    expect(res.ok).toBe(true);
    expect(res.value).toEqual({
      planId: '11111111-1111-1111-1111-111111111111',
    });
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
    const res = validateAgainstSchema(spec.paramsSchema, {
      planId: 'not-a-uuid',
    });
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

/**
 * Wave AI-Knowledge-Hub BE-04 (2026-06-12) — `searchKnowledgeBase`
 * schema strictness (§17.9). Output validation failures on this tool
 * surface as 502 `AI_SCHEMA_DRIFT` through the same tool-loop path the
 * cases above exercise; provenance keys are REQUIRED so the LLM can
 * always cite ที่มา (origin / sourceName / updatedAt / version).
 */
describe('BE-04 / searchKnowledgeBase schema strictness (§17.9)', () => {
  const spec = EXECUTIVE_TOOL_REGISTRY.searchKnowledgeBase;

  it('missing required `query` is an error, not a silent default', () => {
    const res = validateAgainstSchema(spec.paramsSchema, { limit: 3 });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/missing required/);
  });

  it('limit above the top-k ceiling of 5 is rejected', () => {
    const res = validateAgainstSchema(spec.paramsSchema, {
      query: 'นโยบาย',
      limit: 6,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/above maximum/);
  });

  it('domainKey outside the knowledge-domain enum is rejected', () => {
    const res = validateAgainstSchema(spec.paramsSchema, {
      query: 'นโยบาย',
      domainKey: 'not-a-domain',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/enum/);
  });

  it('additionalProperties:false rejects injected extra params', () => {
    const res = validateAgainstSchema(spec.paramsSchema, {
      query: 'นโยบาย',
      injected: 'attack',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/additional property/);
  });

  it('valid params pass (domainKey from the registered knowledge domains)', () => {
    const res = validateAgainstSchema(spec.paramsSchema, {
      query: 'การประสานแผน คืออะไร',
      domainKey: 'glossary',
      limit: 3,
    });
    expect(res.ok).toBe(true);
  });

  it('return schema catches handler drift — missing asOf', () => {
    const res = validateAgainstSchema(spec.returnSchema, { items: [] });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/asOf/);
  });

  it('return schema demands the provenance key `sourceName` on every item (nullable-via-required-only)', () => {
    const itemMissingSourceName = {
      entryId: '11111111-1111-1111-1111-111111111111',
      title: 'อภิธานศัพท์',
      excerpt: 'คำนิยาม…',
      domainKey: 'glossary',
      origin: 'curated',
      updatedAt: '2026-06-12T00:00:00.000Z',
      version: 1,
    };
    const res = validateAgainstSchema(spec.returnSchema, {
      items: [itemMissingSourceName],
      asOf: '2026-06-12T00:00:00.000Z',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/sourceName/);

    // `sourceName: null` (curated row) passes — key present, value null.
    const ok = validateAgainstSchema(spec.returnSchema, {
      items: [{ ...itemMissingSourceName, sourceName: null }],
      asOf: '2026-06-12T00:00:00.000Z',
    });
    expect(ok).toEqual({ ok: true });
  });

  it('return schema rejects an origin outside curated|external (provenance spoof = drift)', () => {
    const res = validateAgainstSchema(spec.returnSchema, {
      items: [
        {
          entryId: '11111111-1111-1111-1111-111111111111',
          title: 'อภิธานศัพท์',
          excerpt: 'คำนิยาม…',
          domainKey: 'glossary',
          origin: 'system',
          sourceName: null,
          updatedAt: '2026-06-12T00:00:00.000Z',
          version: 1,
        },
      ],
      asOf: '2026-06-12T00:00:00.000Z',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/enum/);
  });
});
