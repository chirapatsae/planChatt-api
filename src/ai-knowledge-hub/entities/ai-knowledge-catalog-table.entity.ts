import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Wave wave-ai-knowledge-structure-mgmt — DB-01 (2026-06-13).
 *
 * `ai_knowledge_catalog_tables` — the Class-A data-DICTIONARY catalog
 * (architecture report §3.3; CLAUDE.md §17.16 via DOCS-01). Each row is
 * an admin-curated DOCUMENTATION entry describing a table, NOT the real
 * Postgres schema.
 *
 * NO-DDL GUARANTEE (CTO decision #2 / report §6.3 — ABSOLUTE):
 *
 *   - `table_name` is plain `varchar` TEXT. It is never an SQL
 *     identifier, never reaches a query builder as an identifier, and
 *     never participates in any `CREATE` / `ALTER` / `DROP` / raw DDL.
 *     "เลือกตาราง" = pick / type an entry in this documentation catalog.
 *   - The "นำเข้าจากระบบ (seed)" admin action (BE-03) reads TypeORM
 *     metadata READ-ONLY and inserts rows HERE — it never round-trips to
 *     the real schema.
 *
 * Invariants (CLAUDE.md §17.3 / §17.16):
 *
 *   - `ai_*` namespace ONLY. NO foreign key into any project / plan /
 *     tracking table. `domain_key` is plain text (NOT a DB FK — it
 *     points at a `derived-domain-map.ts` key per §17.14.3).
 *   - Actors are referenced by WorkHistory UUID WITHOUT referential
 *     integrity (plain uuid columns), matching the `ai_knowledge_entries`
 *     precedent.
 *   - Children (`ai_knowledge_catalog_columns`,
 *     `ai_knowledge_catalog_relations`) reference THIS table via an
 *     `ai_* → ai_*` FK — allowed (§17.3 forbids FKs into PROJECT tables
 *     only).
 *   - UNIQUE `(table_name)` WHERE `deleted_at IS NULL` is a PARTIAL
 *     unique index that `synchronize` cannot express — it is created
 *     manually (see DB-01.md appendix) and declared below with
 *     `{ synchronize: false }` so schema sync neither creates NOR drops
 *     it (the trgm-index survival-guard pattern from the prior wave).
 */
@Entity('ai_knowledge_catalog_tables')
@Index('ix_ai_knowledge_catalog_tables_domain_order', [
  'domainKey',
  'displayOrder',
])
// Partial UNIQUE `(table_name) WHERE deleted_at IS NULL` — created
// manually (DB-01.md appendix), excluded from synchronize so it survives
// reboots (same pattern as the AiKnowledgeEntry trgm indexes).
@Index('uq_ai_knowledge_catalog_tables_name_live', { synchronize: false })
export class AiKnowledgeCatalogTable {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Plain-text table name — DOCUMENTATION ONLY. Never an SQL identifier;
   * never reaches a query builder as an identifier; never feeds DDL
   * (report §6.3 no-DDL guarantee).
   */
  @Column({ name: 'table_name', type: 'varchar', length: 128 })
  tableName: string;

  @Column({ name: 'display_name_th', type: 'varchar', length: 200 })
  displayNameTh: string;

  @Column({ name: 'description_th', type: 'text', nullable: true })
  descriptionTh: string | null;

  /**
   * Domain this catalog table belongs to (`derived-domain-map.ts` key).
   * Plain text — NOT a DB FK (§17.14.3).
   */
  @Column({ name: 'domain_key', type: 'varchar', length: 128, nullable: true })
  domainKey: string | null;

  /** True = imported by the BE-03 seed; false = admin hand-typed. */
  @Column({ name: 'is_seeded', type: 'boolean', default: false })
  isSeeded: boolean;

  @Column({ name: 'display_order', type: 'int', default: 0 })
  displayOrder: number;

  /** WorkHistory UUID of the creator. NO FK (§17.3 / §4 actor-by-UUID). */
  @Column({ name: 'created_by_work_history_id', type: 'uuid' })
  createdByWorkHistoryId: string;

  /** WorkHistory UUID of the last editor. NO FK (§17.3). */
  @Column({ name: 'updated_by_work_history_id', type: 'uuid' })
  updatedByWorkHistoryId: string;

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
