import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  IsNull,
  Repository,
} from 'typeorm';
import type { Response } from 'express';
import { createHash } from 'crypto';

import {
  LLM_CLIENT,
  LlmClient,
  ChatCompletionParamsNonStreaming,
} from 'src/ai/llm/llm-client.interface';
import type { OpenAI } from 'openai';

import { AiUsageQuotasService } from 'src/ai-usage-quotas/ai-usage-quotas.service';
import { QuotaOrgCapService } from 'src/ai-usage-quotas/quota-org-cap.service';
import { AiQuotaGuard } from 'src/ai-usage-quotas/guards/ai-quota.guard';
import { calculateAiCost } from 'src/ai/utils/cost-calculator';

import { PiiRedactorService } from 'src/common/pii/pii-redactor.service';
import { EXECUTIVE_CHAT_TOOL_RESULT_POLICY } from 'src/common/pii/field-policies';
import type { PiiRedactionCounts } from 'src/common/pii/pii-patterns';

import { WorkHistory } from 'src/work-history/entities/work-history.entity';

import { AiExecutiveConversation } from './entities/ai-executive-conversation.entity';
import {
  AiChatRole,
  AiExecutiveMessage,
} from './entities/ai-executive-message.entity';

import { PostChatMessageDto } from './dto/send-message.dto';
import {
  ChatConversationSummaryDto,
  ChatMessageDto,
} from './dto/conversation.dto';

import {
  EXECUTIVE_CHAT_SYSTEM_PROMPT,
  EXECUTIVE_CHAT_TOOL_INSTRUCTIONS,
} from './prompts/executive-chat-system-prompt';
import { TITLE_GENERATION_SYSTEM_PROMPT } from './prompts/title-generation-prompt';
import {
  EXECUTIVE_TOOL_REGISTRY,
  getExecutiveToolSpec,
} from './tools/tool-registry';
import {
  ExecutiveToolName,
  ExecutiveToolSpec,
} from './tools/executive-tool.types';
import {
  parseToolCallArguments,
  validateAgainstSchema,
} from './tools/tool-schema-validator';
import { EXECUTIVE_TOOL_HANDLERS } from './tools/handlers/executive-tool-handlers';
import {
  ExecutiveCallerContext,
  ExecutiveToolHandlerDeps,
} from './tools/handlers/handler-types';
import { extractTargetFromToolResult } from './tools/extract-target';
import type { AiResultTargetKind } from 'src/ai/utils/ai-score-envelope';
// Wave 54 BE-W54-06 — Tier B aggregation service tokens + interfaces.
// Injected here so `invokeTool` can hand the 5 service instances to
// every Tier C handler via the shared `ExecutiveToolHandlerDeps` bag.
// §17.11 belt-and-braces still runs inside each handler; this wiring
// merely makes the services reachable.
import {
  AGENCY_ENRICHMENT,
  BUDGET_AGGREGATOR,
  GEO_ENRICHMENT,
  RESILIENCE_ENVELOPE,
  STATUS_AGGREGATOR,
  UNIFIED_PROJECT_AGGREGATOR,
} from './aggregation/tokens';
import { ProjectLineageService } from './aggregation/services/project-lineage.service';
import type {
  IAgencyEnrichment,
  IBudgetAggregator,
  IGeoEnrichment,
  IResilienceEnvelope,
  IStatusAggregator,
  IUnifiedProjectAggregator,
} from './aggregation/interfaces';

/**
 * AiExecutiveChatService — Wave 44 / BE-W44-02.
 *
 * Owns the SSE turn handler for `POST /v1/ai/executive-chat/messages`.
 * Controller validates DTO, runs the guard chain, and delegates here.
 *
 * CLAUDE.md references:
 *   - §4.1 / §17.2  — advisory; this service NEVER writes to
 *                     `tracking_status` and NEVER mutates project rows.
 *   - §17.3         — `ai_executive_messages` has NO FK into project /
 *                     plan / tracking tables. Only intra-AI FK is to
 *                     `ai_executive_conversations`.
 *   - §17.4         — snapshot-only is a MODULE-LEVEL invariant post
 *                     Wave 52 (column dropped by DB-W52-01; see
 *                     `SNAPSHOT_ONLY_INVARIANT` below). Read envelopes
 *                     unconditionally force `isStale: false`.
 *   - §17.7 / §16.5 — tool handlers branch on `reportFormat`; this
 *                     service does NOT inspect classification fields.
 *   - §17.8         — the cooldown guard runs ONCE at controller
 *                     admission. This service does NOT arm cooldown
 *                     mid-turn. The per-hop `checkMidTurn` is a QUOTA
 *                     gate, not a cooldown gate.
 *   - §17.9         — user text and tool results are wrapped with
 *                     `<<<USER_INPUT>>>…<<<END_USER_INPUT>>>` and
 *                     `<<<TOOL_RESULT name="X">>>…<<<END_TOOL_RESULT>>>`.
 *                     Schema drift on a tool_call is a 502
 *                     `AI_SCHEMA_DRIFT`, never silent coerce.
 *   - §17.11        — role + workStatus is re-asserted inside every
 *                     tool handler via `assertExecutiveRole`
 *                     (belt-and-braces after the controller guard).
 */

// ────────────────────────────────────────────────────────────────────
// Types — intentionally narrow local aliases so we never need to
// import the full OpenAI SDK namespace into the service body.
// ────────────────────────────────────────────────────────────────────

type ChatMessageParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ChatToolDefinition = OpenAI.Chat.Completions.ChatCompletionTool;
type ChatCompletionChoice =
  OpenAI.Chat.Completions.ChatCompletion.Choice;

// W68-FIX-02 (2026-04-28) — reduced from 8192 → 4096 to fit under
// the org's 30k TPM ceiling. Tool result snippets > 4KB get
// preview-truncated by the existing TOOL_RESULT_MAX_BYTES gate.
// §17.9 still allows large raw result payloads; we truncate before
// re-entering the prompt to protect both token budget and
// context-window pressure.
const TOOL_RESULT_MAX_BYTES = 4 * 1024;
const MAX_HOPS = 6;
// W68-FIX-02 (2026-04-28) — reduced from 20 → 8. The chat keeps the
// full conversation in DB; only the LAST 8 messages enter the LLM
// prompt (system + tool definitions + tool results dominate the
// budget; older history is the cheapest cut). Single-turn TPM
// regression dropped ~3-5k tokens.
const CONTEXT_MESSAGE_CAP = 8;
const HEARTBEAT_MS = 15_000;

// W68-FIX-01 (2026-04-28) — `PER_HOP_ESTIMATE_THB` removed. The constant
// previously fed a hop-based cost estimate in `deductPostTurnUsage` that
// under-charged executive-chat usage by ~12× because the formula
// `(hops || 1) * PER_HOP_ESTIMATE_THB * 0.03` ignored real OpenAI token
// counts. The real cost is now derived from `calculateAiCost(model,
// usage)`, matching every other caller of `quotaService.checkAndLogUsage`
// across the codebase. See W68-FIX-01 task notes for the full RCA.

// W68-FIX-02 (2026-04-28) — executive-chat default model switched from
// `gpt-4o` → `gpt-4o-mini`. Production hit OpenAI 429 at hop 3 (33,125
// tokens > 30,000 TPM ceiling). Mini has a much higher TPM headroom on
// our org account and is ~16× cheaper input / ~16× cheaper output per
// the `cost-calculator` pricing map. Combined with the
// TOOL_RESULT_MAX_BYTES (8KB → 4KB) and CONTEXT_MESSAGE_CAP (20 → 8)
// trims above, the hop-3 token budget drops from ~33k to ~24-28k.
// The auto-title path was already on `gpt-4o-mini` (Wave 51) and is
// unchanged. Q1-A is scoped to executive-chat ONLY — other AI services
// (`ai.service.ts`, `staff-review-prompt.service.ts`,
// `document-analysis.service.ts`) are out of scope.

// W68-FIX-04 (2026-04-28) — REVERTED W68-FIX-02 because gpt-4o-mini
// regressed agency filtering, classification labels, and multi-rule
// prompt fidelity in production. Default returned to `gpt-4o` while
// ops requested higher TPM headroom from OpenAI. SUPERSEDED by
// W68-FIX-08 below.

// W68-FIX-08 (2026-04-28) — executive-chat default model switched
// from `gpt-4o` → `gpt-4.1-mini`, and the auto-downgrade target moved
// from `gpt-4o-mini` → `gpt-4.1-nano`. Rationale:
//   - gpt-4o still hits the 30k TPM ceiling at hop 2 of multi-tool
//     loops (47,954-token requests observed in the RF trace).
//   - gpt-4.1-mini publishes 200k+ TPM, exposes a 1M-token context
//     window, and is ~6× cheaper than gpt-4o ($0.40 in / $1.60 out
//     vs $2.50 / $10.00 per 1M).
//   - gpt-4.1-mini's instruction-following sits very close to gpt-4o
//     and well above gpt-4o-mini — the W68-FIX-04 regression set
//     re-tested clean.
//   - gpt-4.1-nano ($0.10 / $0.40) replaces 4o-mini as the cheap
//     last-mile fallback once the user has consumed ≥80% of quota
//     (see `quota-model-override.ts`).
// Five service-level sites flipped:
//   1. runToolLoop initial `meta.modelUsed` fallback
//   2. mid-turn auto-downgrade trigger (mini → nano detection)
//   3. resolveConversation new-conversation `model` column
//   4. persistToolRound row `model` column
//   5. deductPostTurnUsage `calculateAiCost` fallback literal
// Auto-title (line ~1820) STAYS at `gpt-4o-mini` per Wave 51 design;
// auto-title is a separate concern from main chat. Other AI services
// (`ai.service.ts`, `staff-review-prompt.service.ts`,
// `document-analysis.service.ts`) remain on gpt-4o for non-chat use
// cases and are intentionally out of scope.

// BE-W46-01 — defensive caps for the two read endpoints. §17.11 treats
// these as integrity invariants, not permissions; no role coerces past
// them. Pagination beyond the cap is a future-wave concern (RCA §6.1).
const LIST_CONVERSATIONS_LIMIT = 200;
const LIST_MESSAGES_LIMIT = 500;
const LAST_MESSAGE_PREVIEW_MAX_CHARS = 120;

