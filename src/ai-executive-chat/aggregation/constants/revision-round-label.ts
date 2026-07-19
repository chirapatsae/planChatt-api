/**
 * Wave 58 W58-BE-AGG-01 — Canonical Thai labels for revision-round
 * grouping (Defect D4).
 *
 * Defect D4: revised + change rounds were merged into a single bucket in
 * the chat answer because the envelope projected only `revisionNumber`
 * and `revisionTypeName`. The DPR `description` was never read, so the
 * LLM had to compose its own heading and naturally collapsed the two
 * categories.
 *
 * Fix:
 *   - Project the parent DPR / Supplement `description` from the DB.
 *   - Pair it with a `revisionRoundType` discriminator so the LLM can
 *     emit separate ### Thai headings per type.
 *   - When `description` is empty/null, fall back to the static labels
 *     defined here. Static literal lookup → §17.9 compliance.
 *
 * §17.9 — fallback strings are static; the only interpolation is the
 * round number which is a numeric scalar from the DB.
 */

export const REVISION_ROUND_LABEL_MAIN = 'เล่มหลัก' as const;

/**
 * Resolve a revision-round label given the round type, the round number
 * and the optional DPR / Supplement description.
 *
 * Resolution order:
 *   1. Trimmed description if non-empty → use verbatim.
 *   2. Otherwise fall back to the static template by type:
 *        - `'edit'`        → `เล่มแก้ไขครั้งที่ N`
 *        - `'change'`      → `เล่มเปลี่ยนแปลงครั้งที่ N`
 *        - `'supplement'`  → `เล่มเพิ่มเติมครั้งที่ N`
 *        - `'main'`        → constant `เล่มหลัก` (number ignored)
 */
export type RevisionRoundType = 'main' | 'edit' | 'change' | 'supplement';

export function resolveRevisionRoundLabel(args: {
  type: RevisionRoundType;
  number: number | null | undefined;
  description: string | null | undefined;
}): string {
  const { type, number, description } = args;
  if (type === 'main') return REVISION_ROUND_LABEL_MAIN;
  const trimmed = typeof description === 'string' ? description.trim() : '';
  if (trimmed.length > 0) return trimmed;
  // Fallback templates — round number is a positive integer scalar.
  const n =
    number == null || !Number.isFinite(Number(number)) ? 1 : Number(number);
  switch (type) {
    case 'edit':
      return `เล่มแก้ไขครั้งที่ ${n}`;
    case 'change':
      return `เล่มเปลี่ยนแปลงครั้งที่ ${n}`;
    case 'supplement':
      return `เล่มเพิ่มเติมครั้งที่ ${n}`;
    default:
      return '';
  }
}

/**
 * Wave AI-EXEC-CHAT-BOOK-LABEL-DOUBLING-FIX (2026-07-18) — deterministic
 * book-label display normaliser for the roster / head-book envelopes.
 *
 * Problem: the label families are INCONSISTENT about the "เล่ม" prefix.
 *   - `REVISION_ROUND_LABEL_MAIN` = "เล่มหลัก"                (INCLUDES "เล่ม")
 *   - the fallback templates       = "เล่มแก้ไขครั้งที่ N" …    (INCLUDE "เล่ม")
 *   - a DPR/DPS `description` verbatim = "แก้ไข ครั้งที่ 1/2569" (NO "เล่ม")
 * The head-roster render templates used to prepend "เล่ม" themselves, which
 * doubled the prefix for the already-prefixed main label ("เล่มเล่มหลัก").
 *
 * `bookDisplayLabel` makes the label the LLM sees FULLY SELF-CONTAINED: it
 * prepends "เล่ม" only when the raw label does not already start with it, so
 * the render template can emit the value verbatim (no prepend) → doubling is
 * structurally impossible.
 *
 * Idempotent: `bookDisplayLabel(bookDisplayLabel(x)) === bookDisplayLabel(x)`.
 * Safe for BOTH label families (constant/fallback already-prefixed →
 * unchanged; description-verbatim → gains exactly one prefix). Empty / blank
 * input is returned unchanged (never produces a bare "เล่ม").
 *
 * NOTE — apply this ONLY at the roster / head-book envelope layer
 * (`listHeadRoster`, `getProjectHeadBook`, equipment `headRoster`). Do NOT
 * mutate `resolveRevisionRoundLabel` / `REVISION_ROUND_LABEL_MAIN` output:
 * timeline rule #59, `getPlanCatalogOverview` (BUG3 wave) and
 * `listDevelopmentPlanRevisions.roundLabel` consume those verbatim and must
 * keep the description-style ("แก้ไข ครั้งที่ 1/2569", no "เล่ม") labels.
 *
 * §17.9 — static literal prefix; no user-controlled interpolation.
 */
const BOOK_LABEL_PREFIX = 'เล่ม' as const;

export function bookDisplayLabel(rawLabel: string | null | undefined): string {
  const trimmed = typeof rawLabel === 'string' ? rawLabel.trim() : '';
  if (trimmed.length === 0) return '';
  return trimmed.startsWith(BOOK_LABEL_PREFIX)
    ? trimmed
    : `${BOOK_LABEL_PREFIX}${trimmed}`;
}

/**
 * Canonical W57 rule #26 disclosure copy used when an LAO-origin project
 * has a null `responsible_agency_id` FK. Static literal — must not be
 * derived from any user-controlled or DB-row text (§17.9). The exact
 * verbatim string is the contract; W58-BE-AGG-02 schema `.refine()`
 * defenders compare against it.
 */
export const PENDING_RESPONSIBLE_AGENCY_DISCLOSURE =
  'ยังไม่มีหน่วยงานรับผิดชอบ (รอ staff กำหนด)' as const;
