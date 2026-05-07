import * as fs from 'fs';
import * as path from 'path';

import { calculateAiCost } from 'src/ai/utils/cost-calculator';

/**
 * W68-FIX-02 — token-budget regression spec.
 *
 * Pins the per-request token budget knobs and the executive-chat
 * default model so a future stale constant cannot silently re-inflate
 * the prompt back over the org's 30,000 TPM ceiling.
 *
 * W68-FIX-04 (2026-04-28) — REVERTED the W68-FIX-02 model swap. The
 * gpt-4o → gpt-4o-mini flip caused production quality regressions
 * (agency filter ignored, classification labels mis-rendered,
 * multi-rule prompt drift). Default model returned to 'gpt-4o' while
 * ops requested higher TPM headroom from OpenAI.
 *
 * W68-FIX-08 (2026-04-28) — switched 'gpt-4o' → 'gpt-4.1-mini'.
 * gpt-4o still hit the 30k TPM ceiling at hop 2 of multi-tool loops.
 * gpt-4.1-mini publishes 200k+ TPM, exposes a 1M-token context window,
 * is 6× cheaper, and matches gpt-4o instruction-following (well above
 * gpt-4o-mini, so the W68-FIX-04 regression set re-tested clean).
 * Auto-downgrade target also flipped to 'gpt-4.1-nano' ($0.10 / $0.40).
 * The token-budget constants (TOOL_RESULT_MAX_BYTES = 4KB,
 * CONTEXT_MESSAGE_CAP = 8) STAY reduced because they help under any
 * model.
 *
 * CLAUDE.md references:
 *   - §17.2  — advisory only; no workflow gating involved.
 *   - §17.3  — no `tracking_status` write; assertions are file-text only.
 *   - §17.11 — no role exemption; the constants are integrity invariants.
 *
 * The constants are file-local (not exported) by design; the file-text
 * grep approach mirrors W68-FIX-01's `PER_HOP_ESTIMATE_THB` regression
 * test.
 */
