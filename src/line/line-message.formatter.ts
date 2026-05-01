/**
 * line-message.formatter.ts — Wave 86 W86-BE-LINE-AI-BRIDGE.
 *
 * Pure (stateless) helpers for adapting `AIExecutiveChatService` output
 * into a LINE-conformant text message:
 *
 *   1. Strip Markdown formatting — LINE renders plain text only; the
 *      web UI's bold / italic / list markers would otherwise show as
 *      raw `**`, `_`, `- `.
 *   2. Truncate to LINE's 5,000-char-per-message platform cap, with a
 *      Thai "(ข้อความถูกตัด)" footer so the user knows truncation
 *      occurred.
 *   3. Extract follow-up suggestion prompts from the AI response so
 *      they can be rendered as Quick Reply chips.
 *
 * CLAUDE.md references:
 *   - §17.2 advisory-only. Quick Reply suggestions and truncation are
 *     UI affordances; they MUST NOT alter workflow state and the LINE
 *     transport MUST NOT gate any transition based on whether
 *     truncation fired.
 *   - §17.10 staleness display. AI scores / bands / timestamps are
 *     intentionally NOT carried into LINE — see also the formatter
 *     header in `line-quick-reply.formatter.ts`. The LINE channel
 *     surfaces follow-up prompts only.
 *   - §17.11 No role exemption. The formatter is stateless and role-
 *     agnostic; identical input produces identical output for every
 *     caller.
 *
 * LINE platform constraints (enforced here):
 *   - Max 5,000 characters per text message body
 *     (`messages[].text.length <= 5000`).
 *   - LINE measures characters in UTF-16 code units; we conservatively
 *     measure JS `.length` which is the same metric, so truncation is
 *     exact.
 */

/**
 * LINE platform hard cap on text-message body length. Going above this
 * yields a 400 from the Reply / Push API.
 */
export const LINE_TEXT_MAX_LENGTH = 5_000;

/**
 * Effective length budget for a body that needs the truncation footer.
 * Reserves ~100 chars for the Thai footer so the final string still
 * fits inside `LINE_TEXT_MAX_LENGTH`.
 */
export const LINE_TEXT_TRUNCATE_TARGET = 4_900;

/**
 * Suffix appended when a response is truncated. Kept short so the
 * user-readable portion of the message dominates.
 */
export const LINE_TEXT_TRUNCATE_SUFFIX = '\n\n…(ข้อความถูกตัด)';

/**
 * Markers the executive-chat system prompt uses to introduce the
 * "recommended next questions" block on web. Both forms are
 * recognized for forward compatibility.
 */
const SUGGESTION_MARKERS_TH: ReadonlyArray<string> = [
  'ข้อเสนอแนะเพิ่มเติม:',
  'คำถามที่แนะนำ:',
  'คำถามแนะนำ:',
  'ลองถามต่อได้ที่:',
];

/**
 * Line-prefix patterns that indicate a tool-call breadcrumb / scope
 * header emitted by the executive-chat system prompt (rule #15 default
 * scope badge "ขอบเขต: ทั้งจังหวัดนครราชสีมา"; rule #6 / tool dispatch
 * "เรียกข้อมูล: ..." breadcrumbs). On the web chat these render as
 * small meta chips above the AI reply; on LINE they would appear inline
 * as plain text and add noise without surfacing useful context. The
 * LINE formatter strips them entirely BEFORE the Markdown-strip pass.
 *
 * Scope: LINE transport only — the web chat continues to render these
 * intentionally. §17.2 advisory-only: stripping is presentation-layer
 * only and does NOT alter workflow state or AI verdicts.
 *
 * The patterns match the START of a line (after optional leading
 * whitespace) up to the first colon (Thai full or ASCII), so any
 * trailing content on the same line is removed with the line.
 */
const LINE_BREADCRUMB_LINE_PREFIXES: ReadonlyArray<string> = [
  'ขอบเขต:',
  'เรียกข้อมูล:',
  'Scope:',
];

export interface LineFormattedAiResponse {
  /**
   * The body of the LINE text message. Markdown stripped, truncated to
   * `LINE_TEXT_MAX_LENGTH` chars. Suggestion markers (if any) are
   * removed from the body so they don't render as plain text underneath
   * the Quick Reply chips.
   */
  text: string;

  /**
   * Trailing suggestion strings extracted from the AI response, if any.
   * The AI bridge passes these to `LineQuickReplyFormatter.formatSuggestions`
   * to build the Quick Reply payload. Empty array when none are
   * detected.
   */
  suggestions: string[];

