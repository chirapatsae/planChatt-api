import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Wave wave-ai-knowledge-structure-mgmt — DB-01 (2026-06-13).
 *
 * `ai_knowledge_tool_binding` — the Phase-3 Class-B tool↔domain override
 * (architecture report §3.6; CLAUDE.md §17.16 via DOCS-01).
 *
 * The entity / table land NOW (DB-01) so the schema and the
 * `UNIQUE(tool_name)` index exist once and never churn under
 * `synchronize:true`. The table stays EMPTY until BE-04 / Phase 3 writes
 * to it — DB-01 only declares it.
 *
 * Bijection strategy B2-with-B1-default (CTO decision #5 / report §6.2):
 *
 *   - EMPTY table → the resolver falls back to
 *     `KNOWLEDGE_DOMAINS[].toolNames` in `derived-domain-map.ts` (B1,
 *     code is source of truth). Phase 1–2 keep tool binding
 *     code-governed; no row is ever written.
 *   - Phase 3 (Q-04 = super-admin only) writes override rows that must
 *     pass the RUNTIME bijection guard at save time: (1) every
 *     `tool_name` exists in `EXECUTIVE_TOOL_NAMES`, (2) no orphan tool,
 *     (3) no tool double-mapped. The `UNIQUE(tool_name)` index is
 *     defense-in-depth for the no-double-map invariant at the DB level
 *     (§17.16.5). Super-admin cannot persist a violating binding
 *     (§17.11 — integrity ≠ permission).
 *
 * Invariants (CLAUDE.md §17.3 / §17.16):
 *
 *   - `ai_*` namespace ONLY. NO FK into any table — `domain_key` /
 *     `tool_name` are plain text (code-declared data per §17.14.3); the
 *     actor is referenced by WorkHistory UUID WITHOUT referential
 *     integrity.
 *   - NO soft-delete column. Un-binding a tool DELETES the row — the
 *     bijection must be exact (a tombstoned row would corrupt the
 *     orphan / double-map check).
 *   - Mutations audit via `ai_knowledge_audit_logs`
 *     (`tool_binding_update`), NEVER TrackingStatus (§17.3).
 */
@Entity('ai_knowledge_tool_binding')
@Unique('uq_ai_knowledge_tool_binding_tool_name', ['toolName'])
export class AiKnowledgeToolBinding {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Derived domain this tool is bound to. Plain text — NO FK (§17.14.3). */
  @Column({ name: 'domain_key', type: 'varchar', length: 128 })
  domainKey: string;

  /**
   * Executive tool name. UNIQUE — DB-level no-double-map guard backing
   * the runtime bijection (§17.16.5). Plain text validated against
   * `EXECUTIVE_TOOL_NAMES` at BE-04 save time — NOT a DB FK.
   */
  @Column({ name: 'tool_name', type: 'varchar', length: 128 })
  toolName: string;

  /** WorkHistory UUID of the binding author. NO FK (§17.3). */
  @Column({ name: 'created_by_work_history_id', type: 'uuid' })
  createdByWorkHistoryId: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
