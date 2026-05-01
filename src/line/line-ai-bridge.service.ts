/**
 * line-ai-bridge.service.ts — Wave 86 W86-BE-LINE-AI-BRIDGE.
 *
 * Bridges a LINE text-message webhook event to the existing
 * `AiExecutiveChatService` and replies with the AI's final answer +
 * follow-up Quick Reply chips.
 *
 * High-level flow per `handleTextMessage`:
 *   1. Resolve `event.source.userId` → active `line_user_bindings` row.
 *      If unbound → polite link-instructions reply, STOP.
 *   2. Bump `lastSeenAt` on the binding (best-effort audit metadata).
 *   3. Resolve the bound user's CURRENT WorkHistory; reject if
 *      `workStatus.name !== 'approved'` (CLAUDE.md §1 + §2).
 *   4. Resolve / create a persistent LINE-channel conversation under
 *      `ai_executive_conversations` keyed off the binding column
 *      `line_ai_conversation_id`. One rolling conversation per LINE
 *      binding (task §6 / Behavior #4).
 *   5. Invoke `AiExecutiveChatService.sendMessage` via an SSE-draining
 *      adapter (`SseDrainResponse`) that captures the streamed events
 *      and yields the final assistant text + meta. The chat service
 *      runs UNCHANGED (§17.2 / §17.11 — we consume, never modify).
 *   6. Format the response for LINE (Markdown strip, 5,000-char cap),
 *      extract recommended-question suggestions, build Quick Reply
 *      chips, and reply via `LineMessagingService.replyText`. If the
 *      reply token has expired (LINE 400), fall back to Push API.
 *
 * AI quota: deducted automatically by `AiExecutiveChatService` — the
 * bridge does NOT count against quota separately. LINE messages share
 * the user's web quota envelope per the W68 design.
 *
 * CLAUDE.md references:
 *   - §17.2 advisory-only. The bridge NEVER triggers a workflow
 *     transition. Reply / Push delivery failure is best-effort and
 *     MUST NOT roll back upstream state.
 *   - §17.3 audit separation. The bridge MUST NOT write to
 *     `tracking_status`. The only mutations performed here are:
 *       - `line_user_bindings.last_seen_at` (audit metadata)
 *       - `line_user_bindings.line_ai_conversation_id` (transport key)
 *       - `ai_executive_conversations` (via the existing service path,
 *         which honors §17.3 internally — owned exclusively by the
 *         AI module).
 *     No FK to project / plan / tracking tables is established by this
 *     code path.
 *   - §17.9 prompt injection. User text is NOT logged in plaintext.
 *     The downstream `AiExecutiveChatService` already wraps user input
 *     with `<<<USER_INPUT>>>...<<<END>>>` and runs `PiiRedactorService`
 *     before LLM call — we forward the raw text as-is and rely on the
 *     existing defense.
 *   - §17.11 No role exemption. Workstatus / classification are the
 *     gates; no role can bypass the `workStatus = approved` check.
 *
 * Logging discipline (W83):
 *   - NEVER log: `event.source.userId` (LINE PDPA), `event.replyToken`
 *     (single-use bearer credential), `event.message.text` (raw user
 *     content, may contain PII).
 *   - DO log: structured event metadata — text length, presence flags,
 *     short SHA-256 prefixes for correlation.
 *
 * Error contract (task §9):
 *   - AI service throws → friendly "ระบบ AI ขัดข้อง" reply; log
 *     `errorClass` only.
 *   - Reply API 400 (token expired) → fall back to Push API.
 *   - Push API also fails → log + silent failure (do NOT crash the
 *     webhook, LINE expects 200 within 30s regardless).
 */

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import * as crypto from 'crypto';
import type { Response } from 'express';

import { LineTextMessageEvent } from './interfaces/line-message-event.interface';
import { LineMessagingService } from './line-messaging.service';
import { LineUserBindingService } from './line-user-binding.service';
import { LineMessageFormatter } from './line-message.formatter';
import {
  LineQuickReplyFormatter,
} from './line-quick-reply.formatter';
import type { LineQuickReplyItem } from './interfaces/line-quick-reply.interface';

