/**
 * line-webhook-event.interface.ts — Wave 86.
 *
 * Typed shapes for the LINE Messaging API webhook envelope. Only the
 * fields actually consumed by the W86 router are typed strictly; LINE
 * delivers many additional fields (mode, webhookEventId, etc.) which
 * pass through as `unknown` to avoid coupling to upstream changes.
 *
 * Reference: https://developers.line.biz/en/reference/messaging-api/#webhook-event-objects
 *
 * §17 alignment notes:
 *   - These interfaces describe the WIRE FORMAT only. They do NOT
 *     declare authority. Routing decisions in
 *     `LineEventRouterService` are advisory dispatch (§17.2) — receipt
 *     of any event MUST NOT mutate workflow state.
 *   - `userId` here is the LINE platform user id (U-prefixed), NOT a
 *     Project Bank `User.id`. Resolution to a Project Bank user lives
 *     in `LineAiBridgeService` (Phase 3) via `line_user_bindings`.
 */

export type LineEventType =
  | 'message'
  | 'follow'
  | 'unfollow'
  | 'postback'
  | 'join'
  | 'leave'
  | 'memberJoined'
  | 'memberLeft'
  | 'beacon'
  | 'accountLink'
  | 'things'
  | 'unsend'
  | 'videoPlayComplete'
  | string; // future-proof: unknown types fall through to ignore branch

export interface LineEventSource {
  type: 'user' | 'group' | 'room' | string;
  /**
   * LINE platform user id (U-prefixed). Personal data per PDPA — MUST
   * NOT be logged in plaintext (W83 logger discipline).
   */
  userId?: string;
  groupId?: string;
  roomId?: string;
}

export interface LineWebhookEvent {
  type: LineEventType;
  /**
   * Reply token — single-use, ~30s TTL. Required for Reply API. MUST
   * NOT be logged (treat as a short-lived bearer credential).
   */
  replyToken?: string;
  source?: LineEventSource;
  timestamp?: number;
  mode?: string;
  webhookEventId?: string;
  // Type-specific payloads (narrowed in handlers):
  message?: unknown;
  postback?: unknown;
  // Permit unknown forward-compat fields without `any`:
  [key: string]: unknown;
}

export interface LineWebhookBody {
  destination: string;
  events: LineWebhookEvent[];
}
