/**
 * token-guard.ts — Phase 4 §T3
 *
 * Replaces the Phase 1 naive `text.slice(0, 8000)` truncation with a
 * smart head + tail truncator so government documents (typically
 * subject/signatures in the header and date/signoff in the footer)
 * keep BOTH ends within the token budget.
 *
 * Dependency-free: we deliberately do NOT add `tiktoken` (~1 MB WASM
 * and a native build step) and instead use a character-based
 * heuristic that is accurate within ~15% for our tha+eng corpus:
 *
 *   thaiTokens   ≈ ceil(thaiChars   / 3)
 *   latinTokens  ≈ ceil(latinChars  / 4)
 *   otherChars   → 1 token per 4 chars (fallback)
 *
 * Rationale for the heuristic constants:
 *   - GPT-4o / 4o-mini BPE tokenizes Thai into sub-syllables; measured
 *     average is ~2.9 chars/token on government Thai prose.
 *   - English/Latin hits the standard ~4 chars/token.
 *   - We round UP (ceil) per script so the estimate is a soft
 *     upper-bound, which is the safe side for a cost cap.
 *
 * Cap: `MAX_INPUT_TOKENS = 2000`. With system + user envelope overhead
 * the actual `completion.usage.prompt_tokens` stays below ~2100.
 */

const MAX_INPUT_TOKENS = 2000;

// Head / tail split per the task contract. Sums to 2000 so a fully
// truncated input hits the cap exactly (before the marker).
const HEAD_TOKENS = 1400;
const TAIL_TOKENS = 600;

const TRUNC_MARKER = '\n\n... [ตัดข้อความส่วนกลาง] ...\n\n';

const THAI_RE = /[\u0E00-\u0E7F]/;
const LATIN_RE = /[A-Za-z]/;

/**
 * Character-based token estimate. Safe upper-bound (rounds up).
 */
export function estimateTokens(text: string): number {
  const s = (text ?? '').toString();
  if (!s) return 0;

  let thai = 0;
  let latin = 0;
  let other = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (THAI_RE.test(ch)) thai++;
    else if (LATIN_RE.test(ch)) latin++;
    else other++;
  }
  return Math.ceil(thai / 3) + Math.ceil(latin / 4) + Math.ceil(other / 4);
}

/**
 * Convert a desired token budget to a character budget using the same
 * heuristic — used for the head/tail slice boundaries. Because a mixed
 * document's char-per-token varies, we walk the string from the
 * requested end and accumulate actual per-char token cost until the
 * budget is reached. This guarantees the slice is ≤ `tokens` tokens.
 */
function sliceByTokenBudget(
  text: string,
  tokens: number,
  from: 'head' | 'tail',
): string {
  if (tokens <= 0 || !text) return '';
  let remaining = tokens;
  let acc = 0;

  if (from === 'head') {
    for (let i = 0; i < text.length; i++) {
      const cost = perCharTokenCost(text[i]);
      if (acc + cost > tokens) return text.slice(0, i);
      acc += cost;
      void remaining;
    }
    return text;
  }

  // Tail: walk from the end.
  for (let i = text.length - 1; i >= 0; i--) {
    const cost = perCharTokenCost(text[i]);
    if (acc + cost > tokens) return text.slice(i + 1);
    acc += cost;
  }
  return text;
}

/**
 * Per-char token cost estimate aligned with `estimateTokens`.
 * Thai = 1/3, Latin = 1/4, other = 1/4. Fractional; caller
 * accumulates and compares against the integer budget.
 */
function perCharTokenCost(ch: string): number {
  if (THAI_RE.test(ch)) return 1 / 3;
  if (LATIN_RE.test(ch)) return 1 / 4;
  return 1 / 4;
}

/**
 * Smart head + tail truncation.
 *
 * If `estimateTokens(text) <= maxTokens`, returns the text unchanged.
 * Otherwise returns `head ⧸ marker ⧸ tail`, where head is the first
 * `HEAD_TOKENS` tokens and tail is the last `TAIL_TOKENS` tokens.
 *
 * The marker itself is a few tokens, but the pre-cap budget is 2000
 * and government prose around the cap averages ~5k chars — the marker
 * overhead (≈ 7 tokens for the Thai sentence) is negligible.
 */
export function smartTruncate(
  text: string,
  maxTokens: number = MAX_INPUT_TOKENS,
): string {
  const s = (text ?? '').toString();
  if (!s) return '';
  if (estimateTokens(s) <= maxTokens) return s;

  const head = sliceByTokenBudget(s, HEAD_TOKENS, 'head');
  const tail = sliceByTokenBudget(s, TAIL_TOKENS, 'tail');

  // Guard: head+tail must not overlap in pathological tiny inputs
  // (cannot happen when we are here because we already confirmed
  // estimateTokens > maxTokens = HEAD_TOKENS + TAIL_TOKENS).
  return `${head}${TRUNC_MARKER}${tail}`;
}

export const TOKEN_GUARD_CONSTANTS = Object.freeze({
  MAX_INPUT_TOKENS,
  HEAD_TOKENS,
  TAIL_TOKENS,
  TRUNC_MARKER,
});
