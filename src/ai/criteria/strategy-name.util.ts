/**
 * Strategy-name normalization helpers for the
 * `findAllByStrategyName` resolver (Wave LAO issue/strategy parity).
 *
 * Pure functions — no I/O, no DB, no side effects. Exported as a
 * sibling file from `issue-criteria-registry.service.ts` so each helper
 * is independently unit-testable.
 *
 * Goal: resolve a `Strategy.name` (e.g. "ยุทธศาสตร์ด้านการพัฒนาเศรษฐกิจ")
 * to the canonical "ด้าน..." root used by `IssueRuleEntry.issueDisplayName`
 * after applying Thai-spelling normalization.
 *
 * Advisory-only per CLAUDE.md §17.2 — these helpers feed an advisory
 * UI panel, never a workflow gate.
 */

/**
 * Removes the leading "ยุทธศาสตร์" token from a Strategy name and
 * trims surrounding whitespace. Idempotent on already-stripped input.
 *
 * Examples:
 *   "ยุทธศาสตร์ด้านการพัฒนาเศรษฐกิจ"   → "ด้านการพัฒนาเศรษฐกิจ"
 *   "ยุทธศาสตร์ ด้านการพัฒนาเศรษฐกิจ"  → "ด้านการพัฒนาเศรษฐกิจ"
 *   "ด้านการพัฒนาเศรษฐกิจ"             → "ด้านการพัฒนาเศรษฐกิจ"
 */
export function extractStrategyRoot(name: string): string {
  const trimmed = (name ?? '').normalize('NFC').trim();
  if (!trimmed) return '';
  const PREFIX = 'ยุทธศาสตร์';
  if (trimmed.startsWith(PREFIX)) {
    return trimmed.slice(PREFIX.length).trim();
  }
  return trimmed;
}

/**
 * NFC-normalize + collapse Thai spelling variations that appear in the
 * Nakhon Ratchasima Strategy ↔ DevelopmentIssue display-name pairs:
 *
 *   - "การพัฒนา" → "พัฒนา"   (e.g. STRAT003 "ด้านการพัฒนาเศรษฐกิจ" must
 *                              match registry root "ด้านพัฒนาเศรษฐกิจ")
 *   - "แนวทาง"  → "แนว"      (e.g. STRAT001 "ด้านโครงการตามแนวพระราชดำริ"
 *                              must match registry root
 *                              "ด้านโครงการตามแนวทางพระราชดำริ")
 *
 * Both collapses are idempotent — strings already lacking the longer
 * form pass through unchanged.
 *
 * Normalization order is NFC first, THEN textual collapses (CLAUDE.md
 * §17 R2 — precomposed vs decomposed Thai sequences must be unified
 * before substring rewriting).
 */
export function normalizeThaiPhrase(s: string): string {
  const nfc = (s ?? '').normalize('NFC');
  return nfc.split('การพัฒนา').join('พัฒนา').split('แนวทาง').join('แนว');
}

/**
 * Returns the portion of `issueDisplayName` BEFORE the first " — "
 * (em-dash U+2014 surrounded by spaces). Returns the entire string when
 * no delimiter is present.
 *
 * Registry convention (frozen — see
 * `nakhon-ratchasima-issue-rules.ts`): sub-topic suffix is separated by
 * " — " (em-dash + spaces). If a future registry edit replaces it with
 * a hyphen-minus "-" or en-dash "–", this helper will return the entire
 * name as the root — registry authors MUST preserve the em-dash
 * convention.
 *
 * Examples:
 *   "ด้านพัฒนาเศรษฐกิจ — แหล่งน้ำเพื่อการเกษตร" → "ด้านพัฒนาเศรษฐกิจ"
 *   "ด้านการพัฒนาคุณภาพชีวิต"                    → "ด้านการพัฒนาคุณภาพชีวิต"
 */
export function extractEntryRoot(displayName: string): string {
  if (!displayName) return '';
  const DELIM = ' — ';
  const idx = displayName.indexOf(DELIM);
  if (idx < 0) return displayName;
  return displayName.slice(0, idx);
}
