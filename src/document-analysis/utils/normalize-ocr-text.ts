/**
 * normalize-ocr-text.ts — SCANNED_PDF_SUMMARY_HARDENING §N1
 *
 * Pure-TypeScript normalizer for OCR-extracted text. Consumed upstream of
 * `smartTruncate()` in `document-analysis.service.ts` (wiring happens in
 * §N3). The goal is to strip the three classes of OCR noise that feed
 * false positives into the downstream `ai-output-validator.ts`
 * loop-detector:
 *
 *   1. Consecutive duplicate lines
 *      Per-page headers/footers repeat on every OCR'd page
 *      (e.g., "หน้า 1/10", ministry letterhead lines).
 *
 *   2. Doc-wide boilerplate
 *      Any line whose trimmed, case-insensitive key appears
 *      ≥ `boilerplateDocWideMinOccurrences` times across the entire
 *      document is dropped in ALL its occurrences. Headers repeat
 *      meaningfully in OCR noise but carry no summary value; the
 *      canonical title usually appears elsewhere too.
 *
 *   3. Intra-line token runs
 *      The same whitespace-separated token repeating
 *      ≥ `intraLineTokenRunThreshold` times in a row within a single
 *      line collapses to a single token (OCR jitter on a low-confidence
 *      region).
 *
 * Contract:
 *   - Accepts any input (string, null, undefined, non-string) and returns
 *     a string. NEVER throws.
 *   - Deterministic and idempotent: normalize(normalize(x)) === normalize(x).
 *   - No external dependencies, no I/O, no logging, no async.
 *   - O(n) in input length (n ≤ 30 000 per the existing MAX_EXTRACTED_CHARS
 *     safety net). Uses simple `split(/\s+/)` and `split('\n')` — no regex
 *     catastrophic backtracking.
 *
 * Legitimate content protection:
 *   - Short lines (length < `minLineLengthForBoilerplate`) are NEVER
 *     dropped even if they repeat — preserves "ข้อ 1" / "-" / "ฯ" type
 *     dividers and numbering.
 *   - Keys are compared via trim + lowercase; no Unicode NFC/NFD
 *     normalization is applied (no-op for Thai script, cheap for Latin).
 *   - Distinct-content lines that happen to start with the same Thai word
 *     (e.g., "โครงการ ก", "โครงการ ข", "โครงการ ค") are NOT collapsed —
 *     keys differ.
 *
 * Defaults:
 *   boilerplateDocWideMinOccurrences = 4
 *   consecutiveDuplicateLineThreshold = 2
 *   intraLineTokenRunThreshold = 3
 *   minLineLengthForBoilerplate = 4
 */

export interface NormalizeOcrOptions {
  /**
   * Minimum occurrence count across ALL lines of the document above which
   * a line is considered boilerplate and dropped. Default: 4.
   * Comparison is case-insensitive and trimmed.
   */
  boilerplateDocWideMinOccurrences?: number;

  /**
   * Minimum number of consecutive identical lines to collapse into one.
   * Default: 2 (two in a row → one).
   */
  consecutiveDuplicateLineThreshold?: number;

  /**
   * Minimum run length for intra-line whitespace-separated repeating
   * tokens to collapse. Default: 3 (e.g., "ฯ ฯ ฯ ฯ" → "ฯ").
   */
  intraLineTokenRunThreshold?: number;

  /**
   * Minimum line length (after trim) to be eligible for boilerplate
   * dropping. Shorter lines are NEVER dropped even if they repeat —
   * protects "ข้อ 1" / "-" / "ฯ" type dividers that legitimately repeat
   * but carry structural meaning. Default: 4.
   */
  minLineLengthForBoilerplate?: number;
}

const DEFAULTS = Object.freeze({
  boilerplateDocWideMinOccurrences: 4,
  consecutiveDuplicateLineThreshold: 2,
  intraLineTokenRunThreshold: 3,
  minLineLengthForBoilerplate: 4,
});

/**
 * Collapse intra-line runs of an identical whitespace-separated token of
 * length ≥ `threshold` down to a single token. Whitespace separators are
 * normalized to a single ASCII space (consistent with OCR output).
 *
 * Single-token lines cannot trigger a run (only one token present), so
 * pathological no-whitespace glue lines pass through unchanged.
 */
function collapseIntraLineTokenRuns(line: string, threshold: number): string {
  if (!line) return line;
  // split on any whitespace; drop empties produced by leading/trailing WS
  const tokens = line.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length < threshold) return line;

  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    let j = i + 1;
    while (j < tokens.length && tokens[j] === tokens[i]) j++;
    const runLen = j - i;
    if (runLen >= threshold) {
      // collapse the whole run down to a single token
      out.push(tokens[i]);
    } else {
      for (let k = i; k < j; k++) out.push(tokens[k]);
    }
    i = j;
  }
  return out.join(' ');
}

/**
 * Compute the comparison key for a line: trimmed + lowercased. Thai
 * script is unaffected by `toLowerCase`; the call is safe and cheap.
 */
