import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { User } from 'src/users/entities/user.entity';

@Entity('pdf_development_plan_draft_agency_documents')
export class PdfDevelopmentPlanDraftAgencyDocument {
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

  // Relations
  @ManyToOne(() => DevelopmentPlan)
  @JoinColumn({ name: 'development_plan_id' })
  developmentPlan: DevelopmentPlan;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'created_by_id' })
  createdBy: User;
}