/**
 * BE-W45-01 — `target_id` / `target_kind` semantics for chat rows.
 *
 * The Wave 44 HOTFIX-W44-01 sentinel writes
 * (`target_id = '00000000-…-000'`, `target_kind = 'project-group'` on
 * every row) have been REMOVED. The columns now carry real meaning:
 *
 *   - `user` rows → always NULL / NULL (a user prompt is not "about" a
 *     specific project; the turn may never name one).
 *   - `tool` rows → populated ONLY when the tool result resolves to
 *     exactly one project (via `extractTargetFromToolResult`). Tools
 *     that return aggregates, buckets, or multi-row arrays write NULL.
 *   - `assistant` rows (final and soft-stop) → inherit the most recent
 *     non-null tool target within the SAME turn. If no tool round in
 *     the turn captured a target, the assistant row writes NULL.
 *
 * Pre-flight requirement (DB-W45-01): both columns MUST be nullable on
 * the target environment before this code ships. The bootstrap DDL hook
 * in `bootstrap-migrations.service.ts` enforces this on every warm
 * boot; the canonical migration lives in DB-W45-01.
 *
 * §17.3 audit separation is UNCHANGED — still NO foreign key from
 * `ai_executive_messages.target_id` into any project table. The column
 * is plain-UUID metadata used exclusively for analytics.
 *
 * Legacy Wave 44 rows may still carry the zero-UUID sentinel; analytics
 * consumers SHOULD filter `target_id <> '00000000-0000-0000-0000-000000000000'`
 * (or wait for the optional DB-W45-01 backfill).
 */

/**
 * Wave 52 BE-W52-03 — §17.4 snapshot-only is now a MODULE-LEVEL invariant,
 * not a per-row column. Every read path in this module MUST force
 * `isStale: false`. The persist helpers MUST NOT write any field that was
 * dropped by migration 1748000000000 (score_0_100, band, result_json,
 * computed_by_work_history_id, updated_at, staleness_policy). See RCA at
 * docs/reports/wave52/WAVE52_CHAT_AI_DECOUPLING_RCA.md §4.
 *
 * Prior to Wave 52, every persisted row carried
 * `staleness_policy = 'snapshot-only'` as a per-row column. That column
 * was dropped in DB-W52-01 because chat has exactly one writer (this
 * service) and exactly one reader (`toMessageDto`), both of which enforce
 * the invariant by construction:
 *
 *   - this service is the ONLY writer of `ai_executive_messages` rows
 *   - `toMessageDto` hard-codes `isStale: false` on every served row
 *
 * The constant + JSDoc below turn §17.4 into a module-level integrity
 * guarantee: it is IMPOSSIBLE for a chat row to escape with a
 * non-snapshot-only semantic, because the semantic is not stored — it is
 * implicit in the module.
 *
 * Cited §§: §17.2 (advisory), §17.4 (snapshot-only), §17.11 (no role
 * exemption — structurally enforced; no runtime role check can bypass).
 */
const SNAPSHOT_ONLY_INVARIANT = Object.freeze({
  isStale: false as const,
} as const);

interface TurnPersistenceSeed {
  conversationId: string;
  userMessageId: string;
  /**
   * Base turn index captured at the start of this turn — equals the
   * count of non-deleted rows in the conversation BEFORE this turn's
   * user row was written. Per-row hashes downstream bump this by their
   * own offset (user=0, first assistant/tool=1, …) so every row gets
   * a distinct, deterministic `content_hash` per §17.4.
   */
  turnBaseIndex: number;
}

interface AssistantTurnMeta {
  finishReason: string;
  modelUsed: string;
  wasDowngraded: boolean;
  hops: number;
  softStopReason?: string;
}

@Injectable()
export class AiExecutiveChatService {
  private readonly logger = new Logger(AiExecutiveChatService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(AiExecutiveConversation)
    private readonly conversationRepo: Repository<AiExecutiveConversation>,
    @InjectRepository(AiExecutiveMessage)
    private readonly messageRepo: Repository<AiExecutiveMessage>,
    @InjectRepository(WorkHistory)
    private readonly workHistoryRepo: Repository<WorkHistory>,
    @Inject(LLM_CLIENT) private readonly llmClient: LlmClient,
    private readonly piiRedactor: PiiRedactorService,
    private readonly quotaService: AiUsageQuotasService,
    private readonly orgCapService: QuotaOrgCapService,
    // Wave 54 BE-W54-06 — Tier B aggregation services. Resolved by
    // `AggregationModule` via DI tokens so consumers depend on the
    // interface contract, not the concrete class.
    @Inject(UNIFIED_PROJECT_AGGREGATOR)
    private readonly unifiedProject: IUnifiedProjectAggregator,
    @Inject(BUDGET_AGGREGATOR)
    private readonly budget: IBudgetAggregator,
    @Inject(STATUS_AGGREGATOR)
    private readonly status: IStatusAggregator,
    @Inject(GEO_ENRICHMENT)
    private readonly geo: IGeoEnrichment,
    @Inject(AGENCY_ENRICHMENT)
    private readonly agency: IAgencyEnrichment,
    // Wave 54 BE-W54-07 — resilience envelope for dimension fallback.
    @Inject(RESILIENCE_ENVELOPE)
    private readonly resilience: IResilienceEnvelope,
    // Wave 61 — Mode 3 lineage service. Read-only (§17.2 / §17.3).
    private readonly projectLineage: ProjectLineageService,
  ) {}

  // ────────────────────────────────────────────────────────────────
  // Public API — SSE endpoint
  // ────────────────────────────────────────────────────────────────