function lineKey(line: string): string {
  return line.trim().toLowerCase();
}

/**
 * Main entry.
 *
 * Steps (see file header for rationale):
 *   1. Defensive coerce: null/undefined/non-string → ''.
 *   2. Normalize line endings (`\r\n` → `\n`, stray `\r` → `\n`).
 *   3. Intra-line token-run collapse per line.
 *   4. Consecutive duplicate line collapse (blank lines collapse to one).
 *   5. Doc-wide boilerplate drop (freq ≥ threshold AND key length ≥ min).
 *   6. Join with `\n` and trim trailing whitespace.
 *
 * Non-throw guard: the entire body is wrapped in try/catch; on any
 * unexpected error the function falls back to a safe pass-through so the
 * fire-and-forget Document Analysis pipeline cannot crash.
 */
export function normalizeOcrText(
  input: string,
  options?: NormalizeOcrOptions,
): string {
  try {
    // ---- 1. Coerce -----------------------------------------------------
    if (input === null || input === undefined) return '';
    const raw =
      typeof input === 'string' ? input : (input as unknown as object).toString();
    if (!raw) return '';
    if (!raw.trim()) return '';

    const {
      boilerplateDocWideMinOccurrences = DEFAULTS.boilerplateDocWideMinOccurrences,
      consecutiveDuplicateLineThreshold = DEFAULTS.consecutiveDuplicateLineThreshold,
      intraLineTokenRunThreshold = DEFAULTS.intraLineTokenRunThreshold,
      minLineLengthForBoilerplate = DEFAULTS.minLineLengthForBoilerplate,
    } = options ?? {};

    // ---- 2. Normalize line endings ------------------------------------
    const unified = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const rawLines = unified.split('\n');

    // ---- 3. Intra-line token-run collapse -----------------------------
    const tokenCollapsed = rawLines.map((ln) =>
      collapseIntraLineTokenRuns(ln, intraLineTokenRunThreshold),
    );

    // ---- 4. Consecutive duplicate line collapse -----------------------
    //   - A run of length ≥ `consecutiveDuplicateLineThreshold` of the
    //     same key collapses to ONE occurrence of that line.
    //   - Empty / blank keys (runs of blank lines) collapse to a single
    //     blank line regardless of threshold (OCR page-break noise).
    const consecutiveCollapsed: string[] = [];
    {
      let i = 0;
      while (i < tokenCollapsed.length) {
        const key = lineKey(tokenCollapsed[i]);
        let j = i + 1;
        while (j < tokenCollapsed.length && lineKey(tokenCollapsed[j]) === key) {
          j++;
        }
        const runLen = j - i;
        if (key.length === 0) {
          // run of blanks → one blank
          consecutiveCollapsed.push('');
        } else if (runLen >= consecutiveDuplicateLineThreshold) {
          // collapse the whole run to a single occurrence
          consecutiveCollapsed.push(tokenCollapsed[i]);
        } else {
          for (let k = i; k < j; k++) consecutiveCollapsed.push(tokenCollapsed[k]);
        }
        i = j;
      }
    }

    // ---- 5. Doc-wide boilerplate drop ---------------------------------
    //   - Count key frequencies across the (already consecutive-collapsed)
    //     lines.
    //   - A key qualifies for dropping iff:
    //       freq >= boilerplateDocWideMinOccurrences
    //       AND key.length >= minLineLengthForBoilerplate
    //   - Blank keys are ignored for the frequency check (they are
    //     already normalized in step 4).
    const freq = new Map<string, number>();
    for (const ln of consecutiveCollapsed) {
      const k = lineKey(ln);
      if (k.length === 0) continue;
      freq.set(k, (freq.get(k) ?? 0) + 1);
    }
    const dropSet = new Set<string>();
    for (const [k, n] of freq) {
      if (
        n >= boilerplateDocWideMinOccurrences &&
        k.length >= minLineLengthForBoilerplate
      ) {
        dropSet.add(k);
      }
    }

    const kept: string[] = [];
    for (const ln of consecutiveCollapsed) {
      const k = lineKey(ln);
      if (k.length > 0 && dropSet.has(k)) continue;
      kept.push(ln);
    }

    // ---- 5b. Re-collapse blank runs created by step 5 -----------------
    //   Dropping boilerplate can leave adjacent blanks; squash to one.
    const squashed: string[] = [];
    for (const ln of kept) {
      if (
        ln.trim().length === 0 &&
        squashed.length > 0 &&
        squashed[squashed.length - 1].trim().length === 0
      ) {
        continue;
      }
      squashed.push(ln);
    }

    // ---- 6. Join + trim -----------------------------------------------
    return squashed.join('\n').trim();
  } catch {
    // Non-throw contract: pass through on unexpected failure.
    try {
      if (input === null || input === undefined) return '';
      return typeof input === 'string' ? input : String(input);
    } catch {
      return '';
    }
  }
}

export const NORMALIZE_OCR_DEFAULTS = DEFAULTS;
