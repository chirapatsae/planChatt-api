/**
 * line-message-event.interface.ts — Wave 86.
 *
 * Narrowed shapes for `event.type === 'message'` from the LINE
 * Messaging API webhook. Only text messages are routed to the AI
 * bridge (Phase 3); non-text types receive a polite "text only"
 * response.
 *
 * Reference: https://developers.line.biz/en/reference/messaging-api/#message-event
 *
 * §17.9 prompt-injection note:
 *   - `text` here is the RAW user-controlled string. The bridge
 *     service (W86-BE-LINE-AI-BRIDGE) MUST wrap this in the
 *     `<<<USER_INPUT>>>...<<<END>>>` envelope and run the
 *     `PiiRedactorService` BEFORE forwarding to the LLM. The webhook
 *     layer itself does NOT sanitize — that is the bridge's
 *     responsibility, mirroring how `AIExecutiveChatService` handles
 *     web-channel input.
 */

import { LineWebhookEvent } from './line-webhook-event.interface';

export type LineMessageType =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'file'
  | 'location'
  | 'sticker'
  | string;

export interface LineBaseMessage {
  id: string;
  type: LineMessageType;
}

export interface LineTextMessage extends LineBaseMessage {
  type: 'text';
  text: string;
  // LINE may include `mention`, `quoteToken`, `emojis`, etc. — pass-through:
  [key: string]: unknown;
}

export interface LineMessageEvent extends LineWebhookEvent {
  type: 'message';
  replyToken: string;
  message: LineBaseMessage;
}

export interface LineTextMessageEvent extends LineMessageEvent {
  message: LineTextMessage;
}

/**
 * Type-guard: `true` when an event is a valid text-message event with
 * a non-empty reply token and a string `text` payload. Used by the
 * router to distinguish AI-routable messages from sticker / image /
 * etc. fallbacks.
 */
export function isTextMessageEvent(
  ev: LineWebhookEvent,
): ev is LineTextMessageEvent {
  if (ev.type !== 'message') return false;
  if (typeof ev.replyToken !== 'string' || ev.replyToken.length === 0) {
    return false;
  }
  const m = ev.message as LineBaseMessage | undefined;
  if (!m || m.type !== 'text') return false;
  const t = (m as LineTextMessage).text;
  return typeof t === 'string';
}
