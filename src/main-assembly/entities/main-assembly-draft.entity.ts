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
import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import {
  MainAssemblyCorrectionMode,
  MainAssemblyDraftStatus,
  MainAssemblyPartUploadStatus,
} from '../enums/main-assembly.enums';
import { MainAssemblyVersion } from './main-assembly-version.entity';

/**
 * MainAssemblyDraft — Wave A1 / DB-01.
 *
 * Standalone main-plan assembly draft row (in-progress
 * Part1 → Part2 → Part3 → finalize workflow). Dedicated table; NOT
 * shared with `book_assembly_drafts`.
 *
 * Design notes:
 *  - `developmentPlanId` replaces the old `(source_type, source_id)`
 *    discriminator. Table membership is the type discriminator.
 *  - FK to `development_plan(id)` with ON DELETE RESTRICT — a plan
 *    that owns an in-flight draft must not be hard-deleted.
 *  - The partial unique index `idx_main_single_active_draft_per_plan`
 *    (declared in the migration; PG-specific partial UNIQUE is not
 *    expressible via `@Unique` decorator) enforces "at most one active
 *    draft per development plan" where `assembly_status != 'merged'`.
 *
 * Column / property naming mirrors `book_assembly_drafts` byte-for-byte
 * minus the source-type discriminator, so BE-01 can clone
 * `BookAssemblyService` with minimal renames.
 */
@Entity('main_assembly_drafts')
@Index('idx_main_draft_plan', ['developmentPlanId'])
export class MainAssemblyDraft {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'development_plan_id', type: 'uuid' })
  developmentPlanId: string;

  @Column({ name: 'target_version', type: 'int' })
  targetVersion: number;

  @Column({ name: 'previous_version_id', type: 'uuid', nullable: true })
  previousVersionId: string | null;

  @Column({
    name: 'correction_mode',
    type: 'enum',
    enum: MainAssemblyCorrectionMode,
    enumName: 'main_assembly_correction_mode',
    nullable: true,
  })
  correctionMode: MainAssemblyCorrectionMode | null;

  @Column({ name: 'correction_reason', type: 'text', nullable: true })
  correctionReason: string | null;

  // Part 1

  @Column({
    name: 'part1_status',
    type: 'enum',
    enum: MainAssemblyPartUploadStatus,
    enumName: 'main_assembly_part_upload_status',
    default: MainAssemblyPartUploadStatus.PENDING,
  })
  part1Status: MainAssemblyPartUploadStatus;

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
    enum: MainAssemblyPartUploadStatus,
    enumName: 'main_assembly_part_upload_status',
    default: MainAssemblyPartUploadStatus.PENDING,
  })
  part2Status: MainAssemblyPartUploadStatus;

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
    enum: MainAssemblyPartUploadStatus,
    enumName: 'main_assembly_part_upload_status',
    default: MainAssemblyPartUploadStatus.PENDING,
  })
  part3Status: MainAssemblyPartUploadStatus;

  @Exclude()
  @Column({ name: 'part3_file_path', type: 'varchar', nullable: true })
  part3FilePath: string | null;

  @Column({ name: 'part3_generated_at', type: 'timestamp', nullable: true })
  part3GeneratedAt: Date | null;

  @Column({ name: 'part3_project_snapshot', type: 'jsonb', nullable: true })
  part3ProjectSnapshot: string[] | null;

  // Wave A1 / DB-01 — the legacy `book_assembly_drafts.part3_page_map`
  // JSONB is INTENTIONALLY preserved on the draft (not yet denormalized
  // into a join table at draft-stage). Page-map denormalization happens
  // on merge() into `main_assembly_version_projects` — see the
  // matching version entity / migration. Keeping the JSONB on the draft
  // matches the existing `BookAssemblyService` merge() flow that reads
  // `draft.part3_page_map` and writes the version snapshot.
  @Column({ name: 'part3_page_map', type: 'jsonb', nullable: true })
  part3PageMap: Record<string, number> | null;

  // Phase 3 (2026-05-31) — equipment (ผ.03) appended INSIDE Part 3 at
  // generatePart3 time so the user previews / downloads ผ.02 + ผ.03 as
  // one Part 3 file. These columns persist the equipment snapshot + the
  // per-equipment 1-based LOCAL page within the ผ.03 sub-buffer so
  // merge() can compute the absolute book page + stamp booking columns
  // without re-rendering ผ.03. typeorm synchronize:true creates the
  // jsonb columns on next reload; legacy rows have null (no equipment
  // appended). Mirror of part3ProjectSnapshot / part3PageMap above.
  @Column({ name: 'part3_equipment_snapshot', type: 'jsonb', nullable: true })
  part3EquipmentSnapshot: string[] | null;

  @Column({ name: 'part3_equipment_page_map', type: 'jsonb', nullable: true })
  part3EquipmentPageMap: Record<string, number> | null;

  // Assembly status

  @Column({
    name: 'assembly_status',
    type: 'enum',
    enum: MainAssemblyDraftStatus,
    enumName: 'main_assembly_draft_status',
    default: MainAssemblyDraftStatus.PREPARING,
  })
  assemblyStatus: MainAssemblyDraftStatus;

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

  @ManyToOne(() => MainAssemblyVersion, { nullable: true })
  @JoinColumn({ name: 'previous_version_id' })
  previousVersion: MainAssemblyVersion | null;

  @ManyToOne(() => WorkHistory, { nullable: true })
  @JoinColumn({ name: 'part1_uploaded_by_id' })
  part1UploadedBy: WorkHistory | null;

  @ManyToOne(() => WorkHistory, { nullable: true })
  @JoinColumn({ name: 'part2_uploaded_by_id' })
  part2UploadedBy: WorkHistory | null;

  @ManyToOne(() => WorkHistory, { nullable: true })
  @JoinColumn({ name: 'canceled_by_id' })
  canceledBy: WorkHistory | null;

  @ManyToOne(() => DevelopmentPlan, { nullable: false })
  @JoinColumn({ name: 'development_plan_id' })
  developmentPlan: DevelopmentPlan;
}