  /**
   * Main SSE handler. Guard chain (JwtAuthGuard → ExecutiveRoleGuard →
   * AiQuotaGuard → AiCooldownGuard) has already run at the controller
   * layer. The caller has been authenticated and their quota/model
   * override written to `req.aiModelOverride`.
   *
   * `response` is the raw Express response — we stream SSE bytes on it
   * and `return` only after the final `event: done` has been flushed.
   */
  async sendMessage(
    userId: string,
    dto: PostChatMessageDto,
    response: Response,
    modelOverride?: string,
  ): Promise<void> {
    // Resolve caller identity (WorkHistory + role). Mirrors the
    // `ExecutiveRoleGuard` load so the service can re-assert §17.11.
    const caller = await this.loadCallerContext(userId);

    // Initialise SSE transport. `X-Accel-Buffering: no` defeats Nginx
    // response buffering; `Cache-Control: no-cache` prevents any
    // intermediary from holding the stream.
    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders?.();

    const heartbeat = setInterval(() => {
      // Comment-form SSE event; ignored by EventSource but keeps the
      // connection alive under aggressive proxy timeouts.
      try {
        response.write(': heartbeat\n\n');
      } catch {
        // Socket torn down; the finally block will clear the interval.
      }
    }, HEARTBEAT_MS);

    // Captured post-commit so the `done` frame can reflect the final
    // meta even though the transaction that wrote the assistant row is
    // already closed. Returned from `dataSource.transaction(...)` rather
    // than captured via closure assignment — TS control-flow analysis
    // cannot see closure writes, so a closure-assigned `let` would
    // narrow to `never` at the post-commit `if` check (TS2339 trap).
    let finalMetaForDone: AssistantTurnMeta | null = null;

    try {
      // Conversation resolve / create. Ownership is enforced here.
      // This runs OUTSIDE the turn transaction — it's a one-time
      // container setup and must not be rolled back by a mid-turn LLM
      // failure. The conversation row is owner-scoped and its creation
      // is independently idempotent-by-intent.
      const conversation = await this.resolveConversation(
        dto.conversationId,
        caller.workHistoryId,
      );

      // Build the working message window BEFORE the transaction so
      // history reads are not held under the turn lock.
      const history = await this.loadRecentHistory(conversation.id);
      const userRedaction = this.piiRedactor.redactText(dto.message, {
        endpoint: 'executive-chat',
      });
      const redactedUser = userRedaction.output;
      // Wave 44 C3 / M1 — FE `SseMessageComplete.hasRedacted` chip.
      // True when ANY of the six PII regex classes fired on the user
      // text or any tool result replayed into the prompt.
      const redactionTotals = { ...userRedaction.counts };
      const wrappedUser = this.wrapUserInput(redactedUser);

      const llmMessages: ChatMessageParam[] = [
        { role: 'system', content: EXECUTIVE_CHAT_SYSTEM_PROMPT },
        { role: 'system', content: EXECUTIVE_CHAT_TOOL_INSTRUCTIONS },
        ...history,
        { role: 'user', content: wrappedUser },
      ];
      const tools = this.buildToolDefinitions();

      // ─────────────────────────────────────────────────────────────
      // TURN TRANSACTION (BE-W44-02.1 requirement #2)
      //
      // Wire-vs-persistence split (§17.3 audit separation):
      //   The SSE `message_start` frame is emitted WHILE the transaction
      //   is still open, so the FE sees its own bubble land immediately.
      //   SSE is not transactional; it is ADVISORY UX. The persisted
      //   row state is all-or-nothing: if the LLM throws (or any
      //   assistant/tool persist write fails), the transaction rolls
      //   back and NO user row is left behind. The FE then receives an
      //   `error` + `done{ok:false}` pair in the catch block below and
      //   can retry cleanly. There is no `assistant-error` placeholder
      //   row by design — the stronger audit invariant ("no orphan
      //   user rows") overrides the weaker UX wish ("error row visible
      //   on history reload"). See BE-W44-02.1 report deviation note.
      // ─────────────────────────────────────────────────────────────
      finalMetaForDone = await this.dataSource.transaction<AssistantTurnMeta>(async (manager) => {
        // Snapshot the turn base index under the transaction so every
        // row-hash downstream is deterministic and monotonically unique.
        const turnBaseIndex = await manager
          .getRepository(AiExecutiveMessage)
          .count({ where: { conversationId: conversation.id } });

        // §17.4 idempotency guard (task §7.4). If the exact same
        // NFC-normalised user payload landed in this conversation in
        // the last 30 seconds, reuse that row id rather than inserting
        // a duplicate. The hash MUST match `rowHash` below with the
        // SAME `turnBaseIndex` — so the re-use window is bounded by
        // "no other rows have been written since".
        const userPayloadHash = this.rowHash({
          conversationId: conversation.id,
          role: 'user',
          turnIndex: turnBaseIndex,
          normalizedPayload: dto.message,
        });

        let userMessage: AiExecutiveMessage;
        const cutoff = new Date(Date.now() - 30_000);
        const existing = await manager
          .getRepository(AiExecutiveMessage)
          .createQueryBuilder('m')
          .where('m.conversation_id = :cid', { cid: conversation.id })
          .andWhere('m.role = :role', { role: 'user' })
          .andWhere('m.content_hash = :hash', { hash: userPayloadHash })
          .andWhere('m.created_at >= :cutoff', { cutoff })
          .andWhere('m.deleted_at IS NULL')
          .orderBy('m.created_at', 'DESC')
          .getOne();

        if (existing) {
          userMessage = existing;
        } else {
          userMessage = await this.persistUserMessage(
            manager,
            conversation.id,
            caller.workHistoryId,
            dto.message,
            userPayloadHash,
            turnBaseIndex,
          );
        }

        // Wave 44 C3 — field name aligned with FE
        // `SseMessageStart.messageId`. Emitted BEFORE commit so the
        // user bubble appears immediately; on rollback the FE will
        // still see `error` + `done{ok:false}` next.
        this.emit(response, 'message_start', {
          conversationId: conversation.id,
          messageId: userMessage.id,
        });

        const seed: TurnPersistenceSeed = {
          conversationId: conversation.id,
          userMessageId: userMessage.id,
          turnBaseIndex,
        };

        // Run the tool-call loop inside the same transaction so
        // assistant/tool rows are all-or-nothing with the user row.
        const finalMeta = await this.runToolLoop(
          manager,
          llmMessages,
          tools,
          caller,
          seed,
          response,
          modelOverride,
          redactionTotals,
          redactedUser,
        );
        return finalMeta;
      });

      if (finalMetaForDone) {
        // Wave 44 C3 / M2 — FE `SseDoneFrame` reads `modelUsed` and
        // `wasDowngraded` to drive the `ModelDowngradeChip`. Include
        // `finishReason` for completeness per Wave 44 design notes.
        this.emit(response, 'done', {
          ok: true,
          modelUsed: finalMetaForDone.modelUsed,
          wasDowngraded: finalMetaForDone.wasDowngraded,
          finishReason: finalMetaForDone.finishReason,
        });
      }
    } catch (err) {
      this.logger.error(
        `[executive-chat] turn failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      const status =
        err instanceof HttpException ? err.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
      const body =
        err instanceof HttpException
          ? err.getResponse()
          : { code: 'INTERNAL_ERROR', message: 'ระบบขัดข้องชั่วคราว' };
      this.emit(response, 'error', { status, body });
      this.emit(response, 'done', { ok: false });
    } finally {
      clearInterval(heartbeat);
      try {
        response.end();
      } catch {
        /* socket already closed */
      }
    }
  }

  // ────────────────────────────────────────────────────────────────
  // BE-W46-01 — Owner-scoped conversation / message read API.
  //
  // Replaces the Wave 44 stub endpoints. Both methods go through
  // `loadCallerContext` so ownership is always resolved from the
  // caller's CURRENT WorkHistory (§4), NEVER from `userId` alone.
  //
  // §17.2  advisory — these reads never gate any workflow transition.
  // §17.3  audit separation — queries stay inside the `ai_*` boundary;
  //        no JOIN to project / plan / tracking tables.
  // §17.4  snapshot-only — `ChatMessageDto.isStale` is forced `false`
  //        on every returned row; content_hash drift is irrelevant.
  // §17.11 no role exemption — there is no admin / super-admin bypass
  //        here; cross-owner reads are an integrity violation, not a
  //        permission check, and cannot be overridden by role.
  // ────────────────────────────────────────────────────────────────

  /**
   * Controller-facing variant — resolves the caller's current
   * WorkHistory id from `userId` and delegates to the inner
   * `workHistoryId`-typed method. Mirrors the userId→workHistoryId
   * contract used by `sendMessage` (service:205+).
   */
  async listConversationsForOwnerByUserId(
    userId: string,
  ): Promise<ChatConversationSummaryDto[]> {
    const caller = await this.loadCallerContext(userId);
    return this.listConversationsForOwner(caller.workHistoryId);
  }

  /**
   * Returns the caller's active conversations ordered by most-recent
   * activity. Soft-deleted rows are excluded. Capped at
   * `LIST_CONVERSATIONS_LIMIT` rows (defensive DoS cap).
   *
   * Query shape — two-query pattern (documented in BE-W46-01 report):
   *   1) List conversations for the owner (indexed read on
   *      `ix_ai_executive_conversations_owner_updated`).
   *   2) Single grouped message query over the N conversation ids
   *      producing both `messageCount` and the last user/assistant
   *      preview via `DISTINCT ON (conversation_id)` + a `COUNT(*)`
   *      GROUP BY. This is two round-trips regardless of N, giving
   *      O(C + M) total work where C ≤ 200 and M is the total number
   *      of non-deleted messages across those C conversations.
   *
   * A single-query `LATERAL JOIN` form was considered but rejected:
   * the two-query form is more readable, reuses the existing
   * `messageRepo` query-builder idiom, and keeps the preview and
   * count derivations explicit. Both are indexed by
   * `ix_ai_executive_messages_conversation_created`.
   */
  async listConversationsForOwner(
    workHistoryId: string,
  ): Promise<ChatConversationSummaryDto[]> {
    // Query A — indexed owner scope + soft-delete filter, ordered by
    // most-recent activity with a stable tiebreaker.
    const conversations = await this.conversationRepo
      .createQueryBuilder('c')
      .where('c.owner_work_history_id = :whId', { whId: workHistoryId })
      .andWhere('c.deleted_at IS NULL')
      .orderBy('c.updated_at', 'DESC', 'NULLS LAST')
      .addOrderBy('c.created_at', 'DESC')
      .limit(LIST_CONVERSATIONS_LIMIT)
      .getMany();

    if (conversations.length === 0) return [];
    const ids = conversations.map((c) => c.id);

    // Query B — message count per conversation (includes all roles per
    // DTO doc at dto/conversation.dto.ts:30-31).
    const countRows = await this.messageRepo
      .createQueryBuilder('m')
      .select('m.conversation_id', 'conversationId')
      .addSelect('COUNT(*)::int', 'n')
      .where('m.conversation_id IN (:...ids)', { ids })
      .andWhere('m.deleted_at IS NULL')
      .groupBy('m.conversation_id')
      .getRawMany<{ conversationId: string; n: number }>();
    const countByConv = new Map<string, number>(
      countRows.map((r) => [r.conversationId, Number(r.n) || 0]),
    );

    // Query C — last non-deleted user/assistant message per
    // conversation for the preview. System/tool turns are excluded
    // from preview per RCA §6.1 + task §6.1 bullet 3.
    const previewRows = await this.messageRepo
      .createQueryBuilder('m')
      .select('DISTINCT ON (m.conversation_id) m.conversation_id', 'conversationId')
      .addSelect('m.content_text', 'contentText')
      .where('m.conversation_id IN (:...ids)', { ids })
      .andWhere('m.deleted_at IS NULL')
      .andWhere('m.role IN (:...roles)', { roles: ['user', 'assistant'] })
      .orderBy('m.conversation_id')
      // Wave 50 BE-W50-01 — pick the latest message per conversation by
      // `turn_index DESC`. Closes RCA §2.3 G7: two messages sharing a
      // ms-precise `created_at` could previously flip the preview.
      .addOrderBy('m.turn_index', 'DESC')
      .getRawMany<{ conversationId: string; contentText: string | null }>();
    const previewByConv = new Map<string, string | null>(
      previewRows.map((r) => [
        r.conversationId,
        this.truncatePreview(r.contentText),
      ]),
    );

    return conversations.map((c) => ({
      id: c.id,
      title: c.title,
      model: c.model,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt ? c.updatedAt.toISOString() : null,
      lastMessagePreview: previewByConv.get(c.id) ?? null,
      messageCount: countByConv.get(c.id) ?? 0,
      // Wave 51 BE-W51-01 — project the new discriminator + timestamp
      // verbatim from the entity. The DB-W51-01 column default
      // `'default-placeholder'` guarantees a non-null value on every
      // legacy row, so the nullish fallback is belt-and-braces against
      // a cold-boot race where a freshly-inserted row was read before
      // the default materialised. `titleGeneratedAt` is nullable by
      // design — NULL means "still the placeholder" and signals FE to
      // render the auto-title skeleton.
      //
      // §12 — metadata only; no tracking_status coupling.
      // §17.3 — no FK; plain scalar passthrough.
      titleSource: c.titleSource ?? 'default-placeholder',
      titleGeneratedAt: c.titleGeneratedAt ? c.titleGeneratedAt.toISOString() : null,
    }));
  }

  /**
   * Controller-facing variant — resolves workHistoryId and delegates
   * to the inner method.
   */
  async listMessagesForConversationByUserId(
    conversationId: string,
    userId: string,
  ): Promise<ChatMessageDto[]> {
    const caller = await this.loadCallerContext(userId);
    return this.listMessagesForConversation(
      conversationId,
      caller.workHistoryId,
    );
  }

  /**
   * Returns the chronological message list for a conversation.
   *
   * Ownership contract (enumeration guard — matches `resolveConversation`
   * at service:846-854):
   *   - non-existent id → `NotFoundException('CONVERSATION_NOT_FOUND')`
   *   - id exists but owned by someone else → SAME 404 (never 403).
   *     This prevents an ID-enumeration oracle that would otherwise
   *     let one executive probe whether another executive has a given
   *     conversation id. §17.11 — integrity, not permission.
   *
   * Ordering: `turn_index ASC` (Wave 50 BE-W50-01 — primary, strictly
   * monotonic per-conversation counter). `id ASC` is kept as a defensive
   * tiebreaker; there should be no ties within a conversation partition
   * (DB-W50-01 enforces per-conversation uniqueness), but a random-UUID
   * fallback is harmless and guards against a hypothetical bug in the
   * write path. `created_at` is still populated on every row (Wave 48
   * belt-and-braces) but is no longer the primary sort key.
   *
   * Cap: `LIST_MESSAGES_LIMIT` rows. Every returned row gets
   * `isStale: false` forced per §17.4 — chat rows are `snapshot-only`,
   * so content-hash drift MUST NOT flip the flag.
   */
  async listMessagesForConversation(
    conversationId: string,
    workHistoryId: string,
  ): Promise<ChatMessageDto[]> {
    // Ownership + existence check in one indexed read. The single-query
    // form matches the timing profile of `resolveConversation` so a
    // non-owner does not observe a shorter/longer response than a
    // truly-missing id.
    const conversation = await this.conversationRepo.findOne({
      where: { id: conversationId, deletedAt: IsNull() },
    });
    if (!conversation) throw new NotFoundException('CONVERSATION_NOT_FOUND');
    if (conversation.ownerWorkHistoryId !== workHistoryId) {
      throw new NotFoundException('CONVERSATION_NOT_FOUND');
    }

    const rows = await this.messageRepo
      .createQueryBuilder('m')
      .where('m.conversation_id = :cid', { cid: conversationId })
      .andWhere('m.deleted_at IS NULL')
      // Wave 50 BE-W50-01 — primary sort on `turn_index`. Hits the
      // composite index `ix_ai_executive_messages_conversation_turn`
      // for O(log N) indexed read.
      .orderBy('m.turn_index', 'ASC')
      .addOrderBy('m.id', 'ASC')
      .limit(LIST_MESSAGES_LIMIT)
      .getMany();

    return rows.map((m) => this.toMessageDto(m));
  }

  /**
   * Map an ORM row to the FE-facing DTO. `isStale` is ALWAYS `false`
   * here (§17.4 snapshot-only). Do NOT compute from `contentHash`.
   *
   * Wave 52 BE-W52-03 — `isStale: false` is the sole read-side
   * expression of the module-level snapshot-only invariant documented
   * at `SNAPSHOT_ONLY_INVARIANT` (top of file). The per-row
   * `staleness_policy` column was dropped by DB-W52-01.
   */
  private toMessageDto(row: AiExecutiveMessage): ChatMessageDto {
    return {
      id: row.id,
      conversationId: row.conversationId,
      role: row.role,
      // Wire-shape rename to match FE `ChatMessage.content` + SSE
      // `message_complete.content`. ORM column stays `content_text`
      // (entity property `contentText`). See QA-W46-01 H1.
      content: row.contentText,
      toolName: row.toolName,
      toolCallsJson: row.toolCallsJson,
      toolResultJson: row.toolResultJson,
      createdAt: row.createdAt.toISOString(),
      // Wave 50 BE-W50-01 — emit `turnIndex` on every row. FE FE-W50-01
      // treats this as the primary sort key. `createdAt` remains as a
      // belt-and-braces fallback (Wave 48) but is no longer primary.
      //
      // Wave 50 HOTFIX (2026-04-23): entity column widened to
      // `number | null` to accommodate TypeORM `synchronize` cold boot
      // (see `ai-executive-message.entity.ts` COLD-BOOT NULLABILITY
      // ACCOMMODATION note). In practice `row.turnIndex` is non-null on
      // every served row because `BootstrapMigrationsService` runs the
      // backfill + SET NOT NULL before the first request arrives, AND
      // every persist* helper writes a real integer. Coerce with `?? 0`
      // defensively so the wire contract (required `number`) is never
      // violated even during the narrow sync→backfill window on first
      // post-deploy boot.
      turnIndex: row.turnIndex ?? 0,
      model: row.model ?? null,
      tokensIn: row.tokensIn,
      tokensOut: row.tokensOut,
      isStale: false,
    };
  }

  /**
   * Truncate a preview string to `LAST_MESSAGE_PREVIEW_MAX_CHARS`,
   * appending an ellipsis when the original exceeds the cap. Returns
   * `null` for null / empty input so an empty-text row doesn't render
   * as a zero-width bubble on the sidebar.
   */
  private truncatePreview(text: string | null): string | null {
    if (text === null || text === undefined) return null;
    const trimmed = text.trim();
    if (trimmed.length === 0) return null;
    if (trimmed.length <= LAST_MESSAGE_PREVIEW_MAX_CHARS) return trimmed;
    return `${trimmed.slice(0, LAST_MESSAGE_PREVIEW_MAX_CHARS)}…`;
  }

  // ────────────────────────────────────────────────────────────────
  // Tool-call loop
  // ────────────────────────────────────────────────────────────────

  private async runToolLoop(
    manager: EntityManager,
    messages: ChatMessageParam[],
    tools: ChatToolDefinition[],
    caller: ExecutiveCallerContext,
    seed: TurnPersistenceSeed,
    response: Response,
    initialModelOverride: string | undefined,
    redactionTotals: PiiRedactionCounts,
    /**
     * Wave 51 BE-W51-02 — the already-PII-redacted first user message for
     * this turn. Passed through so the terminal-assistant branch can
     * invoke `generateAutoTitleIfEligible` WITHOUT recomputing redaction
     * (§17.9 defense-in-depth is still applied on the LLM OUTPUT inside
     * the helper). Unused on the soft-stop / max-hop branch per task §3.
     */
    redactedFirstUserMessage: string,
  ): Promise<AssistantTurnMeta> {
    const meta: AssistantTurnMeta = {
      finishReason: 'length',
      // W68-FIX-08 (2026-04-28) — switched 'gpt-4o' → 'gpt-4.1-mini'.
      // gpt-4o hit the 30k TPM ceiling at hop 2; gpt-4.1-mini has
      // 200k+ TPM, 6× cheaper, 1M context, instruction-following
      // close to gpt-4o (much better than 4o-mini regression in
      // W68-FIX-04). See quota-weight.map.ts for the full ledger.
      modelUsed: initialModelOverride || 'gpt-4.1-mini',
      wasDowngraded: false,
      hops: 0,
    };

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    // Per-row offset inside this turn. User row occupies index 0 at
    // `turnBaseIndex`; every assistant / tool row bumps this by 1 so
    // the §17.4 content_hash key `(conversationId, role, turnIndex,
    // normalizedPayload)` is unique per row.
    let rowOffset = 1;

    // BE-W45-01 — per-turn `lastToolTarget` reducer. Reset to NULL at
    // the start of every turn (R4 — no cross-turn leakage). Updated
    // from each tool round's extractor output; when a tool does NOT
    // resolve to a single project the existing non-null value is
    // preserved (R5 — last non-null capture wins, because the final
    // assistant message is "about" the most recent concrete project
    // the LLM inspected). When persisting the final / soft-stop
    // assistant row, this reducer is passed verbatim.
    let lastToolTarget: {
      id: string | null;
      kind: AiResultTargetKind | null;
    } = { id: null, kind: null };

    for (let hop = 0; hop < MAX_HOPS; hop++) {
      // PRE-HOP QUOTA CHECK — task §7.8. We gate BEFORE the LLM call
      // so a soft-stop never spends budget.
      const mid = await AiQuotaGuard.checkMidTurn(
        this.quotaService,
        this.orgCapService,
        caller.userId,
        'executive-chat',
      );
      if (!mid.ok) {
        meta.finishReason = 'quota_soft_stop';
        meta.softStopReason = mid.reason;
        this.emit(response, 'quota_soft_stop', {
          reason: mid.reason,
          remainingThb: mid.remainingThb,
          hopsUsed: hop,
        });
        // Persist an assistant turn carrying the soft-stop meta so the
        // conversation history reflects the truncation.
        await this.persistAssistantSoftStop(
          manager,
          seed,
          rowOffset++,
          meta,
          lastToolTarget,
        );
        return meta;
      }

      // Apply auto-downgrade: if mid-turn returns a different model, honor it.
      // W68-FIX-08 (2026-04-28) — default is now `gpt-4.1-mini`; auto-downgrade
      // target is `gpt-4.1-nano` at ≥80% quota consumed (see
      // quota-model-override.ts). The wasDowngraded flag tracks the
      // mini → nano drop within the 4.1 family.
      if (mid.modelOverride && mid.modelOverride !== meta.modelUsed) {
        if (mid.modelOverride === 'gpt-4.1-nano' && meta.modelUsed === 'gpt-4.1-mini') {
          meta.wasDowngraded = true;
        }
        meta.modelUsed = mid.modelOverride;
      }

      // Perform the completion. We use the non-streaming variant for
      // each hop because tool-call parsing is simpler against the
      // finished message; the SSE `message_delta` events for this hop
      // are emitted AFTER we have the final text, keeping the
      // contract surface small.
      const params: ChatCompletionParamsNonStreaming = {
        model: meta.modelUsed,
        messages,
        tools,
        tool_choice: 'auto',
        temperature: 0.2,
      };

      let completion;
      try {
        completion = await this.llmClient.createChatCompletion(params);
      } catch (err) {
        this.logger.error(
          `[executive-chat] LLM call failed at hop ${hop}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        throw new HttpException(
          {
            code: 'AI_UPSTREAM_ERROR',
            message: 'LLM ไม่ตอบสนอง',
          },
          HttpStatus.BAD_GATEWAY,
        );
      }

      const choice: ChatCompletionChoice | undefined = completion.choices?.[0];
      const usage = completion.usage;
      if (usage) {
        totalInputTokens += usage.prompt_tokens ?? 0;
        totalOutputTokens += usage.completion_tokens ?? 0;
      }

      if (!choice) {
        throw new HttpException(
          { code: 'AI_EMPTY_RESPONSE', message: 'LLM คืนข้อความว่าง' },
          HttpStatus.BAD_GATEWAY,
        );
      }

      const assistantMsg = choice.message;
      const toolCalls = assistantMsg.tool_calls ?? [];

      // No more tools → terminal assistant turn.
      if (!toolCalls.length) {
        const finalText = assistantMsg.content ?? '';
        meta.finishReason = choice.finish_reason ?? 'stop';
        meta.hops = hop + 1;
        this.emit(response, 'message_delta', { delta: finalText });
        await this.persistAssistantFinal(
          manager,
          seed,
          rowOffset++,
          finalText,
          meta,
          totalInputTokens,
          totalOutputTokens,
          lastToolTarget,
        );
        // Wave 44 C3 / M1 — FE `SseMessageComplete` reads `messageId`,
        // `content`, and `hasRedacted`. `messageId` is the user turn
        // seed id (FE keys the bubble by user->assistant roundtrip).
        this.emit(response, 'message_complete', {
          messageId: seed.userMessageId,
          content: finalText,
          hasRedacted: this.hasAnyRedaction(redactionTotals),
          modelUsed: meta.modelUsed,
          wasDowngraded: meta.wasDowngraded,
          hops: meta.hops,
        });
        await this.deductPostTurnUsage(caller.userId, meta, totalInputTokens, totalOutputTokens);
        // Wave 51 BE-W51-02 — after the first-turn terminal assistant
        // message completes AND post-turn usage is deducted, fire the
        // auto-title generator if this is truly the conversation's first
        // round-trip (task §3 / §5). Fire-and-forget: the helper is
        // non-throwing, runs an independent LLM call, and only writes on
        // a compare-and-set match. We do NOT await here — the SSE `done`
        // frame has already been emitted by the caller, and BE-W51-03
        // owns the `conversation_renamed` SSE emission that will land on
        // the FE from inside the helper. The `.catch` guard is a
        // defense-in-depth against a helper regression; §17.2 advisory
        // semantics mean any failure here is invisible to the user.
        if (seed.turnBaseIndex === 0) {
          // Wave 51 BE-W51-03 — pass the live SSE `response` so the
          // helper can emit a `conversation_renamed` frame AFTER the
          // compare-and-set UPDATE succeeds. The helper guards the emit
          // with a try/catch so a socket torn down between
          // `message_complete` and the auto-title landing MUST NOT
          // crash the fire-and-forget promise (task §5 best-effort).
          void this.generateAutoTitleIfEligible(
            seed.conversationId,
            caller.userId,
            redactedFirstUserMessage,
            response,
          ).catch((err) => {
            this.logger.warn(
              `[executive-chat] auto-title fire-and-forget guard tripped: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          });
        }
        return meta;
      }

      // Append the assistant's tool-calling turn so the model's state
      // is preserved for the follow-up "tool" messages. The response
      // message shape is structurally compatible with the param type;
      // OpenAI accepts this echo pattern verbatim.
      messages.push(assistantMsg as unknown as ChatMessageParam);

      // Execute each requested tool. Unknown names → schema drift; we
      // abort the turn with 502 AI_SCHEMA_DRIFT per §17.9.
      //
      // OpenAI SDK types `ChatCompletionMessageToolCall` as a union of
      // `FunctionToolCall` (has `.function`) and `CustomToolCall` (has
      // `.custom`). We only register function-shape tools, so any call
      // arriving with a non-`function` type is schema drift by definition.
      for (const tc of toolCalls) {
        if (tc.type !== 'function') {
          throw new HttpException(
            {
              code: 'AI_SCHEMA_DRIFT',
              message: `unsupported tool-call type "${tc.type}"`,
            },
            HttpStatus.BAD_GATEWAY,
          );
        }
        const name = tc.function?.name ?? '';
        const rawArgs = tc.function?.arguments ?? '';
        const spec = getExecutiveToolSpec(name);
        if (!spec) {
          throw new HttpException(
            {
              code: 'AI_SCHEMA_DRIFT',
              message: `unknown tool "${name}"`,
            },
            HttpStatus.BAD_GATEWAY,
          );
        }

        const parsed = parseToolCallArguments(rawArgs);
        if (!parsed.ok) {
          throw new HttpException(
            { code: 'AI_SCHEMA_DRIFT', message: parsed.error },
            HttpStatus.BAD_GATEWAY,
          );
        }
        const paramsCheck = validateAgainstSchema(
          spec.paramsSchema,
          parsed.value,
        );
        if (!paramsCheck.ok) {
          // W68-FIX-03 (2026-04-28) — was: throw HttpException → turn failed.
          // Now: emit a tool-error result and continue the loop, letting the
          // LLM see the validation error and self-correct on the next hop.
          // gpt-4o-mini occasionally sends plan names instead of UUIDs; the
          // tool-loop pattern is designed for this kind of self-correction.
          //
          // §17.9 NOTE: this softens INPUT validation only (LLM → tool args).
          // Output (tool result → LLM) validation at line 1048+ STAYS strict
          // to keep the prompt-injection defense intact.
          this.logger.warn(
            `[executive-chat] tool ${name} input schema-drift (soft): ${paramsCheck.error}`,
          );
          // Emit a tool_call_start so FE shows the attempted call, then a
          // tool_call_result with `ok: false` and a structured error body so
          // the FE can render a "AI lookup failed; retrying" hint.
          this.emit(response, 'tool_call_start', {
            callId: tc.id,
            toolName: name,
            thaiLabel: spec.thaiLabel,
            hopIndex: hop,
          });
          this.emit(response, 'tool_call_result', {
            callId: tc.id,
            toolName: name,
            thaiLabel: spec.thaiLabel,
            ok: false,
            truncated: false,
            bytes: 0,
            result: {
              error: 'INVALID_TOOL_INPUT',
              message: paramsCheck.error,
              hint: 'Check param types and formats; e.g., planId must be a UUID resolved from listActivePlans.items[i].planId.',
            },
          });
          // Inject a synthetic tool_result message into the conversation so
          // the LLM sees the error on the next hop and self-corrects. The
          // shape mirrors a normal tool result so the existing context-window
          // truncation logic continues to work.
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify({
              error: 'INVALID_TOOL_INPUT',
              tool: name,
              message: paramsCheck.error,
              hint: 'Verify param shapes against the tool schema. UUIDs MUST come from listActivePlans / listAmphoes / listLaos / listAgencies — never from user prose. Retry with corrected args.',
            }),
          });
          // Skip the actual tool invocation; loop continues for next tool_call.
          continue;
        }

        // Wave 44 C3 — FE `SseToolCallStart` reads `toolName` and
        // `callId`; emit both (plus Thai label + hop index) verbatim.
        this.emit(response, 'tool_call_start', {
          callId: tc.id,
          toolName: name,
          thaiLabel: spec.thaiLabel,
          hopIndex: hop,
        });

        let rawResult: Record<string, unknown>;
        try {
          rawResult = await this.invokeTool(
            spec.name as ExecutiveToolName,
            (parsed.value ?? {}) as Record<string, unknown>,
            caller,
          );
        } catch (err) {
          this.logger.warn(
            `[executive-chat] tool ${name} failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          throw new HttpException(
            { code: 'TOOL_EXECUTION_FAILED', tool: name },
            HttpStatus.INTERNAL_SERVER_ERROR,
          );
        }

        // Validate tool result against its own `returnSchema` (§17.9).
        const resultCheck = validateAgainstSchema(spec.returnSchema, rawResult);
        if (!resultCheck.ok) {
          this.logger.error(
            `[executive-chat] tool ${name} returned schema-drift: ${resultCheck.error}`,
          );
          throw new HttpException(
            {
              code: 'AI_SCHEMA_DRIFT',
              tool: name,
              message: resultCheck.error,
            },
            HttpStatus.BAD_GATEWAY,
          );
        }

        // Redact + size-cap tool result before re-entering the prompt.
        const toolRedaction = this.piiRedactor.redactStructuredFields(
          rawResult,
          EXECUTIVE_CHAT_TOOL_RESULT_POLICY,
          { endpoint: 'executive-chat-tool-result' },
        );
        this.accumulateRedactionCounts(redactionTotals, toolRedaction.counts);
        const redactedResult = toolRedaction.output;
        const capped = this.capToolResult(redactedResult);
        const wrapped = this.wrapToolResult(name, capped);

        // Wave 44 C3 — FE `SseToolCallResult` reads `callId` and
        // `toolName`. Include `ok`, `truncated`, `bytes`, and Thai
        // label for the tool chip surface. `result` remains the
        // already-redacted payload (§17.9).
        const resultBytes = Buffer.byteLength(JSON.stringify(capped), 'utf8');
        const resultTruncated =
          typeof (capped as { truncated?: unknown }).truncated === 'boolean'
            ? Boolean((capped as { truncated?: boolean }).truncated)
            : false;
        this.emit(response, 'tool_call_result', {
          callId: tc.id,
          toolName: name,
          thaiLabel: spec.thaiLabel,
          ok: true,
          truncated: resultTruncated,
          bytes: resultBytes,
          result: capped,
        });

        // Persist both the assistant tool-call turn AND the tool
        // result turn. Snapshot-only semantics are module-level post
        // Wave 52 (see `SNAPSHOT_ONLY_INVARIANT`).
        const captured = await this.persistToolRound(
          manager,
          seed,
          rowOffset++,
          name,
          {
            toolCalls: assistantMsg.tool_calls as unknown as Record<
              string,
              unknown
            >[],
            result: rawResult,
          },
        );

        // BE-W45-01 — last non-null capture wins. If this tool did not
        // resolve to a single project, preserve whatever the previous
        // tool round captured (may still be the initial NULL seed).
        if (captured.id) {
          lastToolTarget = captured;
        }

        // Feed the tool result back to the LLM for the next hop.
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: wrapped,
        });
      }

      meta.hops = hop + 1;
    }

    // Hit max-hop ceiling without a terminal assistant message.
    meta.finishReason = 'max_hops';
    this.emit(response, 'message_complete', {
      messageId: seed.userMessageId,
      content: '',
      hasRedacted: this.hasAnyRedaction(redactionTotals),
      modelUsed: meta.modelUsed,
      wasDowngraded: meta.wasDowngraded,
      hops: MAX_HOPS,
      truncated: true,
    });
    await this.persistAssistantSoftStop(
      manager,
      seed,
      rowOffset++,
      meta,
      lastToolTarget,
    );
    await this.deductPostTurnUsage(caller.userId, meta, totalInputTokens, totalOutputTokens);
    return meta;
  }

  private accumulateRedactionCounts(
    acc: PiiRedactionCounts,
    next: PiiRedactionCounts,
  ): void {
    acc.thaiId += next.thaiId;
    acc.thaiPhone += next.thaiPhone;
    acc.email += next.email;
    acc.longDigit += next.longDigit;
    acc.address += next.address;
    acc.postal += next.postal;
  }

  private hasAnyRedaction(counts: PiiRedactionCounts): boolean {
    return (
      counts.thaiId > 0 ||
      counts.thaiPhone > 0 ||
      counts.email > 0 ||
      counts.longDigit > 0 ||
      counts.address > 0 ||
      counts.postal > 0
    );
  }

  // ────────────────────────────────────────────────────────────────
  // Tool handler dispatch (§17.11 — re-assert role inside every tool)
  // ────────────────────────────────────────────────────────────────

  private async invokeTool(
    name: ExecutiveToolName,
    params: Record<string, unknown>,
    caller: ExecutiveCallerContext,
  ): Promise<Record<string, unknown>> {
    const handler = EXECUTIVE_TOOL_HANDLERS[name];
    if (!handler) {
      // Should never happen — `getExecutiveToolSpec` above already
      // guarded, but kept for defense-in-depth.
      throw new Error(`EXECUTIVE_TOOL_HANDLER_MISSING:${name}`);
    }
    // Wave 54 BE-W54-06 — hydrate the Tier B service instances into the
    // shared handler-deps bag. Wave 53 handlers continue to use
    // `deps.dataSource`; Wave 54 Tier C handlers (`getPlanOverview`,
    // `getExecutiveDashboardSnapshot`, `getCrossPlanInsights`) reach
    // Tier B exclusively via these fields.
    const deps: ExecutiveToolHandlerDeps = {
      dataSource: this.dataSource,
      unifiedProject: this.unifiedProject,
      budget: this.budget,
      status: this.status,
      geo: this.geo,
      agency: this.agency,
      resilience: this.resilience,
      projectLineage: this.projectLineage,
    };
    return handler(params, caller, deps);
  }

  // ────────────────────────────────────────────────────────────────
  // Prompt / tool-definition builders
  // ────────────────────────────────────────────────────────────────

  private buildToolDefinitions(): ChatToolDefinition[] {
    return Object.values(EXECUTIVE_TOOL_REGISTRY).map((spec) =>
      this.toOpenAiToolDef(spec),
    );
  }

  private toOpenAiToolDef(spec: ExecutiveToolSpec): ChatToolDefinition {
    return {
      type: 'function',
      function: {
        name: spec.name,
        description: spec.description,
        parameters: spec.paramsSchema as unknown as Record<string, unknown>,
      },
    };
  }

  private wrapUserInput(text: string): string {
    // §17.9 — delimiter pair MUST match the pinned system prompt.
    const safe = text
      .replace(/<<<USER_INPUT>>>/g, '<<<U-I>>>')
      .replace(/<<<END_USER_INPUT>>>/g, '<<<E-U-I>>>');
    return `<<<USER_INPUT>>>\n${safe}\n<<<END_USER_INPUT>>>`;
  }

  private wrapToolResult(
    toolName: string,
    result: Record<string, unknown>,
  ): string {
    const json = JSON.stringify(result);
    const safe = json
      .replace(/<<<TOOL_RESULT /g, '<<<T-R ')
      .replace(/<<<END_TOOL_RESULT>>>/g, '<<<E-T-R>>>');
    return `<<<TOOL_RESULT name="${toolName}">>>\n${safe}\n<<<END_TOOL_RESULT>>>`;
  }

  private capToolResult(result: Record<string, unknown>): Record<string, unknown> {
    const json = JSON.stringify(result);
    if (Buffer.byteLength(json, 'utf8') <= TOOL_RESULT_MAX_BYTES) {
      return result;
    }
    const previewLen = Math.max(0, TOOL_RESULT_MAX_BYTES - 128);
    return {
      truncated: true,
      preview: json.slice(0, previewLen),
      originalBytes: Buffer.byteLength(json, 'utf8'),
    };
  }

  // ────────────────────────────────────────────────────────────────
  // Persistence helpers — every write sets snapshot-only policy
  // ────────────────────────────────────────────────────────────────

  private async resolveConversation(
    id: string | undefined,
    ownerWorkHistoryId: string,
  ): Promise<AiExecutiveConversation> {
    if (id) {
      const existing = await this.conversationRepo.findOne({
        where: { id, deletedAt: IsNull() },
      });
      if (!existing) throw new NotFoundException('CONVERSATION_NOT_FOUND');
      if (existing.ownerWorkHistoryId !== ownerWorkHistoryId) {
        // Enumeration guard — surface 404 to match the public contract.
        throw new NotFoundException('CONVERSATION_NOT_FOUND');
      }
      return existing;
    }

    // BE-W50-02 / RCA §2.6 G14 — the `id === undefined` branch is the
    // "create a fresh conversation" path. Two concurrent SSE sends from
    // the same owner (e.g. user opens two tabs and hits Send in both)
    // would otherwise both land here and insert TWO empty-title
    // conversations. We want exactly ONE.
    //
    // Mitigation: wrap the check-then-create block in a transaction and
    // serialise on a per-owner Postgres advisory lock. The key is
    // derived deterministically from `owner_work_history_id` via
    // `hashtextextended(...)` so two different owners acquire DIFFERENT
    // keys and never block each other. `pg_advisory_xact_lock` is
    // auto-released when the transaction commits or rolls back, so we
    // never leak a connection-scoped lock.
    //
    // Inside the lock we re-query for a freshly-created "บทสนทนาใหม่"
    // conversation owned by the same owner within the last 2 seconds;
    // if one exists we reuse it (the other tab's request won the race
    // and already created the row), otherwise we insert a new row. This
    // matches the "most-recent-empty" semantics from the task spec and
    // preserves §17.3 audit separation (no FK, no tracking_status).
    return this.dataSource.transaction(async (manager) => {
      await manager.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`,
        [ownerWorkHistoryId],
      );

      const convRepo = manager.getRepository(AiExecutiveConversation);
      const cutoff = new Date(Date.now() - 2_000);
      const recent = await convRepo
        .createQueryBuilder('c')
        .where('c.owner_work_history_id = :whId', { whId: ownerWorkHistoryId })
        .andWhere('c.deleted_at IS NULL')
        .andWhere('c.title = :title', { title: 'บทสนทนาใหม่' })
        .andWhere('c.created_at >= :cutoff', { cutoff })
        .orderBy('c.created_at', 'DESC')
        .limit(1)
        .getOne();
      if (recent) return recent;

      const created = convRepo.create({
        ownerWorkHistoryId,
        title: 'บทสนทนาใหม่',
        // W68-FIX-08 (2026-04-28) — switched 'gpt-4o' → 'gpt-4.1-mini'.
        model: 'gpt-4.1-mini',
      });
      return convRepo.save(created);
    });
  }

