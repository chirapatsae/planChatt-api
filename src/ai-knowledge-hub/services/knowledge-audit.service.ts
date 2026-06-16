import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import {
  AiKnowledgeAuditAction,
  AiKnowledgeAuditLog,
} from '../entities/ai-knowledge-audit-log.entity';

/**
 * Logical audit-target discriminator (DB-01 `target_kind` contract).
 *
 * Phase-1/2 hub kinds: `entry | source | ingestion`. The
 * structure-management kinds (`domain_meta | gap | catalog_table |
 * catalog_column | relation | tool_binding`) are PRE-DECLARED here by
 * wave-ai-knowledge-structure-mgmt DB-01 so BE-02 / BE-03 / BE-04 reuse
 * this single audit writer with no further edit (report §3.7). The
 * column is a plain varchar (no DB enum), so adding union members is a
 * type-only change with zero schema impact.
 */
export type KnowledgeAuditTargetKind =
  | 'entry'
  | 'source'
  | 'ingestion'
  | 'domain_meta'
  | 'gap'
  | 'catalog_table'
  | 'catalog_column'
  | 'relation'
  | 'tool_binding';

export interface KnowledgeAuditRecordParams {
  /** WorkHistory UUID of the acting admin — plain uuid, NO FK (§17.3). */
  actorWorkHistoryId: string;
  /** Role name at action time (denormalized — survives role changes). */
  actorRole: string;
  action: AiKnowledgeAuditAction;
  targetKind: KnowledgeAuditTargetKind;
  targetId: string;
  /** Optional structured context (diff summary, from/to status, …). */
  detail?: Record<string, unknown> | null;
}

/**
 * Wave wave-ai-knowledge-hub — BE-02 (2026-06-12).
 *
 * KnowledgeAuditService — the SINGLE writer of `ai_knowledge_audit_logs`
 * rows for the knowledge hub (wave decision #5).
 *
 * CLAUDE.md references:
 *   - §17.3 — knowledge-hub mutations audit HERE and ONLY here; NEVER
 *     TrackingStatus (§12 audit ownership of workflow transitions is
 *     untouched — this module never imports a tracking-status symbol).
 *   - §17.11 — rows are append-only; there is no update / delete method
 *     on this service, and no role (including super-admin) gets one.
 *
 * Transaction contract: every BE-02 mutation passes its transactional
 * `EntityManager` so the audit row commits or rolls back ATOMICALLY with
 * the mutation it describes — a failed mutation never leaves a stray
 * audit row, and a successful mutation never lacks one (task §6 output
 * contract: exactly one audit row per mutation).
 *
 * BE-03 reuses this service for `promote` / `reject` / `source_*`
 * actions (the action enum is pre-declared in DB-01).
 */
@Injectable()
export class KnowledgeAuditService {
  constructor(
    @InjectRepository(AiKnowledgeAuditLog)
    private readonly auditRepository: Repository<AiKnowledgeAuditLog>,
  ) {}

  /**
   * Append exactly one audit row. When `manager` is provided the insert
   * joins the caller's transaction; otherwise it writes standalone.
   */
  async record(
    params: KnowledgeAuditRecordParams,
    manager?: EntityManager,
  ): Promise<void> {
    const repository = manager
      ? manager.getRepository(AiKnowledgeAuditLog)
      : this.auditRepository;

    await repository.insert({
      actorWorkHistoryId: params.actorWorkHistoryId,
      actorRole: params.actorRole,
      action: params.action,
      targetKind: params.targetKind,
      targetId: params.targetId,
      // TypeORM's QueryDeepPartialEntity narrows `Record<string, unknown>`
      // to a recursively-deep-partial shape that does not unify with a
      // free-form jsonb payload. Cast at the boundary — the value lands
      // in a jsonb column and is round-tripped as-is (same convention as
      // `stats-access-log.service.ts`).
      detail: (params.detail ?? null) as Record<string, any> | null,
    });
  }
}
