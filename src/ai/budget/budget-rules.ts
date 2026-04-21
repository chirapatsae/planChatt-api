/**
 * Wave 34 N1 — LAO-type-aware AI GENERATE budget floor rules.
 *
 * Architecture: belt-and-braces.
 *   Layer 1 (prompt) — `buildIssueBasedPrompt` / `buildStrategyBasedPrompt`
 *     emit a Thai clause asking the LLM for a budget "not less than
 *     {floor}" when a floor is resolvable for the caller's LAO type.
 *   Layer 2 (defensive clamp) — `ai.controller.ts` parses the raw
 *     budget string with `parseBudgetString`, then unconditionally
 *     applies `clampBudget(parsed, floor)`. Even when the LLM
 *     complies with Layer 1, Layer 2 still runs; this mirrors the
 *     Wave 30 / 33.6 "deterministic wins over LLM" discipline.
 *
 * Scope (§16 + §17 compatibility):
 *   - Only LAO users with a recognised `type` get a floor. Agency
 *     callers (and unrecognised values) get `null`, which means:
 *       • no prompt clause is emitted (byte-identical prompt)
 *       • envelope emits `budget: null` (FE hides the card)
 *   - §17.2 advisory — the budget is a primary form field, NOT a
 *     workflow gate. Workflow transitions are unaffected.
 *   - §17.3 — no persistence inside this module; no FK to project
 *     tables; no tracking_status writes.
 *   - §17.11 no role exemption — floor is the same for every user of
 *     a given LAO type regardless of role.
 *
 * Adding a new LAO type: append to `BUDGET_FLOOR_BY_LAO_TYPE` below.
 * No caller-site change is required — `resolveBudgetFloor` does an
 * exact-match lookup on the trimmed Thai string.
 *
 * NOTE on unmapped types (out of scope for Wave 34):
 *   - อบจ. (provincial administration)
 *   - เมืองพัทยา (special administrative area)
 * These MUST fall through to `null` until explicitly added.
 */

export interface BudgetRule {
  /** Thai label as it appears on `LocalAdministrativeOrganization.type`. */
  typeLabel: string;
  /** Integer baht — lower bound; LLM output and FE form must not go below. */
  floor: number;
}

/**
 * Frozen registry of LAO-type → budget floor. Keys MUST match the Thai
 * strings stored on `LocalAdministrativeOrganization.type`.
 *
 * Includes both the full name `องค์การบริหารส่วนตำบล` AND the short form
 * `อบต.` — production data uses both.
 */
export const BUDGET_FLOOR_BY_LAO_TYPE: Readonly<Record<string, number>> =
  Object.freeze({
    'องค์การบริหารส่วนตำบล': 1_000_000,
    'อบต.': 1_000_000,
    'เทศบาลตำบล': 1_000_000,
    'เทศบาลเมือง': 2_000_000,
    'เทศบาลนคร': 2_000_000,
  });

/**
 * Returns the budget floor for a given LAO type label, or null when:
 *   - type is undefined / null / empty / whitespace-only
 *   - type is not a recognised LAO type (agency users / unknown)
 *
 * Null means "no floor enforcement" — the prompt clause is skipped AND
 * the controller emits `budget: null` on the envelope.
 *
 * Normalization: NFC + trim. No case folding (Thai is case-insensitive
 * and the registry is whitespace-exact).
 */
export function resolveBudgetFloor(
  type: string | null | undefined,
): number | null {
  if (!type) return null;
  const normalized = String(type).normalize('NFC').trim();
  if (normalized.length === 0) return null;
  const hit = BUDGET_FLOOR_BY_LAO_TYPE[normalized];
  return typeof hit === 'number' ? hit : null;
}

/**
 * Defensive parser for the LLM's budget output. Handles:
 *   - "1500000"                → 1_500_000
 *   - "1,500,000"              → 1_500_000
 *   - "1,500,000 บาท"          → 1_500_000
 *   - "1,500,000.00"           → 1_500_000
 *   - "ประมาณ 1,500,000 บาท"   → 1_500_000
 *   - "1.5 ล้านบาท"            → 1_500_000 (best-effort: "ล้าน" suffix)
 *   - "๑,๕๐๐,๐๐๐"              → 1_500_000 (Thai numerals)
 *   - non-numeric / missing    → null
 *
 * Returns null when nothing parseable is found. Rounded to the nearest
 * integer; negative and zero values are rejected (return null).
 */
export function parseBudgetString(
  raw: string | null | undefined,
): number | null {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (s.length === 0) return null;

  // Normalize Thai numerals ๐-๙ (U+0E50..U+0E59) to ASCII 0-9.
  s = Array.from(s)
    .map((ch) => {
      const code = ch.charCodeAt(0);
      if (code >= 0x0e50 && code <= 0x0e59) return String(code - 0x0e50);
      return ch;
    })
    .join('');

  // Detect "ล้าน" suffix (millions). Accept an optional comma/decimal
  // number before "ล้าน" — e.g. "1.5 ล้าน", "2 ล้าน", "1,500 ล้าน".
  const millionMatch = s.match(/([\d,\.]+)\s*ล้าน/);
  if (millionMatch && millionMatch[1]) {
    const n = Number(millionMatch[1].replace(/,/g, ''));
    if (Number.isFinite(n) && n > 0) {
      return Math.round(n * 1_000_000);
    }
  }

  // Strip common unit suffix, commas, spaces, and any non-digit/non-
  // decimal character.
  s = s.replace(/บาท/g, '');
  s = s.replace(/[^\d\.\-]/g, '');
  if (s.length === 0) return null;

  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

/**
 * Clamps the parsed budget to the floor. Returns `Math.max(parsed, floor)`.
 *
 * Semantics:
 *   - `parsed === null`        → return `null` (nothing to clamp, FE hides card)
 *   - `floor === null`         → return `parsed` (no floor enforcement)
 *   - both present             → return `Math.max(parsed, floor)`
 *
 * Runs UNCONDITIONALLY at the controller — even when the prompt clause
 * already told the LLM the floor. §17.9 deterministic-wins discipline:
 * NEVER trust the LLM for floor compliance.
 */
export function clampBudget(
  parsed: number | null,
  floor: number | null,
): number | null {
  if (parsed === null) return null;
  if (floor === null) return parsed;
  return Math.max(parsed, floor);
}