describe('W68-FIX-02 token-budget regression', () => {
  const SERVICE_PATH = path.resolve(
    __dirname,
    '..',
    'ai-executive-chat.service.ts',
  );
  const SOURCE = fs.readFileSync(SERVICE_PATH, 'utf8');

  describe('per-request token budget constants', () => {
    it('TOOL_RESULT_MAX_BYTES is pinned at 4 KB (4 * 1024)', () => {
      // Match the literal declaration line. A future PR that bumps
      // this back to `8 * 1024` would silently re-inflate hop-3 token
      // usage by ~3-4k tokens and re-trigger the OpenAI 429.
      expect(SOURCE).toMatch(
        /const\s+TOOL_RESULT_MAX_BYTES\s*=\s*4\s*\*\s*1024\s*;/,
      );
      // Belt-and-braces: the old 8 KB literal must be gone.
      expect(SOURCE).not.toMatch(
        /const\s+TOOL_RESULT_MAX_BYTES\s*=\s*8\s*\*\s*1024\s*;/,
      );
    });

    it('CONTEXT_MESSAGE_CAP is pinned at 8', () => {
      expect(SOURCE).toMatch(/const\s+CONTEXT_MESSAGE_CAP\s*=\s*8\s*;/);
      expect(SOURCE).not.toMatch(/const\s+CONTEXT_MESSAGE_CAP\s*=\s*20\s*;/);
    });
  });

  describe('default executive-chat model (W68-FIX-08: gpt-4.1-mini)', () => {
    it('defaults `meta.modelUsed` to `gpt-4.1-mini`, never `gpt-4o` or `gpt-4o-mini` on the loop entry', () => {
      // W68-FIX-08 — runToolLoop entry-point initializer flipped from
      // 'gpt-4o' → 'gpt-4.1-mini'.
      expect(SOURCE).toMatch(
        /modelUsed:\s*initialModelOverride\s*\|\|\s*'gpt-4\.1-mini'\s*,/,
      );
      expect(SOURCE).not.toMatch(
        /modelUsed:\s*initialModelOverride\s*\|\|\s*'gpt-4o'\s*,/,
      );
      expect(SOURCE).not.toMatch(
        /modelUsed:\s*initialModelOverride\s*\|\|\s*'gpt-4o-mini'/,
      );
    });

    it('post-turn quota deduction fallback is `gpt-4.1-mini`', () => {
      expect(SOURCE).toMatch(
        /calculateAiCost\(\s*meta\.modelUsed\s*\|\|\s*'gpt-4\.1-mini'\s*,/,
      );
      expect(SOURCE).not.toMatch(
        /calculateAiCost\(\s*meta\.modelUsed\s*\|\|\s*'gpt-4o'\s*,/,
      );
      expect(SOURCE).not.toMatch(
        /calculateAiCost\(\s*meta\.modelUsed\s*\|\|\s*'gpt-4o-mini'/,
      );
    });

    it('auto-title path remains pinned to `gpt-4o-mini` (Wave 51 behavior, untouched by W68-FIX-08)', () => {
      // The auto-title block defines `params: ChatCompletionParamsNonStreaming`
      // with `model: 'gpt-4o-mini'`. W68-FIX-08 explicitly preserves
      // this — only the main tool-loop sites flipped to gpt-4.1-mini.
      expect(SOURCE).toMatch(/model:\s*'gpt-4o-mini'/);
    });

    it('no surplus `gpt-4o-mini` literals on the main tool-loop sites (auto-title aside)', () => {
      // After W68-FIX-08 the only legitimate places where 'gpt-4o-mini'
      // may appear as a literal are the auto-title `params.model` and
      // its `modelName` usage-log entry. The mid-turn downgrade trigger
      // no longer references mini (it tests for 'gpt-4.1-nano' now).
      const literalMatches = SOURCE.match(/'gpt-4o-mini'/g) ?? [];
      // Two legitimate occurrences post-W68-FIX-08:
      //   1. params: { model: 'gpt-4o-mini', ... } in generateAutoTitle
      //   2. modelName: 'gpt-4o-mini' in the auto-title usage-log block
      expect(literalMatches.length).toBeLessThanOrEqual(2);
    });

    it('no surplus `gpt-4o` literals on ACTIVE code paths (W68-FIX-08)', () => {
      // After W68-FIX-08 the literal 'gpt-4o' (without -mini suffix)
      // is allowed in W68-FIX-08 ledger COMMENTS (which document the
      // migration trace) but MUST NOT appear in active executable code.
      // Strategy: drop comment-only lines first, then strip
      // 'gpt-4o-mini' substrings (auto-title is the legitimate
      // mini-bearing site), then count any remaining lonely 'gpt-4o'.
      const lines = SOURCE.split('\n');
      // Remove pure comment lines (// ...) and JSDoc lines starting
      // with `*`. This is a coarse strip — block comments inside
      // expressions still survive, which is intentional (they would
      // catch back-door re-introductions).
      const codeOnly = lines
        .filter((l) => {
          const t = l.trim();
          if (t.startsWith('//')) return false;
          if (t.startsWith('*')) return false;
          if (t.startsWith('/*') || t.startsWith('/**')) return false;
          return true;
        })
        .join('\n');
      const stripped = codeOnly.replace(/'gpt-4o-mini'/g, '');
      const lonelyGpt4o = stripped.match(/'gpt-4o'/g) ?? [];
      expect(lonelyGpt4o.length).toBeLessThanOrEqual(0);
    });
  });

  describe('cost-calculator alignment with gpt-4.1-mini pricing (W68-FIX-08)', () => {
    it('gpt-4.1-mini cost for the worst-case observed hop is computable', () => {
      // Worst-case hop captured from the W68-FIX-02 production trace:
      // 47,954 prompt tokens + 249 completion tokens. With W68-FIX-08
      // the default model is now gpt-4.1-mini ($0.40 in / $1.60 out
      // per 1M tokens):
      //   (47954 * 0.4 + 249 * 1.6) / 1_000_000
      //   = (19181.6 + 398.4) / 1_000_000
      //   = 0.01958 USD ≈ ฿0.666 at FX 34
      const cost = calculateAiCost('gpt-4.1-mini', {
        prompt_tokens: 47954,
        completion_tokens: 249,
      });
      expect(cost).toBeCloseTo(0.01958, 6);
    });

    it('nano cost is materially lower than gpt-4.1-mini for the same usage (~4x cheaper input)', () => {
      // Pricing ratio invariant under W68-FIX-08. gpt-4.1-mini
      // ($0.40 / $1.60) vs gpt-4.1-nano ($0.10 / $0.40) is exactly 4×
      // on input AND 4× on output, so the blended ratio is ~4×.
      const usage = { prompt_tokens: 47954, completion_tokens: 249 };
      const nanoCost = calculateAiCost('gpt-4.1-nano', usage);
      const miniCost = calculateAiCost('gpt-4.1-mini', usage);
      expect(miniCost / nanoCost).toBeCloseTo(4, 2);
    });
  });
});
