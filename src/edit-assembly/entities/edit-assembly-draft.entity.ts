import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Exclude } from 'class-transformer';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { DevelopmentPlanRevision } from 'src/development-plan-revision/entities/development-plan-revision.entity';
import {
  EditAssemblyCorrectionMode,
  EditAssemblyDraftStatus,
  EditAssemblyPartUploadStatus,
} from '../enums/edit-assembly.enums';
import { EditAssemblyVersion } from './edit-assembly-version.entity';

/**
 * EditAssemblyDraft — Wave A2 / DB-01.
 *
 * Standalone EDIT_REVISION assembly draft row (in-progress
 * Part1 → Part2 → Part3 → finalize workflow). Dedicated table; NOT
 * shared with `book_assembly_drafts`, `main_assembly_drafts`, or
 * `supplement_assembly_drafts`.
 *
 * Design notes:
 *  - `developmentPlanRevisionId` replaces the old `(source_type,
 *    source_id)` discriminator. Table membership is the type
 *    discriminator.
 *  - FK to `development_plan_revision(id)` with ON DELETE RESTRICT — a
 *    revision that owns an in-flight draft must not be hard-deleted.
 *  - The partial unique index `idx_edit_single_active_draft_per_revision`
 *    (declared in the migration; PG-specific partial UNIQUE is not
 *    expressible via `@Unique` decorator) enforces "at most one active
 *    draft per development plan revision" where
 *    `assembly_status != 'merged'`.
 *
 * Column / property naming mirrors `main_assembly_drafts` byte-for-byte
 * with `developmentPlanId` → `developmentPlanRevisionId`, so BE-01 can
 * clone `MainAssemblyService` with minimal renames.
 */
@Entity('edit_assembly_drafts')
@Index('idx_edit_draft_revision', ['developmentPlanRevisionId'])
export class EditAssemblyDraft {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'development_plan_revision_id', type: 'uuid' })
  developmentPlanRevisionId: string;

  @Column({ name: 'target_version', type: 'int' })
  targetVersion: number;

  @Column({ name: 'previous_version_id', type: 'uuid', nullable: true })
  previousVersionId: string | null;

  @Column({
    name: 'correction_mode',
    type: 'enum',
    enum: EditAssemblyCorrectionMode,
    enumName: 'edit_assembly_correction_mode',
    nullable: true,
  })
  correctionMode: EditAssemblyCorrectionMode | null;

  @Column({ name: 'correction_reason', type: 'text', nullable: true })
  correctionReason: string | null;

  // Part 1

  @Column({
    name: 'part1_status',
    type: 'enum',
    enum: EditAssemblyPartUploadStatus,
    enumName: 'edit_assembly_part_upload_status',
    default: EditAssemblyPartUploadStatus.PENDING,
  })
  part1Status: EditAssemblyPartUploadStatus;

  // Fix V1: exclude internal filesystem paths from API responses
  @Exclude()
  @Column({ name: 'part1_file_path', type: 'varchar', nullable: true })
  part1FilePath: string | null;

  @Column({ name: 'part1_original_file_name', type: 'varchar', nullable: true })
  part1OriginalFileName: string | null;

  @Column({ name: 'part1_uploaded_at', type: 'timestamp', nullable: true })
  part1UploadedAt: Date | null;

  @Column({ name: 'part1_uploaded_by_id', type: 'uuid', nullable: true })
  part1UploadedById: string | null;

  // Part 2

  @Column({
    name: 'part2_status',
    type: 'enum',
    enum: EditAssemblyPartUploadStatus,
    enumName: 'edit_assembly_part_upload_status',
    default: EditAssemblyPartUploadStatus.PENDING,
  })
  part2Status: EditAssemblyPartUploadStatus;

  @Exclude()
  @Column({ name: 'part2_file_path', type: 'varchar', nullable: true })
  part2FilePath: string | null;

  @Column({ name: 'part2_original_file_name', type: 'varchar', nullable: true })
  part2OriginalFileName: string | null;

  @Column({ name: 'part2_uploaded_at', type: 'timestamp', nullable: true })
  part2UploadedAt: Date | null;

  @Column({ name: 'part2_uploaded_by_id', type: 'uuid', nullable: true })
  part2UploadedById: string | null;

  // Part 3

  @Column({
    name: 'part3_status',
    type: 'enum',
    enum: EditAssemblyPartUploadStatus,
    enumName: 'edit_assembly_part_upload_status',
    default: EditAssemblyPartUploadStatus.PENDING,
  })
  part3Status: EditAssemblyPartUploadStatus;

  @Exclude()
  @Column({ name: 'part3_file_path', type: 'varchar', nullable: true })
  part3FilePath: string | null;

  @Column({ name: 'part3_generated_at', type: 'timestamp', nullable: true })
  part3GeneratedAt: Date | null;

  @Column({ name: 'part3_project_snapshot', type: 'jsonb', nullable: true })
  part3ProjectSnapshot: string[] | null;

  // Wave A2 / DB-01 — the legacy `book_assembly_drafts.part3_page_map`
  // JSONB is INTENTIONALLY preserved on the draft (not yet denormalized
  // into a join table at draft-stage). Page-map denormalization happens
  // on merge() into `edit_assembly_version_projects` — see the matching
  // version entity / migration. Keeping the JSONB on the draft matches
  // the existing `BookAssemblyService` merge() flow that reads
  // `draft.part3_page_map` and writes the version snapshot.
  @Column({ name: 'part3_page_map', type: 'jsonb', nullable: true })
  part3PageMap: Record<string, number> | null;

  // Assembly status

  @Column({
    name: 'assembly_status',
    type: 'enum',
    enum: EditAssemblyDraftStatus,
    enumName: 'edit_assembly_draft_status',
    default: EditAssemblyDraftStatus.PREPARING,
  })
  assemblyStatus: EditAssemblyDraftStatus;

  // Canceled (soft-delete) fields

  @Column({ name: 'canceled_at', type: 'timestamp', nullable: true })
  canceledAt: Date | null;

  @Column({ name: 'canceled_by_id', type: 'uuid', nullable: true })
  canceledById: string | null;

  // Creator

  @Column({ name: 'created_by_id', type: 'uuid' })
  createdById: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  // Relations

  @ManyToOne(() => WorkHistory)
  @JoinColumn({ name: 'created_by_id' })
  createdBy: WorkHistory;

  @ManyToOne(() => EditAssemblyVersion, { nullable: true })
  @JoinColumn({ name: 'previous_version_id' })
  previousVersion: EditAssemblyVersion | null;

  @ManyToOne(() => WorkHistory, { nullable: true })
  @JoinColumn({ name: 'part1_uploaded_by_id' })
  part1UploadedBy: WorkHistory | null;

  @ManyToOne(() => WorkHistory, { nullable: true })
  @JoinColumn({ name: 'part2_uploaded_by_id' })
  part2UploadedBy: WorkHistory | null;

  @ManyToOne(() => WorkHistory, { nullable: true })
  @JoinColumn({ name: 'canceled_by_id' })
  canceledBy: WorkHistory | null;

  @ManyToOne(() => DevelopmentPlanRevision, { nullable: false })
  @JoinColumn({ name: 'development_plan_revision_id' })
  developmentPlanRevision: DevelopmentPlanRevision;
}