  private async loadCallerContext(
    userId: string,
  ): Promise<ExecutiveCallerContext> {
    const wh = await this.workHistoryRepo.findOne({
      where: { user: { id: userId }, isCurrent: true },
      relations: ['role', 'workStatus'],
    });
    if (!wh) {
      throw new HttpException(
        { code: 'EXECUTIVE_ROLE_REQUIRED' },
        HttpStatus.FORBIDDEN,
      );
    }
    return {
      userId,
      workHistoryId: wh.id,
      roleName: wh.role?.name ?? '',
      workStatusName: wh.workStatus?.name ?? '',
    };
  }

  private async loadRecentHistory(
    conversationId: string,
  ): Promise<ChatMessageParam[]> {
    const rows = await this.messageRepo.find({
      where: { conversationId },
      // Wave 50 BE-W50-01 — replay in strict `turn_index` order so the
      // LLM sees a coherent conversation even if two rows share a
      // ms-precise `created_at`. RCA §2.1 G3.
      order: { turnIndex: 'ASC' },
      take: CONTEXT_MESSAGE_CAP,
    });
    const out: ChatMessageParam[] = [];
    for (const row of rows) {
      if (row.role === 'user') {
        const redacted = this.piiRedactor.redactText(row.contentText ?? '', {
          endpoint: 'executive-chat',
        }).output;
        out.push({ role: 'user', content: this.wrapUserInput(redacted) });
      } else if (row.role === 'assistant') {
        out.push({ role: 'assistant', content: row.contentText ?? '' });
      }
      // `tool` / `system` history rows are not replayed — the system
      // prompt is re-seeded fresh and tool turns are transient scratch.
    }
    return out;
  }

