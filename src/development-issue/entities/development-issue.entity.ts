import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';

/**
 * DevelopmentIssue — CLAUDE.md §16.6
 *
 * A plan-scoped classification node used by ISSUE_BASED
 * `DevelopmentPlan` lineages. Every row belongs to a single
 * `DevelopmentPlan`. Revisions and supplements inherit the parent plan's
 * issue list as read-only reference — they do NOT own their own issues.
 *
 * Lifecycle (enforced by `DevelopmentIssueService`, not by this entity):
 *   - CREATE/UPDATE: allowed only while the parent plan is unlocked per §15
 *   - DELETE (soft only): allowed only while the parent plan is unlocked AND
 *     no project in the plan references the issue
 *   - HARD DELETE: not permitted — use soft delete
 *
 * Copy-on-fork (§16.6): when a ProjectGroup (ISSUE_BASED) is forked into a
 * RevisedProjectGroup, the `development_issue_id` FK is copied unchanged.
 * The issue row itself is NOT duplicated — the revised row references the
 * same plan-level issue.
 *
 * The composite index `(development_plan_id, sort_order)` is created by
 * the migration explicitly — we do NOT declare it via `@Index` here
 * because TypeORM's decorator does not resolve relation names to raw
 * columns reliably.
 */
@Entity({ name: 'development_issues' })
export class DevelopmentIssue {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => DevelopmentPlan, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'development_plan_id' })
  developmentPlan: DevelopmentPlan;

  @Column({ type: 'varchar', length: 512 })
  name: string;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @DeleteDateColumn({ name: 'deleted_at', nullable: true })
  deletedAt?: Date;

  @ManyToOne(() => WorkHistory, {
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'created_by' })
  createdBy: WorkHistory;
}
