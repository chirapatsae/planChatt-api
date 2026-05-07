/**
 * W63-BE-AGG-01 (2026-04-25) — display-only text normalization for
 * inline numbered lists. Splits patterns like "1. xxx 2. yyy 3. zzz"
 * into newline-separated items so chat markdown renders them as a
 * proper ordered list.
 *
 * Anchored on (\S)\s+(\d+\.\s) — never matches decimals (1.5) or
 * currency (฿1.50) because those have no whitespace after the dot.
 *
 * §17.9 compatible — original DB content untouched; this is a
 * display-only rewrite at handler-emission time.
 *
 * Pure, idempotent: f(f(x)) === f(x). No side effects, no I/O.
 *
 * @see docs/tasks/wave63/W63-BE-AGG-01-normalize-display-text.md
 * @see docs/reports/wave63/WAVE63_CHAT_MARKDOWN_RENDERING_DISPATCH.md
 * @see CLAUDE.md §17.2 (advisory), §17.9 (display-only — DB untouched),
 *      §17.11 (no role exemption)
 */
export function normalizeDisplayText(
  raw: string | null | undefined,
): string | null {
  if (raw == null) return null;
  if (typeof raw !== 'string') return null;
  if (raw.length === 0) return raw;
  return raw.replace(/(\S)\s+(\d+\.\s)/g, '$1\n$2');
}

/**
 * W64-FE-03 (2026-04-25) — markdown-aware ordered-list formatter.
 *
 * Root cause for Wave 64 Q-NORMALIZE-VERIFY: even though
 * `normalizeDisplayText` correctly inserts `\n` between numbered items,
 * a SINGLE `\n` collapses to a space inside a markdown `<p>` or `<li>`.
 * To render as a nested ordered list under a bullet label like
 * `**วัตถุประสงค์:**` the text MUST be emitted as a properly indented
 * markdown ordered-list block — that is, each item on its own line with
 * a leading newline (so it sits below the parent bullet) and a 5-space
 * indent (matching the `   - ` parent bullet column + 2-space hanging
 * indent for the nested list).
 *
 * Input:  "1. xxx\n2. yyy\n3. zzz"        (post-normalize)
 *      OR "1. xxx 2. yyy 3. zzz"          (raw inline form)
 * Output:
 *   "\n     1. xxx\n     2. yyy\n     3. zzz"
 *
 * Plain prose (no leading `\d+\.\s` after split) is returned as-is so
 * the helper is safe to call unconditionally on any free-form field.
 *
 * §17.9 compatible — display-only; never touches DB content.
 * Pure, deterministic, no I/O.
 *
 * @see docs/tasks/wave64/W64-FE-03-normalize-display-text-verify.md
 */
export function formatNumberedListMarkdown(
  raw: string | null | undefined,
  options: { indent?: string } = {},
): string | null {
  if (raw == null) return null;
  if (typeof raw !== 'string') return null;
  if (raw.length === 0) return raw;

  const indent = options.indent ?? '     ';

  // First, normalize so inline runs are line-broken.
  const normalized = normalizeDisplayText(raw) ?? raw;

  // Split on newline; trim whitespace per line; drop empties.
  const parts = normalized
    .split(/\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // Detect ordered-list shape: every non-empty line must start with
  // `\d+.` followed by whitespace. Otherwise return the normalized
  // text unchanged — this helper is non-destructive on prose.
  const allNumbered =
    parts.length >= 2 && parts.every((p) => /^\d+\.\s/.test(p));
  if (!allNumbered) {
    return normalized;
  }

  // Re-emit as indented markdown ordered list with a leading newline
  // so the block sits BELOW its parent bullet label (the `\n` flips
  // the parent `<li>` from inline to block content, allowing a nested
  // `<ol>` to render).
  return '\n' + parts.map((p) => `${indent}${p}`).join('\n');
}
