import { DevelopmentPlanRevision } from 'src/development-plan-revision/entities/development-plan-revision.entity';
import { DevelopmentPlanSupplement } from 'src/development-plan-supplement/entities/development-plan-supplement.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { PlanPhase } from 'src/plan-phase/entities/plan-phase.entity';
import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity({ name: 'development_plan' })
export class DevelopmentPlan {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ name: 'start_year' })
  startYear: number;

  @Column({ name: 'end_year' })
  endYear: number;

  @Column({ name: 'is_latest' })
  isLatest: boolean;

  @Column({ name: 'is_booked', default: false })
  isBooked: boolean;

  @CreateDateColumn({ name: 'create_at' })
  createAt: Date;

  @DeleteDateColumn({ name: 'deleted_at', nullable: true })
  deletedAt?: Date;

  @ManyToOne(() => WorkHistory, (workHistory) => workHistory.developmentPlan, {
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'created_by' })
  createdBy: WorkHistory;

  @ManyToOne(() => WorkHistory, (workHistory) => workHistory.deletorDevelopmentPlan, {
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'deleted_by' })
  deletedBy?: WorkHistory | null;

  @OneToMany(() => ProjectGroup, (projectGroup) => projectGroup.developmentPlan, {
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE',
  })
  projectGroup: ProjectGroup[];

  @OneToMany(() => DevelopmentPlanRevision, (dpr) =>  dpr.developmentPlan, {
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE',
  })
  developmentPlanRevision : DevelopmentPlanRevision[];

  @OneToMany(() => DevelopmentPlanSupplement, (dps) => dps.developmentPlan, {
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE',
  })
  developmentPlanSupplements: DevelopmentPlanSupplement[];

  @OneToMany(() => PlanPhase, (planPhase) => planPhase.developmentPlan, {
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE',
  })
  planPhases: PlanPhase[];

  /**
   * CLAUDE.md §15 Book Lineage Immutability.
   *
   * Runtime-only flag populated by
   * `DevelopmentPlanService.decorateBookLockFlags` (and by `findOne`
   * via `BookLockService.hasNewerRevision`). NOT a database column.
   *
   * Declared as a plain class field so that:
   *   1. `class-transformer` (`ClassSerializerInterceptor` in main.ts)
   *      reliably preserves the property during JSON serialization of
   *      the response body — dynamic `(obj as any).x = …` assignments
   *      are brittle under strict / grouped transform configurations.
   *   2. TypeScript understands the field exists on the entity and
   *      downstream callers no longer need `as any` casts.
   *
   * `true` when this plan has at least one non-soft-deleted revision or
   * supplement child (i.e. the plan itself has become a locked, historical
   * root per §15.3). The write paths enforce the invariant via
   * `BookLockService.assertEditable`; this flag only surfaces the state to
   * the UI.
   */
  hasNewerRevision?: boolean;
}

