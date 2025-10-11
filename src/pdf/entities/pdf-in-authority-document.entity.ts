import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { BudgetPlan } from 'src/budget_plan/entities/budget_plan.entity';
import { User } from 'src/users/entities/user.entity';

@Entity('pdf_in_authority_documents')
export class PdfInAuthorityDocument {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'budget_plan_id' })
  budgetPlanId: string;

  @Column({ name: 'version' })
  version: number;

  @Column({ name: 'file_path' })
  filePath: string;

  @Column({ name: 'project_ids_snapshot', type: 'jsonb' })
  projectIdsSnapshot: Array<string | number>;

  @Column({ name: 'project_count' })
  projectCount: number;

  @Column({ name: 'created_by_id' })
  createdById: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  // Relations
  @ManyToOne(() => BudgetPlan)
  @JoinColumn({ name: 'budget_plan_id' })
  budgetPlan: BudgetPlan;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'created_by_id' })
  createdBy: User;
}
