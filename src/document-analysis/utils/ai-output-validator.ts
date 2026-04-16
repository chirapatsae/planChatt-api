/**
 * ai-output-validator.ts — Phase 4 §T2 (revised by SCANNED_PDF_SUMMARY_HARDENING §N2)
 *
 * Validates the GPT-4o-mini JSON response AFTER parse, BEFORE persist.
 * Even with `response_format = json_schema` and `max_tokens = 500`, the
 * model occasionally returns:
 *   - degenerate loops ("สรุป สรุป สรุป สรุป ...")
 *   - punctuation-only summaries ("- - - - -")
 *   - single-token topics ("?" or "-")
 *   - empty whitespace
 *
 * Phase 1 PII redaction runs AFTER this validator, so validating against
 * the raw parsed values is safe (the redactor only narrows content, it
 * never injects).
 *
 * Rules:
 *   summary:
 *     - length > 20
 *     - no ≥8-char substring appears more than 3 times (loop detector,
 *       relaxed in §N2 from 6 chars / >2 occurrences to reduce false
 *       positives on legitimate short Thai words like "โครงการ" /
 *       "รัฐบาล" that naturally repeat in government summaries)
 *     - at least one Thai or English alphabetic character
 *   topic:
 *     - 3 < length ≤ 100
 *     - not empty / whitespace after trim
 *
 * Optional qualityScore (§N2):
 *   Callers may pass the 0–1 `scoreExtractionQuality()` result. When
 *   the score is < 0.5, the repeating-phrase (loop) detector is skipped
 *   entirely. Rationale: the upstream extraction-quality guard already
 *   rejects obviously-broken inputs, and the loop detector — tuned for
 *   clean GPT output — over-triggers on noisy OCR-derived summaries.
 *   Omitting the field, passing undefined, or passing a score ≥ 0.5
 *   leaves the loop detector engaged (backward-compatible default).
 *
 * On reject → service marks `ai_status = 'failed'` with reason
 * `LOW_AI_QUALITY: …`, and crucially does NOT persist aiSummary or
 * aiTopic (§T2 acceptance criterion).
 */

const ALPHA_RE = /[\u0E00-\u0E7FA-Za-z]/;

export type AiOutputValidationResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Detects whether any contiguous substring of length >= minLen occurs
 * more than `maxOccurrences` times in `text`.
 *
 * Implementation: sliding window over all length-minLen substrings,
 * tallied in a Map. Early-exit the moment one exceeds the cap.
 *
 * Complexity: O(n) where n = text length. Bounded because summaries
 * are capped at 800 chars by the existing Phase 1 redactor.
 */
function hasRepeatingPhrase(
  text: string,
  minLen: number,
  maxOccurrences: number,
): boolean {
  if (text.length < minLen * (maxOccurrences + 1)) return false;
  const counts = new Map<string, number>();
  for (let i = 0; i + minLen <= text.length; i++) {
    const sub = text.slice(i, i + minLen);
    const n = (counts.get(sub) ?? 0) + 1;
    if (n > maxOccurrences) return true;
    counts.set(sub, n);
  }
  return false;
}

/**
 * Validates the parsed AI payload.
 *
 * The shape is already enforced by OpenAI's `response_format` JSON
 * schema, so we only inspect the semantic content.
 */
export function validateAiOutput(input: {
  topic?: string | null;
  summary?: string | null;
  /**
   * Optional extraction quality score in [0, 1] from
   * `scoreExtractionQuality()`. When provided and < 0.5, the repeating-
   * phrase (loop) detector is skipped — the upstream quality guard
   * already rejected obviously-broken extractions, and the loop rule
   * over-triggers on noisy OCR-derived summaries.
   *
   * Omit / undefined / >= 0.5  → loop detector runs (relaxed thresholds).
   * < 0.5                      → loop detector skipped.
   * NaN / Infinity / non-number → treated as omitted (detector runs).
   */
  qualityScore?: number | null;
}): AiOutputValidationResult {
  const topic = (input.topic ?? '').toString();
  const summary = (input.summary ?? '').toString();

  // ---- topic ----
  const topicTrim = topic.trim();
  if (topicTrim.length <= 3) {
    return {
      ok: false,
      reason: `LOW_AI_QUALITY: topic too short (${topicTrim.length} chars)`,
    };
  }
  if (topicTrim.length > 100) {
    return {
      ok: false,
      reason: `LOW_AI_QUALITY: topic too long (${topicTrim.length} chars)`,
    };
  }

  // ---- summary length ----
  const summaryTrim = summary.trim();
  if (summaryTrim.length <= 20) {
    return {
      ok: false,
      reason: `LOW_AI_QUALITY: summary too short (${summaryTrim.length} chars)`,
    };
  }

  // ---- summary alpha presence ----
  if (!ALPHA_RE.test(summaryTrim)) {
    return {
      ok: false,
      reason: 'LOW_AI_QUALITY: summary has no Thai or English letters',
    };
  }

  // ---- summary repeat detector ----
  // §N2 relaxed thresholds: minLen raised from 6 → 8 chars (short Thai
  // words like "โครงการ" legitimately repeat), and maxOccurrences raised
  // from 2 → 3 (require ≥ 4 occurrences before flagging as a loop).
  //
  // §N2 skip-on-low-quality: if caller supplied a qualityScore < 0.5,
  // skip the loop detector entirely. The upstream extraction-quality
  // guard has already filtered genuinely broken extractions; running a
  // loop rule tuned for clean GPT output on noisy inputs produces
  // false positives that double-penalise borderline documents.
  const qs =
    typeof input.qualityScore === 'number' &&
    Number.isFinite(input.qualityScore)
      ? input.qualityScore
      : null;
  const runLoopCheck = qs === null || qs >= 0.5;

  if (runLoopCheck && hasRepeatingPhrase(summaryTrim, 8, 3)) {
    return {
      ok: false,
      reason:
        'LOW_AI_QUALITY: summary contains a repeating phrase (loop detected)',
    };
  }

  return { ok: true };
}
