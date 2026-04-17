import {
  Column,
  Entity,
  Index,
} from 'typeorm';
import { AbstractAiResult } from './abstract-ai-result.entity';

/**
 * ai_pre_submit_snapshots — RF5 persistence table (CLAUDE.md §17).
 *
 * Extends the N1 `AbstractAiResult` base so the envelope shape and column
 * discipline are shared with every other AI result table. Adds RF5-specific
 * columns (`workflow`, `submittedByWorkHistoryId`, `summaryText`, JSON
 * carriers) that do not belong in the base.
 *
 * Invariants enforced by the schema / migration, not just TypeORM:
 *
 *   - §17.3 NO FK to project tables. `targetKind` + `targetId` is a logical
 *     discriminator; the `target_id` column is a plain uuid. Staff-led
 *     rollback (§14.6) physically removes a RevisedProjectGroup row; we
 *     deliberately do NOT want that delete to cascade into this audit
 *     history.
 *
 *   - §17.4 `snapshot-only` staleness policy is the canonical policy for
 *     this table. The `stalenessPolicy` column exists for forward
 *     compatibility but the read endpoint ALWAYS returns `isStale: false`.
 *
 *   - Partial unique index `(target_kind, target_id) WHERE deleted_at IS
 *     NULL` enforces exactly-one-active-snapshot-per-target at the DB level.
 *
 *   - §12 / §17.5 Audit preservation — rows are never hard-deleted. Resubmit
 *     soft-deletes the prior active row (sets deleted_at = now()) and
 *     inserts a new row.
 */
@Entity('ai_pre_submit_snapshots')
@Index('ix_ai_pre_submit_snapshots_target_computed_at', [
  'targetId',
  'computedAt',
])
export class AiPreSubmitSnapshot extends AbstractAiResult {
  @Column({
    name: 'workflow',
    type: 'enum',
    enum: ['add', 'revision', 'change'],
    enumName: 'ai_pre_submit_workflow',
  })
  workflow: 'add' | 'revision' | 'change';

  /**
   * WorkHistory.id of the user who submitted at the time of snapshot.
   * §4 ownership source of truth — NO FK so audit rows survive any
   * hypothetical WorkHistory row mutation.
   */
  @Column({ name: 'submitted_by_work_history_id', type: 'uuid' })
  submittedByWorkHistoryId: string;

  @Column({ name: 'summary_text', type: 'text', nullable: true })
  summaryText: string | null;

  @Column({ name: 'suggestions_json', type: 'jsonb', default: () => `'[]'::jsonb` })
  suggestions: unknown[];

  @Column({ name: 'categories_json', type: 'jsonb', default: () => `'{}'::jsonb` })
  categories: Record<string, unknown>;

  // `deletedAt` is inherited from AbstractAiResult (§17 base class) — TypeORM
  // resolves the @DeleteDateColumn from the parent via entity inheritance.
  // Do NOT redeclare it here — TS 2612 rejects the shadow.
}