  /**
   * `true` when the body had to be truncated to fit
   * `LINE_TEXT_MAX_LENGTH`. Surfaced for log lines only.
   */
  truncated: boolean;
}

export class LineMessageFormatter {
  /**
   * Convert an AI response into a LINE-ready `{ text, suggestions }`
   * pair.
   *
   *   1. Defensive trim.
   *   2. Extract trailing suggestion list (look for one of the
   *      `SUGGESTION_MARKERS_TH` markers near the end of the text;
   *      lines below the marker that look like enumerated items become
   *      suggestions).
   *   3. Strip the suggestion block from the body.
   *   4. Strip tool-call breadcrumb / scope-header lines (LINE-only;
   *      web chat surfaces these as meta chips and keeps them).
   *   5. Strip Markdown formatting.
   *   6. Truncate to `LINE_TEXT_MAX_LENGTH` if needed.
   */
  static format(rawAiText: string | null | undefined): LineFormattedAiResponse {
    const input = typeof rawAiText === 'string' ? rawAiText : '';
    const trimmed = input.trim();

    if (trimmed.length === 0) {
      return { text: '', suggestions: [], truncated: false };
    }

    const { body, suggestions } = this.extractSuggestions(trimmed);
    const debreadcrumbed = this.stripBreadcrumbLines(body);
    const plain = this.stripMarkdown(debreadcrumbed).trim();
    const { text, truncated } = this.truncateForLine(plain);

    return { text, suggestions, truncated };
  }

  /**
   * Remove tool-call breadcrumb / scope header lines that the executive
   * chat prompt emits for the web UI's meta-chip rendering. Lines that
   * START with any prefix in `LINE_BREADCRUMB_LINE_PREFIXES` (after
   * optional leading whitespace) are dropped in their entirety. Any
   * resulting consecutive blank lines are collapsed to a single blank
   * line so the visible body keeps its paragraph spacing without a
   * gap where the breadcrumb used to live.
   *
   * The remaining content is preserved verbatim — only the breadcrumb
   * lines are removed.
   */
  static stripBreadcrumbLines(s: string): string {
    if (typeof s !== 'string' || s.length === 0) return '';

    const inputLines = s.split(/\r?\n/);
    const kept: string[] = [];
    for (const line of inputLines) {
      const trimmedStart = line.replace(/^[\s ]+/, '');
      const isBreadcrumb = LINE_BREADCRUMB_LINE_PREFIXES.some((prefix) =>
        trimmedStart.startsWith(prefix),
      );
      if (isBreadcrumb) continue;
      kept.push(line);
    }

    // Collapse runs of >=2 consecutive blank lines down to a single
    // blank line. A "blank" here is empty-or-whitespace-only.
    const collapsed: string[] = [];
    let lastWasBlank = false;
    for (const line of kept) {
      const isBlank = line.trim().length === 0;
      if (isBlank && lastWasBlank) continue;
      collapsed.push(line);
      lastWasBlank = isBlank;
    }

    // Drop a leading blank line (e.g. when the breadcrumb was the very
    // first line and removing it left the body starting with "\n").
    while (collapsed.length > 0 && collapsed[0].trim().length === 0) {
      collapsed.shift();
    }

    return collapsed.join('\n');
  }

  /**
   * Strip Markdown formatting characters that LINE does not render.
   * Conservative — preserves the visible text content; only removes
   * decoration. Bullet markers are normalized to a Thai-friendly
   * fullwidth dot so the visual hierarchy survives in plaintext.
   */
  static stripMarkdown(s: string): string {
    if (typeof s !== 'string' || s.length === 0) return '';

    let out = s;

    // Code fences ``` ... ``` — strip the fences but keep the content.
    out = out.replace(/```[a-zA-Z0-9]*\n?/g, '').replace(/```/g, '');

    // Inline code `...` — drop the backticks, keep the inside.
    out = out.replace(/`([^`]*)`/g, '$1');

    // Bold **...** or __...__ — drop the markers, keep the inside.
    out = out.replace(/\*\*([^*]+)\*\*/g, '$1');
    out = out.replace(/__([^_]+)__/g, '$1');

    // Italic *...* or _..._ — same. Done after bold so we don't eat
    // the inner pair of `**foo**`.
    out = out.replace(/\*([^*\n]+)\*/g, '$1');
    out = out.replace(/(?<![A-Za-z0-9])_([^_\n]+)_(?![A-Za-z0-9])/g, '$1');

    // Headings `#`, `##`, ... — drop the leading hashes + space.
    out = out.replace(/^#{1,6}\s+/gm, '');

    // Blockquote `> ` — drop the prefix.
    out = out.replace(/^>\s?/gm, '');

    // Horizontal rules `---`, `***`, `___` on their own line — drop entirely.
    out = out.replace(/^[\-*_]{3,}\s*$/gm, '');

    // Links `[label](url)` — keep `label (url)`. Image links `![alt](url)`
    // — keep `alt (url)`.
    out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1 ($2)');
    out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');

    // Bullet markers `- `, `* `, `+ ` at line start → "• " (LINE-safe).
    out = out.replace(/^[\s]*[-*+]\s+/gm, '• ');

    // Numbered list `1. `, `1) ` → keep number + ". " — already plain.
    // (no transform needed)

    return out;
  }

