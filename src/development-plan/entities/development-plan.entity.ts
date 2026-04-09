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

  /**
   * Denormalized cache. Set to true by the service when the first
   * DevelopmentPlanRevision is created for this plan.
   *
   * This field enables fast UI filtering to exclude frozen main plans from the
   * actionable book-assembly view without a JOIN on development_plan_revision.
   *
   * IMPORTANT: Backend MUST NOT treat this as the authoritative freeze check.
   * The authoritative check is always: COUNT(*) FROM development_plan_revision
   * WHERE development_plan_id = this.id. This field is a performance cache only.
   */
  @Column({ name: 'is_frozen', default: false })
  isFrozen: boolean;

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
}

