/**
 * line-quick-reply.formatter.ts — Wave 86 LINE Quick Reply formatter.
 *
 * Pure (stateless, side-effect-free) static-method utility that turns a
 * list of plain-text suggestions — typically produced by the
 * `AIExecutiveChatService.suggestions[]` field — into a LINE-conformant
 * `quickReply.items[]` payload.
 *
 * CLAUDE.md references:
 *
 *   - §17.2 advisory-only constraint. Quick Reply chips ARE advisory
 *     UI: tapping a chip merely echoes the chip's `text` back to the
 *     bot as if the user had typed it. Chips MUST NOT be modeled as
 *     workflow gates or capability tokens. The formatter intentionally
 *     enforces no privileged semantics — it only does string truncation
 *     and array capping.
 *
 *   - §17.10 staleness display. The Quick Reply payload contains NO
 *     score, band, or timestamp metadata. AI scores remain owned by the
 *     web staff UI; LINE renders only follow-up prompts. This is the
 *     correct boundary — we MUST NOT smuggle raw numeric scores into
 *     LINE chip labels because the staleness envelope cannot be
 *     reproduced in a 20-character chip.
 *
 *   - §17.11 no role exemption. The formatter is stateless and role-
 *     agnostic; identical input produces identical output regardless of
 *     caller. There is no role-based branch.
 *
 * LINE platform constraints (enforced here):
 *
 *   - At most 13 items per Quick Reply (LINE returns 400 above this).
 *     Task spec recommends a tighter UX cap of 5 — see `MAX_RECOMMENDED_ITEMS`.
 *     The formatter implements the HARD cap of 13 as the integrity
 *     guarantee; UX-level tightening is the caller's responsibility.
 *
 *   - `action.label` MAX 20 characters (LINE measures grapheme clusters;
 *     we measure JS code-points which is a safe under-approximation for
 *     Thai). Strings longer than 20 are truncated to 19 + "…" so that
 *     the visible cut is intentional rather than mid-word.
 *
 *   - `action.text` MAX 300 characters for `message` actions. We pass
 *     through the full untruncated suggestion as the text so the AI
 *     receives the user's complete intent on chip tap, even if the
 *     visible label was abbreviated. Strings over 300 chars are also
 *     truncated (defensive — most AI suggestions are < 100 chars).
 */

import type {
  LineQuickReplyItem,
  LineMessageAction,
} from './interfaces/line-quick-reply.interface';

/** LINE platform hard cap. Going above this produces 400 Bad Request. */
export const QUICK_REPLY_MAX_ITEMS = 13;

/** UX recommendation per W86 discovery report §F. */
export const QUICK_REPLY_RECOMMENDED_ITEMS = 5;

/** LINE platform hard cap on `action.label`. */
export const QUICK_REPLY_LABEL_MAX = 20;

/** LINE platform hard cap on `action.text` for message-type actions. */
export const QUICK_REPLY_TEXT_MAX = 300;

/**
 * Default fallback chips used when the AI returns no suggestions or
 * returns an empty array. These are intentionally generic and map to
 * canonical commands the AI executive chat service already understands.
 *
 * Order matters — the most-likely-helpful prompt comes first.
 */
export const DEFAULT_SUGGESTION_TEXTS: ReadonlyArray<string> = [
  'เริ่มใหม่',
  'ดูโครงการรอตรวจสอบ',
  'ดูงบประมาณ',
];

export class LineQuickReplyFormatter {
  /**
   * Convert an array of free-text suggestions into LINE Quick Reply
   * items. Empty / non-string entries are dropped before truncation
   * (defensive against malformed AI output).
   *
   * Truncation rules:
   *   - label > 20 chars → first 19 chars + "…" (ellipsis is U+2026,
   *     a single grapheme on LINE's side).
   *   - text  > 300 chars → first 299 chars + "…".
   *   - input array > 13  → first 13 entries kept (LINE platform cap).
   *
   * Returns an empty array when input is empty / all-invalid; callers
   * that want a fallback should call `defaultSuggestions()` instead and
   * branch on `.length === 0`.
   */
  static formatSuggestions(suggestions: string[]): LineQuickReplyItem[] {
    if (!Array.isArray(suggestions) || suggestions.length === 0) {
      return [];
    }

    const cleaned = suggestions
      .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
      .map((s) => s.trim());

    const capped = cleaned.slice(0, QUICK_REPLY_MAX_ITEMS);

    return capped.map((raw) => this.buildMessageItem(raw));
  }

  /**
   * Default chips used when AI returns no suggestions or returns
   * malformed output. The set is small (3 items), well under the
   * 13-item hard cap, and deliberately generic.
   *
   * Returned as a fresh array each call so callers may freely
   * mutate / extend without affecting future invocations.
   */
  static defaultSuggestions(): LineQuickReplyItem[] {
    return DEFAULT_SUGGESTION_TEXTS.map((raw) => this.buildMessageItem(raw));
  }

  /**
   * Build a single `message`-action item with both labels and text
   * properly truncated. The visible label is always derived from the
   * full source text — we never silently use a different value.
   */
  private static buildMessageItem(raw: string): LineQuickReplyItem {
    const label = this.truncate(raw, QUICK_REPLY_LABEL_MAX);
    const text = this.truncate(raw, QUICK_REPLY_TEXT_MAX);

    const action: LineMessageAction = {
      type: 'message',
      label,
      text,
    };

    return {
      type: 'action',
      action,
    };
  }

  /**
   * Right-pad-safe truncation: returns `s` unchanged when it fits,
   * otherwise returns the first `(max - 1)` code points + "…". The
   * "− 1" reservation keeps the final string at exactly `max`
   * code points so we never violate LINE's bound.
   *
   * NOTE: We intentionally use `Array.from(s)` rather than `s.length`
   * to avoid splitting astral-plane characters in the middle of a
   * surrogate pair. Thai script does not use surrogates, but emoji and
   * other AI-generated decorations might.
   */
  private static truncate(s: string, max: number): string {
    const codePoints = Array.from(s);
    if (codePoints.length <= max) {
      return s;
    }
    return codePoints.slice(0, max - 1).join('') + '…';
  }
}
