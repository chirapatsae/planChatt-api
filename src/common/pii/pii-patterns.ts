/**
 * pii-patterns.ts (SEC-W44-02)
 *
 * Pure regex library for PII detection.  Ported from the original
 * `document-analysis/utils/pii-redactor.ts` with three additions:
 *
 *   - Thai national-ID space-separated variant (OCR layout artifact)
 *   - `บ้านเลขที่` / `หมู่ที่` address fragments
 *   - Thai postal code (keyword-gated by `รหัสไปรษณีย์` to avoid 5-digit FP)
 *
 * Execution order matters: specific → generic.
 *   1. Thai national ID (dashed | spaced | bare)
 *   2. Thai phone (dashed | bare)
 *   3. Email
 *   4. Postal (keyword-gated)
 *   5. Address fragments (บ้านเลขที่, หมู่)
 *   6. Bank-account-style long digit run (10–14 digits)
 *
 * Replacement token: `[ข้อมูลส่วนบุคคล]`.
 *
 * Negative cases (intentionally NOT matched):
 *   - 4-digit years (e.g. "ปี 2567")
 *   - Short project IDs (≤ 9 digits)
 *   - Comma-grouped amounts (e.g. "9,000,000")
 *   - Bare "5 ล้านบาท" — the word ล้าน is not a digit run
 */

export const PII_MASK = '[ข้อมูลส่วนบุคคล]';

// ────────────────────────────────────────────────────────────────
// Thai national ID — three canonical shapes
// ────────────────────────────────────────────────────────────────

// Dashed: X-XXXX-XXXXX-XX-X  (1+4+5+2+1 = 13 digits)
export const RE_THAI_ID_DASHED = /\b\d-\d{4}-\d{5}-\d{2}-\d\b/g;

// Space-separated: `1 2345 67890 12 3` (OCR layout artifact)
export const RE_THAI_ID_SPACED = /\b\d\s\d{4}\s\d{5}\s\d{2}\s\d\b/g;

// Bare: exactly 13 consecutive digits
export const RE_THAI_ID_BARE = /\b\d{13}\b/g;

// ────────────────────────────────────────────────────────────────
// Thai phone numbers
// ────────────────────────────────────────────────────────────────

// Formatted: 0XX-XXX-XXXX / 0X-XXXX-XXXX (separators: '-' or space)
export const RE_THAI_PHONE_DASHED = /\b0\d{1,2}[-\s]\d{3,4}[-\s]\d{3,4}\b/g;

// Bare: 10 or 11 digits starting with 0
export const RE_THAI_PHONE_BARE = /\b0\d{8,9}\b/g;

// ────────────────────────────────────────────────────────────────
// Email
// ────────────────────────────────────────────────────────────────

export const RE_EMAIL = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;

// ────────────────────────────────────────────────────────────────
// Postal code — keyword-gated
//
// Matching an unconditional `\b\d{5}\b` would FP on many ordinary
// 5-digit numbers (years, reference IDs, amounts).  We require the
// keyword `รหัสไปรษณีย์` to precede the digits within ~8 chars.
// ────────────────────────────────────────────────────────────────

export const RE_THAI_POSTAL = /รหัสไปรษณีย์\s*:?\s*(\d{5})\b/g;

// ────────────────────────────────────────────────────────────────
// Address fragments — Thai free-text addresses
//
// These are deliberately aggressive — the body after the keyword is
// replaced up to the next punctuation or newline.  The field-policy
// layer is the primary defender; this regex is the belt-and-braces
// catch-all for free-text inputs (OCR'd letters, user prose).
// ────────────────────────────────────────────────────────────────

export const RE_THAI_ADDRESS = /(?:บ้านเลขที่|หมู่ที่|หมู่\s*\d+)[^\n,.;]{0,80}/g;

// ────────────────────────────────────────────────────────────────
// Bank-account / long digit run (10–14 digits)
// MUST run AFTER national-ID to avoid double-masking the 13-digit case.
// ────────────────────────────────────────────────────────────────

