import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { DevelopmentPlanRevision } from 'src/development-plan-revision/entities/development-plan-revision.entity';
import { User } from 'src/users/entities/user.entity';

@Entity('pdf_revision_edit_approved_documents')
export class PdfRevisionEditApprovedDocument {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'development_plan_revision_id' })
  developmentPlanRevisionId: string;

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
  @ManyToOne(() => DevelopmentPlanRevision, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'development_plan_revision_id' })
  developmentPlanRevision: DevelopmentPlanRevision;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'created_by_id' })
  createdBy: User;
}

