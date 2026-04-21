/**
 * Wave 31 N1 — Briefing output sanitizer.
 *
 * Server-side safety net that runs on LLM-generated Thai prose BEFORE it is
 * returned to the FE. Strips three classes of prompt-structure leaks:
 *
 *   1. Bracketed section markers (e.g. `[GEO_GROUND_TRUTH]`, `[CRITERIA]`,
 *      `[CONFLICT_ASSESSMENT]`, `[RULES]`, `[SUB_TYPE_SCOPE]`,
 *      `[OUTPUT_HYGIENE]`, `[END_GEO_GROUND_TRUTH]`, ...).
 *   2. Raw criterion IDs from the Wave 24 registry (`C4_1to4.b`, `C3_1.a`,
 *      etc.) echoed verbatim instead of their Thai `label`.
 *   3. (Wave 31 hotfix) Raw sub-type codes preceded by the keywords
 *      `sub-type` / `subtype` / `ประเภทย่อย` (e.g. "sub-type 4.1",
 *      "ประเภทย่อย 3.1.1") — replaced with the Thai `label` of the
 *      matching registry entry.
 *
 * Advisory per CLAUDE.md §17.2 — pure text normalization; does NOT gate
 * workflow transitions, does NOT mutate prompts, does NOT persist.
 *
 * §17.3 — no FK, no persistence. Pure function.
 * §17.9 — operates on LLM OUTPUT only. User input MUST NOT pass through
 *         this module.
 * §17.11 — no role exemption. Every response runs through this sanitizer.
 *
 * Registry usage (Wave 24) — imports `NAKHON_RATCHASIMA_ISSUE_RULES`
 * read-only and builds a frozen id → label map at module-init time. The
 * registry file itself is NOT modified.
 */
import { NAKHON_RATCHASIMA_ISSUE_RULES } from './criteria/nakhon-ratchasima-issue-rules';

/**
 * Frozen criterion-id → Thai-label map derived from the Wave 24 registry.
 * 21 entries (3 / 3 / 3 / 5 / 4 / 3 across the 6 issue-rule entries).
 */
export const CRITERION_TITLE_MAP: Readonly<Record<string, string>> =
  Object.freeze(
    NAKHON_RATCHASIMA_ISSUE_RULES.flatMap((entry) => entry.criteria).reduce<
      Record<string, string>
    >((acc, criterion) => {
      acc[criterion.id] = criterion.label;
      return acc;
    }, {}),
  );

/**
 * Pass A — bracketed uppercase-ASCII section markers.
 *
 * Matches `[A]` / `[AB]` / `[A_B]` / `[END_XYZ]` / `[GEO_GROUND_TRUTH]` etc.
 * Uppercase-ASCII-only class guarantees zero false-positive on Thai text
 * (Thai code points never satisfy `[A-Z]`).
 *
 * `[A-Z]` head + `[A-Z0-9_]*` tail allows single-letter markers like `[A]`
 * to be stripped as well; registry markers are always 2+ chars but the
 * broader pattern is defensive against future prompt additions.
 */
const BRACKETED_MARKER = /\[[A-Z][A-Z0-9_]*\]/g;

/**
 * Frozen sub-type-code → Thai-label map derived from the Wave 24 registry.
 *
 * Wave 31 hotfix. ~19 entries across the 6 issue-rule entries
 * (2 + 5 + 5 + 1 + 4 + 2). Built by flattening every `subTypes[]` array
 * from `NAKHON_RATCHASIMA_ISSUE_RULES`. The registry file itself is NOT
 * modified.
 */
export const SUBTYPE_TITLE_MAP: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>();
  for (const entry of NAKHON_RATCHASIMA_ISSUE_RULES) {
    for (const st of entry.subTypes) {
      m.set(st.code, st.label);
    }
  }
  return m;
})();

/**
 * Pass B2 — sub-type prefix phrase pattern (Wave 31 hotfix).
 *
 * Matches ONLY when an English or Thai sub-type keyword prefixes the
 * numeric code. This anchor is critical — it prevents bare decimals in
 * legitimate prose (budget figures like `1.5 ล้าน`, percentages like
 * `30.5 เปอร์เซ็นต์`) from being clobbered.
 *
 * Supported prefix tokens (case-insensitive):
 *   - `sub-type`   (English with hyphen)
 *   - `sub_type`   (English with underscore)
 *   - `sub type`   (English with space)
 *   - `subtype`    (English concatenated)
 *   - `ประเภทย่อย` (Thai)
 *
 * Capture group 1 = numeric code: `\d+(\.\d+){1,2}`
 *   - 2-part: `1.1`, `2.3`, `4.1`
 *   - 3-part: `3.1.1`, `3.1.5`, `3.2.1`
 *
 * Trailing `\b` is ASCII-aware; Thai code points never extend an ASCII
 * digit match, so `4.1การ...` does NOT accidentally inflate the code.
 */
