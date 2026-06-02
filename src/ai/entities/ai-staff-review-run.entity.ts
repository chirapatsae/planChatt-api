import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import {
  AiResultTargetKind,
  AiScoreBand,
  AiStalenessPolicy,
} from '../utils/ai-score-envelope';

/**
 * ai_staff_review_runs — Wave 40 N4 reviewer-run cache schema scaffold.
 *
 * Persistence target for the staff-side `smart-approve/analyze`
 * endpoint (currently ephemeral). Wave 40 scope is SCHEMA + ENTITY
 * ONLY — no service writes, no controller writes. Wave 41 will wire
 * the write path.
 *
 * CLAUDE.md references:
 *
 *   - §17.3 Audit separation. `target_id` is a plain UUID column with
 *     NO foreign key to `project_groups`, `revised_project_groups`,
 *     or `supplement_project_groups` — staff-led rollback (§14.6)
 *     physically removes rows, and we deliberately do NOT want that
 *     delete to cascade into this reviewer audit history.
 *     `reviewer_work_history_id` is likewise a plain UUID with no FK
 *     to `work_histories`, mirroring the precedent set by
 *     `AiPreSubmitSnapshot.submittedByWorkHistoryId` and
 *     `AiUsageLog.actorWorkHistoryId`.
 *
 *   - §17.4 `strict` staleness policy — reviewer runs are live
 *     (NOT snapshot-only). The DB default is `'strict'`; Wave 41 read
 *     paths will surface a stale warning banner when the current
 *     content hash drifts from the stored hash.
 *
 *   - §17.11 No role exemption. The schema is an integrity guarantee,
 *     not a permission. No role (including `super-admin`) may
 *     override or coerce an AI result outside the designated
 *     Wave 41 service.
 *
 * NOTE: this entity is intentionally NOT extending `AbstractAiResult`
 * because the task-spec column `reviewer_work_history_id` is
 * semantically distinct from the base's nullable
 * `computed_by_work_history_id`, and we want a NOT NULL reviewer
 * stamp at the schema level. The column set nevertheless mirrors the
 * base so future refactors can consolidate if desired.
 */
@Entity('ai_staff_review_runs')
@Index('ix_ai_staff_review_runs_target_computed_at', [
  'targetKind',
  'targetId',
  'computedAt',
])
@Index('ix_ai_staff_review_runs_reviewer_computed_at', [
  'reviewerWorkHistoryId',
  'computedAt',
])
@Index('ix_ai_staff_review_runs_content_hash', ['contentHash'])
export class AiStaffReviewRun {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Discriminator for `target_id`. Uses shared `ai_target_kind` enum.
   *
   * MUST stay in lockstep with `AbstractAiResult.target_kind` enum list —
   * both declarations point at the SAME PG type `ai_target_kind`, and a
   * mismatch causes TypeORM's `synchronize:true` to attempt a futile
   * enum-rename cycle on every BE boot (verified 2026-05-28: missing
   * `equipment-project-group` here triggers `cannot drop type
   * ai_target_kind_old because other objects depend on it` since the
   * RENAME-CREATE-SWITCH-DROP protocol leaves dependent columns mid-flight).
   * Wave Equipment ผ.03 Phase 2 — BE-06.
   */
  @Column({
    name: 'target_kind',
    type: 'enum',
    enum: [
      'project-group',
      'revised-project-group',
      'supplement-project-group',
      'equipment-project-group',
      // Wave Equipment Revision Management — Phase 3 (2026-06-01). MUST
      // mirror AbstractAiResult + AiExecutiveMessage exactly (shared
      // `ai_target_kind` type) or synchronize:true loops the enum-rename
      // cycle on every boot — see the class-doc note above.
      'revised-equipment-project-group',
    ] as AiResultTargetKind[],
    enumName: 'ai_target_kind',
  })
  targetKind: AiResultTargetKind;

  /**
   * Project UUID the reviewer run is about. NOT a foreign key (§17.3).
   */
  @Column({ name: 'target_id', type: 'uuid' })
  targetId: string;

  /**
   * WorkHistory.id of the reviewer at compute time (§4 ownership
   * source of truth). NO FK — audit rows survive any hypothetical
   * WorkHistory row mutation.
   */
  @Column({ name: 'reviewer_work_history_id', type: 'uuid' })
  reviewerWorkHistoryId: string;

  /**
   * SHA-256 hex of the canonical input hash that produced this run.
   */
  @Column({ name: 'content_hash', type: 'varchar', length: 64 })
  contentHash: string;

  /**
   * Endpoint path. Defaults to the canonical reviewer endpoint so
   * Wave 41 bare INSERTs land on the right value.
   */
  @Column({
    name: 'endpoint',
    type: 'varchar',
    length: 256,
    default: 'smart-approve/analyze',
  })
  endpoint: string;

  /**
   * Raw structured result payload from the AI run (opaque per
   * Wave 13 discipline).
   */
  @Column({
    name: 'result_json',
    type: 'jsonb',
    default: () => `'{}'::jsonb`,
  })
  resultJson: Record<string, unknown>;

  /**
   * Normalized score 0..100. Nullable for non-scoring result kinds.
   */
  @Column({ name: 'score_0_100', type: 'int', nullable: true })
  score0100: number | null;

  /**
   * Interpretation band. Uses shared `ai_score_band` enum.
   */
  @Column({
    name: 'band',
    type: 'enum',
    enum: ['green', 'amber', 'red'] as AiScoreBand[],
    enumName: 'ai_score_band',
    nullable: true,
  })
  band: AiScoreBand | null;

  /**
   * Model identifier (e.g. 'gpt-4o').
   */
  @Column({
    name: 'model',
    type: 'varchar',
    length: 128,
    default: 'unknown',
  })
  model: string;

  /**
   * Per-result staleness policy (§17.4). Defaults to `'strict'` —
   * reviewer runs are live, NOT snapshot-only.
   */
  @Column({
    name: 'staleness_policy',
    type: 'enum',
    enum: ['strict', 'snapshot-only', 'warning-only'] as AiStalenessPolicy[],
    enumName: 'ai_staleness_policy',
    default: 'strict',
  })
  stalenessPolicy: AiStalenessPolicy;

  /**
   * Timestamp of the AI run (UTC).
   */
  @Column({
    name: 'computed_at',
    type: 'timestamptz',
    default: () => 'now()',
  })
  computedAt: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({
    name: 'updated_at',
    type: 'timestamptz',
    nullable: true,
  })
  updatedAt: Date | null;

  @DeleteDateColumn({
    name: 'deleted_at',
    type: 'timestamptz',
    nullable: true,
  })
  deletedAt: Date | null;
}
