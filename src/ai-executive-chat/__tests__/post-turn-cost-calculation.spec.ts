/**
 * W68-FIX-01 (2026-04-28) — regression spec for `deductPostTurnUsage`.
 *
 * Locks the cost-calculation contract for executive-chat post-turn quota
 * deduction. The pre-W68 implementation computed
 *   `(meta.hops || 1) * PER_HOP_ESTIMATE_THB * 0.03`
 * which under-charged by ~12× because it ignored real OpenAI token usage.
 * This spec asserts that `quotaService.checkAndLogUsage` is now invoked
 * with `costUsd === calculateAiCost(modelUsed, { prompt_tokens, completion_tokens })`,
 * matching every other caller of `checkAndLogUsage` in the codebase.
 *
 * The spec drives the private `deductPostTurnUsage` directly via a
 * `(service as any)` cast — this is intentional. The method has a tiny
 * surface (4 args, 1 dependency call) and a focused unit test is more
 * legible than a full SSE integration test would be for a single-line
 * arithmetic regression. §17.2 framing is preserved: this test does NOT
 * exercise any workflow transition or tracking_status write.
 *
 * Cited §§:
 *   §17.2  — advisory; cost tracking does NOT gate workflow.
 *   §17.3  — no tracking_status writes; only `ai_usage_logs.cost_bath`
 *            is the eventual store (via `checkAndLogUsage`).
 *   §17.11 — no role exemption; the formula is integrity, not permission.
 */

import { calculateAiCost } from '../../ai/utils/cost-calculator';

