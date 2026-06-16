import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import {
  SupplementAssemblyCorrectionMode,
  SupplementAssemblyDraftStatus,
  SupplementAssemblyPartSource,
  SupplementAssemblyPartUploadStatus,
} from '../enums/supplement-assembly.enums';
import { SupplementAssemblyVersion } from './supplement-assembly-version.entity';

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

  // wave-supplement-correction-workflow / DB-01 — correction-lineage
  // columns. Mirror main-plan precedent at `book-assembly-draft.entity.ts`
  // lines 36-51. All NULL-able so pre-existing Wave-A draft rows stay
  // unaffected (legacy active drafts are not correction drafts).
  //
  // BE-01 sets `targetVersion` to the in-progress integer version this
  // draft will become on merge (typically `latestVersion.versionNumber +
  // 1`). `previousVersionId` references the version being corrected,
  // and `correctionMode` / `correctionReason` describe HOW the
  // correction is being performed. The relation `previousVersion` is
  // registered at the TypeORM level only; the underlying FK is enforced
  // by the migration with `ON DELETE RESTRICT` to preserve audit.

  @Column({ name: 'target_version', type: 'int', nullable: true })
  targetVersion: number | null;

  @Column({ name: 'previous_version_id', type: 'uuid', nullable: true })
  previousVersionId: string | null;

  @Column({
    name: 'correction_mode',
    type: 'enum',
    enum: SupplementAssemblyCorrectionMode,
    enumName: 'supplement_assembly_correction_mode',
    nullable: true,
  })
  correctionMode: SupplementAssemblyCorrectionMode | null;

  @Column({ name: 'correction_reason', type: 'text', nullable: true })
  correctionReason: string | null;

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

  // wave-supplement-true-footer-pagenumber / DB-01 — per-SPG page map
  // produced by the page-tracking renderer at `generatePart3` and consumed
  // at `merge` to stamp the TRUE ผ.02 footer page onto SupplementProjectGroup
  // .pageNumber + the version-projects join. Key = SPG UUID, value = 1-based
  // PART3-RELATIVE page (== the printed footer; supplement Part 3 restarts at
  // 1 per §21.3.4). Nullable: manual-upload / legacy drafts have no map →
  // merge falls back to sequential i+1 (BE-02 staleness guard). Advisory
  // authoring artifact per §17.2 (UUID→int only, no PII; NOT a tracking_status
  // / ai_* row). synchronize:true adds the column in dev; prod needs a manual
  // `ALTER TABLE supplement_assembly_drafts ADD COLUMN part3_page_map jsonb`
  // (nullable → no backfill of existing rows required).
  @Column({ name: 'part3_page_map', type: 'jsonb', nullable: true })
  part3PageMap: Record<string, number> | null;

  // Creator — `created_by_id` is the canonical column. As of
  // wave-supplement-assembly-metadata-parity / BE-01 we also expose a
  // `@ManyToOne(WorkHistory)` relation on the same column so the draft
  // DTO can surface `createdBy.user.{prefix,firstName,lastName}` to the
  // FE. The class-doc note about "bare UUID, no FK at TypeORM level" is
  // superseded by this relation; the underlying SQL column is unchanged
  // and there is NO schema drift. Mirrors main-plan precedent.

  @Column({ name: 'created_by_id', type: 'uuid' })
  createdById: string;

  @ManyToOne(() => WorkHistory)
  @JoinColumn({ name: 'created_by_id' })
  createdBy: WorkHistory;

  // wave-supplement-correction-workflow / DB-01 — read-side relation for
  // the version being corrected. Reuses `previous_version_id` declared
  // above; no schema drift. Mirrors main-plan precedent at
  // `book-assembly-draft.entity.ts` lines 158-160.
  @ManyToOne(() => SupplementAssemblyVersion, { nullable: true })
  @JoinColumn({ name: 'previous_version_id' })
  previousVersion: SupplementAssemblyVersion | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
