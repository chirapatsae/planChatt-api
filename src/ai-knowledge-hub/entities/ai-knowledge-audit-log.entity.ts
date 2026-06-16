import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Wave wave-ai-knowledge-hub — DB-01 (2026-06-12).
 * Wave wave-ai-knowledge-structure-mgmt — DB-01 (2026-06-13; +13 values).
 *
 * All actions a knowledge-hub mutation can record. The `source_*` values
 * are PRE-DECLARED in DB-01 even though the source console only lands in
 * DB-02/BE-03 — under TypeORM `synchronize:true`, widening a Postgres enum
 * later triggers the `ai_target_kind`-style enum-rename churn (drop /
 * recreate / cast). Declaring the full value set NOW keeps the second and
 * every subsequent boot at zero schema mutations (task §8 risk note).
 *
 * The 13 `domain_meta_update` / `gap_*` / `catalog_*` / `relation_*` /
 * `tool_binding_update` values are the structure / catalog management
 * actions (BE-02 = domains/gaps Phase 1; BE-03 = catalog Phase 2; BE-04
 * = tool binding Phase 3). All are PRE-DECLARED here at the wave's DB-01
 * so the later phase services land with ZERO enum churn (report §3.7).
 */
export const AI_KNOWLEDGE_AUDIT_ACTIONS = [
  // Phase 1 — curated entry lifecycle (BE-02)
  'create',
  'update',
  'publish',
  'archive',
  'delete',
  // Phase 2 — ingestion review verdicts (BE-03)
  'promote',
  'reject',
  // Phase 2 — connector/source console (BE-03; pre-declared, unused in P1)
  'source_create',
  'source_approve',
  'source_suspend',
  'source_revoke',
  'source_rotate_key',
  // Wave wave-ai-knowledge-structure-mgmt — domain/gap display overlay
  // (BE-02, Phase 1). PRE-DECLARED at this wave's DB-01.
  'domain_meta_update',
  'gap_create',
  'gap_update',
  'gap_delete',
  // Catalog tables / columns / relations CRUD (BE-03, Phase 2).
  'catalog_table_create',
  'catalog_table_update',
  'catalog_table_delete',
  'catalog_column_upsert',
  'catalog_column_delete',
  'relation_create',
  'relation_update',
  'relation_delete',
  // Tool↔domain binding override (BE-04, Phase 3, super-admin only).
  'tool_binding_update',
] as const;

export type AiKnowledgeAuditAction =
  (typeof AI_KNOWLEDGE_AUDIT_ACTIONS)[number];

/**
 * `ai_knowledge_audit_logs` — THE audit channel for every knowledge-hub
 * mutation (wave decision #5). NEVER TrackingStatus (§17.3, §12 — audit
 * ownership of workflow transitions stays with TrackingStatus; ai_*
 * mutations log here and ONLY here).
 *
 * Invariants:
 *
 *   - `actor_work_history_id` is a plain uuid — NO FK (§17.3
 *     actor-by-UUID). `actor_role` is denormalized at write time so the
 *     audit row stays truthful even if the actor's role later changes.
 *   - `target_id` is a plain uuid + `target_kind` varchar discriminator
 *     (`entry | source | ingestion`) — NO referential integrity, so a hard
 *     delete of the target never erases its audit trail.
 *   - Rows are append-only: no update/delete lifecycle columns. §17.11 —
 *     no role (including super-admin) mutates audit rows after the fact.
 *   - Read endpoints over this table are §18.13-style zero-write
 *     aggregators.
 */
@Entity('ai_knowledge_audit_logs')
@Index('ix_ai_knowledge_audit_logs_target', [
  'targetKind',
  'targetId',
  'createdAt',
])
export class AiKnowledgeAuditLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** WorkHistory UUID of the acting admin. NO FK (§17.3). */
  @Column({ name: 'actor_work_history_id', type: 'uuid' })
  actorWorkHistoryId: string;

  /** Role name at action time (denormalized — survives role changes). */
  @Column({ name: 'actor_role', type: 'varchar', length: 64 })
  actorRole: string;

  @Column({
    name: 'action',
    type: 'enum',
    enum: AI_KNOWLEDGE_AUDIT_ACTIONS,
    enumName: 'ai_knowledge_audit_action',
  })
  action: AiKnowledgeAuditAction;

  /**
   * Logical discriminator. Phase-1/2 hub values: `entry | source |
   * ingestion`. Structure-mgmt values (this wave): `domain_meta | gap |
   * catalog_table | catalog_column | relation | tool_binding`. Plain
   * varchar — no enum churn for new logical kinds.
   */
  @Column({ name: 'target_kind', type: 'varchar', length: 32 })
  targetKind: string;

  /** UUID of the target row. Plain uuid — NO FK by design. */
  @Column({ name: 'target_id', type: 'uuid' })
  targetId: string;

  /** Optional structured context (diff summary, reason, source key, …). */
  @Column({ name: 'detail', type: 'jsonb', nullable: true })
  detail: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
