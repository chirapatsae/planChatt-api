/**
 * extraction-quality.ts — Phase 4 §T1
 *
 * Computes a deterministic 0.000–1.000 quality score for extracted text
 * (from PDF parse, DOCX, XLSX, PPTX, or OCR) and decides whether the
 * text is too low-quality to be worth sending to GPT-4o-mini.
 *
 * Rationale:
 *   Phase 2 enabled OCR fallback for scanned PDFs and images. OCR on
 *   low-DPI scans, photographed documents, or heavy watermarks often
 *   returns noise like `"|_. !@#$ ^^ \n :: 1l1l1 0o0o"` — which GPT
 *   then hallucinates a plausible-sounding Thai summary for. This
 *   module is the hard guard that fires BEFORE the OpenAI call so:
 *     (a) the user sees a clear `LOW_EXTRACTION_QUALITY` reason
 *     (b) we do not waste tokens / quota summarising garbage
 *     (c) the summary column is not polluted with hallucinations.
 *
 * Rejection rules (any one triggers):
 *   - readable-char ratio < 0.30
 *   - average whitespace-split word length < 2 OR > 20
 *   - no Thai AND no English alphabetic character present
 *
 * Score formula (monotonic, unit-testable):
 *   score =
 *       0.6  * readableRatio
 *     + 0.3  * alphaPresenceBonus   // 1 if any Thai/English alpha, else 0
 *     + 0.1  * wordLengthFit        // triangular, peak at 5 chars
 *
 * The score is clamped to [0, 1] and rounded to 3 decimals to match the
 * database column (NUMERIC(4,3)). It is also persisted on REJECT paths
 * so ops can diagnose false positives.
 *
 * CLAUDE.md interactions: §13 — advisory only; this module MUST NOT
 * throw. Garbage in → low score + failed marker; never a crash.
 */

const THAI_RE = /[\u0E00-\u0E7F]/;
const LATIN_ALPHA_RE = /[A-Za-z]/;

/**
 * Readable characters counted towards the ratio:
 *   - Thai script         U+0E00..U+0E7F
 *   - ASCII alphanumeric  A-Z a-z 0-9
 *   - Common punctuation  . , : ; ! ? ( ) / \ space newline tab -
 *
 * Everything else (control chars, CJK, box-drawing, replacement char,
 * stray zero-width, OCR noise like `|~^`) does NOT count as readable.
 */
const READABLE_RE =
  /[\u0E00-\u0E7FA-Za-z0-9.,:;!?()\/\\ \n\t\r\-]/;

/** Clamp to [0, 1]. */
function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/** Round to 3 decimals to match the NUMERIC(4,3) column. */
function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/**
 * Triangular fit around 5 chars; 0 outside [2, 20]; 1 at 5.
 */
function wordLengthFit(avgLen: number): number {
  if (!Number.isFinite(avgLen)) return 0;
  if (avgLen < 2 || avgLen > 20) return 0;
  if (avgLen <= 5) return clamp01((avgLen - 2) / 3); // 2 → 0, 5 → 1
  return clamp01((20 - avgLen) / 15); // 5 → 1, 20 → 0
}

export type ExtractionQualityResult =
  | { ok: true; score: number }
  | { ok: false; score: number; reason: string };

/**
 * Main entry. Returns a score in [0, 1] and an accept/reject decision.
 *
 * `ok: true`  → text passes all three hard-guard rules; proceed to AI.
 * `ok: false` → reject with reason; persist score + LOW_EXTRACTION_QUALITY.
 */
export function scoreExtractionQuality(
  rawText: string,
): ExtractionQualityResult {
  const text = (rawText ?? '').toString();

  // Empty string → zero score, not a crash.
  if (!text.trim()) {
    return {
      ok: false,
      score: 0,
      reason: 'LOW_EXTRACTION_QUALITY: empty text',
    };
  }

  // ---- Readable ratio ----------------------------------------------
  const total = text.length;
  let readable = 0;
  for (let i = 0; i < total; i++) {
    if (READABLE_RE.test(text[i])) readable += 1;
  }
  const readableRatio = total > 0 ? readable / total : 0;

  // ---- Alpha presence ---------------------------------------------
  const hasThai = THAI_RE.test(text);
  const hasLatin = LATIN_ALPHA_RE.test(text);
  const alphaPresence = hasThai || hasLatin ? 1 : 0;

  // ---- Average word length ----------------------------------------
  // Whitespace-split; drop empty tokens; ignore pure-punctuation tokens
  // so `"!!! ??? ..."` doesn't register as 3 real words of length 3.
  const words = text
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 0 && /[\u0E00-\u0E7FA-Za-z0-9]/.test(w));
  const avgLen =
    words.length === 0
      ? 0
      : words.reduce((s, w) => s + w.length, 0) / words.length;

  // ---- Score ------------------------------------------------------
  const score = round3(
    clamp01(
      0.6 * readableRatio +
        0.3 * alphaPresence +
        0.1 * wordLengthFit(avgLen),
    ),
  );

  // ---- Hard-guard rules (any triggers rejection) ------------------
  if (readableRatio < 0.3) {
    return {
      ok: false,
      score,
      reason: `LOW_EXTRACTION_QUALITY: readable ratio ${(
        readableRatio * 100
      ).toFixed(1)}% < 30%`,
    };
  }
  if (words.length === 0 || avgLen < 2 || avgLen > 20) {
    return {
      ok: false,
      score,
      reason: `LOW_EXTRACTION_QUALITY: avg word length ${avgLen.toFixed(
        2,
      )} outside [2, 20]`,
    };
  }
  if (!hasThai && !hasLatin) {
    return {
      ok: false,
      score,
      reason:
        'LOW_EXTRACTION_QUALITY: no Thai or English alphabetic character detected',
    };
  }

  return { ok: true, score };
}
