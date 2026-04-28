/**
 * Wave 59 W59-BE-AGG-01 (D-B) — `objective` truncation at source.
 *
 * The `ProjectGroup` / `RevisedProjectGroup` / `SupplementProjectGroup`
 * `objective` column is free-form Thai prose authored by users. The
 * Executive Chat envelope ships it so the LLM can answer "วัตถุประสงค์
 * ของโครงการนี้คือ ...". To bound the prompt-injection surface
 * (CLAUDE.md §17.9) and keep the tool-result envelope size predictable
 * we truncate the raw column at this hard cap BEFORE the value is
 * folded into the `<<<TOOL_RESULT>>>` boundary.
 *
 * The LLM's render-side rule (W59-BE-PROMPT-01 #27f) further trims
 * to ~200 chars in chat output and shows an "[ขยาย]" affordance — but
 * that downstream UI step CANNOT recover bytes the envelope has already
 * truncated. The 500-char cap therefore is the upper-bound budget for
 * any future "expand objective" feature; raising it requires a
 * re-evaluation of the §17.9 injection-surface trade-off.
 *
 * @see docs/tasks/wave59/W59-BE-AGG-01.md §3.2
 * @see CLAUDE.md §17.9 — prompt-injection defense
 */

export const OBJECTIVE_HARD_CAP = 500;

export interface TruncatedObjective {
  text: string | null;
  truncated: boolean;
}

/**
 * Truncate a raw `objective` value at `OBJECTIVE_HARD_CAP` characters.
 *
 * Contract:
 *   - `null` / `undefined` / empty / whitespace-only → `{text: null,
 *     truncated: false}`. The LLM treats null as "no objective recorded".
 *   - Length ≤ cap → `{text: <as-is>, truncated: false}`.
 *   - Length > cap → `{text: <first cap chars>, truncated: true}`.
 *     A LENGTH OF EXACTLY `OBJECTIVE_HARD_CAP` IS NOT TRUNCATED.
 *
 * Truncation is byte-naive (JS string length = UTF-16 code units).
 * Thai characters above the BMP are exceedingly rare in practice and
 * §17.9 prefers the simpler bound; downstream the LLM never sees the
 * raw bytes anyway.
 */
export function truncateObjective(
  raw: string | null | undefined,
): TruncatedObjective {
  if (raw == null) return { text: null, truncated: false };
  const s = String(raw);
  if (s.trim().length === 0) return { text: null, truncated: false };
  if (s.length <= OBJECTIVE_HARD_CAP) {
    return { text: s, truncated: false };
  }
  return { text: s.slice(0, OBJECTIVE_HARD_CAP), truncated: true };
}