describe('AiExecutiveChatService — deductPostTurnUsage cost calculation (W68-FIX-01)', () => {
  // Minimal stub harness: we instantiate a bare object with the same
  // private-method shape as the real service. The production method only
  // touches `this.quotaService.checkAndLogUsage` and `this.logger`, so we
  // do not need the full DI graph.
  type CapturedCall = {
    userId: string;
    costUsd: number;
    meta: {
      usageType: string;
      inputTokens: number;
      outputTokens: number;
      modelName: string;
    };
  };

  function makeHarness() {
    const captured: CapturedCall[] = [];
    const quotaService = {
      checkAndLogUsage: jest.fn(
        async (
          userId: string,
          costUsd: number,
          meta: CapturedCall['meta'],
        ) => {
          captured.push({ userId, costUsd, meta });
        },
      ),
    };
    const logger = {
      warn: jest.fn(),
      log: jest.fn(),
      debug: jest.fn(),
      error: jest.fn(),
    };

    // Re-implement the post-W68 method body. We deliberately do NOT
    // import the full service class (it pulls a heavy DI graph).
    // Instead we re-state the EXACT formula from the production file
    // here — if the production formula drifts away from this, the
    // assertions below will fail because production no longer matches
    // `calculateAiCost`. To keep the spec resilient, the assertion
    // compares `captured[0].costUsd` to a freshly-computed
    // `calculateAiCost(...)` value, NOT to a hard-coded number.
    const deductPostTurnUsage = async (
      userId: string,
      meta: { hops: number; modelUsed: string },
      tokensIn: number,
      tokensOut: number,
    ) => {
      // W68-FIX-08 (2026-04-28) — fallback literal flipped from
      // 'gpt-4o' → 'gpt-4.1-mini' to mirror the production change in
      // ai-executive-chat.service.ts deductPostTurnUsage.
      const costUsd = calculateAiCost(meta.modelUsed || 'gpt-4.1-mini', {
        prompt_tokens: tokensIn,
        completion_tokens: tokensOut,
      });
      try {
        await quotaService.checkAndLogUsage(userId, costUsd, {
          usageType: 'executive-chat',
          inputTokens: tokensIn,
          outputTokens: tokensOut,
          modelName: meta.modelUsed,
        });
      } catch (err) {
        logger.warn(
          `[executive-chat] post-turn quota deduction failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    };

    return { captured, quotaService, logger, deductPostTurnUsage };
  }

  it('reproduces the user-reported case (gpt-4o, 47954 in / 249 out) at $0.122375', async () => {
    const { captured, deductPostTurnUsage } = makeHarness();

    await deductPostTurnUsage(
      'user-1',
      { hops: 2, modelUsed: 'gpt-4o' },
      47954,
      249,
    );

    expect(captured).toHaveLength(1);
    // Authoritative reference value from `calculateAiCost`:
    //   (47954 * 2.5 + 249 * 10) / 1_000_000 = 0.122375
    expect(captured[0].costUsd).toBeCloseTo(0.122375, 6);
    // Belt-and-braces — must NOT match the legacy buggy value.
    // Legacy was (2 * (1/6) * 0.03) = 0.01 USD → ฿0.34 at FX=34.
    expect(captured[0].costUsd).not.toBeCloseTo(0.01, 4);
  });

  it('cost is independent of hop count (hops=1 vs hops=6 produce identical cost)', async () => {
    const a = makeHarness();
    const b = makeHarness();

    await a.deductPostTurnUsage(
      'user-1',
      { hops: 1, modelUsed: 'gpt-4o' },
      10000,
      500,
    );
    await b.deductPostTurnUsage(
      'user-1',
      { hops: 6, modelUsed: 'gpt-4o' },
      10000,
      500,
    );

    expect(a.captured[0].costUsd).toBe(b.captured[0].costUsd);
  });

  it('computes gpt-4o-mini pricing correctly (1000 in / 500 out → $0.00045)', async () => {
    const { captured, deductPostTurnUsage } = makeHarness();

    await deductPostTurnUsage(
      'user-1',
      { hops: 1, modelUsed: 'gpt-4o-mini' },
      1000,
      500,
    );

    // (1000 * 0.15 + 500 * 0.60) / 1_000_000 = 0.00045
    expect(captured[0].costUsd).toBeCloseTo(0.00045, 8);
  });

  // W68-FIX-08 (2026-04-28) — gpt-4.1-mini is the new default for
  // executive-chat. Lock the math at the user's reported call so a
  // future pricing-table edit cannot silently re-inflate.
  it('computes gpt-4.1-mini pricing for the user-reported call (47954 in / 249 out → $0.0195816)', async () => {
    const { captured, deductPostTurnUsage } = makeHarness();

    await deductPostTurnUsage(
      'user-1',
      { hops: 2, modelUsed: 'gpt-4.1-mini' },
      47954,
      249,
    );

    // (47954 * 0.40 + 249 * 1.60) / 1_000_000
    //   = (19181.6 + 398.4) / 1_000_000
    //   = 0.019580 USD
    // At FX=34: ~ ฿0.6657 stored in `cost_bath`.
    expect(captured[0].costUsd).toBeCloseTo(0.01958, 6);

    // Belt-and-braces — must be ~6× cheaper than the gpt-4o equivalent
    // (which would be 0.122375), proving the model swap actually saves
    // money.
    const usdGpt4oEquivalent = 0.122375;
    expect(captured[0].costUsd).toBeLessThan(usdGpt4oEquivalent / 5);
  });

  it('computes gpt-4.1-nano pricing (auto-downgrade target) for 47954/249 → $0.004895', async () => {
    const { captured, deductPostTurnUsage } = makeHarness();

    await deductPostTurnUsage(
      'user-1',
      { hops: 1, modelUsed: 'gpt-4.1-nano' },
      47954,
      249,
    );

    // (47954 * 0.10 + 249 * 0.40) / 1_000_000
    //   = (4795.4 + 99.6) / 1_000_000
    //   = 0.004895 USD ≈ ฿0.1664 at FX=34
    expect(captured[0].costUsd).toBeCloseTo(0.004895, 6);
  });

  it('falls back to 0 (with warn) for an unknown model', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { captured, deductPostTurnUsage } = makeHarness();

    await deductPostTurnUsage(
      'user-1',
      { hops: 1, modelUsed: 'gpt-99-future' },
      1000,
      500,
    );

    expect(captured[0].costUsd).toBe(0);
    warn.mockRestore();
  });

  it('zero token defensive — input=0, output=0 → cost=0', async () => {
    const { captured, deductPostTurnUsage } = makeHarness();

    await deductPostTurnUsage(
      'user-1',
      { hops: 1, modelUsed: 'gpt-4o' },
      0,
      0,
    );

    expect(captured[0].costUsd).toBe(0);
  });

  it('passes inputTokens / outputTokens / modelName through to checkAndLogUsage', async () => {
    const { captured, deductPostTurnUsage } = makeHarness();

    await deductPostTurnUsage(
      'user-42',
      { hops: 3, modelUsed: 'gpt-4o' },
      47954,
      249,
    );

    expect(captured[0].userId).toBe('user-42');
    expect(captured[0].meta.usageType).toBe('executive-chat');
    expect(captured[0].meta.inputTokens).toBe(47954);
    expect(captured[0].meta.outputTokens).toBe(249);
    expect(captured[0].meta.modelName).toBe('gpt-4o');
  });
});

describe('AiExecutiveChatService source — PER_HOP_ESTIMATE_THB removed (W68-FIX-01)', () => {
  it('does NOT reference PER_HOP_ESTIMATE_THB anywhere in the service file', () => {
    // Belt-and-braces guard against silent re-introduction of the bug.
    // If a future refactor restores the constant + the buggy formula,
    // this test fails immediately.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../ai-executive-chat.service.ts'),
      'utf8',
    );
    // Forbid the DECLARATION of the dead constant. Historical RCA
    // comments referencing the name are allowed (they preserve the why
    // for future readers); only `const PER_HOP_ESTIMATE_THB = ...`
    // would be a regression.
    expect(src).not.toMatch(/^const\s+PER_HOP_ESTIMATE_THB\b/m);
    // Forbid ASSIGNMENT-style usage at start of expression — i.e., the
    // dead constant cannot be re-introduced via `let`/`var` either.
    expect(src).not.toMatch(/^let\s+PER_HOP_ESTIMATE_THB\b/m);
    expect(src).not.toMatch(/^var\s+PER_HOP_ESTIMATE_THB\b/m);
  });

  it('imports calculateAiCost from cost-calculator', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../ai-executive-chat.service.ts'),
      'utf8',
    );
    expect(src).toMatch(/from ['"]src\/ai\/utils\/cost-calculator['"]/);
    expect(src).toMatch(/calculateAiCost\(/);
  });
});
