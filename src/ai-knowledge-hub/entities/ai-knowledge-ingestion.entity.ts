import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

import { AiKnowledgeEntry } from './ai-knowledge-entry.entity';
import { AiKnowledgeSource } from './ai-knowledge-source.entity';

/**
 * Wave wave-ai-knowledge-hub — DB-02 (2026-06-12).
 *
 * Staging verdict lifecycle (report §2.3/§4): every accepted payload
 * lands `quarantined`; schema-validation failures land `rejected` (with
 * stored errors — still auditable); admin review promotes (`promoted`,
 * spawning a draft `ai_knowledge_entries` row) or rejects; the PDPA
 * retention cron tombstones aged rejected/unreviewed rows as `purged`
 * (docs/pdpa/06, report §6.2).
 */
export const AI_KNOWLEDGE_INGESTION_STATUSES = [
  'quarantined',
  'rejected',
  'promoted',
  'purged',
] as const;

export type AiKnowledgeIngestionStatus =
  (typeof AI_KNOWLEDGE_INGESTION_STATUSES)[number];

/**
 * `ai_knowledge_ingestions` — QUARANTINE-ONLY landing zone for external
 * payloads (wave decision #2; report §2.3). External data is hostile by
 * default (§17.9) — nothing in this table is EVER prompt-eligible, in any
 * status. Promotion copies content into a draft `ai_knowledge_entries`
 * row (`origin = 'external'`), which then walks the normal publish flow.
 *
 * Invariants (CLAUDE.md §17.3 / §17.9; report §6 STRIDE):
 *
 *   - `ai_*` namespace ONLY. NO foreign key into `project_groups` or any
 *     other project-owning table. The ONLY FKs are ai_* → ai_*
 *     (`source_id` → `ai_knowledge_sources`, `promoted_entry_id` →
 *     `ai_knowledge_entries`) — allowed per §17.3.
 *   - UNIQUE `(source_id, idempotency_key)` — replay/dedupe guarantee
 *     (STRIDE-T): a duplicate push returns the original row, no re-insert.
 *   - `payload` is stored VERBATIM (jsonb) — §17.9 delimiter-wrapping
 *     happens at CONSUMPTION time, and staging is never consumed by the
 *     chat at all. `payload_bytes` records size for the 256 KB cap +
 *     Phase-B object-storage offload trigger (report §5).
 *   - `content_hash` = SHA-256 hex recorded at receipt (§17.4 discipline /
 *     STRIDE-T tamper evidence).
 *   - `reviewed_by_work_history_id` is a plain uuid — NO FK (§17.3
 *     actor-by-UUID). Review verdicts ALSO write `ai_knowledge_audit_logs`
 *     (`promote` / `reject`) — never TrackingStatus.
 *   - Rows are append-only from the source's perspective; only the admin
 *     review verdict + retention purge mutate them (BE-03). No
 *     `updated_at` by design — `reviewed_at` is the only meaningful
 *     post-receipt timestamp.
 */
@Entity('ai_knowledge_ingestions')
@Unique('uq_ai_knowledge_ingestions_source_idempotency', [
  'sourceId',
  'idempotencyKey',
])
@Index('ix_ai_knowledge_ingestions_source_received', [
  'sourceId',
  'receivedAt',
])
@Index('ix_ai_knowledge_ingestions_status', ['status'])
export class AiKnowledgeIngestion {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Source that pushed this payload (ai_* → ai_* FK — allowed). Dual
   * relation + plain-column mapping per the `ai_knowledge_entry_revisions`
   * precedent; a (rare, admin-initiated) hard delete of the source takes
   * its staging rows with it — the no-FK audit log survives.
   */
  @ManyToOne(() => AiKnowledgeSource, {
    onDelete: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'source_id' })
  source: AiKnowledgeSource;

  @Column({ name: 'source_id', type: 'uuid' })
  sourceId: string;

  /** Caller-supplied dedupe key — unique per source (STRIDE-T replay). */
  @Column({ name: 'idempotency_key', type: 'varchar', length: 128 })
  idempotencyKey: string;

  /** Raw inbound item, stored verbatim. NEVER prompt-eligible (§17.9). */
  @Column({ name: 'payload', type: 'jsonb' })
  payload: Record<string, unknown>;

  /** Serialized payload size — 256 KB cap + Phase-B trigger metric. */
  @Column({ name: 'payload_bytes', type: 'int' })
  payloadBytes: number;

  /** SHA-256 hex over the payload, recorded at receipt (§17.4). */
  @Column({ name: 'content_hash', type: 'char', length: 64 })
  contentHash: string;

  /** Receipt timestamp, stamped by BE-03 at ingest time. */
  @Column({ name: 'received_at', type: 'timestamptz' })
  receivedAt: Date;

  /** Remote address at receipt — abuse forensics. NULL if unresolvable. */
  @Column({ name: 'remote_ip', type: 'inet', nullable: true })
  remoteIp: string | null;

  @Column({
    name: 'status',
    type: 'enum',
    enum: AI_KNOWLEDGE_INGESTION_STATUSES,
    enumName: 'ai_knowledge_ingestion_status',
    default: 'quarantined',
  })
  status: AiKnowledgeIngestionStatus;

  /** Schema-validation failures (kept for source operators / audit). */
  @Column({ name: 'validation_errors', type: 'jsonb', nullable: true })
  validationErrors: Record<string, unknown> | null;

  /**
   * Automated PII scan findings (Thai national ID, phone, email patterns —
   * report §4). Q4 LOCKED: PII is categorically forbidden — any flag
   * BLOCKS promotion until the offending fields are removed/masked.
   */
  @Column({ name: 'pii_flags', type: 'jsonb', nullable: true })
  piiFlags: Record<string, unknown> | null;

  /** WorkHistory UUID of the reviewing admin. NO FK (§17.3). */
  @Column({
    name: 'reviewed_by_work_history_id',
    type: 'uuid',
    nullable: true,
  })
  reviewedByWorkHistoryId: string | null;

  @Column({ name: 'reviewed_at', type: 'timestamptz', nullable: true })
  reviewedAt: Date | null;

  /**
   * Entry spawned by promotion (ai_* → ai_* FK — allowed). SET NULL on
   * entry hard-delete so the staging/audit trail outlives the entry.
   */
  @ManyToOne(() => AiKnowledgeEntry, {
    onDelete: 'SET NULL',
    nullable: true,
  })
  @JoinColumn({ name: 'promoted_entry_id' })
  promotedEntry: AiKnowledgeEntry | null;

  @Column({ name: 'promoted_entry_id', type: 'uuid', nullable: true })
  promotedEntryId: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt: Date | null;
}
