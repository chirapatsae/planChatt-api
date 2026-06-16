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

import { AiKnowledgeCatalogTable } from './ai-knowledge-catalog-table.entity';

/**
 * Relationship cardinality for the documentation ER builder.
 *
 * PRE-DECLARED as a fixed four-value set so a later widening never
 * triggers the `ai_target_kind`-style drop/recreate/cast churn under
 * `synchronize:true` (same discipline as `ai_knowledge_audit_action`).
 */
export const AI_KNOWLEDGE_RELATION_TYPES = [
  'one_to_one',
  'one_to_many',
  'many_to_one',
  'many_to_many',
] as const;

export type AiKnowledgeRelationType =
  (typeof AI_KNOWLEDGE_RELATION_TYPES)[number];

/**
 * Wave wave-ai-knowledge-structure-mgmt — DB-01 (2026-06-13).
 *
 * `ai_knowledge_catalog_relations` — Class-A documentation edges of the
 * ER builder (architecture report §3.5; CLAUDE.md §17.16 via DOCS-01).
 * Each row is a drawn relationship between two CATALOG tables — NOT a
 * real Postgres foreign key.
 *
 * NO-DDL GUARANTEE (report §6.3 — ABSOLUTE): `on_delete_note` is a
 * free-text DOCUMENTATION string (e.g. "CASCADE", "ลบรายการแม่ = ลบประวัติตาม").
 * It never enforces any DB behaviour and never feeds DDL.
 *
 * Invariants (CLAUDE.md §17.3 / §17.16):
 *
 *   - `ai_*` namespace ONLY. The ONLY FKs are `from_table_id` /
 *     `to_table_id` → `ai_knowledge_catalog_tables.id` (`ai_* → ai_*`,
 *     CASCADE — allowed per §17.3). NO FK into any project / plan /
 *     tracking table.
 *   - Service-layer (BE-03) enforces `from_table_id != to_table_id` and
 *     that both ends reference non-soft-deleted catalog tables; these
 *     are not DDL constraints.
 *   - Dual relation + plain-column mapping per the
 *     `ai_knowledge_entry_revisions` precedent.
 */
@Entity('ai_knowledge_catalog_relations')
@Index('ix_ai_knowledge_catalog_relations_from', ['fromTableId'])
@Index('ix_ai_knowledge_catalog_relations_to', ['toTableId'])
export class AiKnowledgeCatalogRelation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Source catalog table (`ai_* → ai_*` FK — allowed; CASCADE). */
  @ManyToOne(() => AiKnowledgeCatalogTable, {
    onDelete: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'from_table_id' })
  fromTable: AiKnowledgeCatalogTable;

  @Column({ name: 'from_table_id', type: 'uuid' })
  fromTableId: string;

  /** Target catalog table (`ai_* → ai_*` FK — allowed; CASCADE). */
  @ManyToOne(() => AiKnowledgeCatalogTable, {
    onDelete: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'to_table_id' })
  toTable: AiKnowledgeCatalogTable;

  @Column({ name: 'to_table_id', type: 'uuid' })
  toTableId: string;

  @Column({
    name: 'relation_type',
    type: 'enum',
    enum: AI_KNOWLEDGE_RELATION_TYPES,
    enumName: 'ai_knowledge_relation_type',
  })
  relationType: AiKnowledgeRelationType;

  @Column({ name: 'label_th', type: 'varchar', length: 300, nullable: true })
  labelTh: string | null;

  /**
   * Free-text on-delete note (e.g. "CASCADE", "SET NULL") —
   * DOCUMENTATION ONLY, never enforced at the DB (report §6.3).
   */
  @Column({
    name: 'on_delete_note',
    type: 'varchar',
    length: 64,
    nullable: true,
  })
  onDeleteNote: string | null;

  @Column({ name: 'display_order', type: 'int', default: 0 })
  displayOrder: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @DeleteDateColumn({
    name: 'deleted_at',
    type: 'timestamptz',
    nullable: true,
  })
  deletedAt: Date | null;
}
