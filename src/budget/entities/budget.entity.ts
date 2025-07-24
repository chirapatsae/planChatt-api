// budget.entity.ts
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  JoinColumn,
} from 'typeorm';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { IsOptional } from 'class-validator';
import { BudgetPlan } from 'src/budget_plan/entities/budget_plan.entity';

@Entity('budget')
export class Budget {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => ProjectGroup, (projectGroup) => projectGroup.budgets, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'project_group_id' })
  projectGroupId?: ProjectGroup;

  @IsOptional()
  @Column({ name: 'project_version_id', nullable: true })
  projectVersionId?: number;

  @ManyToOne(() => BudgetPlan, (budgetPlan) => budgetPlan.budget, {
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'budget_plan_id' })
  budgetPlanId;

  @Column()
  year: number;

  @Column('decimal', { precision: 18, scale: 2 })
  quantity: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
