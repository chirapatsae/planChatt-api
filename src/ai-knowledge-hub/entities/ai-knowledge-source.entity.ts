import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

import {
  AI_KNOWLEDGE_CLASSIFICATIONS,
  AiKnowledgeClassification,
} from '../types/ai-knowledge-classification.enum';

/**
 * Wave wave-ai-knowledge-hub — DB-02 (2026-06-12).
 *
 * Connector mode. Q3 LOCKED (2026-06-12) = WEBHOOK PUSH ONLY for v1.
 * `pull` is PRE-DECLARED but unused — widening a Postgres enum later under
 * `synchronize:true` triggers the `ai_target_kind`-style drop/recreate/cast
 * churn, so the full value set is declared once now (same discipline as
 * the `source_*` values pre-declared in `ai_knowledge_audit_action`).
 */
export const AI_KNOWLEDGE_SOURCE_MODES = ['webhook', 'pull'] as const;

export type AiKnowledgeSourceMode = (typeof AI_KNOWLEDGE_SOURCE_MODES)[number];

/**
 * Source lifecycle (report §4): registration lands at `pending_approval`;
 * a SECOND admin approves (4-eyes) → `active`; `suspended` is reversible,
 * `revoked` is terminal. Transitions are service-enforced in BE-03.
 */
export const AI_KNOWLEDGE_SOURCE_STATUSES = [
  'pending_approval',
  'active',
  'suspended',
  'revoked',
] as const;

export type AiKnowledgeSourceStatus =
  (typeof AI_KNOWLEDGE_SOURCE_STATUSES)[number];

/**
 * `ai_knowledge_sources` — Phase-2 connector registry: one row per
 * registered external system allowed to push knowledge payloads into the
 * quarantine staging table (Segment sources → hub model, report §2.3/§4).
 *
 * Invariants (CLAUDE.md §17.3 / §17.9 / §17.15 via DOCS-01; report §6):
 *
 *   - `ai_*` namespace ONLY. NO foreign key into `project_groups`,
 *     `government_agencies`, or any other app table — sources are EXTERNAL
 *     systems; `owning_agency_note` is deliberately free text, not an FK.
 *   - SECRETS ARE NEVER STORED IN PLAINTEXT. The only credential columns
 *     are `api_key_hash` (argon2/bcrypt digest), `api_key_prefix` (lookup
 *     prefix shown in the admin console, e.g. `pbk_live_xxxx`), and
 *     `hmac_secret_hash`. The raw key is generated server-side, shown
 *     ONCE at creation/rotation, and is unrecoverable thereafter
 *     (STRIDE-S mitigation, report §6.1).
 *   - 4-eyes approval: `approved_by_work_history_id` MUST differ from
 *     `created_by_work_history_id` — service-enforced in BE-03 (cannot be
 *     expressed in DDL). Both are plain uuid columns, NO FK (§17.3
 *     actor-by-UUID precedent, `ai_pre_submit_snapshots`).
 *   - Q4 LOCKED: PII is CATEGORICALLY FORBIDDEN in external payloads and
 *     the classification ceiling maxes out at `internal`. The ceiling
 *     column REUSES the existing `ai_knowledge_classification` Postgres
 *     enum (identical value set + enumName — zero enum churn under
 *     synchronize:true).
 *   - PDPA (docs/pdpa/02 + 07): `purpose_declaration` + `lawful_basis`
 *     are required at registration; DPO sign-off precedes `active`.
 *   - §17.9: nothing in this row is prompt-eligible. Source metadata is
 *     admin-console data; delimiter-wrapping concerns only published
 *     entry content at CONSUMPTION time (BE-04).
 */
