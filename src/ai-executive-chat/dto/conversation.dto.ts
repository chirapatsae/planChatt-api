/**
 * Response shapes for conversation list + message list endpoints.
 *
 * These are plain interface shapes (not `class-validator` classes)
 * because they are response envelopes only — no incoming body.
 *
 * §17.3 boundary: neither shape carries a FK into project / plan /
 * tracking tables. `targetId` is an opaque uuid pointer with no
 * referential integrity.
 *
 * §17.4 boundary: chat turns are `snapshot-only`; the read-side MUST
 * force `isStale: false`. BE-W44-02 applies this policy at the service
 * layer — this DTO only carries the raw row fields.
 */

import { AiChatRole } from '../entities/ai-executive-message.entity';

export interface ChatConversationSummaryDto {
  id: string;
  title: string;
  model: string;
  createdAt: string;
  updatedAt: string | null;
  /**
   * Preview of the last non-tool message in the conversation. Nullable
   * when the conversation has only system/tool turns (e.g., a freshly
   * created empty conversation).
   */
  lastMessagePreview: string | null;
  /** Count of persisted turns, including tool/system. */
  messageCount: number;
  /**
   * Wave 51 BE-W51-01 — discriminator for how the current title was
   * produced. Projected verbatim from
   * `AiExecutiveConversation.titleSource` (DB column
   * `ai_executive_conversations.title_source`). Drives FE copy +
   * animation states (e.g. auto-title skeleton while an LLM call is
   * pending) and the BE-W51-02 compare-and-set idempotency gate
   * (auto-title is allowed only while this is `'default-placeholder'`).
   *
   * §12 — title source is metadata, NOT a workflow status. No
   *       `tracking_status` row is written when it changes.
   * §17.3 — no FK introduced by surfacing this field.
   * §17.11 — the enum domain is integrity, not permission.
   */
  titleSource: 'default-placeholder' | 'llm-auto' | 'user-rename';
  /**
   * Wave 51 BE-W51-01 — ISO-8601 timestamp of the most recent title
   * write (either `'user-rename'` or `'llm-auto'`). `null` while the
   * row still carries the `'default-placeholder'` sentinel, so the FE
   * can render an age-based skeleton before the first auto-title lands.
   */
  titleGeneratedAt?: string | null;
}

export interface ChatMessageDto {
  id: string;
  conversationId: string;
  role: AiChatRole;
  /**
   * Nullable for `tool`-role turns that carry only `toolResult`.
   *
   * Wire-shape name: `content` (matches FE `ChatMessage.content` and
   * the SSE `message_complete.content` frame so the FE mapper can
   * spread REST rows into local state without a per-field rename).
   * The ORM column / entity property remains `contentText` —
   * `toMessageDto` performs the rename on the BE side.
   *
   * Fix: Wave 46 QA-W46-01 H1 — prior to this rename the FE
   * `[activeId]` hydration effect received `contentText` but rendered
   * `message.content`, producing empty bubbles on every reload. See
   * `docs/reports/wave46/QA-W46-01.md` §H1.
   */
  content: string | null;
  toolName: string | null;
  /** Opaque blob — FE renders or ignores. */
  toolCallsJson: Record<string, unknown> | null;
  toolResultJson: Record<string, unknown> | null;
  createdAt: string;
  /**
   * Deterministic per-conversation monotonic counter (Wave 50 BE-W50-01).
   *
   * Encodes strict insertion order within a conversation. Starts at 0
   * for the oldest row; every subsequent row bumps by 1. FE SHOULD sort
   * by `turnIndex ASC` to render chronological order; the legacy
   * `createdAt ASC` sort remains correct but is no longer primary.
   *
   * Always present on every row emitted by the backend from Wave 50
   * onward. FE type FE-W50-01 accepts this field as optional for
   * backward-compat with any cached response from pre-Wave-50 builds.
   *
   * §17.2 advisory — ordering is display integrity, not a workflow gate.
   * §17.3 audit separation — no FK; plain integer metadata.
   */
  turnIndex: number;
  /** Model that produced this turn (assistant/tool turns only). */
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  /**
   * §17.4 snapshot-only — MUST be false in every served row.
   * Carried on the DTO for FE type-ergonomics.
   */
  isStale: false;
}
