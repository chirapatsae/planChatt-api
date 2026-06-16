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
 * Wave wave-ai-knowledge-structure-mgmt — DB-01 (2026-06-13).
 *
 * `ai_knowledge_catalog_columns` — Class-A documentation columns under a
 * catalog table (architecture report §3.4; CLAUDE.md §17.16 via DOCS-01).
 *
 * NO-DDL GUARANTEE (report §6.3 — ABSOLUTE): `column_name` / `data_type`
 * are plain `varchar` TEXT. They are documentation strings, never SQL
 * identifiers, and never feed any DDL.
 *
 * Invariants (CLAUDE.md §17.3 / §17.16):
 *
 *   - `ai_*` namespace ONLY. The ONLY FK is `table_id` →
 *     `ai_knowledge_catalog_tables.id` (`ai_* → ai_*`, CASCADE — allowed
 *     per §17.3). NO FK into any project / plan / tracking table.
 *   - The dual relation + plain-column mapping follows the
 *     `ai_knowledge_entry_revisions` precedent so callers read/write
 *     `tableId` without loading the relation.
 *   - `is_pii` is an ADVISORY PDPA documentation flag (§17.2) — it gates
 *     nothing.
 *   - UNIQUE `(table_id, column_name)` WHERE `deleted_at IS NULL` is a
 *     PARTIAL unique index `synchronize` cannot express — created
 *     manually (DB-01.md appendix), declared below with
 *     `{ synchronize: false }` so schema sync neither creates NOR drops
 *     it.
 */
@Entity('ai_knowledge_catalog_columns')
@Index('ix_ai_knowledge_catalog_columns_table_order', [
  'tableId',
  'displayOrder',
])
// Partial UNIQUE `(table_id, column_name) WHERE deleted_at IS NULL` —
// created manually (DB-01.md appendix), excluded from synchronize.
@Index('uq_ai_knowledge_catalog_columns_table_col_live', {
  synchronize: false,
})
export class AiKnowledgeCatalogColumn {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Parent catalog table (`ai_* → ai_*` FK — allowed). CASCADE on hard
   * delete; soft delete of the parent leaves columns intact.
   */
  @ManyToOne(() => AiKnowledgeCatalogTable, {
    onDelete: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'table_id' })
  table: AiKnowledgeCatalogTable;

  @Column({ name: 'table_id', type: 'uuid' })
  tableId: string;

  /** Plain-text column name — DOCUMENTATION ONLY (report §6.3 no-DDL). */
  @Column({ name: 'column_name', type: 'varchar', length: 128 })
  columnName: string;

  /** Free-text data type (e.g. `uuid`, `varchar(300)`) — documentation. */
  @Column({ name: 'data_type', type: 'varchar', length: 64, nullable: true })
  dataType: string | null;

  /** Documentation nullable flag — gates nothing. */
  @Column({ name: 'is_nullable', type: 'boolean', default: true })
  isNullable: boolean;

  @Column({ name: 'description_th', type: 'text', nullable: true })
  descriptionTh: string | null;

  /** Advisory PDPA PII flag (§17.2) — documentation only. */
  @Column({ name: 'is_pii', type: 'boolean', default: false })
  isPii: boolean;

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