@Entity('ai_knowledge_sources')
@Unique('uq_ai_knowledge_sources_source_key', ['sourceKey'])
export class AiKnowledgeSource {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'name', type: 'varchar', length: 200 })
  name: string;

  @Column({ name: 'description', type: 'text' })
  description: string;

  /** URL slug for the ingest endpoint (`POST …/ingest/:sourceKey`). */
  @Column({ name: 'source_key', type: 'varchar', length: 64 })
  sourceKey: string;

  /**
   * Free-text note identifying the owning agency / external system.
   * Deliberately NOT an FK to `government_agencies` — sources are external
   * systems outside the app's org model (§17.3 spirit).
   */
  @Column({ name: 'owning_agency_note', type: 'varchar', length: 300 })
  owningAgencyNote: string;

  /** Q3 LOCKED: v1 is webhook push only; `pull` pre-declared, unused. */
  @Column({
    name: 'mode',
    type: 'enum',
    enum: AI_KNOWLEDGE_SOURCE_MODES,
    enumName: 'ai_knowledge_source_mode',
    default: 'webhook',
  })
  mode: AiKnowledgeSourceMode;

  @Column({
    name: 'status',
    type: 'enum',
    enum: AI_KNOWLEDGE_SOURCE_STATUSES,
    enumName: 'ai_knowledge_source_status',
    default: 'pending_approval',
  })
  status: AiKnowledgeSourceStatus;

  /** Argon2/bcrypt digest of the server-generated API key. NEVER raw. */
  @Column({ name: 'api_key_hash', type: 'varchar', length: 255 })
  apiKeyHash: string;

  /** Non-secret lookup prefix (e.g. `pbk_live_xxxx`) for console display. */
  @Column({ name: 'api_key_prefix', type: 'varchar', length: 12 })
  apiKeyPrefix: string;

  /**
   * Optional HMAC payload-signature secret (opt-in, NULL = API-key-only).
   *
   * Stored AES-ENCRYPTED-AT-REST (reversible ciphertext via
   * `src/util/encryption.util.ts`, keyed by env `SECRET_KEY`/`SALT` —
   * NOT a one-way hash). Symmetric HMAC-SHA256 verification requires the
   * server to recompute `HMAC(secret, rawBody)` at receipt, so the raw
   * secret MUST be recoverable — a one-way digest is cryptographically
   * incompatible with body-signature verification. Encryption-at-rest
   * keeps a bare DB dump useless (forging also needs `SECRET_KEY`),
   * mirroring the W89 email/phone hardening posture (docs/pdpa/03 §P.3).
   *
   * The plaintext secret is server-generated, shown ONCE at
   * rotate-hmac-secret, never logged, and never re-derivable from this
   * column without `SECRET_KEY` (§17.15.5 hashed-credentials spirit;
   * §17.15.7 — no role may read it back, only rotate/disable). The column
   * name retains the `_hash` suffix for back-compat; its semantics are
   * "encrypted secret", documented here and in docs/pdpa/03 §P.3.
   */
  @Column({
    name: 'hmac_secret_hash',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  hmacSecretHash: string | null;

  /** Declared JSON schema every inbound item is validated against (BE-03). */
  @Column({ name: 'payload_schema', type: 'jsonb' })
  payloadSchema: Record<string, unknown>;

  /**
   * Domain key promoted entries land under. Service-validated against
   * BE-01's domain list — NOT a DB FK (§17.14.3, code-declared data).
   * Length matches `ai_knowledge_entries.domain_key`.
   */
  @Column({ name: 'target_domain_key', type: 'varchar', length: 128 })
  targetDomainKey: string;

  /**
   * Maximum classification external items from this source may carry.
   * Reuses the `ai_knowledge_classification` enum; Q4 LOCKED — the value
   * set itself tops out at `internal`, so the ceiling can never exceed it.
   */
  @Column({
    name: 'classification_ceiling',
    type: 'enum',
    enum: AI_KNOWLEDGE_CLASSIFICATIONS,
    enumName: 'ai_knowledge_classification',
    default: 'internal',
  })
  classificationCeiling: AiKnowledgeClassification;

  /** Per-source ingest rate limit (BE-03 enforces; 429 + retryAfter). */
  @Column({ name: 'rate_limit_per_min', type: 'int', default: 60 })
  rateLimitPerMin: number;

  /** Payload size cap in bytes (256 KB default; BE-03 enforces). */
  @Column({ name: 'max_payload_bytes', type: 'int', default: 262144 })
  maxPayloadBytes: number;

  /** PDPA records-of-processing: declared purpose (docs/pdpa/02). */
  @Column({ name: 'purpose_declaration', type: 'text' })
  purposeDeclaration: string;

  /** PDPA lawful basis for processing (docs/pdpa/02). */
  @Column({ name: 'lawful_basis', type: 'varchar', length: 128 })
  lawfulBasis: string;

  /** WorkHistory UUID of the registering admin. NO FK (§17.3). */
  @Column({ name: 'created_by_work_history_id', type: 'uuid' })
  createdByWorkHistoryId: string;

  /**
   * WorkHistory UUID of the SECOND admin who approved the source. NO FK
   * (§17.3). MUST differ from `created_by_work_history_id` — 4-eyes rule,
   * service-enforced in BE-03. NULL while `pending_approval`.
   */
  @Column({
    name: 'approved_by_work_history_id',
    type: 'uuid',
    nullable: true,
  })
  approvedByWorkHistoryId: string | null;

  @Column({ name: 'approved_at', type: 'timestamptz', nullable: true })
  approvedAt: Date | null;

  /** Last successful authenticated ingest — source health tracking. */
  @Column({ name: 'last_seen_at', type: 'timestamptz', nullable: true })
  lastSeenAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt: Date | null;
}
