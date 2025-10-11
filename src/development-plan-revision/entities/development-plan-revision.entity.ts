import { BudgetPlan } from 'src/budget_plan/entities/budget_plan.entity';
import { RevisionType } from 'src/revision-type/entities/revision-type.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('development_plan_revision')
export class DevelopmentPlanRevision {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => BudgetPlan, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'budget_plan_id' })
  budgetPlan: BudgetPlan;

  @ManyToOne(() => RevisionType, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'revision_type_id' })
  revisionType: RevisionType;

  @Column({ name: 'revision_number', type: 'int' })
  revisionNumber: number;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column({ name: 'is_latest', default: false })
  isLatest: boolean;

  @Column({ name: 'start_date', type: 'timestamp', nullable: true })
  startDate: Date | null;

  @Column({ name: 'end_date', type: 'timestamp', nullable: true })
  endDate: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @ManyToOne(() => WorkHistory, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'created_by' })
  createdBy: WorkHistory;
}
