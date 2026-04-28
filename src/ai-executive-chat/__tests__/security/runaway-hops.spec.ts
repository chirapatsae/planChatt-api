/**
 * SEC-W44-01 — Attack class #7: runaway tool-call loop (hop cap).
 *
 * Threat model: The LLM — either adversarially coerced or simply
 * hallucinating — returns a tool_call on EVERY response and never
 * finalizes. Without a cap, the adapter would keep invoking tools
 * forever, exhausting quota and potentially amplifying an attacker's
 * bandwidth against downstream services.
 *
 * Defense (§17.8 / BE-W44-02 §7.2):
 *   - Hard cap of 6 hops per turn.
 *   - On exhaustion: emit SSE `event: error { code: 'TOOL_LOOP_EXHAUSTED' }`,
 *     persist partial transcript (no assistant prose), return.
 *   - `finishReason` on the assistant message row is set to
 *     `'tool_loop_exhausted'` in `tool_calls_json.meta`.
 *
 * This spec documents the contract; full simulation is deferred to
 * BE-W44-02 where the `LlmToolLoopAdapter` exists.
 */

import { EXECUTIVE_TOOL_REGISTRY } from '../../tools/tool-registry';
import { QUOTA_WEIGHT_MAP } from 'src/ai-usage-quotas/quota-weight.map';

describe('SEC-W44-01 / runaway-hops (§17.8)', () => {
  it('executive-chat quota weight declares maxHops = 6', () => {
    // Authoritative cap source — consumed by both `AiQuotaGuard.checkMidTurn`
    // and the BE-W44-02 adapter's loop counter.
    expect(QUOTA_WEIGHT_MAP['executive-chat'].maxHops).toBe(6);
  });

  it('executive-chat quota weight pins model to gpt-4.1-mini (W68-FIX-08)', () => {
    // W68-FIX-08 (2026-04-28): switched 'gpt-4o' → 'gpt-4.1-mini'.
    // Lineage:
    //   W68-FIX-02 — first try: 'gpt-4o' → 'gpt-4o-mini'. Reverted by
    //                W68-FIX-04 because mini regressed agency filter,
    //                classification labels, and multi-rule prompt fidelity.
    //   W68-FIX-04 — REVERT to 'gpt-4o' while ops requested higher TPM.
    //                gpt-4o still hit the 30k TPM ceiling at hop 2.
    //   W68-FIX-08 — present switch to 'gpt-4.1-mini' (200k+ TPM, 1M
    //                context, 6× cheaper, instruction-following close
    //                to gpt-4o). Auto-downgrade target moved from
    //                'gpt-4o-mini' → 'gpt-4.1-nano'.
    // The weight map is the SINGLE SOURCE OF TRUTH for default model;
    // service-side fallback at ai-executive-chat.service.ts is flipped
    // at all five sites. Auto-title (Wave 51) stays at 'gpt-4o-mini'.
    expect(QUOTA_WEIGHT_MAP['executive-chat'].model).toBe('gpt-4.1-mini');
  });

  it('registry contains at LEAST one tool (so a loop is possible in the first place)', () => {
    expect(Object.keys(EXECUTIVE_TOOL_REGISTRY).length).toBeGreaterThan(0);
  });

  it('no registered tool supports pagination parameters above what a reasonable single turn would need', () => {
    // Indirect guard: if a tool accepted limit=10000, each hop could
    // return a massive payload and amplify the attack. Every tool caps
    // its `limit` at ≤50.
    for (const [name, spec] of Object.entries(EXECUTIVE_TOOL_REGISTRY)) {
      const limit = spec.paramsSchema.properties?.limit;
      if (limit?.type === 'integer') {
        expect({ name, max: limit.maximum }).toEqual({
          name,
          max: expect.any(Number),
        });
        expect(limit.maximum ?? 0).toBeLessThanOrEqual(50);
      }
    }
  });

  describe.skip('E2E — pending BE-W44-02 LlmToolLoopAdapter', () => {
    it('mocked LLM returns tool_call every hop → adapter bails at hop 6, emits TOOL_LOOP_EXHAUSTED', async () => {
      /**
       * Pseudo-test for BE-W44-02:
       *   const llm = mock<LlmClient>();
       *   llm.createChatCompletionStream.mockImplementation(async function*() {
       *     yield { choices: [{ delta: { tool_calls: [{ id:'t', function:{ name:'listActivePlans', arguments:'{}' }}] } }] };
       *   });
       *   const events = await runTurn(adapter, { message:'loop me' });
       *   expect(events.filter(e => e.event==='tool')).toHaveLength(6);
       *   expect(events.pop()).toMatchObject({ event:'error', data: expect.objectContaining({ code:'TOOL_LOOP_EXHAUSTED' }) });
       *   expect(llm.createChatCompletionStream).toHaveBeenCalledTimes(6);
       */
    });

    it('persisted assistant message has tool_calls_json.meta.finishReason = "tool_loop_exhausted"', () => {
      /** Per BE-W44-02 §7.1 step 8 + QA checklist. */
    });

    it('does NOT attempt hop 7 (LlmClient.createChatCompletionStream call count == 6)', () => {
      /** Pairs with the previous test — proves the cap is inclusive. */
    });

    it('partial transcript is persisted (all 6 tool rows + a finalizing assistant row)', () => {
      /** Ensures client disconnect / partial result preservation. */
    });
  });

  /**
   * DEFENSE NOTE (for BE-W44-02):
   *  - Per-hop mid-turn quota check (`AiQuotaGuard.checkMidTurn`) is the
   *    SECOND brake: even within the 6-hop cap, if the user runs out of
   *    quota the loop emits `quota_soft_stop`. The test suite for that
   *    path lives in `docs/tasks/wave44/BE-W44-02.md` §10 (`per-hop-quota-stop.spec.ts`).
   *  - The 6-hop cap is in-memory only — if the adapter is restarted
   *    mid-turn the counter resets. This is acceptable because the SSE
   *    response stream is tied to the request lifecycle; a restart
   *    tears the stream down.
   */
});