const SUBTYPE_PREFIX_PHRASE =
  /(?:sub[-_\s]?type|subtype|ประเภทย่อย)[\s:]*(\d+(?:\.\d+){1,2})\b/gi;

/**
 * Pass B — criterion-id pattern (with optional Thai-prefix absorption).
 *
 * Matches:
 *   C1.a  C1.b  C1.c
 *   C2.a  C2.b  C2.c
 *   C3_1.a  C3_1.b  C3_1.c
 *   C3_2.a  C3_2.b  C3_2.c  C3_2.d  C3_2.e
 *   C4_1to4.a  C4_1to4.b  C4_1to4.c  C4_1to4.d
 *   C4_5to6.a  C4_5to6.b  C4_5to6.d
 *
 * Word-boundary guarded; `\b` is ASCII-aware; Thai text never produces
 * an accidental match since Thai code points are not ASCII word chars.
 *
 * Wave 31 hotfix follow-up: absorbs an OPTIONAL leading Thai "เกณฑ์" /
 * "เกณฑ์ที่" prefix (with optional whitespace) so that replacing with
 * "เกณฑ์{title}" does NOT double the word when the LLM already wrote
 * "เกณฑ์ C4_1to4.b" in source text. Capture group 1 is the bare id.
 */
const CRITERION_ID = /(?:เกณฑ์(?:ที่)?\s*)?\b(C\d+(?:_\d+(?:to\d+)?)?\.[a-z])\b/g;

export interface SanitizeBriefingOpts {
  /**
   * When `true`, skip Pass B (criterion-id replacement). Reserved for
   * future structured outputs that legitimately need to surface raw IDs.
   * Pass A and Pass C still run.
   */
  preserveCriterionIds?: boolean;
  /**
   * When `true`, skip Pass B2 (sub-type prefix phrase replacement).
   * Reserved for future structured outputs that legitimately need to
   * surface raw sub-type codes. Pass A / B / C still run. Wave 31
   * hotfix mirror of `preserveCriterionIds`.
   */
  preserveSubtypeCodes?: boolean;
}

/**
 * Sanitize an LLM-authored Thai prose string.
 *
 * Null-safety contract:
 *   - `null` / `undefined` / non-string → returns `''`
 *   - empty string → returns `''`
 *   - never throws
 *
 * Idempotence: running the sanitizer twice on the same input yields the
 * same output. Running it on marker-free / id-free text is a pure
 * whitespace normalization. This makes it safe to apply on BOTH
 * STRATEGY_BASED and ISSUE_BASED envelopes without byte-drift on clean
 * STRATEGY outputs.
 */
export function sanitizeBriefingText(
  text: string | null | undefined,
  opts?: SanitizeBriefingOpts,
): string {
  if (text === null || text === undefined) return '';
  if (typeof text !== 'string') return '';
  if (text.length === 0) return '';

  let out = text;

  // Pass A — strip bracketed section markers.
  out = out.replace(BRACKETED_MARKER, '');

  // Pass B — replace criterion IDs with Thai titles. Absorbs optional
  // leading "เกณฑ์" / "เกณฑ์ที่" prefix so the replacement doesn't
  // produce a double-word (Wave 31 hotfix follow-up).
  if (!opts?.preserveCriterionIds) {
    out = out.replace(CRITERION_ID, (_match, id: string) => {
      const title = CRITERION_TITLE_MAP[id];
      if (title) return `เกณฑ์${title}`;
      // Defensive fallback — never leave a raw ID visible even if the
      // registry is updated without updating this file.
      return 'เกณฑ์ที่เกี่ยวข้อง';
    });
  }

  // Pass B2 — replace sub-type prefix phrases with Thai labels (Wave 31
  // hotfix). Runs AFTER Pass B so criterion-id replacements never collide
  // with sub-type code matching. The regex is anchored to a prefix
  // keyword, so bare decimals in user-facing prose (budget figures,
  // percentages, population counts) are NOT affected.
  if (!opts?.preserveSubtypeCodes) {
    out = out.replace(SUBTYPE_PREFIX_PHRASE, (_match, code: string) => {
      const title = SUBTYPE_TITLE_MAP.get(code);
      if (title) return `ประเภทย่อย${title}`;
      // Defensive fallback — never leave a raw code visible even if the
      // registry is updated without updating this file.
      return 'ประเภทย่อยที่เกี่ยวข้อง';
    });
  }

  // Pass C — whitespace / punctuation cleanup.
  // 1. Collapse double commas with optional spaces: ", ," → ","
  out = out.replace(/,+(?:\s*,+)+/g, ',');
  // 2. Strip whitespace immediately before ASCII punctuation.
  out = out.replace(/\s+([,.;:!?])/g, '$1');
  // 3. Collapse runs of ASCII whitespace to a single space.
  out = out.replace(/[ \t]{2,}/g, ' ');
  // 4. Collapse runs of spaces around newlines (preserve newline itself).
  out = out.replace(/[ \t]*\n[ \t]*/g, '\n');
  // 5. Trim leading / trailing whitespace.
  out = out.trim();

  return out;
}
