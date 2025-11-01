import { DevelopmentPlanRevision } from 'src/development-plan-revision/entities/development-plan-revision.entity';
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

@Entity({ name: 'budget_plan' })
export class BudgetPlan {
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

  @Column({ name: 'start_date', type: 'timestamp', nullable: true })
  startDate: Date | null;

  @Column({ name: 'end_date', type: 'timestamp', nullable: true })
  endDate: Date | null;

  @CreateDateColumn({ name: 'create_at' })
  createAt: Date;

  @DeleteDateColumn({ name: 'deleted_at', nullable: true })
  deletedAt?: Date;

  @ManyToOne(() => WorkHistory, (workHistory) => workHistory.budgetPlan, {
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'created_by' })
  createdBy: WorkHistory;

  @OneToMany(() => ProjectGroup, (projectGroup) => projectGroup.budgetPlan, {
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE',
  })
  projectGroup: ProjectGroup[];

  @OneToMany(() => DevelopmentPlanRevision, (dpr) =>  dpr.budgetPlan, {
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE',
  })
  developmentPlanRevision : DevelopmentPlanRevision[];

  @OneToMany(() => PlanPhase, (planPhase) => planPhase.budgetPlan, {
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE',
  })
  planPhases: PlanPhase[];
}
