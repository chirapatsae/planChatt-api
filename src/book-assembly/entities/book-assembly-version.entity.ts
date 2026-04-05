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
  BookAssemblySourceType,
  BookAssemblyVersionStatus,
  CorrectionMode,
  PartSource,
} from '../enums/book-assembly.enums';

@Entity('book_assembly_versions')
@Index('idx_version_source', ['sourceType', 'sourceId'])
@Index('idx_version_source_number', ['sourceType', 'sourceId', 'versionNumber'], {
  unique: true,
})
@Index('idx_version_status', ['status'])
export class BookAssemblyVersion {
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

  @Column({ name: 'version_number', type: 'int' })
  versionNumber: number;

  @Column({
    name: 'status',
    type: 'enum',
    enum: BookAssemblyVersionStatus,
    default: BookAssemblyVersionStatus.COMPLETED,
  })
  status: BookAssemblyVersionStatus;

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

  // Fix V1: exclude internal filesystem paths from API responses
  @Exclude()
  @Column({ name: 'part1_file_path', type: 'varchar' })
  part1FilePath: string;

  @Column({
    name: 'part1_source',
    type: 'enum',
    enum: PartSource,
  })
  part1Source: PartSource;

  @Column({ name: 'part1_original_file_name', type: 'varchar', nullable: true })
  part1OriginalFileName: string | null;

  // Part 2

  // Fix V1: exclude internal filesystem paths from API responses
  @Exclude()
  @Column({ name: 'part2_file_path', type: 'varchar' })
  part2FilePath: string;

  @Column({
    name: 'part2_source',
    type: 'enum',
    enum: PartSource,
  })
  part2Source: PartSource;

  @Column({ name: 'part2_original_file_name', type: 'varchar', nullable: true })
  part2OriginalFileName: string | null;

  // Part 3

  // Fix V1: exclude internal filesystem paths from API responses
  @Exclude()
  @Column({ name: 'part3_file_path', type: 'varchar' })
  part3FilePath: string;

  @Column({
    name: 'part3_source',
    type: 'enum',
    enum: PartSource,
  })
  part3Source: PartSource;

  @Column({ name: 'part3_project_snapshot', type: 'jsonb' })
  part3ProjectSnapshot: string[];

  @Column({ name: 'part3_project_count', type: 'int' })
  part3ProjectCount: number;

  // Fix D2: persist pageMap on version so reused Part 3 carries page assignments
  @Column({ name: 'part3_page_map', type: 'jsonb', nullable: true })
  part3PageMap: Record<string, number> | null;

  // Merged output

  // Fix V1: exclude internal filesystem paths from API responses
  @Exclude()
  @Column({ name: 'merged_file_path', type: 'varchar' })
  mergedFilePath: string;

  @Column({ name: 'merged_at', type: 'timestamp' })
  mergedAt: Date;

  @Column({ name: 'total_pages', type: 'int', nullable: true })
  totalPages: number | null;

  // Creator

  @Column({ name: 'created_by_id' })
  createdById: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  // Deprecation

  @Column({ name: 'deprecated_at', type: 'timestamp', nullable: true })
  deprecatedAt: Date | null;

  @Column({ name: 'deprecated_by_id', type: 'uuid', nullable: true })
  deprecatedById: string | null;

  @Column({ name: 'deprecation_reason', type: 'text', nullable: true })
  deprecationReason: string | null;

  // Relations

  @ManyToOne(() => WorkHistory)
  @JoinColumn({ name: 'created_by_id' })
  createdBy: WorkHistory;

  @ManyToOne(() => WorkHistory, { nullable: true })
  @JoinColumn({ name: 'deprecated_by_id' })
  deprecatedBy: WorkHistory | null;
}
