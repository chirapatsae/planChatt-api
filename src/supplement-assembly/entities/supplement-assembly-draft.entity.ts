import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import {
  SupplementAssemblyDraftStatus,
  SupplementAssemblyPartSource,
  SupplementAssemblyPartUploadStatus,
} from '../enums/supplement-assembly.enums';

/**
 * SupplementAssemblyDraft — SUPP_STANDALONE_DB_01.
 *
 * Standalone supplement-assembly draft row (in-progress Part1 → Part2 →
 * Part3 → finalize workflow). Dedicated table; NOT shared with
 * `book_assembly_drafts`. Per CLAUDE.md §15 / §18.2.1 the finalize path
 * runs the §18 orphan cascade BEFORE flipping `isBooked = true` — this
 * row participates only as the in-flight authoring scratch state.
 *
 * Design notes:
 *  - `developmentPlanSupplementId` is a bare UUID + `@JoinColumn` is
 *    NOT used. The relation is intentionally NOT declared at the
 *    TypeORM level to avoid pulling `DevelopmentPlanSupplement` (and
 *    its OneToMany of SPGs) into every load. Equivalent of how
 *    BookAssembly carries `sourceId` as bare uuid.
 *  - `createdById` is bare UUID (no FK at the TypeORM level) — matches
 *    BookAssembly precedent and the §7 BookAssembly pattern for
 *    migration-safety.
 *  - The partial unique index `uniq_sad_active_draft` (declared in the
 *    migration; PG-specific partial UNIQUE is not expressible via
 *    `@Unique` decorator) enforces "at most one active draft per
 *    supplement" where `assembly_status IN ('preparing','ready')`.
 *
 * Wave A.5 — column / property names aligned with the `book_assembly_*`
 * analog:
 *   status → assembly_status (assemblyStatus)
 *   part{n}_upload_status → part{n}_status (part{n}Status)
 *   part{n}_filename → part{n}_original_file_name (part{n}OriginalFileName)
 *   part3_uploaded_at → part3_generated_at (part3GeneratedAt)
 *   created_by_work_history_id → created_by_id (createdById)
 */
@Entity('supplement_assembly_drafts')
@Index('idx_sad_supplement', ['developmentPlanSupplementId'])
export class SupplementAssemblyDraft {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({
    name: 'development_plan_supplement_id',
    type: 'uuid',
  })
  developmentPlanSupplementId: string;

  @Column({
    name: 'assembly_status',
    type: 'enum',
    enum: SupplementAssemblyDraftStatus,
    enumName: 'supplement_assembly_draft_status',
    default: SupplementAssemblyDraftStatus.PREPARING,
  })
  assemblyStatus: SupplementAssemblyDraftStatus;

  // Part 1

  @Column({
    name: 'part1_status',
    type: 'enum',
    enum: SupplementAssemblyPartUploadStatus,
    enumName: 'supplement_assembly_part_upload_status',
    default: SupplementAssemblyPartUploadStatus.PENDING,
  })
  part1Status: SupplementAssemblyPartUploadStatus;

  @Column({
    name: 'part1_source',
    type: 'enum',
    enum: SupplementAssemblyPartSource,
    enumName: 'supplement_assembly_part_source',
    nullable: true,
  })
  part1Source: SupplementAssemblyPartSource | null;

  @Column({ name: 'part1_original_file_name', type: 'text', nullable: true })
  part1OriginalFileName: string | null;

  @Column({
    name: 'part1_uploaded_at',
    type: 'timestamptz',
    nullable: true,
  })
  part1UploadedAt: Date | null;

  // Part 2

  @Column({
    name: 'part2_status',
    type: 'enum',
    enum: SupplementAssemblyPartUploadStatus,
    enumName: 'supplement_assembly_part_upload_status',
    default: SupplementAssemblyPartUploadStatus.PENDING,
  })
  part2Status: SupplementAssemblyPartUploadStatus;

  @Column({
    name: 'part2_source',
    type: 'enum',
    enum: SupplementAssemblyPartSource,
    enumName: 'supplement_assembly_part_source',
    nullable: true,
  })
  part2Source: SupplementAssemblyPartSource | null;

  @Column({ name: 'part2_original_file_name', type: 'text', nullable: true })
  part2OriginalFileName: string | null;

  @Column({
    name: 'part2_uploaded_at',
    type: 'timestamptz',
    nullable: true,
  })
  part2UploadedAt: Date | null;

  // Part 3

  @Column({
    name: 'part3_status',
    type: 'enum',
    enum: SupplementAssemblyPartUploadStatus,
    enumName: 'supplement_assembly_part_upload_status',
    default: SupplementAssemblyPartUploadStatus.PENDING,
  })
  part3Status: SupplementAssemblyPartUploadStatus;

  @Column({
    name: 'part3_source',
    type: 'enum',
    enum: SupplementAssemblyPartSource,
    enumName: 'supplement_assembly_part_source',
    nullable: true,
  })
  part3Source: SupplementAssemblyPartSource | null;

  @Column({ name: 'part3_original_file_name', type: 'text', nullable: true })
  part3OriginalFileName: string | null;

  @Column({
    name: 'part3_generated_at',
    type: 'timestamptz',
    nullable: true,
  })
  part3GeneratedAt: Date | null;

  // Creator (bare uuid — no FK at TypeORM level; see class doc).

  @Column({ name: 'created_by_id', type: 'uuid' })
  createdById: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