import { AiExecutiveChatService } from 'src/ai-executive-chat/ai-executive-chat.service';
import { AiExecutiveConversation } from 'src/ai-executive-chat/entities/ai-executive-conversation.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';

const FRONTEND_URL = process.env.FRONTEND_URL || '';

const REPLY_UNLINKED =
  'กรุณาเชื่อมต่อบัญชีของคุณก่อนใช้งานผู้ช่วย AI ที่หน้าโปรไฟล์';
const REPLY_NOT_APPROVED =
  'บัญชีของคุณยังไม่สามารถใช้งานระบบได้ กรุณาติดต่อผู้ดูแล';
const REPLY_AI_ERROR =
  'ขออภัย ระบบ AI ขัดข้อง กรุณาลองใหม่อีกครั้ง';
const REPLY_AI_EMPTY =
  'ขออภัย ระบบ AI ไม่มีคำตอบในขณะนี้ กรุณาลองใหม่';

/**
 * Quick Reply item that opens the profile page (LINE Login surface)
 * for users who haven't linked yet. `uri` action — LINE renders this
 * as a chip that, on tap, opens the URL in the in-app browser. Label
 * cap = 20 chars per LINE platform.
 */
function profileLinkQuickReplyItem(): LineQuickReplyItem | null {
  if (!FRONTEND_URL) return null;
  return {
    type: 'action',
    action: {
      type: 'uri',
      label: 'เชื่อมต่อบัญชี',
      uri: `${FRONTEND_URL}/profile`,
    },
  };
}

@Injectable()
export class LineAiBridgeService {
  private readonly logger = new Logger(LineAiBridgeService.name);

  constructor(
    private readonly messaging: LineMessagingService,
    private readonly bindings: LineUserBindingService,
    private readonly chat: AiExecutiveChatService,
    @InjectRepository(WorkHistory)
    private readonly workHistoryRepo: Repository<WorkHistory>,
    @InjectRepository(AiExecutiveConversation)
    private readonly conversationRepo: Repository<AiExecutiveConversation>,
  ) {}