  /**
   * Apply LINE's 5,000-char platform cap. When the body exceeds the
   * budget, truncate at `LINE_TEXT_TRUNCATE_TARGET` chars and append
   * the Thai footer so the final length is still ≤ `LINE_TEXT_MAX_LENGTH`.
   */
  static truncateForLine(text: string): { text: string; truncated: boolean } {
    if (typeof text !== 'string') return { text: '', truncated: false };
    if (text.length <= LINE_TEXT_MAX_LENGTH) {
      return { text, truncated: false };
    }
    const head = text.slice(0, LINE_TEXT_TRUNCATE_TARGET).trimEnd();
    return {
      text: `${head}${LINE_TEXT_TRUNCATE_SUFFIX}`,
      truncated: true,
    };
  }

  /**
   * Find a trailing "recommended next questions" block introduced by
   * any of the `SUGGESTION_MARKERS_TH` markers and split it off into a
   * structured `suggestions[]` array.
   *
   * Lenient parser:
   *   - Marker is matched case-insensitively.
   *   - Items below the marker are collected as long as they look like
   *     enumerated entries: bullet (`-`, `*`, `•`), numbered (`1.`,
   *     `2)`), or plain non-empty lines.
   *   - A blank line OR a line that starts a new paragraph
   *     (case-folded, doesn't match the item shape) terminates the
   *     block.
   *   - Each captured suggestion is trimmed and stripped of its leading
   *     marker (`-`, `1.`, `•`, etc).
   *
   * If no marker is found OR no items are captured, returns the
   * original body unchanged with `suggestions: []`.
   */
  private static extractSuggestions(body: string): {
    body: string;
    suggestions: string[];
  } {
    const lines = body.split(/\r?\n/);
    let markerLineIndex = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      const lineLower = lines[i].toLowerCase();
      for (const marker of SUGGESTION_MARKERS_TH) {
        if (lineLower.includes(marker.toLowerCase())) {
          markerLineIndex = i;
          break;
        }
      }
      if (markerLineIndex >= 0) break;
    }
    if (markerLineIndex < 0) {
      return { body, suggestions: [] };
    }

    // Capture items below the marker line.
    const suggestions: string[] = [];
    for (let i = markerLineIndex + 1; i < lines.length; i++) {
      const raw = lines[i].trim();
      if (raw.length === 0) {
        // Blank line — keep scanning; AI sometimes inserts a blank
        // between the marker and the first bullet.
        if (suggestions.length === 0) continue;
        // A blank AFTER we started capturing terminates the block.
        break;
      }
      const cleaned = this.cleanSuggestionLine(raw);
      if (cleaned.length === 0) continue;
      suggestions.push(cleaned);
    }

    if (suggestions.length === 0) {
      return { body, suggestions: [] };
    }

    // Body is everything UP TO (but not including) the marker line.
    // Trim trailing whitespace so we don't leave a dangling newline.
    const remainingBody = lines.slice(0, markerLineIndex).join('\n').trimEnd();
    return { body: remainingBody, suggestions };
  }

  /**
   * Strip a leading list marker (bullet or numbering) from a single
   * suggestion line and return the suggestion text.
   *
   * Examples:
   *   "- ดูโครงการรอตรวจสอบ"  → "ดูโครงการรอตรวจสอบ"
   *   "1. ดูงบประมาณ"           → "ดูงบประมาณ"
   *   "• เริ่มใหม่"             → "เริ่มใหม่"
   *   "ดูแผนพัฒนาท้องถิ่น"      → "ดูแผนพัฒนาท้องถิ่น"
   */
  private static cleanSuggestionLine(raw: string): string {
    let s = raw.trim();
    // Bullet markers
    s = s.replace(/^[-*+•·●○]\s+/, '');
    // Numbered "1.", "1)", "1:"
    s = s.replace(/^\d+[.)\]:]\s+/, '');
    // Quoted markdown link "[label](url)" — keep label
    s = s.replace(/^\[([^\]]+)\]\([^)]+\)\s*/, '$1');
    return s.trim();
  }
}
