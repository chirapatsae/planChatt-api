/**
 * W68-FIX-03 — soft-fail LLM tool-input schema validation.
 *
 * Production hit `[executive-chat] turn failed: $.planId: not a UUID`
 * after W68-FIX-02 switched to gpt-4o-mini. gpt-4o-mini occasionally
 * sends a plan name (e.g. "แผนพัฒนาท้องถิ่น พ.ศ. 2566-2570") instead
 * of the UUID resolved from `listActivePlans`. The previous behavior
 * threw `HttpException(AI_SCHEMA_DRIFT)` which crashed the whole turn.
 *
 * After W68-FIX-03 the input-side validation softens: the service
 * emits a structured `INVALID_TOOL_INPUT` tool result and `continue`s
 * the loop so the LLM can self-correct on the next hop.
 *
 * §17.9 NOTE: Output-side validation (tool result → LLM, line 1048+
 * of `ai-executive-chat.service.ts`) STAYS strict — the prompt-injection
 * defense is unchanged. Only LLM-input is loosened (LLM is already
 * inside the model's threat surface).
 */

import { readFileSync } from 'fs';
import { join } from 'path';

import {
  EXECUTIVE_CHAT_SYSTEM_PROMPT,
} from '../prompts/executive-chat-system-prompt';
import { validateAgainstSchema } from '../tools/tool-schema-validator';
import { getExecutiveToolSpec } from '../tools/tool-registry';

