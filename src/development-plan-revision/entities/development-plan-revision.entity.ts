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

  /**
   * AUTHORING-ORDER counter — assigned at create time, per-plan, CROSS-type.
   *
   * Computed as `MAX(revisionNumber) + 1` over ALL revisions of the plan
   * INCLUDING soft-deleted rows (development-plan-revision.service.ts), so
   * แก้ไข and เปลี่ยนแปลง share ONE sequence and a deleted/gapped number is
   * never reused. (Previously `length + 1`, which could re-issue a number
   * after a mid-chain soft-delete.) This is the order rounds were CREATED,
   * NOT the order books were published/booked.
   *
   * Decoupling from the §15 publication timeline is DELIBERATE:
   *   - §15.2 / §15.11: the book lineage timeline is ordered by `bookedAt`
   *     (strict `>`), and MUST NOT be ordered by `revisionNumber` or
   *     `createdAt`. BookLockService never reads this field.
   *   - The printed "ครั้งที่ N" is re-derived PER-TYPE at print time via
   *     `PdfService.calculateRevisionCountByType` (pdf.service.ts), so the
   *     absolute value here is not printed directly — only its ordering matters.
   *   - `MAX(revisionNumber)` IS used to pick the latest revised version per
   *     project (revised-project-group.service.ts). Because of this, and per
   *     §11/§12 immutability (the value is snapshotted into printed/booked
   *     PDFs as editNo/changeNo), `revisionNumber` MUST NOT be reassigned or
   *     mutated after creation.
   *
   * Do NOT "fix" this into publication order — that would re-violate §15.11,
   * break latest-version selection, and rewrite booked history.
   */
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

  /**
   * CLAUDE.md §15.2 / §15.3 Book Lineage Immutability — finalize-moment
   * timestamp used by the cross-category linear-chain ordering
   * (wave-lineage-linear-chain-by-bookedAt). NULL while the revision is a
   * draft (`isBooked = false`); set at the moment `isBooked` flips to
   * `true` (BE-01 wires the write). Backfilled per DB-01 migration from
   * `book_assembly_versions.merged_at` (source_type = edit_revision /
   * change_revision; fallback `created_at`).
   */
  @Column({ name: 'booked_at', type: 'timestamptz', nullable: true })
  bookedAt: Date | null;

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
   * `true` when ANY other non-soft-deleted, BOOKED (`bookedAt IS NOT NULL`)
   * revision or supplement of the same `DevelopmentPlan` has a strictly-newer
   * `bookedAt` — §15.2/§15.11 LINEAR CHAIN ACROSS CATEGORIES, ordered by
   * `bookedAt` (strict `>`). Drafts (`bookedAt IS NULL`) are excluded from the
   * chain. NOTE: ordering is by `bookedAt`, NOT `createdAt` — see
   * `BookLockService.hasStrictlyNewerBookedSibling`. The write paths enforce
   * the invariant via `BookLockService.assertEditable`; this flag only
   * surfaces the state to the UI (disable "แก้ไขเล่ม" / "ยกเลิกเล่ม",
   * show the "เล่มเก่า (ถูกล็อก)" badge).
   */
  hasNewerRevision?: boolean;
}