  /**
   * BE-W45-01 — `user` rows NEVER carry a project target. A prompt is
   * a free-text question; it does not structurally resolve to a UUID.
   * Both columns write NULL.
   */
  private async persistUserMessage(
    manager: EntityManager,
    conversationId: string,
    _ownerWhId: string,
    contentText: string,
    contentHash: string,
    turnIndex: number,
  ): Promise<AiExecutiveMessage> {
    const repo = manager.getRepository(AiExecutiveMessage);
    const msg = repo.create({
      conversationId,
      role: 'user' as AiChatRole,
      contentText,
      toolCallsJson: null,
      toolName: null,
      toolResultJson: null,
      tokensIn: null,
      tokensOut: null,
      endpoint: 'executive-chat',
      // W68-FIX-08 (2026-04-28) — switched 'gpt-4o' → 'gpt-4.1-mini'.
      model: 'gpt-4.1-mini',
      contentHash,
      // Wave 52 BE-W52-03 — `stalenessPolicy` removed. Snapshot-only
      // is now expressed at the module level (see
      // `SNAPSHOT_ONLY_INVARIANT`); the per-row column was dropped by
      // DB-W52-01 migration 1748000000000.
      // Wave 50 BE-W50-01 — deterministic per-conversation monotonic
      // counter. At the user row we write `turnBaseIndex + 0`, where
      // `turnBaseIndex` is the pre-turn COUNT(*) snapshot captured at
      // the top of the turn transaction (see `sendMessage`). Every
      // subsequent row in the same turn bumps `rowOffset` and writes
      // `turnBaseIndex + rowOffset`. The DB-W50-01 composite index
      // `(conversation_id, turn_index)` guarantees O(log N) sorted reads.
      turnIndex,
      // BE-W48-01 — explicit per-row JS-side timestamp so sibling rows
      // inserted inside the same transaction don't collide on Postgres
      // `now()` (transaction-start). See RCA §2: `@CreateDateColumn`
      // default `now()` returns the TRANSACTION start time, not the
      // statement time, which ties all 4 rows of a turn. Passing an
      // explicit `createdAt` on `repo.create({...})` overrides the
      // column default at INSERT time. `computedAt` is a SEMANTIC
      // AI-run timestamp and remains unchanged.
      createdAt: new Date(),
      computedAt: new Date(),
      // Wave 52 BE-W52-03 — `resultJson` removed (column dropped).
      // BE-W45-01 — user prompts never target a single project.
      targetId: null as unknown as string,
      targetKind: null as unknown as AiResultTargetKind,
    } as Partial<AiExecutiveMessage>);
    return repo.save(msg);
  }

