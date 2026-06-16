import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import {
  AI_KNOWLEDGE_CLASSIFICATIONS,
  AiKnowledgeClassification,
} from '../types/ai-knowledge-classification.enum';
import { AiKnowledgeSource } from './ai-knowledge-source.entity';

/**
 * Wave wave-ai-knowledge-hub — DB-01 (2026-06-12; `source_id` upgraded to
 * a real FK + classification const hoisted to `../types/` by DB-02).
 *
 * `ai_knowledge_entries` — Phase-1 curated knowledge storage for the AI
 * Knowledge Hub (CLAUDE.md §17.15 scope clause via DOCS-01).
 *
 * Invariants (CLAUDE.md §17.3 / §17.4 / report §2.2):
 *
 *   - `ai_*` namespace ONLY. NO foreign key into `project_groups` or any
 *     project-owning table — knowledge entries are project-agnostic by
 *     design and must never cascade with project mutations.
 *   - Actors are referenced by WorkHistory UUID WITHOUT referential
 *     integrity (`created_by_work_history_id` / `updated_by_work_history_id`
 *     are plain uuid columns), matching the `ai_pre_submit_snapshots`
 *     precedent.
 *   - `content_hash` = SHA-256 hex over NFC-normalized `title + body_md`
 *     (§17.4 discipline). Stored for drift display and idempotent edits —
 *     NEVER for auto-recompute (§17.5). Curated entries are themselves the
 *     source of truth (`snapshot-only` analog posture).
 *   - `domain_key` is service-validated against BE-01's
 *     `derived-domain-map.ts` / curated-domain list — NOT a DB FK, because
 *     domains are code-declared data per §17.14.3.
 *   - `source_id` is a real nullable FK → `ai_knowledge_sources.id`
 *     (ai_* → ai_* — allowed; §17.3 forbids FKs into PROJECT tables only)
 *     since DB-02 landed the Phase-2 connector entities. ON DELETE SET
 *     NULL — a promoted entry outlives its source. Always NULL for
 *     `origin = 'curated'` rows.
 *   - Only `status = 'published'` entries are ever visible to the chat
 *     (BE-04 consumption). Draft / archived rows never enter a prompt.
 *   - §17.9 delimiter-wrapping happens at CONSUMPTION time (BE-04), not
 *     at storage — `body_md` is stored verbatim.
 *
 * Retrieval (Q5 LOCKED = pg_trgm): the GIN pg_trgm indexes on `title` +
 * `body_md` are expression indexes that TypeORM synchronize cannot create —
 * see the "Appendix — index SQL (DB-01)" section of
 * `docs/tasks/wave-ai-knowledge-hub/DB-01.md` for the exact manual SQL.
 * The btree indexes below ARE synchronize-managed; the two trgm indexes
 * are declared with `{ synchronize: false }` so schema sync neither
 * creates NOR DROPS them (verified via schema-builder dry-run: without
 * the declarations, the next boot emits `DROP INDEX` for both — the
 * same strip-on-reboot footgun as the SEPG CHECK constraint).
 */
@Entity('ai_knowledge_entries')
@Index('ix_ai_knowledge_entries_domain_status', ['domainKey', 'status'])
@Index('ix_ai_knowledge_entries_status', ['status'])
// GIN pg_trgm expression indexes — created manually (see DB-01.md
// appendix), excluded from synchronize so they survive reboots.
@Index('ix_ai_knowledge_entries_title_trgm', { synchronize: false })
@Index('ix_ai_knowledge_entries_body_md_trgm', { synchronize: false })
export class AiKnowledgeEntry {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Domain key from BE-01's `derived-domain-map.ts` or the curated-domain
   * list. Service-validated, NOT a DB FK (§17.14.3 — domains are
   * code-declared data).
   */
  @Column({ name: 'domain_key', type: 'varchar', length: 128 })
  domainKey: string;

  @Column({ name: 'title', type: 'varchar', length: 300 })
  title: string;

  /** Markdown body. Stored verbatim — §17.9 wrap happens at consumption. */
  @Column({ name: 'body_md', type: 'text' })
  bodyMd: string;

  @Column({ name: 'tags', type: 'text', array: true, default: () => `'{}'` })
  tags: string[];

  /**
   * `curated` = admin-authored (Q2: admin + super-admin only).
   * `external` = promoted from a quarantined Phase-2 ingestion (DB-02 /
   * BE-03) — origin is stamped at promotion time and never flips back.
   */
  @Column({
    name: 'origin',
    type: 'enum',
    enum: ['curated', 'external'],
    enumName: 'ai_knowledge_origin',
    default: 'curated',
  })
  origin: 'curated' | 'external';

  /**
   * Phase-2 linkage to the connector registry (ai_* → ai_* FK — allowed).
   * Upgraded from a plain uuid by DB-02. SET NULL on source hard-delete —
   * the promoted entry outlives its source. Always NULL for
   * `origin = 'curated'` rows. Dual relation + plain-column mapping per
   * the `ai_knowledge_entry_revisions` precedent.
   */
  @ManyToOne(() => AiKnowledgeSource, {
    onDelete: 'SET NULL',
    nullable: true,
  })
  @JoinColumn({ name: 'source_id' })
  source: AiKnowledgeSource | null;

  @Column({ name: 'source_id', type: 'uuid', nullable: true })
  sourceId: string | null;

  /** Only `published` rows are chat-visible (BE-04). */
  @Column({
    name: 'status',
    type: 'enum',
    enum: ['draft', 'published', 'archived'],
    enumName: 'ai_knowledge_entry_status',
    default: 'draft',
  })
  status: 'draft' | 'published' | 'archived';

  /**
   * Monotonic version pointer. Edit = insert a new immutable
   * `ai_knowledge_entry_revisions` row + bump this counter (BE-02).
   * History is never overwritten.
   */
  @Column({ name: 'current_version', type: 'int', default: 1 })
  currentVersion: number;

  /** SHA-256 hex over NFC-normalized `title + body_md` (§17.4). */
  @Column({ name: 'content_hash', type: 'char', length: 64 })
  contentHash: string;

  /** BCP-47-ish short code; Thai-dominant corpus per Q5. */
  @Column({ name: 'language', type: 'varchar', length: 8, default: 'th' })
  language: string;

  /**
   * Q4 LOCKED: classification ceiling for external data is `internal`;
   * PII is categorically forbidden in external payloads (enforced at
   * BE-03 ingestion, not DDL).
   */
  @Column({
    name: 'classification',
    type: 'enum',
    enum: AI_KNOWLEDGE_CLASSIFICATIONS,
    enumName: 'ai_knowledge_classification',
    default: 'internal',
  })
  classification: AiKnowledgeClassification;

  /** WorkHistory UUID of the author. NO FK (§17.3 / §4 actor-by-UUID). */
  @Column({ name: 'created_by_work_history_id', type: 'uuid' })
  createdByWorkHistoryId: string;

  /** WorkHistory UUID of the last editor. NO FK (§17.3). */
  @Column({ name: 'updated_by_work_history_id', type: 'uuid' })
  updatedByWorkHistoryId: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt: Date | null;
}
