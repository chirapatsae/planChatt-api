/**
 * abstract-ai-result.entity.ts — Shared TypeORM base for ai_* result tables.
 *
 * CLAUDE.md §17.3 (audit separation) + §17.4 (staleness model).
 *
 * Invariants enforced by this base:
 *   - Each concrete `ai_*` result table extends this class via TypeORM
 *     entity inheritance.
 *   - NO foreign key to `project_groups`, `revised_project_groups`, or
 *     `supplement_project_groups`. Projects are referenced by UUID via
 *     `target_id` + `target_kind` without referential integrity so that
 *     §14.6 rollback hard-deletes do not cascade into AI audit.
 *   - `content_hash` is indexed per-subtable; the base defines the
 *     column but NOT the index (concrete tables add `(target_id,
 *     target_kind, content_hash)` composite indexes in their own
 *     migrations — see task file §8).
 *
 * This class is marked abstract so it cannot be instantiated directly.
 * Downstream RF2/RF5 extend it with `@Entity({ name: 'ai_*' })`.
 */
import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import {
  AiResultTargetKind,
  AiScoreBand,
  AiStalenessPolicy,
} from '../utils/ai-score-envelope';

export abstract class AbstractAiResult {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Project UUID the result is about. NOT a foreign key (§17.3).
   */
  @Column({ name: 'target_id', type: 'uuid' })
  targetId: string;

  /**
   * Discriminator for `target_id`. Uses shared `ai_target_kind` enum.
   */
  @Column({
    name: 'target_kind',
    type: 'enum',
    enum: [
      'project-group',
      'revised-project-group',
      'supplement-project-group',
    ] as AiResultTargetKind[],
    enumName: 'ai_target_kind',
  })
  targetKind: AiResultTargetKind;

  /**
   * SHA-256 hex of the canonical input hash that produced this result.
   */
  @Column({ name: 'content_hash', type: 'varchar', length: 64 })
  contentHash: string;

  /**
   * Timestamp of the AI run (UTC).
   */
  @Column({
    name: 'computed_at',
    type: 'timestamptz',
    default: () => 'CURRENT_TIMESTAMP',
  })
  computedAt: Date;

  /**
   * WorkHistory id of the acting user at compute time. Nullable —
   * background/system-initiated runs may leave this null.
   *
   * No FK declared here to keep this entity portable across downstream
   * tables; concrete tables MAY declare the FK in their own entity if
   * they need relation fetching.
   */
  @Column({
    name: 'computed_by_work_history_id',
    type: 'uuid',
    nullable: true,
  })
  computedByWorkHistoryId: string | null;

  /**
   * Raw structured result payload from the AI run.
   */
  @Column({ name: 'result_json', type: 'jsonb' })
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
   * Per-result staleness policy (§17.4). Uses shared `ai_staleness_policy`
   * enum.
   */
  @Column({
    name: 'staleness_policy',
    type: 'enum',
    enum: ['strict', 'snapshot-only', 'warning-only'] as AiStalenessPolicy[],
    enumName: 'ai_staleness_policy',
  })
  stalenessPolicy: AiStalenessPolicy;

  /**
   * Model identifier (e.g. 'gpt-4o').
   */
  @Column({ type: 'varchar', length: 128 })
  model: string;

  /**
   * Endpoint path (e.g. 'smart-approve/analyze/revised').
   */
  @Column({ type: 'varchar', length: 256 })
  endpoint: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz', nullable: true })
  updatedAt: Date | null;

  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt: Date | null;
}
