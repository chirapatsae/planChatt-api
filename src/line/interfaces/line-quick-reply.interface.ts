/**
 * line-quick-reply.interface.ts — Wave 86 LINE Quick Reply typings.
 *
 * Quick Reply is a per-message UI affordance: each Message object MAY
 * carry a `quickReply` block whose `items[]` array renders as chip
 * buttons above the LINE keyboard. The chips disappear when the user
 * taps one (which dispatches a NEW user-text event back to the bot) or
 * when the user types anything else.
 *
 * CLAUDE.md references:
 *
 *   - §17.2 advisory-only constraint. Tapping a Quick Reply chip is
 *     identical to the user typing the same text by hand — it produces
 *     an ordinary `message` webhook event. Quick Reply chips MUST NOT
 *     be treated as privileged inputs by downstream services.
 *
 *   - §17.10 UI score display. Quick Reply chips are NOT a substitute
 *     for the score-staleness / band / timestamp envelope mandated for
 *     AI score surfaces. Score rendering on LINE is reserved for a
 *     follow-up wave (see W86 discovery report §H deferred items); the
 *     formatter implemented in this module is for AI-suggested next
 *     prompts, not numeric scores.
 *
 * LINE constraints (hard limits enforced by the formatter):
 *   - At most 13 items per Quick Reply.
 *   - `action.label` MAX 20 characters (UTF-8 grapheme-counted on
 *     LINE's side — we count JavaScript code-points which is a safe
 *     under-approximation for Thai text since combining marks count
 *     equal-or-lower than LINE's measurement).
 *   - `action.text` MAX 300 characters for `message` actions.
 *
 * Reference:
 *   https://developers.line.biz/en/reference/messaging-api/#quick-reply
 */

/**
 * Top-level Quick Reply container attached to a Message object.
 */
export interface LineQuickReply {
  items: LineQuickReplyItem[];
}

/**
 * Single chip. `type` is always literal `'action'` per LINE's spec.
 * `imageUrl` is optional — when omitted, LINE renders the chip as
 * label-only.
 */
export interface LineQuickReplyItem {
  type: 'action';
  imageUrl?: string;
  action: LineQuickReplyAction;
}

/**
 * W86 emits the `message` and `uri` action variants. Other variants
 * (`postback`, `datetimepicker`, `camera`, `cameraRoll`, `location`,
 * `richmenuswitch`) are intentionally NOT modeled here — they are
 * slated for later waves and would require additional server-side
 * validation.
 *
 * On `message` chip tap, LINE dispatches a `message` event to the
 * webhook with the chip's `text` as if the user had typed it. There
 * is NO hidden payload channel, so the webhook handler MUST treat
 * tapped text exactly like free-form text (re-validate, re-classify,
 * re-rate-limit).
 *
 * On `uri` chip tap, LINE opens the URL in the in-app browser without
 * sending any event back to the webhook. Used by W86-BE-LINE-AI-BRIDGE
 * to deep-link unlinked LINE users to the profile page where they can
 * complete the LINE Login OIDC flow.
 */
export type LineQuickReplyAction = LineMessageAction | LineUriAction;

export interface LineMessageAction {
  type: 'message';
  /**
   * Visible chip label. LINE truncates server-side at 20 grapheme
   * clusters — but the visual cut is ugly, so the formatter pre-truncates
   * to 19 + ellipsis "…".
   */
  label: string;
  /**
   * Body of the message dispatched on chip tap. SHOULD be the full,
   * untruncated suggestion text so the AI receives the complete
   * intent even if the visible chip was abbreviated.
   */
  text: string;
}

/**
 * `uri` action — chip opens an external URL in LINE's in-app browser.
 * Does NOT generate a webhook event on tap, so it cannot be used to
 * smuggle privileged input to the bot — §17.2 compliance is automatic.
 *
 * The `uri` MUST be `https://...` in production; LINE rejects `http://`
 * URLs (except for whitelisted dev hosts). Length cap: 1,000 chars.
 */
export interface LineUriAction {
  type: 'uri';
  /**
   * Visible chip label. Same 20-grapheme cap as the message variant.
   */
  label: string;
  /**
   * Target URL. Required. SHOULD be HTTPS.
   */
  uri: string;
}
