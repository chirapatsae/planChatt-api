import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

import { AiKnowledgeEntry } from './ai-knowledge-entry.entity';

/**
 * Wave wave-ai-knowledge-hub — DB-01 (2026-06-12).
 *
 * `ai_knowledge_entry_revisions` — IMMUTABLE per-version history rows for
 * curated knowledge entries (report §2.2).
 *
 * Invariants:
 *
 *   - Rows are write-once. There is NO update path — every edit on the
 *     parent entry inserts a NEW revision row and bumps
 *     `ai_knowledge_entries.current_version` (BE-02). History is never
 *     overwritten, mirroring the §11/§12 never-rewrite-history spirit
 *     inside the ai_* namespace.
 *   - UNIQUE `(entry_id, version)` — at most one row per version per entry.
 *   - `entry_id` FK → `ai_knowledge_entries` with CASCADE on hard delete.
 *     ai_* → ai_* referential integrity is allowed (§17.3 forbids FKs into
 *     PROJECT tables only). Soft delete of the entry leaves revisions
 *     intact; a (rare, admin-initiated) hard delete takes the whole
 *     history with it.
 *   - `edited_by_work_history_id` is a plain uuid — NO FK (§17.3
 *     actor-by-UUID precedent, `ai_pre_submit_snapshots`).
 *   - No `updated_at` / `deleted_at` — immutable rows have no update or
 *     soft-delete lifecycle.
 */
@Entity('ai_knowledge_entry_revisions')
@Unique('uq_ai_knowledge_entry_revisions_entry_version', ['entryId', 'version'])
export class AiKnowledgeEntryRevision {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Relation to the parent entry (ai_* → ai_* FK — allowed). The dual
   * relation + plain-column mapping follows the `backup-login` entity
   * precedent so callers can read/write `entryId` without loading the
   * relation.
   */
  @ManyToOne(() => AiKnowledgeEntry, {
    onDelete: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'entry_id' })
  entry: AiKnowledgeEntry;

  @Column({ name: 'entry_id', type: 'uuid' })
  entryId: string;

  /** Version number this row snapshots (1-based, monotonic per entry). */
  @Column({ name: 'version', type: 'int' })
  version: number;

  @Column({ name: 'title', type: 'varchar', length: 300 })
  title: string;

  @Column({ name: 'body_md', type: 'text' })
  bodyMd: string;

  @Column({ name: 'tags', type: 'text', array: true, default: () => `'{}'` })
  tags: string[];

  /** SHA-256 hex over NFC-normalized `title + body_md` at edit time (§17.4). */
  @Column({ name: 'content_hash', type: 'char', length: 64 })
  contentHash: string;

  /** WorkHistory UUID of the editor. NO FK (§17.3). */
  @Column({ name: 'edited_by_work_history_id', type: 'uuid' })
  editedByWorkHistoryId: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