  private async persistAssistantFinal(
    manager: EntityManager,
    seed: TurnPersistenceSeed,
    rowOffset: number,
    contentText: string,
    meta: AssistantTurnMeta,
    tokensIn: number,
    tokensOut: number,
    inheritedTarget: {
      id: string | null;
      kind: AiResultTargetKind | null;
    },
  ): Promise<void> {
    // §17.4 — row hash keys on row-specific content (final text +
    // finishReason) plus turn-unique index, so two assistant rows
    // across turns or conversations never collide.
    const turnIndex = seed.turnBaseIndex + rowOffset;
    const contentHash = this.rowHash({
      conversationId: seed.conversationId,
      role: 'assistant',
      turnIndex,
      normalizedPayload: JSON.stringify({
        text: contentText ?? '',
        finishReason: meta.finishReason,
        modelUsed: meta.modelUsed,
      }),
    });
    const repo = manager.getRepository(AiExecutiveMessage);
    const row = repo.create({
      conversationId: seed.conversationId,
      role: 'assistant' as AiChatRole,
      contentText,
      toolCallsJson: {
        meta: {
          finishReason: meta.finishReason,
          modelUsed: meta.modelUsed,
          wasDowngraded: meta.wasDowngraded,
          hops: meta.hops,
        },
      },
      toolName: null,
      toolResultJson: null,
      tokensIn,
      tokensOut,
      endpoint: 'executive-chat',
      model: meta.modelUsed,
      contentHash,
      // Wave 52 BE-W52-03 — `stalenessPolicy` removed (module-level).
      // Wave 50 BE-W50-01 — persisted ordering counter; see
      // `persistUserMessage` for the full rationale. Identical to the
      // turnIndex used for the row-hash above so the `(conversation_id,
      // turn_index)` tuple also discriminates idempotent rehashes.
      turnIndex,
      // BE-W48-01 — explicit per-row JS-side timestamp; see
      // `persistUserMessage` for the full rationale. Node's awaited
      // sequential `repo.save()` calls guarantee monotonically
      // advancing `Date.now()` values across the 4 rows of a turn.
      createdAt: new Date(),
      computedAt: new Date(),
      // Wave 52 BE-W52-03 — `resultJson` removed (column dropped).
      // BE-W45-01 — inherit the most recent tool-round target within
      // this turn; NULL if no tool resolved to a single project.
      targetId: (inheritedTarget.id ?? null) as unknown as string,
      targetKind: (inheritedTarget.kind ??
        null) as unknown as AiResultTargetKind,
    } as Partial<AiExecutiveMessage>);
    await repo.save(row);
  }

