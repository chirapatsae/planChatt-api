/**
 * line-message.interface.ts — Wave 86 LINE Messaging API typings.
 *
 * Type-only definitions for the subset of LINE Messaging API "Message
 * objects" used in W86. Currently W86 ships only `text` messages with
 * an optional `quickReply` payload; richer variants (sticker, image,
 * audio, video, file, location, imagemap, template, flex) are
 * deliberately omitted to keep the surface small. They MAY be added in
 * later waves without breaking the contract — this file follows the
 * same "discriminated union by `type`" shape that LINE itself uses, so
 * extensions are additive.
 *
 * CLAUDE.md references:
 *
 *   - §17.2 advisory-only constraint. The Quick Reply chips embedded in
 *     these messages are presentation-layer affordances; tapping a chip
 *     dispatches a NEW user-text event to the webhook and does NOT
 *     trigger any privileged workflow transition. The frontend / LINE
 *     UI cannot smuggle authority into the conversation by virtue of
 *     having a chip.
 *
 *   - §17.11 no role exemption. No role may craft a message-object
 *     payload that bypasses webhook auth or service-layer validation;
 *     these types are pure data carriers, not capability tokens.
 *
 * Reference: https://developers.line.biz/en/reference/messaging-api/#message-objects
 */

import type { LineQuickReply } from './line-quick-reply.interface';

/**
 * Discriminator union — every Message object carries `type`. W86 ships
 * `text`; W96 adds `flex` for the owner-side LINE notification fanout.
 * Additional members (sticker, image, audio, video, file, location,
 * imagemap, template) MAY be added later without breaking the contract —
 * consumers should `switch (msg.type)` to keep exhaustiveness checks honest.
 */
export type LineMessage = LineTextMessage | LineFlexMessage;

/**
 * Plain text message. The `text` field is the user-visible body and is
 * subject to the LINE 5000-character cap (callers MUST split / chunk
 * upstream — this interface does NOT enforce the cap, the service
 * layer does).
 *
 * `quickReply` is optional. When present, LINE renders chip-style
 * buttons above the keyboard until the user either taps one (which
 * dispatches the chip's `action.text` as a new message event) or types
 * something else (which dismisses the chips). Quick Reply chips are
 * ephemeral and DO NOT persist across messages.
 */
export interface LineTextMessage {
  type: 'text';
  text: string;
  quickReply?: LineQuickReply;
}

/**
 * Flex Message — Wave 96. Renders a structured bubble (header band,
 * body, optional footer) on LINE clients that support Flex (LINE app
 * v7.0+). On unsupported clients LINE falls back to `altText` as a
 * plain push, so `altText` MUST be a meaningful Thai sentence (NOT a
 * placeholder like "Flex message").
 *
 * `contents` carries the Flex bubble JSON object (see LINE Messaging
 * API "Flex Message" reference). It is typed as `object` here because
 * the full Flex schema (bubble vs carousel, nested boxes, components)
 * is voluminous and is owned by the template authors. Templates are
 * loaded from `backend/src/notifications/templates/line/*.json` and
 * validated by the LINE platform on push (a malformed bubble returns
 * 400 from the messaging API and is caught by the transport layer).
 *
 * §17.2 advisory — Flex bubbles MUST NOT include inline workflow
 * affordances (no "Approve" / "Reject" buttons in the message body).
 * The single CTA is read-only navigation to the project page.
 */
export interface LineFlexMessage {
  type: 'flex';
  altText: string;
  contents: object;
}

/**
 * Reply API request body. Matches
 * `POST https://api.line.me/v2/bot/message/reply` exactly.
 *
 * `replyToken` is single-use and expires ~30 seconds after the
 * originating webhook event. Callers MUST treat it as a perishable
 * capability — re-using a consumed token returns 400 from LINE.
 */
export interface LineReplyRequest {
  replyToken: string;
  messages: LineMessage[];
  notificationDisabled?: boolean;
}

/**
 * Push API request body. Matches
 * `POST https://api.line.me/v2/bot/message/push` exactly.
 *
 * `to` is the LINE user id (U-prefixed). Callers MUST verify that the
 * user has an active `line_user_bindings` row (or that consent was
 * given through another linked path) BEFORE invoking push — pushing
 * without consent violates LINE's terms of service and PDPA obligations.
 */
export interface LinePushRequest {
  to: string;
  messages: LineMessage[];
  notificationDisabled?: boolean;
}