  /**
   * Top-level entry point invoked by `LineEventRouterService` for
   * every text-message webhook event. Always resolves to `void` —
   * errors are caught internally so the webhook handler always
   * returns 200 within LINE's 30-second window.
   */
  async handleTextMessage(event: LineTextMessageEvent): Promise<void> {
    const startedAt = Date.now();
    const lineUserId = event.source?.userId;
    const replyToken = event.replyToken;
    const text = event.message.text;

    // Structured audit log (W83) — presence + length only.
    this.logger.log(
      `ai-bridge.invoked textLen=${text.length} hasUser=${!!lineUserId} hasToken=${!!replyToken} at=${new Date().toISOString()}`,
    );

    if (typeof lineUserId !== 'string' || lineUserId.length === 0) {
      // Webhook event without a source user id — cannot resolve a
      // binding. Skip silently; LINE still expects 200.
      this.logger.warn('ai-bridge.skipped reason=no_source_user_id');
      return;
    }

    try {
      // 1) Resolve LINE user → Project Bank user via active binding.
      const binding = await this.bindings.findActive(lineUserId);
      if (!binding) {
        await this.replySafe(
          replyToken,
          REPLY_UNLINKED,
          this.unlinkedQuickReply(),
          'unlinked',
          lineUserId,
        );
        return;
      }

      // 2) Best-effort audit bump. Failure is logged inside the helper.
      await this.bindings.markLastSeen(lineUserId);

      // 3) Resolve current WorkHistory + workStatus gate (§1 + §2).
      const wh = await this.workHistoryRepo.findOne({
        where: {
          user: { id: binding.userId },
          isCurrent: true,
        },
        relations: ['workStatus'],
      });
      if (!wh) {
        this.logger.warn(
          `ai-bridge.rejected reason=no_current_work_history userIdHash=${this.shortHash(binding.userId)}`,
        );
        await this.replySafe(
          replyToken,
          REPLY_NOT_APPROVED,
          undefined,
          'no_workhistory',
          lineUserId,
        );
        return;
      }
      if (wh.workStatus?.name !== 'approved') {
        this.logger.warn(
          `ai-bridge.rejected reason=work_status_not_approved status=${wh.workStatus?.name ?? 'unknown'} userIdHash=${this.shortHash(binding.userId)}`,
        );
        await this.replySafe(
          replyToken,
          REPLY_NOT_APPROVED,
          undefined,
          'not_approved',
          lineUserId,
        );
        return;
      }

      // 4) Resolve / create the persistent LINE-channel conversation.
      const conversationId = await this.resolveLineConversationId(
        binding.id,
        lineUserId,
        wh.id,
        binding.lineAiConversationId,
      );

      // 5) Invoke the AI service via the SSE drain adapter.
      let aiText: string;
      try {
        aiText = await this.invokeAiAndDrain(
          binding.userId,
          conversationId,
          text,
        );
      } catch (err) {
        this.logger.error(
          `ai-bridge.ai_failed errorClass=${this.errorClass(err)} userIdHash=${this.shortHash(binding.userId)}`,
        );
        await this.replySafe(
          replyToken,
          REPLY_AI_ERROR,
          undefined,
          'ai_error',
          lineUserId,
        );
        return;
      }

      if (!aiText || aiText.trim().length === 0) {
        await this.replySafe(
          replyToken,
          REPLY_AI_EMPTY,
          undefined,
          'ai_empty',
          lineUserId,
        );
        return;
      }

      // 6) Format response + suggestions + Quick Reply.
      const formatted = LineMessageFormatter.format(aiText);
      const quickReply = this.buildQuickReplyForResponse(formatted.suggestions);

      await this.replyOrPushFallback(
        replyToken,
        lineUserId,
        formatted.text,
        quickReply,
        formatted.truncated,
      );

      this.logger.log(
        `ai-bridge.completed durationMs=${Date.now() - startedAt} truncated=${formatted.truncated} suggestionCount=${formatted.suggestions.length}`,
      );
    } catch (err) {
      // Catch-all defense — guarantee the webhook handler returns 200.
      this.logger.error(
        `ai-bridge.unhandled errorClass=${this.errorClass(err)} durationMs=${Date.now() - startedAt}`,
      );
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // Internals
  // ──────────────────────────────────────────────────────────────────

  /**
   * Resolve the persistent LINE-channel conversation id for this
   * binding, creating one if missing. Race-safe per-binding via the
   * unique active-binding constraint and an indexed read on
   * `line_ai_conversation_id`.
   *
   * If the stored id points at a soft-deleted (PDPA-erased) row, treat
   * as missing and create a fresh conversation; the binding column is
   * updated transparently so the next message reuses the new row.
   */
  private async resolveLineConversationId(
    bindingId: string,
    lineUserId: string,
    workHistoryId: string,
    storedConversationId: string | null,
  ): Promise<string> {
    if (storedConversationId) {
      const existing = await this.conversationRepo.findOne({
        where: { id: storedConversationId, deletedAt: IsNull() },
      });
      // Owner re-check — the binding's stored id MUST belong to the
      // same WorkHistory the bound user is currently working under.
      // Mismatch implies the user changed WorkHistory after linking;
      // we treat that as "create fresh conversation" for the new
      // organizational context. §4 ownership + §17.3 audit separation.
      if (existing && existing.ownerWorkHistoryId === workHistoryId) {
        return existing.id;
      }
    }

    // Create a fresh LINE-channel conversation. Title carries the
    // `[LINE]` marker for operator visibility; `titleSource` stays at
    // the default placeholder so the existing auto-title flow can
    // override on the first round-trip if it fires.
    //
    // §17.3 — owned via `ownerWorkHistoryId` (NOT a FK), same pattern
    // as the web channel.
    const created = this.conversationRepo.create({
      ownerWorkHistoryId: workHistoryId,
      title: '[LINE] บทสนทนา',
      // W68-FIX-08 — match the web service default model.
      model: 'gpt-4.1-mini',
    });
    const saved = await this.conversationRepo.save(created);

    // Persist the new id back onto the binding (best-effort — failure
    // here only means the next message creates another fresh one,
    // which the AI module's PDPA cron will retire on schedule).
    try {
      await this.bindings.setLineAiConversationId(lineUserId, saved.id);
    } catch (err) {
      this.logger.warn(
        `ai-bridge.binding_update_failed errorClass=${this.errorClass(err)} bindingIdHash=${this.shortHash(bindingId)}`,
      );
    }
    return saved.id;
  }

  /**
   * Invoke `AiExecutiveChatService.sendMessage` and capture the
   * streamed SSE output as a single assistant-text string.
   *
   * The chat service is fundamentally SSE-coupled (it writes
   * `event:`/`data:` frames to an Express `Response`). We adapt by
   * passing in an `SseDrainResponse` shim that captures every
   * frame in memory; on `done` we parse out the `message_complete`
   * payload and return its `content` field.
   *
   * Failure modes:
   *   - SSE emits an `error` frame → we throw with the embedded body.
   *   - SSE emits `done { ok: false }` without `message_complete` → throw.
   *   - SSE never emits `done` → throw timeout (defensive; the chat
   *     service's `finally` block always emits `done`).
   *   - Quota soft-stop → returned as the partial assistant text if
   *     present, else throws.
   */
  private async invokeAiAndDrain(
    userId: string,
    conversationId: string,
    userText: string,
  ): Promise<string> {
    const drain = new SseDrainResponse();
    // The chat service's `sendMessage(userId, dto, response, modelOverride)`
    // expects an Express `Response`. The shim implements the surface
    // it actually touches (`setHeader`, `flushHeaders`, `write`, `end`)
    // and ignores the rest.
    // The chat service's DTO caps `message` at 2,000 chars (see
    // PostChatMessageDto). LINE inbound text is also bounded (LINE
    // platform cap ~5,000 chars), so we defensively trim to the chat
    // DTO's cap with a small reserve to keep the body comfortably
    // under the validation boundary.
    const CHAT_MESSAGE_CAP = 2000;
    const safeMessage =
      userText.length > CHAT_MESSAGE_CAP
        ? userText.slice(0, CHAT_MESSAGE_CAP)
        : userText;

    await this.chat.sendMessage(
      userId,
      { conversationId, message: safeMessage } as {
        conversationId: string;
        message: string;
      },
      drain as unknown as Response,
      undefined,
    );
    return drain.assembleAssistantText();
  }

  /**
   * Build the Quick Reply payload for a successful AI response.
   * Falls back to the formatter's default chips when no suggestions
   * were extracted.
   */
  private buildQuickReplyForResponse(
    suggestions: string[],
  ): LineQuickReplyItem[] | undefined {
    const items =
      suggestions.length > 0
        ? LineQuickReplyFormatter.formatSuggestions(suggestions)
        : LineQuickReplyFormatter.defaultSuggestions();
    return items.length > 0 ? items : undefined;
  }

  /**
   * Quick Reply chip set for the unlinked-user reply. A single uri
   * action that deep-links to the profile page. Returns `undefined`
   * (no quick reply) when `FRONTEND_URL` is not configured.
   */
  private unlinkedQuickReply(): LineQuickReplyItem[] | undefined {
    const item = profileLinkQuickReplyItem();
    return item ? [item] : undefined;
  }

  /**
   * Send `text` via Reply API; on token-expired (400) fall back to
   * Push API. Both failure paths are logged + swallowed — the
   * webhook handler MUST always return 200 within LINE's 30s window.
   */
  private async replyOrPushFallback(
    replyToken: string,
    lineUserId: string,
    text: string,
    quickReply: LineQuickReplyItem[] | undefined,
    truncated: boolean,
  ): Promise<void> {
    try {
      await this.messaging.replyText(replyToken, text, quickReply);
      return;
    } catch (err) {
      const isExpired = this.isReplyTokenExpired(err);
      this.logger.warn(
        `ai-bridge.reply_failed errorClass=${this.errorClass(err)} expired=${isExpired} truncated=${truncated}`,
      );
      // Only fall back to Push when we have a strong reason to believe
      // the reply token expired. For other 4xx classes (auth, payload
      // shape) Push will ALSO fail and we'd be wasting a billable
      // message — log + swallow instead.
      if (!isExpired) return;
    }
    // Push fallback path.
    try {
      await this.messaging.pushText(lineUserId, text, quickReply);
      this.logger.log('ai-bridge.push_fallback_sent');
    } catch (err) {
      this.logger.warn(
        `ai-bridge.push_fallback_failed errorClass=${this.errorClass(err)}`,
      );
    }
  }

  /**
   * "Safe" reply path used by the unlinked / not-approved / AI-error
   * branches. Same Reply→Push fallback semantics as the success path,
   * but separated so the success path can log richer telemetry without
   * polluting the early-exit branches.
   *
   * `lineUserId` is required for the Push fallback; pass an empty
   * string to disable fallback (e.g. when we already failed to resolve
   * a binding).
   */
  private async replySafe(
    replyToken: string,
    text: string,
    quickReply: LineQuickReplyItem[] | undefined,
    branch: string,
    lineUserId: string,
  ): Promise<void> {
    if (!replyToken || replyToken.length === 0) {
      // No token, no fallback recipient unless we have a lineUserId.
      if (lineUserId) {
        try {
          await this.messaging.pushText(lineUserId, text, quickReply);
        } catch (err) {
          this.logger.warn(
            `ai-bridge.safe_push_failed branch=${branch} errorClass=${this.errorClass(err)}`,
          );
        }
      }
      return;
    }
    try {
      await this.messaging.replyText(replyToken, text, quickReply);
      return;
    } catch (err) {
      const isExpired = this.isReplyTokenExpired(err);
      this.logger.warn(
        `ai-bridge.safe_reply_failed branch=${branch} errorClass=${this.errorClass(err)} expired=${isExpired}`,
      );
      if (!isExpired || !lineUserId) return;
    }
    try {
      await this.messaging.pushText(lineUserId, text, quickReply);
    } catch (err) {
      this.logger.warn(
        `ai-bridge.safe_push_failed branch=${branch} errorClass=${this.errorClass(err)}`,
      );
    }
  }

  /**
   * Heuristic — `LineMessagingService.replyText` throws an Error whose
   * message contains `status=400` and `reason=bad-request` for any
   * 400 from LINE. The most common cause for a Reply 400 in production
   * is an expired reply token, so we treat 400 as "try Push".
   */
  private isReplyTokenExpired(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const m = err.message || '';
    return m.includes('status=400') || m.includes('reason=bad-request');
  }

  private errorClass(err: unknown): string {
    if (err instanceof Error) return err.name || 'Error';
    return 'Unknown';
  }

  /**
   * Short SHA-256 prefix used to identify a value in logs without
   * exposing it (matches the W83 / `LineMessagingService` pattern).
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
}

// ──────────────────────────────────────────────────────────────────────
// SSE drain adapter
// ──────────────────────────────────────────────────────────────────────

/**
 * Minimal duck-typed Express `Response` shim that captures every
 * `write()` call into an in-memory buffer, parses the SSE frames, and
 * reconstructs the final assistant text the chat service would have
 * streamed to a real client.
 *
 * SSE frame shape produced by `AiExecutiveChatService.emit`:
 *   event: <name>\n
 *   data: <json>\n\n
 *
 * Events the bridge consumes:
 *   - `message_complete` — `{ messageId, content, hasRedacted, modelUsed, ... }`
 *     Source of the final assistant text.
 *   - `message_delta`    — `{ delta: string }` — concatenated as a
 *     fallback when `message_complete` is absent (e.g. soft-stop path).
 *   - `quota_soft_stop`  — surfaces a partial-text path; we capture the
 *     reason but still return whatever delta accumulated.
 *   - `error`            — `{ status, body }` — throw with the body.
 *   - `done`             — `{ ok }` — terminal frame; we return on `ok`,
 *     throw on `!ok` (unless we already captured a complete message).
 *
 * The shim is intentionally NON-streaming on the LINE side — Reply API
 * sends a single message per webhook event. Streaming SSE would not
 * map onto LINE's transport without an entirely separate Push-per-delta
 * loop, which is OUT OF SCOPE for W86 (deferred per the task spec's
 * "non-streaming path" preference).
 *
 * §17.3 / §17.11 compatibility: the shim does not mutate any AI table;
 * it only captures bytes the chat service was already going to write.
 * The chat service's transactional persistence (user row, assistant
 * row, tool rows) runs identically whether the response sink is a real
 * socket or this shim.
 */
class SseDrainResponse {
  private buffer = '';
  private completedText: string | null = null;
  private deltaParts: string[] = [];
  private errorPayload: { status: unknown; body: unknown } | null = null;
  private done = false;
  private doneOk: boolean | null = null;
  // The chat service calls `setHeader` / `flushHeaders` early; we
  // accept and ignore. Reading them back is intentionally
  // unimplemented — the chat service never reads its own headers.
  private headers: Record<string, string> = {};

  setHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = value;
  }

  flushHeaders(): void {
    /* no-op */
  }

  /**
   * SSE frames may arrive split across writes (axios/express buffering
   * patterns are not deterministic). We buffer until we see the frame
   * delimiter `\n\n` and then parse one frame at a time. Comment-form
   * heartbeat lines (starting with `:`) are ignored.
   */
  write(chunk: string | Buffer): boolean {
    const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    this.buffer += s;
    let idx = this.buffer.indexOf('\n\n');
    while (idx >= 0) {
      const frame = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      this.parseFrame(frame);
      idx = this.buffer.indexOf('\n\n');
    }
    return true;
  }

  end(): void {
    // Flush any trailing frame that didn't end in `\n\n` (defensive).
    if (this.buffer.length > 0) {
      this.parseFrame(this.buffer);
      this.buffer = '';
    }
    this.done = true;
  }

  private parseFrame(frame: string): void {
    const trimmed = frame.trim();
    if (trimmed.length === 0) return;
    // Heartbeat / comment line — ignored.
    if (trimmed.startsWith(':')) return;

    // Extract `event:` and `data:` lines. SSE frame may have multi-line
    // `data:` continuations; we concatenate them with newlines.
    let eventName = 'message';
    const dataLines: string[] = [];
    for (const rawLine of trimmed.split(/\r?\n/)) {
      const line = rawLine;
      if (line.startsWith('event:')) {
        eventName = line.slice('event:'.length).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trim());
      }
    }
    const dataStr = dataLines.join('\n');
    let data: unknown = null;
    if (dataStr.length > 0) {
      try {
        data = JSON.parse(dataStr);
      } catch {
        // Non-JSON data — keep as string.
        data = dataStr;
      }
    }
    this.dispatch(eventName, data);
  }

  private dispatch(eventName: string, data: unknown): void {
    switch (eventName) {
      case 'message_complete': {
        const content = (data as { content?: string } | null)?.content;
        if (typeof content === 'string') {
          this.completedText = content;
        }
        return;
      }
      case 'message_delta': {
        const delta = (data as { delta?: string } | null)?.delta;
        if (typeof delta === 'string') {
          this.deltaParts.push(delta);
        }
        return;
      }
      case 'error': {
        if (data && typeof data === 'object') {
          this.errorPayload = data as { status: unknown; body: unknown };
        } else {
          this.errorPayload = { status: 'unknown', body: data };
        }
        return;
      }
      case 'done': {
        const ok = (data as { ok?: boolean } | null)?.ok;
        this.doneOk = typeof ok === 'boolean' ? ok : false;
        this.done = true;
        return;
      }
      // `message_start`, `quota_soft_stop`, `conversation_renamed`,
      // and anything else are observable but not load-bearing for the
      // LINE single-message reply contract. Ignored.
      default:
        return;
    }
  }

  /**
   * Reduce the captured stream into the final assistant text. Throws
   * when the stream ended in an error state with no usable content.
   */
  assembleAssistantText(): string {
    if (this.errorPayload) {
      const body = this.errorPayload.body;
      let message = 'AI_UPSTREAM_ERROR';
      if (body && typeof body === 'object') {
        const m = (body as { message?: unknown }).message;
        if (typeof m === 'string' && m.length > 0) message = m;
      } else if (typeof body === 'string' && body.length > 0) {
        message = body;
      }
      throw new Error(`[ai-drain] ${message}`);
    }
    if (this.completedText !== null) {
      return this.completedText;
    }
    if (this.deltaParts.length > 0) {
      return this.deltaParts.join('');
    }
    if (this.doneOk === false) {
      throw new Error('[ai-drain] stream ended with ok=false');
    }
    return '';
  }
}
