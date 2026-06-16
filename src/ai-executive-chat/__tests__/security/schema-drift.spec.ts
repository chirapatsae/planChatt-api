/**
 * SEC-W44-01 — Attack class #6: LLM schema drift / malformed tool-call.
 *
 * Threat model: OpenAI returns (or is coerced via injection to return)
 * a tool_call whose `arguments` JSON does NOT conform to the tool's
 * `paramsSchema`. Two sub-threats:
 *   (a) Missing required field — adapter must not silently fall back
 *       to default or guessed values.
 *   (b) Wrong-type fields — adapter must not coerce strings to ints,
 *       booleans to strings, etc., because that lets an attacker inject
 *       unexpected shapes into handler code.
 *
 * Defense (§17.9 / BE-W44-02 §7.1):
 *   - Every tool_call arg JSON is validated with Ajv against
 *     `spec.paramsSchema`.
 *   - On failure: a synthetic tool-error `{error:"INVALID_ARGS",...}`
 *     is returned to the LLM; loop CONTINUES.
 *   - After 3 consecutive args-invalid failures in the same turn, the
 *     adapter bails out with 502 `AI_SCHEMA_DRIFT`.
 *   - Tool-result validation follows the same pattern (500
 *     `TOOL_RESULT_INVALID` — internal drift).
 *
 * This spec exercises the shape/contract of the registry schemas today,
 * and defers the Ajv-backed adapter assertions to BE-W44-02.
 */

import { EXECUTIVE_TOOL_REGISTRY } from '../../tools/tool-registry';
import type { ToolJsonSchema } from '../../tools/executive-tool.types';

describe('SEC-W44-01 / schema-drift (§17.9)', () => {
  it('every tool paramsSchema has additionalProperties:false (strict-mode Ajv-ready)', () => {
    for (const [name, spec] of Object.entries(EXECUTIVE_TOOL_REGISTRY)) {
      expect({
        name,
        addProps: spec.paramsSchema.additionalProperties,
      }).toEqual({ name, addProps: false });
    }
  });

  it('every tool paramsSchema declares `type: "object"` at the top level', () => {
    for (const spec of Object.values(EXECUTIVE_TOOL_REGISTRY)) {
      expect(spec.paramsSchema.type).toBe('object');
    }
  });

  it('every tool returnSchema declares a structured object result (not `any`)', () => {
    for (const spec of Object.values(EXECUTIVE_TOOL_REGISTRY)) {
      expect(spec.returnSchema.type).toBe('object');
      expect(spec.returnSchema.properties).toBeDefined();
    }
  });

  it('required fields declared in paramsSchema.required appear in paramsSchema.properties', () => {
    // Guards against a schema authoring mistake where a `required` entry
    // has no matching property definition — Ajv would then fail every
    // call with a confusing error.
    for (const [name, spec] of Object.entries(EXECUTIVE_TOOL_REGISTRY)) {
      const required = spec.paramsSchema.required ?? [];
      const props = spec.paramsSchema.properties ?? {};
      for (const key of required) {
        expect({ name, key, present: key in props }).toEqual({
          name,
          key,
          present: true,
        });
      }
    }
  });

  it('every enum-constrained field lists at least two choices', () => {
    // An enum with a single value is almost always a bug — use a
    // literal default instead. This spec pins the intent.
    //
    // Wave 54 (BE-W54-06) exemption: the Tier C envelope returnSchema
    // encodes its `shape` discriminator as `enum: [<literal>]` — this is
    // the correct JSON-Schema encoding for a per-tool literal tag (the
    // envelope's three tools share a builder that stamps exactly one
    // shape per tool) and is NOT a user-facing input enum. The §17.9
    // intent here is to forbid single-enum on PARAMETER inputs (which
    // would deny the model any real choice); a discriminator literal on
    // the RETURN envelope's `shape` key is exempt.
    // Wave AI-Exec-Chat-Enterprise-Output-Tone exemption (caught up by
    // BE-04, 2026-06-12): `getPlanCatalogOverview.returnSchema.metadata.
    // documentVersion` is `enum: ['1.0']` — a RETURN-envelope literal
    // version tag, same discriminator-literal rationale as `shape`.
    // Not a user-facing input enum, so it is exempt like `shape`.
    const SKIP_KEYS = new Set(['shape', 'documentVersion']);
    const walkSchema = (
      schema: ToolJsonSchema,
      path: string,
      parentKey?: string,
    ): void => {
      if (
        schema.enum &&
        schema.enum.length === 1 &&
        !(parentKey && SKIP_KEYS.has(parentKey))
      ) {
        throw new Error(
          `enum with single value at ${path} — use a literal default`,
        );
      }
      if (schema.properties) {
        for (const [k, v] of Object.entries(schema.properties)) {
          walkSchema(v, `${path}.${k}`, k);
        }
      }
      if (schema.items) {
        walkSchema(schema.items, `${path}[]`);
      }
    };
    for (const [name, spec] of Object.entries(EXECUTIVE_TOOL_REGISTRY)) {
      expect(() => walkSchema(spec.paramsSchema, name)).not.toThrow();
      expect(() => walkSchema(spec.returnSchema, name)).not.toThrow();
    }
  });

  describe.skip('E2E — pending BE-W44-02 Ajv validator + adapter', () => {
    it('malformed tool-call JSON (missing required `planId` for getDevelopmentIssues) → synthetic tool-error, loop continues', () => {
      /** Mock LlmClient to emit { tool_calls: [{ name:'getDevelopmentIssues', arguments: '{}' }] };
       *  assert the adapter appends `{role:'tool', content: '{"error":"INVALID_ARGS",...}'}`
       *  to the message list and NEVER invokes the handler. */
    });

    it('wrong-type fields (e.g. `limit: "ten"`) are NOT silently coerced to 10', () => {
      /** Mock LlmClient to emit arguments: `{"limit":"ten"}` for `listActivePlans`;
       *  assert handler is not invoked; assert the tool-error message does NOT contain
       *  a coerced int. */
    });

    it('three consecutive INVALID_ARGS in the same turn → 502 AI_SCHEMA_DRIFT', () => {
      /** Per BE-W44-02 §7.2: hard cap = 6 hops, but 3 consecutive args-invalid bail early. */
    });

    it('tool HANDLER returns a value that fails `resultSchema` → 500 TOOL_RESULT_INVALID', () => {
      /** Internal drift surface — staff should see a loud error, NOT a silent LLM answer. */
    });
  });

  /**
   * DEFENSE NOTE:
   *  - `ToolJsonSchema` is a hand-rolled subset of JSON Schema Draft-07.
   *    If a future tool spec uses a keyword outside this subset (e.g.
   *    `oneOf`, `$ref`, `pattern`), BE-W44-02's Ajv validator may either
   *    (a) ignore it silently (BAD) or (b) fail to compile (loud, GOOD
   *    but must be handled). The SEC-W44-01 spec `additionalProperties`
   *    assertion above is the primary guardrail — it catches most
   *    authoring mistakes at review time.
   *  - If `ToolJsonSchema` is ever extended to support `oneOf`/`anyOf`,
   *    this spec must grow a test that asserts Ajv rejects values
   *    matching multiple branches.
   */
});
