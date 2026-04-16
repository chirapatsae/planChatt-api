/**
 * pii-redactor.ts
 *
 * Server-side post-processing for AI-produced `topic` + `summary` text.
 *
 * Contract (see docs/tasks/DOCUMENT_ANALYSIS_PHASE1_FOUNDATION.md §3.2):
 *   - Mask Thai national ID (13 consecutive digits, with or without dashes)
 *   - Mask Thai phone numbers (10-digit 0-prefixed, optional separators)
 *   - Mask email addresses
 *   - Mask long digit runs (10–14 digits) as a bank-account heuristic —
 *     run AFTER the national-ID pass so the 13-digit case is already consumed
 *
 * Negative cases (intentionally NOT matched):
 *   - 4-digit years (e.g., "ปี 2567")
 *   - short project IDs / reference numbers (≤ 9 digits)
 *   - comma-grouped amounts (e.g., "9,000,000") — the commas break the \d runs
 *
 * Replacement token: `[ข้อมูลส่วนบุคคล]`.
 *
 * Execution order matters: specific → generic.
 *   1. Thai national ID with dashes
 *   2. Thai national ID bare (13 digits)
 *   3. Thai phone (0-prefixed)
 *   4. Email
 *   5. Bank account run (10–14 digits fallback)
 *
 * Pure function; safe to unit-test in isolation.
 */

const MASK = '[ข้อมูลส่วนบุคคล]';

// Dashed Thai national ID: X-XXXX-XXXXX-XX-X  (1+4+5+2+1 = 13 digits)
const RE_THAI_ID_DASHED = /\b\d-\d{4}-\d{5}-\d{2}-\d\b/g;

// Bare Thai national ID: exactly 13 consecutive digits
const RE_THAI_ID_BARE = /\b\d{13}\b/g;

// Thai phone number:
//   - 10 or 11 digits starting with 0 (bare)
//   - or 0XX-XXX-XXXX / 0X-XXXX-XXXX style (separators: `-` or space)
const RE_THAI_PHONE_DASHED = /\b0\d{1,2}[-\s]\d{3,4}[-\s]\d{3,4}\b/g;
const RE_THAI_PHONE_BARE = /\b0\d{8,9}\b/g;

// Email: conservative
const RE_EMAIL = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;

// Bank-account-style long digit runs (10–14 digits).
// MUST run AFTER national ID to avoid double-masking (the 13-digit case).
const RE_BANK_ACCOUNT = /\b\d{10,14}\b/g;

/**
 * redactPii
 *
 * @param input Arbitrary free-form text from the AI response.
 * @returns Same text with PII patterns replaced by `[ข้อมูลส่วนบุคคล]`.
 */
export function redactPii(input: string): string {
  if (!input) return input;

  let out = input;
  out = out.replace(RE_THAI_ID_DASHED, MASK);
  out = out.replace(RE_THAI_ID_BARE, MASK);
  out = out.replace(RE_THAI_PHONE_DASHED, MASK);
  out = out.replace(RE_THAI_PHONE_BARE, MASK);
  out = out.replace(RE_EMAIL, MASK);
  out = out.replace(RE_BANK_ACCOUNT, MASK);
  return out;
}

export const PII_MASK = MASK;