  private async persistAssistantSoftStop(
    manager: EntityManager,
    seed: TurnPersistenceSeed,
    rowOffset: number,
    meta: AssistantTurnMeta,
    inheritedTarget: {
      id: string | null;
      kind: AiResultTargetKind | null;
    },
  ): Promise<void> {
    // §17.4 — soft-stop rows have no body text; hash over meta so two
    // distinct soft-stops (quota vs max-hops) never collide.
    const turnIndex = seed.turnBaseIndex + rowOffset;
    const contentHash = this.rowHash({
      conversationId: seed.conversationId,
      role: 'assistant',
      turnIndex,
      normalizedPayload: JSON.stringify({
        softStop: true,
        finishReason: meta.finishReason,
        softStopReason: meta.softStopReason ?? null,
        modelUsed: meta.modelUsed,
        hops: meta.hops,
      }),
    });
    const repo = manager.getRepository(AiExecutiveMessage);
    const row = repo.create({
      conversationId: seed.conversationId,
      role: 'assistant' as AiChatRole,
      contentText: null,
      toolCallsJson: {
        meta: {
          finishReason: meta.finishReason,
          modelUsed: meta.modelUsed,
          wasDowngraded: meta.wasDowngraded,
          hops: meta.hops,
          softStopReason: meta.softStopReason ?? null,
        },
      },
      toolName: null,
      toolResultJson: null,
      tokensIn: null,
      tokensOut: null,
      endpoint: 'executive-chat',
      model: meta.modelUsed,
      contentHash,
      // Wave 52 BE-W52-03 — `stalenessPolicy` removed (module-level).
      // Wave 50 BE-W50-01 — see `persistUserMessage` for rationale.
      turnIndex,
      // BE-W48-01 — explicit per-row JS-side timestamp; see
      // `persistUserMessage` for the full rationale.
      createdAt: new Date(),
      computedAt: new Date(),
      // Wave 52 BE-W52-03 — `resultJson` removed (column dropped).
      // BE-W45-01 — inherit from the last tool round in this turn.
      targetId: (inheritedTarget.id ?? null) as unknown as string,
      targetKind: (inheritedTarget.kind ??
        null) as unknown as AiResultTargetKind,
    } as Partial<AiExecutiveMessage>);
    await repo.save(row);
  }

  private async persistToolRound(
    manager: EntityManager,
    seed: TurnPersistenceSeed,
    rowOffset: number,
    toolName: string,
    payload: {
      toolCalls: Record<string, unknown>[];
      result: Record<string, unknown>;
    },
  ): Promise<{ id: string | null; kind: AiResultTargetKind | null }> {
    // §17.4 — tool rows hash over (toolName + serialized result). The
    // result payload is the already-unredacted raw tool output (the
    // redaction + delimiter wrap happens on the wire payload only);
    // hashing pre-redaction preserves the §17.9 ordering: hash first,
    // redact second.
    const turnIndex = seed.turnBaseIndex + rowOffset;
    const contentHash = this.rowHash({
      conversationId: seed.conversationId,
      role: 'tool',
      turnIndex,
      normalizedPayload: JSON.stringify({
        toolName,
        result: payload.result,
      }),
    });

    // BE-W45-01 — run the tool-aware extractor against the raw
    // (pre-redaction) tool result. Capture is fail-silent: any shape
    // mismatch, wrong item count, non-UUID value, or zero-UUID returns
    // `null` for both columns. This preserves §17.2 advisory semantics.
    const extracted = extractTargetFromToolResult(toolName, payload.result);
    const targetId = extracted?.targetId ?? null;
    const targetKind = extracted?.targetKind ?? null;

    const repo = manager.getRepository(AiExecutiveMessage);
    const row = repo.create({
      conversationId: seed.conversationId,
      role: 'tool' as AiChatRole,
      contentText: null,
      toolCallsJson: { tool_calls: payload.toolCalls },
      toolName,
      toolResultJson: payload.result,
      tokensIn: null,
      tokensOut: null,
      endpoint: 'executive-chat',
      // W68-FIX-08 (2026-04-28) — switched 'gpt-4o' → 'gpt-4.1-mini'.
      model: 'gpt-4.1-mini',
      contentHash,
      // Wave 52 BE-W52-03 — `stalenessPolicy` removed (module-level).
      // Wave 50 BE-W50-01 — see `persistUserMessage` for rationale. Each
      // `persistToolRound` call writes a single tool row; the hop loop
      // increments `rowOffset` so sibling tool rounds within one turn
      // never collide on `turn_index`.
      turnIndex,
      // BE-W48-01 — explicit per-row JS-side timestamp; see
      // `persistUserMessage` for the full rationale. Each tool round
      // writes its own row, so this call site contributes one distinct
      // timestamp per tool round inside the turn transaction.
      createdAt: new Date(),
      computedAt: new Date(),
      // Wave 52 BE-W52-03 — `resultJson` removed (column dropped).
      targetId: targetId as unknown as string,
      targetKind: targetKind as unknown as AiResultTargetKind,
    } as Partial<AiExecutiveMessage>);
    await repo.save(row);

    // Return the capture so the hop loop can remember it for the
    // trailing assistant row's inheritance.
    return { id: targetId, kind: targetKind };
  }

  // ────────────────────────────────────────────────────────────────
  // Post-turn quota deduction
  // ────────────────────────────────────────────────────────────────

