/**
 * line-messaging.service.ts — Wave 86 LINE Messaging API client wrapper.
 *
 * Outbound HTTP client for the LINE Reply API and Push API. Wraps axios
 * with:
 *   - lazy bearer-token resolution (`assertLineChannelAccessToken`)
 *   - structured W83-style logging (no plaintext tokens, replyTokens,
 *     LINE user ids, or message bodies in any log line)
 *   - exponential-backoff retry for 429 / 5xx classes
 *   - immediate failure (no retry) for 400 / 401 / 403 / 404
 *
 * This file replaces the Phase-1 stub. Consumers that imported
 * `LineMessagingService.replyText(replyToken, text)` continue to work
 * — the legacy two-arg signature is preserved as the no-quick-reply
 * variant of the new three-arg form.
 *
 * CLAUDE.md references:
 *
 *   - §17.2 advisory-only constraint. Outbound LINE messages are
 *     advisory: a Reply or Push delivery failure MUST NOT block any
 *     workflow transition. Callers (currently the future
 *     LineAiBridgeService in W86 Phase 3) treat this service as
 *     best-effort and log failures without rolling back upstream
 *     workflow state.
 *
 *   - §17.3 audit separation. This service NEVER writes to
 *     `tracking_status`. Outbound delivery state is observable only via
 *     log lines and (optionally, future wave) the `notification_logs`
 *     table — neither of which are workflow audit.
 *
 *   - §17.11 no role exemption. The bearer token is global to the OA
 *     channel; no role can elevate the channel's send permissions.
 *
 * LINE platform notes:
 *   - Reply API: free, but the `replyToken` expires ~30s after the
 *     originating webhook event. After expiry, LINE returns 400. We
 *     do NOT retry 400s — a stale reply token is unrecoverable, so
 *     burning retries is pointless.
 *   - Push API: billable in some plans, no time limit. Same retry
 *     policy applies.
 *   - Rate limit: ~2000 req/sec on free tier. Realistic OA bots run
 *     orders of magnitude below this; backoff is for transient blips,
 *     not steady-state throttling.
 *
 * Multicast / Broadcast / Narrowcast are intentionally NOT implemented
 * here — they are deferred to W87 and beyond. See `// TODO(W87)`.
 */

import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

/**
 * Local type aliases — avoids depending on axios's named type exports
 * which don't resolve cleanly under this project's `esModuleInterop=false`
 * tsconfig. `ReturnType<typeof axios.create>` gives us a fully typed
 * client without importing `AxiosInstance` directly.
 */
type AxiosClient = ReturnType<typeof axios.create>;

/** Duck-type narrow for axios errors that works regardless of TS module interop. */
interface AxiosErrorLike {
  isAxiosError: true;
  code?: string;
  name?: string;
  response?: { status?: number; data?: unknown };
}

function isAxiosErr(err: unknown): err is AxiosErrorLike {
  return (
    !!err &&
    typeof err === 'object' &&
    (err as { isAxiosError?: unknown }).isAxiosError === true
  );
}
import * as crypto from 'crypto';
import {
  LINE_MESSAGING_PUSH_URL,
  LINE_MESSAGING_REPLY_URL,
  assertLineChannelAccessToken,
} from './line.config';
import type {
  LineMessage,
  LinePushRequest,
  LineReplyRequest,
  LineTextMessage,
} from './interfaces/line-message.interface';
import type { LineQuickReplyItem } from './interfaces/line-quick-reply.interface';

/**
 * Maximum number of retry attempts for transient failures (429 / 5xx).
 * Total attempt count = `1 + RETRY_MAX_ATTEMPTS` (1 initial + up to
 * 3 retries = 4 total attempts).
 */
const RETRY_MAX_ATTEMPTS = 3;

/**
 * Base backoff in milliseconds. Actual delay = `BASE * 2 ** (attempt - 1)`,
 * so attempts use 250ms, 500ms, 1000ms — total worst-case latency under
 * 2 seconds for a fully-retried request.
 */
const RETRY_BASE_DELAY_MS = 250;

/**
 * HTTP timeout per attempt. LINE's API is sub-second under normal load;
 * a 10-second ceiling avoids holding the webhook handler past LINE's
 * 30-second reply-token TTL even on the worst-case retry path.
 */
const REQUEST_TIMEOUT_MS = 10_000;

@Injectable()
export class LineMessagingService {
  private readonly logger = new Logger(LineMessagingService.name);

  /**
   * Pre-configured axios instance. Bearer token is NOT baked in here —
   * we attach it per-request from `assertLineChannelAccessToken()` so
   * env-var rotation (operator action) takes effect on the next send
   * without a process restart.
   */
  private readonly http: AxiosClient;

