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
import {
  AssemblyDraftStatus,
  BookAssemblySourceType,
  CorrectionMode,
  PartUploadStatus,
} from '../enums/book-assembly.enums';
import { BookAssemblyVersion } from './book-assembly-version.entity';

@Entity('book_assembly_drafts')
@Index('idx_draft_source', ['sourceType', 'sourceId'])
export class BookAssemblyDraft {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({
    name: 'source_type',
    type: 'enum',
    enum: BookAssemblySourceType,
  })
  sourceType: BookAssemblySourceType;

  @Column({ name: 'source_id', type: 'uuid' })
  sourceId: string;

  @Column({ name: 'target_version', type: 'int' })
  targetVersion: number;

  @Column({ name: 'previous_version_id', type: 'uuid', nullable: true })
  previousVersionId: string | null;

  @Column({
    name: 'correction_mode',
    type: 'enum',
    enum: CorrectionMode,
    nullable: true,
  })
  correctionMode: CorrectionMode | null;

  @Column({ name: 'correction_reason', type: 'text', nullable: true })
  correctionReason: string | null;

  // Part 1

  @Column({
    name: 'part1_status',
    type: 'enum',
    enum: PartUploadStatus,
    default: PartUploadStatus.PENDING,
  })
  part1Status: PartUploadStatus;

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
    enum: PartUploadStatus,
    default: PartUploadStatus.PENDING,
  })
  part2Status: PartUploadStatus;

  // Fix V1: exclude internal filesystem paths from API responses
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
    enum: PartUploadStatus,
    default: PartUploadStatus.PENDING,
  })
  part3Status: PartUploadStatus;

  // Fix V1: exclude internal filesystem paths from API responses
  @Exclude()
  @Column({ name: 'part3_file_path', type: 'varchar', nullable: true })
  part3FilePath: string | null;

  @Column({ name: 'part3_generated_at', type: 'timestamp', nullable: true })
  part3GeneratedAt: Date | null;

  @Column({ name: 'part3_project_snapshot', type: 'jsonb', nullable: true })
  part3ProjectSnapshot: string[] | null;

  // Fix D2: persist pageMap so merge() can assign pageNumber to each project
  @Column({ name: 'part3_page_map', type: 'jsonb', nullable: true })
  part3PageMap: Record<string, number> | null;

  // Assembly status

  @Column({
    name: 'assembly_status',
    type: 'enum',
    enum: AssemblyDraftStatus,
    default: AssemblyDraftStatus.PREPARING,
  })
  assemblyStatus: AssemblyDraftStatus;

  @Column({ name: 'created_by_id' })
  createdById: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  // Relations

  @ManyToOne(() => WorkHistory)
  @JoinColumn({ name: 'created_by_id' })
  createdBy: WorkHistory;

  @ManyToOne(() => BookAssemblyVersion, { nullable: true })
  @JoinColumn({ name: 'previous_version_id' })
  previousVersion: BookAssemblyVersion | null;

  @ManyToOne(() => WorkHistory, { nullable: true })
  @JoinColumn({ name: 'part1_uploaded_by_id' })
  part1UploadedBy: WorkHistory | null;

  @ManyToOne(() => WorkHistory, { nullable: true })
  @JoinColumn({ name: 'part2_uploaded_by_id' })
  part2UploadedBy: WorkHistory | null;
}
