/**
 * line-webhook.controller.ts — Wave 86.
 *
 * Public-facing webhook endpoint for the LINE Messaging API platform.
 * `POST /api/v1/line/webhook` receives a batched envelope of events;
 * each event is routed independently via `LineEventRouterService`.
 *
 * Hardening posture:
 *   1. SIGNATURE FIRST. `LineSignatureGuard` runs as the first action;
 *      no body parse, no DB access, no logging of payload contents
 *      occurs before signature verification. A bad signature short-
 *      circuits with 401.
 *   2. ALWAYS 200. Once signature passes, the controller MUST return
 *      200 OK within 30s. LINE retries on 5xx/timeout, which would
 *      cause duplicate event delivery; we'd rather log and absorb than
 *      retry. Per-event handler errors are caught and logged here.
 *   3. PER-EVENT ISOLATION. One bad event must not affect siblings in
 *      the same batch. Each event is awaited inside a try/catch.
 *   4. RATE LIMIT. `@Throttle` 100 req / 60s / IP — generous because
 *      LINE legitimately bursts when many users message at once, but
 *      tight enough to neutralize a flood from a misconfigured signer.
 *      Note: signature failures still consume rate-limit budget; this
 *      is intentional — a bad-secret attacker should be slowed down,
 *      not given a free probe.
 *
 * §17 alignment:
 *   - §17.2 advisory — webhook events MUST NOT alter workflow state.
 *     Only `line_user_bindings.unlinked_at` is mutable here, and that
 *     is binding lifecycle, not workflow.
 *   - §17.3 audit separation — no TrackingStatus writes.
 *   - §17.11 no role exemption — signature is the only authority
 *     check; no role can override.
 *
 * Logging discipline (W83):
 *   - controller.invoked with eventCount only
 *   - controller.event.failed with error class:message (no body, no PII)
 *   - NEVER log: source.userId, message text, replyToken, header value
 */

import {
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { Request } from 'express';
import { LineSignatureGuard } from './line-signature.guard';
import { LineEventRouterService } from './line-event-router.service';
import {
  LineWebhookBody,
  LineWebhookEvent,
} from './interfaces/line-webhook-event.interface';

type RawBodyRequest = Request & { rawBody?: Buffer };

/**
 * `default` named throttler config — applies a 100 req / 60_000 ms
 * limit keyed on remote IP. The `@nestjs/throttler` v6 `@Throttle`
 * decorator expects a Record<name, options>; we use the default
 * tracker name to avoid coupling to a custom named tracker until
 * AppModule wires `ThrottlerModule.forRoot([{ name: 'webhook', ... }])`.
 * If/when a separate `webhook` tracker is registered globally, change
 * the key here and the AppModule registration in lockstep.
 */
const WEBHOOK_THROTTLE = {
  default: { limit: 100, ttl: 60_000 },
};

@Controller({ path: 'line/webhook', version: '1' })
export class LineWebhookController {
  private readonly logger = new Logger(LineWebhookController.name);

  constructor(private readonly router: LineEventRouterService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  // Order matters: `ThrottlerGuard` runs first so a flood of requests
  // (with bad signatures or otherwise) is dropped at the rate-limit
  // boundary BEFORE we burn HMAC cycles in `LineSignatureGuard`. NestJS
  // executes guards in array order.
  @UseGuards(ThrottlerGuard, LineSignatureGuard)
  @Throttle(WEBHOOK_THROTTLE)
  async receive(@Req() req: RawBodyRequest): Promise<{ ok: true }> {
    // Parse the body OURSELVES from `req.rawBody` rather than relying
    // on `@Body()` + the global ValidationPipe. Two reasons:
    //   1. Defensive symmetry — the signature was verified against
    //      `req.rawBody` bytes, so the routing decision MUST be made
    //      on the parse of those exact bytes (eliminates any chance
    //      of a discrepancy between the verified payload and the
    //      payload routed to handlers).
    //   2. The global ValidationPipe runs with
    //      `forbidNonWhitelisted` + `forbidUnknownValues`, which
    //      rejects payloads bound to plain interfaces (not classes).
    //      LINE delivers many forward-compat fields we deliberately
    //      do NOT enumerate; bypassing the pipe avoids future LINE
    //      schema additions silently breaking the webhook.
    let body: LineWebhookBody;
    try {
      const raw = req.rawBody;
      if (!raw || raw.length === 0) {
        // Should never happen — signature guard already rejected.
        // Defensive 200 anyway so LINE doesn't retry.
        return { ok: true };
      }
      body = JSON.parse(raw.toString('utf8')) as LineWebhookBody;
    } catch (err) {
      const cls = (err as Error)?.constructor?.name ?? 'Error';
      this.logger.error(
        `controller.body.parse.failed reason=${cls} at=${new Date().toISOString()}`,
      );
      return { ok: true };
    }

    const events = Array.isArray(body?.events) ? body.events : [];
    this.logger.log(
      `controller.invoked eventCount=${events.length} at=${new Date().toISOString()}`,
    );

    // Per-event isolation. We `await` each handler to surface ordering
    // (LINE delivers events in order within a single batch) but wrap
    // each in try/catch so one failure cannot abort the rest.
    for (const ev of events) {
      try {
        await this.router.handle(ev as LineWebhookEvent);
      } catch (err) {
        // Sanitize the error: log only class + message, never stack
        // traces (which can echo headers / body fragments) and never
        // the event payload.
        const cls = (err as Error)?.constructor?.name ?? 'Error';
        const msg = (err as Error)?.message ?? 'unknown';
        const safeMsg = msg.replace(/[\r\n]/g, ' ').slice(0, 200);
        this.logger.error(
          `controller.event.failed type=${ev?.type ?? 'unknown'} ` +
            `reason=${cls}:${safeMsg} at=${new Date().toISOString()}`,
        );
        // SWALLOW. Do not re-throw — guarantees the outer 200.
      }
    }

    return { ok: true };
  }
}