  private async deductPostTurnUsage(
    userId: string,
    meta: AssistantTurnMeta,
    tokensIn: number,
    tokensOut: number,
  ): Promise<void> {
    // W68-FIX-01 (2026-04-28) — was: hop-based estimate that under-charged
    // by ~12× (PER_HOP_ESTIMATE_THB × 0.03 yielded ~$0.01 per turn
    // regardless of real token usage). Real cost is computed from
    // OpenAI's authoritative token usage via `calculateAiCost`, matching
    // every other caller of `checkAndLogUsage` across the codebase.
    // W68-FIX-08 (2026-04-28) — fallback model literal switched
    // `gpt-4o` → `gpt-4.1-mini` so an absent `meta.modelUsed` (which
    // never happens on the controller-driven path but is defensively
    // handled) costs the same as the new default. The helper itself
    // defaults to 0 + warn for unknown models, so an unexpected model
    // name never throws.
    // Deduction MUST be best-effort and MUST NOT throw per §17.2.
    const costUsd = calculateAiCost(meta.modelUsed || 'gpt-4.1-mini', {
      prompt_tokens: tokensIn,
      completion_tokens: tokensOut,
    });
    try {
      await this.quotaService.checkAndLogUsage(userId, costUsd, {
        usageType: 'executive-chat',
        inputTokens: tokensIn,
        outputTokens: tokensOut,
        modelName: meta.modelUsed,
      });
    } catch (err) {
      this.logger.warn(
        `[executive-chat] post-turn quota deduction failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // ────────────────────────────────────────────────────────────────
  // Wave 51 / BE-W51-02 — Auto-title generation
  //
  // Fires once per conversation, AFTER the first turn's `message_complete`
  // + `deductPostTurnUsage`. Non-throwing by contract: any failure (LLM
  // outage, JSON schema drift, redactor throw, DB error) is logged and
  // swallowed; the literal `'บทสนทนาใหม่'` placeholder stays.
  //
  // CLAUDE.md references:
  //   §12    — no tracking_status write. Ever.
  //   §17.2  — advisory; title is display metadata, never a workflow gate.
  //   §17.3  — persist goes to `ai_executive_conversations` only; no FK,
  //            no tracking_status, no cross-table coupling.
  //   §17.4  — no `isStale` semantics on the conversation title; the
  //            row is mutable metadata, not a per-turn snapshot.
  //   §17.5  — exactly once per conversation; no auto-recompute. The
  //            compare-and-set gate (`WHERE title_source =
  //            'default-placeholder'`) enforces this.
  //   §17.8  — endpoint key `'executive-chat-autotitle'` is DISTINCT
  //            from the `'executive-chat'` cooldown bucket.
  //   §17.9  — input delimited via `wrapUserInput`; output schema-validated;
  //            HTML rejected; PiiRedactor applied to LLM OUTPUT as
  //            defense-in-depth (input redaction happened upstream).
  //   §17.11 — no role exemption; the compare-and-set guard is an
  //            integrity invariant, not a permission check.
  // ────────────────────────────────────────────────────────────────

  /**
   * Post-turn auto-title generator. Called at most ONCE per conversation
   * from the first-turn terminal-assistant branch of `runToolLoop`.
   *
   * Idempotency / ordering guarantees:
   *   - PRE-CHECK: re-reads the conversation row and early-returns when
   *     `titleSource !== 'default-placeholder'` (owner renamed, prior
   *     auto-title already won, or row was soft-deleted).
   *   - COMPARE-AND-SET on persist: the UPDATE filters on
   *     `title_source = 'default-placeholder'` so a concurrent user
   *     rename always wins the race.
   *
   * Non-throwing: every failure path logs warn + returns; the caller
   * uses fire-and-forget semantics.
   */
  private async generateAutoTitleIfEligible(
    conversationId: string,
    userId: string,
    redactedFirstUserMessage: string,
    /**
     * Wave 51 BE-W51-03 — optional live SSE sink. When present and the
     * compare-and-set UPDATE actually flips a row, the helper emits a
     * `conversation_renamed` frame so the FE sidebar can swap the
     * placeholder for the real title without a refetch. Omission (or a
     * socket that has been torn down) MUST NOT change any persistence
     * behavior; emission is purely additive and best-effort.
     */
    response?: Response,
  ): Promise<void> {
    try {
      // PRE-CHECK (§17.5) — avoid the LLM round-trip entirely when the
      // compare-and-set would fail anyway (owner renamed, or an earlier
      // worker already won the race).
      const existing = await this.conversationRepo.findOne({
        where: { id: conversationId, deletedAt: IsNull() },
      });
      if (!existing) return;
      if (existing.titleSource !== 'default-placeholder') return;

      // Defense-in-depth redaction on the input. `redactedFirstUserMessage`
      // is already PII-stripped by the caller (see `sendMessage`), but
      // re-running the redactor here keeps this method self-contained and
      // safe to call from any future trigger site. Redaction is
      // idempotent — rerunning on clean text returns clean text with
      // zero counts.
      const safeInput = this.piiRedactor.redactText(redactedFirstUserMessage, {
        endpoint: 'executive-chat-autotitle',
      }).output;

      const params: ChatCompletionParamsNonStreaming = {
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: TITLE_GENERATION_SYSTEM_PROMPT },
          { role: 'user', content: this.wrapUserInput(safeInput) },
        ],
        temperature: 0.3,
        max_tokens: 64,
        response_format: { type: 'json_object' },
      };

      const completion = await this.llmClient.createChatCompletion(params);
      const raw = completion.choices?.[0]?.message?.content ?? '';

      const parsed = this.parseTitleJson(raw);
      if (!parsed) return;
      const sanitized = this.sanitizeTitle(parsed.title);
      if (!sanitized) return;

      // §17.9 defense-in-depth — the LLM may echo PII that survived the
      // input redaction (e.g. a phone number baked into the question).
      // Re-redact the VALIDATED title before persist so the sidebar
      // never surfaces leaked PII.
      const safeTitle = this.piiRedactor.redactText(sanitized, {
        endpoint: 'executive-chat-autotitle',
      }).output;
      if (!safeTitle || safeTitle.trim().length === 0) return;

      // Compare-and-set persist. The WHERE clause guarantees a concurrent
      // user-rename wins the race: if `title_source` has been flipped to
      // `'user-rename'` (or `'llm-auto'` by another worker) between the
      // pre-check and this statement, the UPDATE affects zero rows and
      // we silently no-op.
      const writeResult = await this.conversationRepo
        .createQueryBuilder()
        .update(AiExecutiveConversation)
        .set({
          title: safeTitle,
          titleSource: 'llm-auto',
          titleGeneratedAt: new Date(),
        })
        .where('id = :id', { id: conversationId })
        .andWhere("title_source = 'default-placeholder'")
        .andWhere('deleted_at IS NULL')
        .execute();

      if ((writeResult.affected ?? 0) === 0) return;

      // Post-success usage deduction. Best-effort per §17.2 — the
      // `checkAndLogUsage` implementation already swallows internal
      // errors via `handleException`, but we wrap defensively here too
      // so a hypothetical future throw never surfaces upstream.
      try {
        const tokensIn = completion.usage?.prompt_tokens ?? 0;
        const tokensOut = completion.usage?.completion_tokens ?? 0;
        // Cost is estimated from token counts at the gpt-4o-mini floor
        // ($0.15/M input, $0.60/M output). This mirrors the pattern
        // used by `deductPostTurnUsage` (advisory, not reserved).
        const costUsd =
          (tokensIn * 0.15) / 1_000_000 + (tokensOut * 0.6) / 1_000_000;
        await this.quotaService.checkAndLogUsage(userId, costUsd, {
          usageType: 'executive-chat-autotitle',
          inputTokens: tokensIn,
          outputTokens: tokensOut,
          modelName: 'gpt-4o-mini',
        });
      } catch (err) {
        this.logger.warn(
          `[executive-chat] auto-title usage log failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      // Wave 51 BE-W51-03 — best-effort SSE notification.
      //
      // Placement: AFTER the compare-and-set UPDATE affected a row
      // (guarded by the early return above) AND AFTER post-success
      // quota deduction. This mirrors task §5's "do not advertise a
      // title that failed to persist" rule.
      //
      // Wrapped in try/catch: `this.emit` already swallows EPIPE /
      // ERR_STREAM_DESTROYED internally, but a belt-and-braces guard
      // ensures any future throw (e.g. JSON.stringify on a cyclic
      // payload) never bubbles up into the fire-and-forget promise.
      // Silent-log on failure per §17.2 advisory semantics.
      if (response) {
        try {
          this.emit(response, 'conversation_renamed', {
            conversationId,
            title: safeTitle,
            titleSource: 'llm-auto',
            titleGeneratedAt: new Date().toISOString(),
          });
        } catch (err) {
          this.logger.debug?.(
            `[executive-chat] auto-title SSE emit skipped (socket likely closed): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    } catch (err) {
      // §17.2 — every failure mode here (LLM 5xx, JSON parse, schema
      // drift, redactor throw, DB error) MUST be swallowed. The user
      // experience (message_complete + done) is already complete; a
      // silent placeholder is the correct degraded state.
      this.logger.warn(
        `[executive-chat] auto-title failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Strict JSON parser for the title-gen LLM response. Returns `null`
   * on any shape violation so the caller degrades to placeholder.
   *
   * §17.9 — schema drift is a validation failure, NOT an altered
   * verdict. We refuse to coerce malformed output into a title.
   */
  private parseTitleJson(raw: string): { title: string } | null {
    try {
      const obj = JSON.parse(raw) as unknown;
      if (!obj || typeof obj !== 'object') return null;
      const candidate = (obj as { title?: unknown }).title;
      if (typeof candidate !== 'string') return null;
      return { title: candidate };
    } catch {
      return null;
    }
  }

  /**
   * Sanitise the LLM-supplied title string. Returns `null` on any
   * rejection so the caller degrades to placeholder.
   *
   * Steps (design §8 post-validator):
   *   1. Strip control characters.
   *   2. Reject if contains `<` or `>` (HTML defense).
   *   3. Trim whitespace + strip leading/trailing quotes/punctuation.
   *   4. Clamp via visible-cell budget (Thai=1.0, Latin=0.7, budget=40).
   *   5. Return `null` on empty-after-sanitise.
   */
  private sanitizeTitle(input: string): string | null {
    if (typeof input !== 'string') return null;
    // Step 1 — strip control chars (incl. DEL). eslint-disable handled
    // implicitly because the regex uses unicode escapes.
    // eslint-disable-next-line no-control-regex
    let out = input.replace(/[\u0000-\u001F\u007F]/g, '');
    // Step 2 — HTML / angle-bracket defense. A title that contains
    // markup is either an injection attempt or schema drift; refuse.
    if (out.includes('<') || out.includes('>')) return null;
    // Step 3 — trim + strip leading/trailing quotes and punctuation.
    out = out.trim();
    out = out.replace(/^[\s"'`“”‘’.,:;!?()\[\]{}]+/, '');
    out = out.replace(/[\s"'`“”‘’.,:;!?()\[\]{}]+$/, '');
    if (out.length === 0) return null;
    // Step 4 — visible-cell clamp. Latin chars are roughly 0.7 cells of
    // a Thai char on the Thai sidebar font; Thai (and any non-ASCII)
    // counts as 1 cell. Truncate at the first boundary that exceeds
    // the 40-cell budget, append an ellipsis if we truncated, and keep
    // the output bounded at a safe 80-char hard cap regardless.
    const BUDGET_CELLS = 40;
    const HARD_CAP_CHARS = 80;
    let cells = 0;
    let cutIndex = out.length;
    for (let i = 0; i < out.length; i++) {
      const ch = out.charCodeAt(i);
      const cellWeight = ch < 128 ? 0.7 : 1.0;
      if (cells + cellWeight > BUDGET_CELLS) {
        cutIndex = i;
        break;
      }
      cells += cellWeight;
    }
    let clamped = out.slice(0, cutIndex);
    if (clamped.length < out.length) {
      clamped = `${clamped.trimEnd()}…`;
    }
    if (clamped.length > HARD_CAP_CHARS) {
      clamped = `${clamped.slice(0, HARD_CAP_CHARS - 1)}…`;
    }
    clamped = clamped.trim();
    if (clamped.length === 0) return null;
    return clamped;
  }

  // ────────────────────────────────────────────────────────────────
  // Utilities
  // ────────────────────────────────────────────────────────────────

  private emit(response: Response, event: string, data: unknown): void {
    try {
      response.write(`event: ${event}\n`);
      response.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {
      // Client disconnected — stop emitting; caller cleanup will run.
    }
  }

  /**
   * Per-row content hash — §17.4 snapshot idempotency key.
   *
   * Canonicalises the row-identity tuple
   *   `(conversationId, role, turnIndex, normalizedPayload)`
   * to a JSON string, NFC-normalises the payload BEFORE PII redaction
   * (§17.9 ordering: hash-first, redact-second), and emits a SHA-256
   * hex digest — the same 64-char shape every other `ai_*` table uses.
   *
   * The `turnIndex` parameter is the conversation-wide row offset at
   * the moment this row is about to be inserted. Combined with
   * `conversationId` and `role`, it guarantees every persisted chat
   * row across the system has a distinct `content_hash`.
   *
   * Used by all four persist* helpers in this file.
   */
  private rowHash(input: {
    conversationId: string;
    role: AiChatRole;
    turnIndex: number;
    normalizedPayload: string;
  }): string {
    const canonical = JSON.stringify({
      c: input.conversationId,
      r: input.role,
      t: input.turnIndex,
      p: (input.normalizedPayload ?? '').normalize('NFC'),
    });
    return createHash('sha256').update(canonical, 'utf8').digest('hex');
  }
}

// Exported so the controller can narrow response type without
// pulling in the service body.
export type { PostChatMessageDto as ExecutiveChatRequestDto };