export const RE_BANK_ACCOUNT = /\b\d{10,14}\b/g;

// ────────────────────────────────────────────────────────────────
// Counted redaction — single source of truth for both the Nest
// service (common/pii) and the legacy util (document-analysis).
// ────────────────────────────────────────────────────────────────

export interface PiiRedactionCounts {
  thaiId: number;
  thaiPhone: number;
  email: number;
  longDigit: number;
  address: number;
  postal: number;
}

export function emptyCounts(): PiiRedactionCounts {
  return {
    thaiId: 0,
    thaiPhone: 0,
    email: 0,
    longDigit: 0,
    address: 0,
    postal: 0,
  };
}

function countMatches(input: string, re: RegExp): number {
  // Need a fresh regex for .match + /g safety across calls.
  const m = input.match(new RegExp(re.source, re.flags));
  return m ? m.length : 0;
}

/**
 * redactPiiWithCounts
 *
 * Single-pass redactor that returns both the redacted text and the
 * tally of matches per PII class.  Idempotent: text that already
 * contains `PII_MASK` is left unchanged for the portions already
 * masked (further PII in the same string is still redacted).
 */
export function redactPiiWithCounts(input: string | null | undefined): {
  output: string;
  counts: PiiRedactionCounts;
} {
  const counts = emptyCounts();
  if (!input) return { output: input ?? '', counts };

  let out = input;

  // 1. Thai national ID (specific → generic)
  counts.thaiId += countMatches(out, RE_THAI_ID_DASHED);
  out = out.replace(RE_THAI_ID_DASHED, PII_MASK);
  counts.thaiId += countMatches(out, RE_THAI_ID_SPACED);
  out = out.replace(RE_THAI_ID_SPACED, PII_MASK);
  counts.thaiId += countMatches(out, RE_THAI_ID_BARE);
  out = out.replace(RE_THAI_ID_BARE, PII_MASK);

  // 2. Thai phone
  counts.thaiPhone += countMatches(out, RE_THAI_PHONE_DASHED);
  out = out.replace(RE_THAI_PHONE_DASHED, PII_MASK);
  counts.thaiPhone += countMatches(out, RE_THAI_PHONE_BARE);
  out = out.replace(RE_THAI_PHONE_BARE, PII_MASK);

  // 3. Email
  counts.email += countMatches(out, RE_EMAIL);
  out = out.replace(RE_EMAIL, PII_MASK);

  // 4. Postal (keyword-gated — replace only the trailing 5 digits)
  counts.postal += countMatches(out, RE_THAI_POSTAL);
  out = out.replace(RE_THAI_POSTAL, `รหัสไปรษณีย์ ${PII_MASK}`);

  // 5. Address fragments
  counts.address += countMatches(out, RE_THAI_ADDRESS);
  out = out.replace(RE_THAI_ADDRESS, PII_MASK);

  // 6. Long digit run (bank-account heuristic)
  counts.longDigit += countMatches(out, RE_BANK_ACCOUNT);
  out = out.replace(RE_BANK_ACCOUNT, PII_MASK);

  return { output: out, counts };
}

/**
 * Legacy alias — preserves the pre-SEC-W44-02 import surface used by
 * `document-analysis/utils/pii-redactor.ts`.  New callers should use
 * `PiiRedactorService.redactText` for telemetry-instrumented redaction.
 */
export function redactPii(input: string): string {
  return redactPiiWithCounts(input).output;
}

export function addCounts(
  a: PiiRedactionCounts,
  b: PiiRedactionCounts,
): PiiRedactionCounts {
  return {
    thaiId: a.thaiId + b.thaiId,
    thaiPhone: a.thaiPhone + b.thaiPhone,
    email: a.email + b.email,
    longDigit: a.longDigit + b.longDigit,
    address: a.address + b.address,
    postal: a.postal + b.postal,
  };
}
