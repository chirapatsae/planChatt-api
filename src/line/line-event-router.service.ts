/**
 * line-event-router.service.ts — Wave 86.
 *
 * Routes a single signature-verified LINE webhook event to its
 * appropriate handler. Each event is processed independently — a
 * failure in one event MUST NOT poison sibling events in the same
 * batch (LINE batches up to ~100 events per delivery).
 *
 * Routing matrix:
 *   - message + text  → LineAiBridgeService.handleTextMessage
 *   - message + other → polite "text only" reply
 *   - follow          → welcome + link instructions reply
 *   - unfollow        → soft-unlink the binding (set unlinked_at)
 *   - postback/join/leave/etc. → log + skip (Wave 86B+)
 *
 * §17 alignment:
 *   - §17.2 advisory — no event triggers a workflow transition.
 *   - §17.3 audit separation — only `line_user_bindings.unlinked_at`
 *     is mutated (NOT TrackingStatus).
 *   - §17.11 no role exemption — events arrive from LINE, not from
 *     authenticated Project Bank users; role gating is N/A.
 *
 * Logging discipline (W83):
 *   - log event type + presence flags only
 *   - NEVER log: source.userId, replyToken, message body, displayName
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  LineWebhookEvent,
} from './interfaces/line-webhook-event.interface';
import {
  isTextMessageEvent,
  LineMessageEvent,
} from './interfaces/line-message-event.interface';
import { LineAiBridgeService } from './line-ai-bridge.service';
import { LineMessagingService } from './line-messaging.service';
import { LineUserBindingService } from './line-user-binding.service';

const FRONTEND_URL = process.env.FRONTEND_URL || '';

const FOLLOW_REPLY_TEXT =
  `ยินดีต้อนรับสู่ Project Bank!\n` +
  `เชื่อมต่อบัญชีของคุณเพื่อใช้งานผู้ช่วย AI ที่: ` +
  `${FRONTEND_URL}/profile`;

const NON_TEXT_REPLY_TEXT = 'รองรับเฉพาะข้อความเท่านั้น';

@Injectable()
export class LineEventRouterService {
  private readonly logger = new Logger(LineEventRouterService.name);

  constructor(
    private readonly bindings: LineUserBindingService,
    private readonly aiBridge: LineAiBridgeService,
    private readonly messaging: LineMessagingService,
  ) {}

  /**
   * Dispatch a single event. Errors are caught at the controller
   * boundary so LINE always sees 200 and does NOT retry the entire
   * batch on a single bad event. This method may still throw;
   * callers wrap in try/catch.
   */
  async handle(event: LineWebhookEvent): Promise<void> {
    const at = new Date().toISOString();
    const dest = this.safeDest(event);
    this.logger.log(
      `webhook.received eventType=${event.type} destination=${dest} at=${at}`,
    );

    switch (event.type) {
      case 'message':
        await this.handleMessage(event);
        return;
      case 'follow':
        await this.handleFollow(event);
        return;
      case 'unfollow':
        await this.handleUnfollow(event);
        return;
      case 'postback':
      case 'join':
      case 'leave':
      case 'memberJoined':
      case 'memberLeft':
      case 'beacon':
      case 'accountLink':
      case 'things':
      case 'unsend':
      case 'videoPlayComplete':
      default:
        // Acknowledge by logging at debug level (W86B+ may extend).
        this.logger.debug(
          `webhook.event.ignored eventType=${event.type} at=${at}`,
        );
        return;
    }
  }

  // ──────────────────────────────────────────────────────────────────

  private async handleMessage(event: LineWebhookEvent): Promise<void> {
    if (isTextMessageEvent(event)) {
      await this.aiBridge.handleTextMessage(event);
      return;
    }
    // Non-text message — sticker, image, location, etc. Reply with a
    // polite text-only notice if a reply token is present; else skip.
    const ev = event as LineMessageEvent;
    if (typeof ev.replyToken === 'string' && ev.replyToken.length > 0) {
      await this.messaging.replyText(ev.replyToken, NON_TEXT_REPLY_TEXT);
    }
  }

  private async handleFollow(event: LineWebhookEvent): Promise<void> {
    const replyToken = event.replyToken;
    if (typeof replyToken === 'string' && replyToken.length > 0) {
      await this.messaging.replyText(replyToken, FOLLOW_REPLY_TEXT);
    }
  }

  /**
   * Soft-unlink: set `unlinked_at = now()` on the active binding for
   * the LINE userId in `event.source.userId`. Delegates to
   * `LineUserBindingService.softUnlinkByLineUserId` (W86-BE-LINE-AI-BRIDGE
   * Phase 3) so the partial-uniqueness-equivalent filter and audit
   * logging live in one place.
   *
   * If no active binding exists (user never linked), the operation
   * is a no-op — LINE's `unfollow` event fires regardless of whether
   * we ever knew about the user.
   */
  private async handleUnfollow(event: LineWebhookEvent): Promise<void> {
    const lineUserId = event.source?.userId;
    if (typeof lineUserId !== 'string' || lineUserId.length === 0) {
      // No userId on event source — cannot soft-unlink. Skip silently.
      this.logger.debug('webhook.unfollow.skipped reason=no_user_id');
      return;
    }
    const affected = await this.bindings.softUnlinkByLineUserId(lineUserId);
    // Log only the count, not the userId.
    this.logger.log(`webhook.unfollow.softunlink affected=${affected}`);
  }

  /**
   * `destination` is the bot's own user id (Bot User ID), NOT a
   * personal data field — LINE docs treat it as channel metadata.
   * Safe to log when present, but defensively trimmed for length.
   */
  private safeDest(event: LineWebhookEvent): string {
    const ev = event as LineWebhookEvent & { destination?: unknown };
    const d = typeof ev.destination === 'string' ? ev.destination : '';
    return d.slice(0, 64) || 'unknown';
  }
}
