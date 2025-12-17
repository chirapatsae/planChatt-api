import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { User } from 'src/users/entities/user.entity';

@Entity('pdf_development_plan_approved_documents')
export class PdfDevelopmentPlanApprovedDocument {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'development_plan_id' })
  developmentPlanId: string;

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

  // Deprecation fields (for audit trail)
  @Column({ name: 'is_deprecated', default: false })
  isDeprecated: boolean;

  @Column({ name: 'deprecated_at', type: 'timestamp', nullable: true })
  deprecatedAt: Date | null;

  @Column({ name: 'deprecated_by_id', nullable: true })
  deprecatedById: string | null;

  // Relations
  @ManyToOne(() => DevelopmentPlan)
  @JoinColumn({ name: 'development_plan_id' })
  developmentPlan: DevelopmentPlan;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'created_by_id' })
  createdBy: User;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'deprecated_by_id' })
  deprecatedBy: User | null;
}