  constructor() {
    this.http = axios.create({
      timeout: REQUEST_TIMEOUT_MS,
      // Important: validateStatus returns true for ALL codes so we
      // handle status-code branching ourselves below. Default axios
      // throws on non-2xx, which would obscure the 401-vs-429-vs-5xx
      // routing we need for retry decisions.
      validateStatus: () => true,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  // ---- Reply API --------------------------------------------------------

  /**
   * Send one or more messages in response to a webhook event.
   *
   * The `replyToken` is single-use and expires ~30 seconds after the
   * originating event. Callers MUST NOT retry a failed call with the
   * same token; a fresh user message is required to obtain a new token.
   *
   * On success, returns void. On unrecoverable failure (e.g. expired
   * token, malformed payload), throws after logging — the caller
   * decides whether to fall back to Push API.
   */
  async replyMessage(
    replyToken: string,
    messages: LineMessage[],
  ): Promise<void> {
    if (!replyToken || replyToken.trim().length === 0) {
      throw new Error('[LineMessaging] replyToken is required');
    }
    if (!messages || messages.length === 0) {
      throw new Error('[LineMessaging] at least one message is required');
    }

    const body: LineReplyRequest = { replyToken, messages };
    const tokenHash = this.shortHash(replyToken);

    await this.postWithRetry(
      LINE_MESSAGING_REPLY_URL,
      body,
      `messaging.reply`,
      {
        replyToken: tokenHash,
        messageCount: messages.length,
      },
    );

    this.logger.log(
      `messaging.reply.sent replyToken=${tokenHash} messageCount=${messages.length} at=${new Date().toISOString()}`,
    );
  }

  /**
   * Convenience helper: send a single text reply with optional Quick
   * Reply chips.
   *
   * Two-arg form `replyText(replyToken, text)` is preserved from the
   * Phase-1 stub for source-level compatibility with the
   * `LineEventRouterService` integration scaffolding.
   */
  async replyText(
    replyToken: string,
    text: string,
    quickReplyItems?: LineQuickReplyItem[],
  ): Promise<void> {
    const message = this.buildTextMessage(text, quickReplyItems);
    await this.replyMessage(replyToken, [message]);
  }

  // ---- Push API ---------------------------------------------------------

  /**
   * Send one or more messages to a LINE user out-of-band (no webhook
   * required). BILLABLE on some plans — callers should prefer
   * `replyMessage` whenever a webhook reply token is available.
   *
   * The `to` value MUST be the LINE user id (U-prefixed, ≤ 33 chars).
   * Callers SHOULD verify the recipient has an active
   * `line_user_bindings` row before invoking — sending to a user that
   * never linked is a TOS violation.
   */
  async pushMessage(
    toLineUserId: string,
    messages: LineMessage[],
  ): Promise<void> {
    if (!toLineUserId || toLineUserId.trim().length === 0) {
      throw new Error('[LineMessaging] toLineUserId is required');
    }
    if (!messages || messages.length === 0) {
      throw new Error('[LineMessaging] at least one message is required');
    }

    const body: LinePushRequest = { to: toLineUserId, messages };
    const recipientHash = this.shortHash(toLineUserId);

    await this.postWithRetry(
      LINE_MESSAGING_PUSH_URL,
      body,
      `messaging.push`,
      {
        to: recipientHash,
        messageCount: messages.length,
      },
    );

    this.logger.log(
      `messaging.push.sent to=${recipientHash} messageCount=${messages.length} at=${new Date().toISOString()}`,
    );
  }

  /**
   * Convenience helper: send a single text push with optional Quick
   * Reply chips.
   */
  async pushText(
    toLineUserId: string,
    text: string,
    quickReplyItems?: LineQuickReplyItem[],
  ): Promise<void> {
    const message = this.buildTextMessage(text, quickReplyItems);
    await this.pushMessage(toLineUserId, [message]);
  }

  // TODO(W87): multicast / broadcast / narrowcast. Deferred — these
  // require additional rate-limit accounting and an audience-id
  // management surface that does not yet exist.

  // ---- Internals --------------------------------------------------------

  /**
   * Compose a text Message object, attaching `quickReply` only when
   * the items array is present and non-empty. LINE rejects an empty
   * `quickReply.items[]`.
   */
  private buildTextMessage(
    text: string,
    quickReplyItems?: LineQuickReplyItem[],
  ): LineTextMessage {
    const message: LineTextMessage = { type: 'text', text };
    if (quickReplyItems && quickReplyItems.length > 0) {
      message.quickReply = { items: quickReplyItems };
    }
    return message;
  }

  /**
   * Core HTTP send with retry. Routes:
   *   - 2xx → success (return void)
   *   - 400 / 401 / 403 / 404 → throw immediately, no retry
   *   - 429 / 5xx → exponential backoff up to RETRY_MAX_ATTEMPTS retries
   *   - network error (no response) → treat like 5xx (transient)
   *
   * `logContext` is folded into the failure log line so operators can
   * correlate retries with the originating request without exposing
   * raw recipient ids or message bodies.
   */
  private async postWithRetry(
    url: string,
    body: unknown,
    opPrefix: string,
    logContext: Record<string, string | number>,
  ): Promise<void> {
    const accessToken = assertLineChannelAccessToken();
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    };

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS + 1; attempt++) {
      try {
        const response = await this.http.post(url, body, { headers });
        const status = response.status;

        if (status >= 200 && status < 300) {
          return;
        }

        // Non-retryable: client error indicating the request itself
        // is broken. Retrying does not help — fail fast.
        if (
          status === 400 ||
          status === 401 ||
          status === 403 ||
          status === 404
        ) {
          const reason = this.classifyStatus(status);
          this.logger.error(
            `${opPrefix}.failure status=${status} reason=${reason}:non-retryable attempt=${attempt} ${this.flatten(logContext)} at=${new Date().toISOString()}`,
          );
          throw new Error(
            `[LineMessaging] ${opPrefix} failed status=${status} reason=${reason}`,
          );
        }

        // Retryable: rate-limited or transient server error.
        if (status === 429 || status >= 500) {
          const reason = this.classifyStatus(status);
          this.logger.warn(
            `${opPrefix}.failure status=${status} reason=${reason}:retryable attempt=${attempt} ${this.flatten(logContext)} at=${new Date().toISOString()}`,
          );
          lastError = new Error(
            `[LineMessaging] ${opPrefix} transient status=${status} reason=${reason}`,
          );
          if (attempt <= RETRY_MAX_ATTEMPTS) {
            await this.sleep(this.backoffDelay(attempt));
            continue;
          }
          throw lastError;
        }

        // Any other status (e.g. 3xx redirects we did not opt in to,
        // unknown 4xx) → treat as non-retryable.
        const reason = this.classifyStatus(status);
        this.logger.error(
          `${opPrefix}.failure status=${status} reason=${reason}:unexpected attempt=${attempt} ${this.flatten(logContext)} at=${new Date().toISOString()}`,
        );
        throw new Error(
          `[LineMessaging] ${opPrefix} failed status=${status} reason=${reason}`,
        );
      } catch (err) {
        // Distinguish "axios threw because of a non-2xx" (cannot
        // happen here, validateStatus is permissive) from "axios
        // threw because of a network error / timeout / DNS".
        if (this.isAxiosNetworkError(err)) {
          this.logger.warn(
            `${opPrefix}.failure status=- reason=network:${this.errorClass(err)} attempt=${attempt} ${this.flatten(logContext)} at=${new Date().toISOString()}`,
          );
          lastError = err instanceof Error ? err : new Error(String(err));
          if (attempt <= RETRY_MAX_ATTEMPTS) {
            await this.sleep(this.backoffDelay(attempt));
            continue;
          }
          throw lastError;
        }
        // Non-network error — propagate (already logged above when it
        // was a status-routed throw).
        throw err;
      }
    }

    // Defensive — loop above always returns or throws.
    throw (
      lastError ??
      new Error(`[LineMessaging] ${opPrefix} exhausted retries`)
    );
  }

  private classifyStatus(status: number): string {
    if (status === 400) return 'bad-request';
    if (status === 401) return 'unauthorized';
    if (status === 403) return 'forbidden';
    if (status === 404) return 'not-found';
    if (status === 429) return 'rate-limited';
    if (status >= 500 && status < 600) return 'server-error';
    return `http-${status}`;
  }

  private errorClass(err: unknown): string {
    if (isAxiosErr(err)) {
      return err.code ?? err.name ?? 'AxiosError';
    }
    if (err instanceof Error) {
      return err.name || 'Error';
    }
    return 'Unknown';
  }

  private isAxiosNetworkError(err: unknown): boolean {
    if (!isAxiosErr(err)) return false;
    // No response means the request did not get an HTTP status — i.e.
    // network / DNS / timeout. With validateStatus permissive, axios
    // does not throw for non-2xx, so any thrown AxiosError is by
    // definition a transport-level failure.
    return !err.response;
  }

  private backoffDelay(attempt: number): number {
    return RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Short SHA-256 prefix used to identify a value in logs without
   * exposing it. 8 hex chars = 32 bits = enough collision room for
   * single-tenant correlation, far short of letting an operator
   * recover the original token / user id.
   */
  private shortHash(value: string): string {
    return (
      crypto
        .createHash('sha256')
        .update(value, 'utf8')
        .digest('hex')
        .slice(0, 8) + '...'
    );
  }

  private flatten(obj: Record<string, string | number>): string {
    return Object.entries(obj)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
  }
}
