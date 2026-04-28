import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { AiExecutiveConversation } from './ai-executive-conversation.entity';
import { AiResultTargetKind } from '../../ai/utils/ai-score-envelope';

/**
 * Role discriminator for an executive chat turn.
 *
 *   - `user`      : prompt from the executive
 *   - `assistant` : model output
 *   - `tool`      : tool-invocation or tool-result turn
 *   - `system`    : system prompt seeded by the backend
 */
export type AiChatRole = 'user' | 'assistant' | 'tool' | 'system';

/**
 * ai_executive_messages — Executive AI Chat turn log (Wave 44 origin).
 *
 * ──────────────────────────────────────────────────────────────────────
 * WAVE 52 DECOUPLE (2026-04-24)
 * ──────────────────────────────────────────────────────────────────────
 * As of Wave 52, this entity NO LONGER `extends AbstractAiResult`.
 *
 * Rationale (see `docs/reports/wave52/WAVE52_CHAT_AI_DECOUPLING_RCA.md`):
 *
 *   - Chat turns are fundamentally a conversation-turn log, not a scored
 *     AI-result record. The columns `score_0_100`, `band`, `result_json`,
 *     `computed_by_work_history_id`, `updated_at`, and `staleness_policy`
 *     were inherited from `AbstractAiResult` but were either always-NULL,
 *     always-`{}`, or always-`'snapshot-only'` in chat rows. They are
 *     DROPPED from the underlying table by migration
 *     `1748000000000-DecoupleAiExecutiveMessages.ts` (DB-W52-01).
 *
 *   - The Wave 46 entity-inheritance foot-gun (TypeORM 0.3.x silently
 *     ignoring `declare field` + `@Column` overrides on inherited
 *     columns) is eliminated by removing the base class entirely. Every
 *     column is now first-class on this entity — no more base-vs-child
 *     metadata fights. See `docs/reports/wave46/*` for the historical
 *     pathology.
 *
 *   - §17.4 `snapshot-only` guarantee is now enforced at the MODULE
 *     level instead of via a per-row `staleness_policy` column. The sole
 *     writer is `AiExecutiveChatService`; the sole read projection
 *     (`toMessageDto`) hard-codes `isStale: false`. Removing the per-row
 *     column TIGHTENS the invariant — the row cannot express a
 *     non-snapshot-only policy because the column does not exist.
 *
 * CLAUDE.md references preserved from the pre-Wave-52 shape:
 *
 *   - §17.3 Audit separation (CRITICAL). The sole FK leaving this row
 *     is intra-AI: `conversation_id REFERENCES ai_executive_conversations(id)
 *     ON DELETE CASCADE`. `target_id` is a plain uuid with NO FK into
 *     project / plan / tracking tables — §14.6 rollback hard-deletes
 *     and §15 book lineage unlocks MUST NEVER cascade into chat history.
 *
 *   - §17.4 Staleness — chat messages are point-in-time photographs.
 *     Module-level invariant replaces the per-row column; read envelope
 *     forces `isStale: false` unconditionally.
 *
 *   - §17.11 No role exemption. Persistence discipline is an integrity
 *     guarantee, not a permission. No role may coerce a chat turn into
 *     a workflow audit signal (§12 / §17.3).
 *
 *   - §12 Audit — chat NEVER writes to `tracking_status`.
 */
@Entity('ai_executive_messages')
@Index('ix_ai_executive_messages_conversation_created', [
  'conversationId',
  'createdAt',
])
@Index('ix_ai_executive_messages_conversation_hash', [
  'conversationId',
  'contentHash',
])
@Index('ix_ai_executive_messages_conversation_turn', [
  'conversationId',
  'turnIndex',
])
export class AiExecutiveMessage {
  // ──────────────────────────────────────────────────────────────────
  // Identity + FK group
  // ──────────────────────────────────────────────────────────────────

  /**
   * Primary key. Lifted from `AbstractAiResult` post-Wave-52 decouple.
   */
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Intra-AI FK to the parent conversation (§17.3 permits FK between
   * `ai_*` tables; it is the project/plan/tracking boundary that must
   * not be crossed). `ON DELETE CASCADE` is safe — conversations are
   * soft-deleted, so the cascade fires only under explicit hard delete.
   */
  @Column({ name: 'conversation_id', type: 'uuid' })
  conversationId: string;

  @ManyToOne(
    () => AiExecutiveConversation,
    (conversation) => conversation.messages,
    { onDelete: 'CASCADE' },
  )
  @JoinColumn({ name: 'conversation_id' })
  conversation: AiExecutiveConversation;

  // ──────────────────────────────────────────────────────────────────
  // Turn ordering (Wave 50 — cold-boot widened nullability)
  // ──────────────────────────────────────────────────────────────────

