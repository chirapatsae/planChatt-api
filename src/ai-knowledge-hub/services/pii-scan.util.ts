/**
 * Wave wave-ai-knowledge-hub — BE-03 (2026-06-12).
 *
 * Automated PII pattern scan for external ingestion payloads (report §4
 * "Quarantine review"; CLAUDE.md §17.15.5 — "Thai 13-digit national ID,
 * phone, email patterns"; Q4 LOCKED: PII is CATEGORICALLY FORBIDDEN in
 * external data, so any flag BLOCKS promotion until the offending fields
 * are removed or masked).
 *
 * Pure functions — no Nest injection, no DB access, no logging of raw
 * matches. The recorded `sample` is ALWAYS masked (first 2 + last 2
 * characters) so the staging row's `pii_flags` column never re-stores the
 * PII it just flagged (STRIDE-I, report §6.1).
 *
 * Scope note: this is a deliberately pattern-based scan (same posture as
 * the §13 geo checks — a guardrail, not a verdict). False positives are
 * resolved by the reviewing admin masking/overriding the mapped fields at
 * promote time; false negatives remain covered by the 4-eyes human review
 * that promotion requires.
 */

export type PiiFlagType = 'thai_national_id' | 'phone' | 'email';

export interface PiiFlag {
  /** JSON-path-ish location of the offending string (`$.items[0].body`). */
  path: string;
  type: PiiFlagType;
  /** MASKED excerpt of the match — never the raw PII. */
  sample: string;
}

/** Mask all but the first/last 2 chars (`0812345678` → `08******78`). */
function mask(value: string): string {
  if (value.length <= 4) return '*'.repeat(value.length);
  return `${value.slice(0, 2)}${'*'.repeat(value.length - 4)}${value.slice(-2)}`;
}

/**
 * Ordered detector list. Thai national ID runs FIRST so a 13-digit run is
 * attributed to the ID detector, not partially to the phone detector
 * (both use digit-boundary lookarounds, so they never overlap anyway —
 * order just keeps attribution deterministic).
 */
const DETECTORS: ReadonlyArray<{ type: PiiFlagType; pattern: RegExp }> = [
  // เลขบัตรประชาชน 13 หลัก — plain run or the dashed display format.
  { type: 'thai_national_id', pattern: /(?<!\d)\d{13}(?!\d)/g },
  {
    type: 'thai_national_id',
    pattern: /(?<![\d-])\d-\d{4}-\d{5}-\d{2}-\d(?![\d-])/g,
  },
  // Thai phone — 0-leading 9/10-digit local or +66 international form.
  { type: 'phone', pattern: /(?<!\d)0\d{8,9}(?!\d)/g },
  { type: 'phone', pattern: /\+66\d{8,9}(?!\d)/g },
  // Email.
  {
    type: 'email',
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  },
];

/** Scan one string value; returns flags for every detector hit. */
export function scanStringForPii(value: string, path: string): PiiFlag[] {
  const flags: PiiFlag[] = [];
  for (const detector of DETECTORS) {
    // Fresh lastIndex per call — the shared RegExp objects carry the /g
    // flag, so reset before reuse.
    detector.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = detector.pattern.exec(value)) !== null) {
      flags.push({ path, type: detector.type, sample: mask(match[0]) });
    }
  }
  return flags;
}

/**
 * Recursively scan an arbitrary JSON value (object / array / string
 * leaves) for PII patterns. Depth-capped defensively — staging payloads
 * are schema-validated but external data is hostile by default (§17.9).
 */
export function scanForPii(
  value: unknown,
  basePath = '$',
  depth = 0,
): PiiFlag[] {
  if (depth > 16) return [];
  if (typeof value === 'string') {
    return scanStringForPii(value, basePath);
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      scanForPii(item, `${basePath}[${index}]`, depth + 1),
    );
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(
      ([key, child]) => scanForPii(child, `${basePath}.${key}`, depth + 1),
    );
  }
  return [];
}
