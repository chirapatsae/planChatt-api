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

  @ManyToOne(() => WorkHistory, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'deleted_by' })
  deletedBy?: WorkHistory | null;

  @OneToMany(() => PdfRevisionEditDraftDocument, 
  (pdfRevisionEditDraftDocument) => pdfRevisionEditDraftDocument.developmentPlanRevision)
  pdfRevisionEditDraftDocuments: PdfRevisionEditDraftDocument[];

  @OneToMany(() => PdfRevisionEditApprovedDocument, (pdfRevisionEditApprovedDocument) => pdfRevisionEditApprovedDocument.developmentPlanRevision)
  pdfRevisionEditApprovedDocuments: PdfRevisionEditApprovedDocument[];

  @OneToMany(() => PdfRevisionChangeDraftDocument, (pdfRevisionChangeDraftDocument) => pdfRevisionChangeDraftDocument.developmentPlanRevision)
  pdfRevisionChangeDraftDocuments: PdfRevisionChangeDraftDocument[];

  @OneToMany(() => PdfRevisionChangeApprovedDocument, (pdfRevisionChangeApprovedDocument) => pdfRevisionChangeApprovedDocument.developmentPlanRevision)
  pdfRevisionChangeApprovedDocuments: PdfRevisionChangeApprovedDocument[];

  /**
   * CLAUDE.md §15 Book Lineage Immutability.
   *
   * Runtime-only flag populated by
   * `DevelopmentPlanService.decorateBookLockFlags`. NOT a database column.
   *
   * Declared as a plain class field so that:
   *   1. `class-transformer` (`ClassSerializerInterceptor` in main.ts)
   *      reliably preserves the property during JSON serialization of
   *      the response body — dynamic `(obj as any).x = …` assignments
   *      are brittle under strict / grouped transform configurations.
   *   2. TypeScript understands the field exists on the entity and
   *      downstream callers no longer need `as any` casts.
   *
   * `true` when ANY other non-soft-deleted revision or supplement of the
   * same `DevelopmentPlan` has a strictly-newer `createdAt` — OQ-2=(B)
   * global timeline across BOTH collections. The write paths enforce the
   * invariant via `BookLockService.assertEditable`; this flag only
   * surfaces the state to the UI (disable "แก้ไขเล่ม" / "ยกเลิกเล่ม",
   * show the "เล่มเก่า (ถูกล็อก)" badge).
   */
  hasNewerRevision?: boolean;
}