  /**
   * Deterministic per-conversation monotonic counter (Wave 50 DB-W50-01).
   *
   * Encodes explicit row-insertion order within a conversation so
   * hydration / history replay / preview `DISTINCT ON` queries never
   * tiebreak on the random UUID `id` column. `turn_index` starts at 0
   * for the oldest message in a conversation and is strictly
   * increasing; duplicates within a `conversation_id` partition are a
   * bug.
   *
   * Governance:
   *   - §17.3 Audit separation — integer metadata column, NO FK added.
   *   - §17.11 No role exemption — ordering is integrity, not a
   *     permission gate.
   *   - §12 — no `tracking_status` coupling.
   *
   * The composite index `(conversation_id, turn_index)` above supports
   * O(log N) sorted reads for `ORDER BY turn_index ASC` and the
   * `DISTINCT ON (conversation_id) ... ORDER BY turn_index DESC`
   * preview query (BE-W50-01).
   *
   * COLD-BOOT NULLABILITY ACCOMMODATION (Wave 50 HOTFIX, 2026-04-23)
   * ────────────────────────────────────────────────────────────────
   * TypeORM's `DataSource.synchronize()` runs as part of
   * `DataSource.initialize()` — i.e. BEFORE any `OnApplicationBootstrap`
   * hook (including `BootstrapMigrationsService`). On a dev/staging DB
   * that predates this column, synchronize reads the entity shape and
   * tries `ALTER TABLE ai_executive_messages ADD COLUMN turn_index
   * INTEGER NOT NULL` — Postgres refuses with 23502 because existing
   * rows would receive NULL. This is the exact pathology fixed in Wave
   * 46 for `target_id` (see `docs/reports/WAVE46_*` HOTFIX notes).
   *
   * Resolution: the TypeScript-level column is declared `nullable: true`
   * so synchronize emits the column without a NOT NULL constraint. The
   * bootstrap hook (`BootstrapMigrationsService`) then runs POST-
   * synchronize and executes the canonical three-step ritual — ADD
   * COLUMN IF NOT EXISTS (no-op after synchronize), backfill via
   * `row_number()`, `ALTER COLUMN ... SET NOT NULL` — so the steady-
   * state DB shape is NOT NULL. The service layer (BE-W50-01) always
   * writes a real integer on every row, so `null` is observable ONLY
   * during the brief window between `synchronize` and the bootstrap
   * hook's backfill on first post-deploy boot. The TypeScript `| null`
   * union is metadata accommodation, NOT a semantic change.
   */
  @Column({ name: 'turn_index', type: 'int', nullable: true })
  turnIndex: number | null;

  // ──────────────────────────────────────────────────────────────────
  // Role + payload
  // ──────────────────────────────────────────────────────────────────

  /**
   * Role of the turn. Uses the local `ai_chat_role` enum.
   */
  @Column({
    name: 'role',
    type: 'enum',
    enum: ['user', 'assistant', 'tool', 'system'] as AiChatRole[],
    enumName: 'ai_chat_role',
  })
  role: AiChatRole;

  /**
   * Raw message text (user prompt or assistant reply). Nullable because
   * a `tool` turn may carry only `tool_calls_json` / `tool_result_json`.
   */
  @Column({ name: 'content_text', type: 'text', nullable: true })
  contentText: string | null;

  /**
   * Structured tool-call payload emitted by the assistant (e.g. OpenAI
   * tool_calls array). Nullable.
   */
  @Column({ name: 'tool_calls_json', type: 'jsonb', nullable: true })
  toolCallsJson: Record<string, unknown> | null;

  /**
   * Name of the invoked tool (when `role = 'tool'`). Nullable.
   */
  @Column({ name: 'tool_name', type: 'varchar', length: 64, nullable: true })
  toolName: string | null;

  /**
   * Structured tool result payload (when `role = 'tool'`). Nullable.
   */
  @Column({ name: 'tool_result_json', type: 'jsonb', nullable: true })
  toolResultJson: Record<string, unknown> | null;

  @Column({ name: 'tokens_in', type: 'int', nullable: true })
  tokensIn: number | null;

  @Column({ name: 'tokens_out', type: 'int', nullable: true })
  tokensOut: number | null;

  // ──────────────────────────────────────────────────────────────────
  // Target (Wave 46 H1 widened — §17.3 no-FK metadata)
  // ──────────────────────────────────────────────────────────────────