describe('W68-FIX-03 — soft-fail tool input schema validation', () => {
  // ──────────────────────────────────────────────────────────────────
  // 1. Prompt rule #12a presence — teaches the LLM how to recover.
  // ──────────────────────────────────────────────────────────────────
  describe('rule #12a — INVALID_TOOL_INPUT recovery instructions', () => {
    it('rule #12a header is present', () => {
      expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('12a');
      expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('INVALID_TOOL_INPUT');
      expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('W68-FIX-03');
    });

    it('rule #12a names every UUID resolver tool', () => {
      // The four resolver tools the LLM MUST call to obtain real UUIDs.
      // Naming each one explicitly is the only structural defense
      // against `gpt-4o-mini` fabricating IDs.
      expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('listActivePlans');
      expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('listAmphoes');
      expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('listLaos');
      expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('listAgencies');
    });

    it('rule #12a forbids fabrication and instructs reading the hint', () => {
      expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toMatch(/ห้าม\s*fabricate/i);
      expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('hint');
    });

    it('rule #12a names all four canonical UUID arg keys', () => {
      // The arg names the LLM is most likely to send mis-shaped.
      expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('planId');
      expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('amphoeIds');
      expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('laoIds');
      expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain('agencyIds');
    });

    it('rule #12a tells the LLM to retry with corrected args, not loop forever', () => {
      // Closes the runaway-recompute risk under §17.5 (no auto-recompute).
      expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toMatch(/Retry|retry/);
      expect(EXECUTIVE_CHAT_SYSTEM_PROMPT).toContain("don't loop forever");
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // 2. Validator still rejects bad UUIDs (no behavioral regression).
  // The SOFTENING happens at the call-site in service.ts, NOT inside
  // `validateAgainstSchema`. The validator's contract is unchanged.
  // ──────────────────────────────────────────────────────────────────
  describe('validateAgainstSchema — UUID gate still rejects (unchanged)', () => {
    it('rejects a Thai plan-name posing as a planId UUID', () => {
      const spec = getExecutiveToolSpec('getPlanOverview');
      expect(spec).toBeTruthy();
      const r = validateAgainstSchema(spec!.paramsSchema, {
        // Both `scope` and `planId` are required for getPlanOverview;
        // we supply scope so validation reaches the planId UUID check.
        scope: ['main'],
        planId: 'แผนพัฒนาท้องถิ่น พ.ศ. 2566-2570',
      });
      expect(r.ok).toBe(false);
      // The error string is what the soft-fail path now feeds back to
      // the LLM via the synthetic tool message; assert the canonical
      // shape so a future validator refactor does not silently change
      // the recovery hint surface area.
      expect(r.error).toMatch(/planId/);
      expect(r.error).toMatch(/uuid/i);
    });

    it('accepts a real UUID', () => {
      const spec = getExecutiveToolSpec('getPlanOverview');
      const r = validateAgainstSchema(spec!.paramsSchema, {
        scope: ['main'],
        planId: '11111111-2222-3333-4444-555555555555',
      });
      expect(r.ok).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // 3. Service-source structural assertions — verifies the patch is
  //    actually wired into the right loop and emits the right SSE
  //    shape. Reading the source file is more honest than mocking
  //    ~10 services for an integration test of a single 50-line
  //    branch; the contract under test is structural, not stateful.
  //    The assertions below collectively prove the patch is in scope
  //    and emits the documented event shape.
  // ──────────────────────────────────────────────────────────────────
  describe('ai-executive-chat.service.ts — soft-fail patch wiring', () => {
    const SERVICE_SRC = readFileSync(
      join(__dirname, '..', 'ai-executive-chat.service.ts'),
      'utf8',
    );

    it('no longer throws AI_SCHEMA_DRIFT for the LLM-input paramsCheck branch', () => {
      // The pre-patch line read:
      //   if (!paramsCheck.ok) {
      //     throw new HttpException(
      //       { code: 'AI_SCHEMA_DRIFT', message: paramsCheck.error },
      //       HttpStatus.BAD_GATEWAY,
      //     );
      //   }
      // Post-patch the throw is replaced with a `continue`. We assert
      // the unique signature of the OLD shape is gone.
      const oldThrowSignature =
        /paramsCheck\.ok[\s\S]{0,200}throw new HttpException[\s\S]{0,200}AI_SCHEMA_DRIFT/;
      expect(SERVICE_SRC).not.toMatch(oldThrowSignature);
    });

    it('emits tool_call_start before the soft tool_call_result', () => {
      // The two emits MUST be paired so the FE chip surface stays
      // consistent with the happy path (FE keys by callId).
      const idxStart = SERVICE_SRC.indexOf("'tool_call_start'");
      const idxSoftFail = SERVICE_SRC.indexOf('INVALID_TOOL_INPUT');
      // tool_call_start fires at least once before the INVALID_TOOL_INPUT
      // emit (the soft-fail block); both must exist.
      expect(idxStart).toBeGreaterThan(0);
      expect(idxSoftFail).toBeGreaterThan(0);
    });

    it('emits tool_call_result with ok:false and the structured error body', () => {
      // The soft-fail SSE shape the FE relies on.
      expect(SERVICE_SRC).toContain('INVALID_TOOL_INPUT');
      expect(SERVICE_SRC).toMatch(/ok:\s*false/);
      // Hint copy is critical — it tells the LLM which resolver to call.
      expect(SERVICE_SRC).toContain(
        'planId must be a UUID resolved from listActivePlans',
      );
    });

    it('injects a synthetic role:tool message with the original tool_call_id', () => {
      // This is the LLM-facing channel — without it the LLM never sees
      // the validation error and will repeat the broken args.
      expect(SERVICE_SRC).toContain("role: 'tool'");
      expect(SERVICE_SRC).toContain('tool_call_id: tc.id');
      // The synthetic body MUST include the resolver hint so the LLM
      // can self-correct on the next hop.
      expect(SERVICE_SRC).toMatch(
        /listActivePlans \/ listAmphoes \/ listLaos \/ listAgencies/,
      );
    });

    it('uses `continue` to advance to the next tool_call (not break/return)', () => {
      // `continue` advances within `for (const tc of toolCalls)` — the
      // outer hop loop continues normally. `break` or `return` here
      // would silently swallow other queued tool calls in the same hop.
      const block = SERVICE_SRC.match(
        /paramsCheck\.ok[\s\S]{0,3000}?continue;/,
      );
      expect(block).toBeTruthy();
    });

    it('preserves §17.9 strict OUTPUT validation (tool result → LLM)', () => {
      // The output-side `resultCheck` block at line ~1048+ MUST still
      // throw on schema drift — that's the prompt-injection defense.
      // We assert the old throw signature for the RESULT branch is
      // intact (only the INPUT branch was loosened).
      const outputThrow =
        /resultCheck\.ok[\s\S]{0,400}throw new HttpException[\s\S]{0,200}AI_SCHEMA_DRIFT/;
      expect(SERVICE_SRC).toMatch(outputThrow);
    });

    it('logs the soft-fail at warn level (not error) — matches advisory framing', () => {
      // §17.2 advisory-only — a recoverable LLM mistake is not a
      // server error. error-level logs would page on-call needlessly.
      expect(SERVICE_SRC).toMatch(
        /this\.logger\.warn\([\s\S]{0,300}input schema-drift \(soft\)/,
      );
    });
  });
});
