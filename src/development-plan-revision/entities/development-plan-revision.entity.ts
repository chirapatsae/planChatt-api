import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { PdfRevisionChangeApprovedDocument } from 'src/pdf/entities/pdf-revision-change-approved-document.entity';
import { PdfRevisionChangeDraftDocument } from 'src/pdf/entities/pdf-revision-change-draft-document.entity';
import { PdfRevisionEditApprovedDocument } from 'src/pdf/entities/pdf-revision-edit-approved-document.entity';
import { PdfRevisionEditDraftDocument } from 'src/pdf/entities/pdf-revision-edit-draft-document.entity';
import { RevisionType } from 'src/revision-type/entities/revision-type.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
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

@Entity('development_plan_revision')
export class DevelopmentPlanRevision {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => DevelopmentPlan, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'development_plan_id' })
  developmentPlan: DevelopmentPlan;

  @ManyToOne(() => RevisionType, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'revision_type_id' })
  revisionType: RevisionType;

  @Column({ name: 'revision_number', type: 'int' })
  revisionNumber: number;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column({ name: 'is_latest', default: false })
  isLatest: boolean;

  @Column({ name: 'is_booked', default: false })
  isBooked: boolean;

  @Column({ name: 'is_open', default: false })
  isOpen: boolean;

  @Column({ name: 'start_date', type: 'timestamp', nullable: true })
  startDate: Date | null;

  @Column({ name: 'end_date', type: 'timestamp', nullable: true })
  endDate: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @DeleteDateColumn({ name: 'deleted_at', nullable: true })
  deletedAt?: Date;

  @ManyToOne(() => WorkHistory, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'created_by' })
  createdBy: WorkHistory;

  @OneToMany(() => PdfRevisionEditDraftDocument, 
  (pdfRevisionEditDraftDocument) => pdfRevisionEditDraftDocument.developmentPlanRevision)
  pdfRevisionEditDraftDocuments: PdfRevisionEditDraftDocument[];

  @OneToMany(() => PdfRevisionEditApprovedDocument, (pdfRevisionEditApprovedDocument) => pdfRevisionEditApprovedDocument.developmentPlanRevision)
  pdfRevisionEditApprovedDocuments: PdfRevisionEditApprovedDocument[];

  @OneToMany(() => PdfRevisionChangeDraftDocument, (pdfRevisionChangeDraftDocument) => pdfRevisionChangeDraftDocument.developmentPlanRevision)
  pdfRevisionChangeDraftDocuments: PdfRevisionChangeDraftDocument[];

  @OneToMany(() => PdfRevisionChangeApprovedDocument, (pdfRevisionChangeApprovedDocument) => pdfRevisionChangeApprovedDocument.developmentPlanRevision)
  pdfRevisionChangeApprovedDocuments: PdfRevisionChangeApprovedDocument[];
}