  /**
   * `target_id` / `target_kind` semantics for chat turns
   * (BE-W45-01, supersedes Wave 44 HOTFIX-W44-01 sentinel path):
   *
   *   - NULL when the turn is not "about" any one specific project.
   *     This covers: every `user` row (free-text prompts never resolve
   *     to a UUID); every `tool` row whose result is an aggregate, a
   *     bucket, or a multi-row array (the LLM has not narrowed to a
   *     single project); and every `assistant` row whose turn contained
   *     no single-project tool round.
   *   - A real UUID when a tool resolved the turn to exactly one
   *     concrete project. Tool rows capture via
   *     `extractTargetFromToolResult` (see `tools/extract-target.ts`);
   *     trailing assistant rows inherit the most recent non-null
   *     tool-round capture within the same turn (last-write-wins,
   *     bounded to one turn).
   *   - NO foreign key to any project table (§17.3 audit separation
   *     is absolute — §14.6 rollback hard-deletes MUST NOT cascade
   *     into chat history). The column is informational metadata.
   *
   * WAVE 46 HOTFIX (preserved at entity level post-Wave-52 decouple):
   * Column is `nullable: true`. Prior to the Wave 52 decouple this
   * nullability was declared on the `AbstractAiResult` base class; now
   * it is declared here directly. Snapshot-style AI result tables
   * (e.g. `ai_pre_submit_snapshots`) continue to enforce NOT NULL at
   * the SERVICE layer on their own entity declarations.
   *
   * LEGACY DATA NOTE:
   *   Rows written before BE-W45-01 by the Wave 44 HOTFIX-W44-01 path
   *   may still carry the sentinel UUID `00000000-0000-0000-0000-000000000000`
   *   alongside `target_kind = 'project-group'`. Analytics queries that
   *   count "how many chat turns are about project X" SHOULD filter
   *   `target_id <> '00000000-0000-0000-0000-000000000000'` until
   *   DB-W45-01 backfill completes. Chat rows are always discriminable
   *   from per-project AI-result rows via `endpoint = 'executive-chat'`.
   */
  @Column({ name: 'target_id', type: 'uuid', nullable: true })
  targetId: string | null;

  /**
   * Discriminator for `target_id`. Uses shared `ai_target_kind` enum
   * (owned by the RF2/RF5 AI foundation migration).
   *
   * Wave 46 HOTFIX — nullable; paired coherently with `targetId`.
   * See §17.3 doc above on `targetId` for the full rationale.
   */
  @Column({
    name: 'target_kind',
    type: 'enum',
    enum: [
      'project-group',
      'revised-project-group',
      'supplement-project-group',
    ] as AiResultTargetKind[],
    enumName: 'ai_target_kind',
    nullable: true,
  })
  targetKind: AiResultTargetKind | null;

  // ──────────────────────────────────────────────────────────────────
  // Provenance
  // ──────────────────────────────────────────────────────────────────

  /**
   * Endpoint discriminator. Defaults to `'executive-chat'` — today every
   * chat row writes this constant, but the column is kept cheap as a
   * future discriminator if additional chat endpoint families ever
   * land on this table (RCA §7 non-goal L1).
   *
   * Lifted from `AbstractAiResult` at Wave 52 decouple; default
   * overridden to the chat value.
   */
  @Column({
    name: 'endpoint',
    type: 'varchar',
    length: 256,
    default: 'executive-chat',
  })
  endpoint: string;

  /**
   * Model identifier (e.g. `'gpt-4o'`). Lifted from `AbstractAiResult`
   * at Wave 52 decouple; default overridden to the chat default.
   * Assistant rows may persist the actually-used model after a
   * downgrade fallback.
   */
  @Column({
    name: 'model',
    type: 'varchar',
    length: 128,
    default: 'gpt-4o',
  })
  model: string;

  /**
   * SHA-256 hex of the canonical input hash that produced this row.
   * Lifted from `AbstractAiResult`; length preserved at 64. Used for
   * §17.4 per-turn idempotency in the service-layer write paths.
   */
  @Column({ name: 'content_hash', type: 'varchar', length: 64 })
  contentHash: string;

  /**
   * Timestamp of the AI run (UTC). Lifted from `AbstractAiResult`.
   *
   * Kept as an explicit `@Column` (NOT `@CreateDateColumn`) so the
   * service layer can write an explicit app-controlled value per row
   * for traceability — Wave 48 discipline preserved.
   */
  @Column({
    name: 'computed_at',
    type: 'timestamptz',
    default: () => 'CURRENT_TIMESTAMP',
  })
  computedAt: Date;

  // ──────────────────────────────────────────────────────────────────
  // Lifecycle
  // ──────────────────────────────────────────────────────────────────

  /**
   * Insertion timestamp. Wave 48 contract: the service layer writes an
   * explicit `new Date()` on every row for deterministic SSE ordering;
   * the `@CreateDateColumn` decorator remains as a safety-net default
   * for any code path that forgets.
   *
   * Lifted from `AbstractAiResult` at Wave 52 decouple.
   */
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  /**
   * Soft-delete marker, populated by the PDPA cascade on conversation
   * archival / retention-cron. Filtered on every read.
   *
   * Lifted from `AbstractAiResult` at Wave 52 decouple.
   *
   * Post-Wave-52: the `updated_at` column that was inherited from
   * `AbstractAiResult` is INTENTIONALLY NOT DECLARED — chat rows are
   * append-only and never updated in place. Migration
   * `1748000000000-DecoupleAiExecutiveMessages.ts` drops the column.
   */
  @DeleteDateColumn({
    name: 'deleted_at',
    type: 'timestamptz',
    nullable: true,
  })
  deletedAt: Date | null;
}
