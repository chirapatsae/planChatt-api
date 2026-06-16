import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Node kind discriminator for the structure overlay. A `domain` row
 * overlays display fields onto a code descriptor in
 * `derived-domain-map.ts` (`KNOWLEDGE_DOMAINS` / `CURATED_DOMAINS`); a
 * `gap` row is a coverage-gap node (`COVERAGE_GAPS` seed + admin-added).
 *
 * PRE-DECLARED as a fixed two-value set so a later widening never
 * triggers the `ai_target_kind`-style drop/recreate/cast churn under
 * `synchronize:true` (same discipline as `ai_knowledge_audit_action`).
 */
export const AI_KNOWLEDGE_NODE_KINDS = ['domain', 'gap'] as const;

export type AiKnowledgeNodeKind = (typeof AI_KNOWLEDGE_NODE_KINDS)[number];

/**
 * Wave wave-ai-knowledge-structure-mgmt — DB-01 (2026-06-13).
 *
 * `ai_knowledge_domain_meta` — the Class-A display OVERLAY for the
 * executive mind-map (architecture report §3.2; CLAUDE.md §17.16 via
 * DOCS-01). One row overlays display-only fields (label overrides,
 * description, order, colour, icon, hidden flag) onto a code descriptor
 * that STILL lives in `derived-domain-map.ts`.
 *
 * Overlay-not-replacement (CTO decision #3 / report §6.6):
 *
 *   - `derived-domain-map.ts` remains the source of truth for WHICH
 *     domains exist and (until Phase 3) their tool bindings. This row
 *     never declares a new domain — it only re-skins an existing one.
 *   - A MISSING row falls back to the code descriptor. After the
 *     idempotent DB-01 seed imports the current registry, `GET /map`
 *     renders byte-identically to pre-wave (report §4.2 / §6.4).
 *   - `node_kind = 'domain'` rows have a `domain_key` that MUST be in
 *     `ALL_KNOWLEDGE_DOMAIN_KEYS` (BE-02 service-validated, NOT a DB FK —
 *     domains are code-declared data per §17.14.3). Adding a NEW derived
 *     domain via UI is forbidden (Q-05). `node_kind = 'gap'` rows may be
 *     freely added / edited / soft-deleted.
 *
 * Invariants (CLAUDE.md §17.3 / §17.16):
 *
 *   - `ai_*` namespace ONLY. NO foreign key into any project / plan /
 *     tracking table — this is advisory display metadata (§17.2) and
 *     must never cascade with project mutations.
 *   - `domain_key` is plain text (UNIQUE), NOT a DB FK — it points at a
 *     code descriptor key, not a row.
 *   - Actors are referenced by WorkHistory UUID WITHOUT referential
 *     integrity (`created_by_work_history_id` / `updated_by_work_history_id`
 *     are plain uuid columns), matching the `ai_knowledge_entries`
 *     precedent.
 *   - Soft delete (`deleted_at`) — used by gap removal; the partial
 *     UNIQUE on `domain_key` is full (not deleted-aware) because a
 *     re-seed must not silently shadow a soft-deleted key. The seed and
 *     BE-02 resolve by `domain_key` regardless of `deleted_at`.
 *   - Mutations audit via `ai_knowledge_audit_logs`
 *     (`domain_meta_update` / `gap_*`), NEVER TrackingStatus (§17.3).
 */
@Entity('ai_knowledge_domain_meta')
@Unique('uq_ai_knowledge_domain_meta_domain_key', ['domainKey'])
@Index('ix_ai_knowledge_domain_meta_kind_order', ['nodeKind', 'displayOrder'])
export class AiKnowledgeDomainMeta {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Code descriptor / gap key (`KNOWLEDGE_DOMAINS[].key`,
   * `CURATED_DOMAINS[].key`, or `COVERAGE_GAPS[].key`). Plain text,
   * UNIQUE — NOT a DB FK (§17.14.3, code-declared data).
   */
  @Column({ name: 'domain_key', type: 'varchar', length: 128 })
  domainKey: string;

  @Column({
    name: 'node_kind',
    type: 'enum',
    enum: AI_KNOWLEDGE_NODE_KINDS,
    enumName: 'ai_knowledge_node_kind',
  })
  nodeKind: AiKnowledgeNodeKind;

  /** Overrides the code `labelTh` when set; NULL = use code. */
  @Column({
    name: 'label_th_override',
    type: 'varchar',
    length: 200,
    nullable: true,
  })
  labelThOverride: string | null;

  /** Overrides the code `labelEn` when set; NULL = use code. */
  @Column({
    name: 'label_en_override',
    type: 'varchar',
    length: 200,
    nullable: true,
  })
  labelEnOverride: string | null;

  /** Domain description (new — no code equivalent). */
  @Column({ name: 'description_th', type: 'text', nullable: true })
  descriptionTh: string | null;

  /** Position on the mind-map ring. */
  @Column({ name: 'display_order', type: 'int', default: 0 })
  displayOrder: number;

  /** Colour token from the design-system allow-list (BE-02 validated). */
  @Column({ name: 'color_token', type: 'varchar', length: 32, nullable: true })
  colorToken: string | null;

  /** Icon key from the lucide allow-list (BE-02 validated). */
  @Column({ name: 'icon_key', type: 'varchar', length: 48, nullable: true })
  iconKey: string | null;

  /** Hide the node from the mind-map (display-only — gates nothing). */
  @Column({ name: 'is_hidden', type: 'boolean', default: false })
  isHidden: boolean;

  /** Coverage-gap reason (only meaningful for `node_kind = 'gap'`). */
  @Column({
    name: 'gap_reason_th',
    type: 'varchar',
    length: 300,
    nullable: true,
  })
  gapReasonTh: string | null;

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
