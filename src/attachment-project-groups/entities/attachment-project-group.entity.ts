import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  DeleteDateColumn,
} from 'typeorm';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';

@Entity('attachment_project_groups')
export class AttachmentProjectGroup {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  filename: string;

  @Column()
  originalName: string;

  @Column()
  mimetype: string;

  @Column()
  size: number;

  @Column()
  path: string;

  @ManyToOne(() => ProjectGroup, (projectGroup) => projectGroup.attachments, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'project_group_id' })
  projectGroup: ProjectGroup;

  // --- AI analysis metadata (see migration 1744934400000). -------------------
  // Populated asynchronously by DocumentAnalysisService after upload; never
  // user-editable. §14 lineage lock does not apply: these columns are
  // internal derived metadata, not user-driven project mutation.
  @Column({ name: 'ai_topic', type: 'varchar', length: 100, nullable: true })
  aiTopic?: string | null;

  @Column({ name: 'ai_summary', type: 'varchar', length: 800, nullable: true })
  aiSummary?: string | null;

  @Column({ name: 'ai_doc_type', type: 'varchar', length: 32, nullable: true })
  aiDocType?: string | null;

  @Column({
    name: 'ai_status',
    type: 'varchar',
    length: 16,
    default: 'pending',
    nullable: true,
  })
  aiStatus?: string | null;

  @Column({ name: 'ai_processed_at', type: 'timestamp', nullable: true })
  aiProcessedAt?: Date | null;

  @Column({ name: 'ai_model', type: 'varchar', length: 32, nullable: true })
  aiModel?: string | null;

  // Phase 4 §T1: deterministic 0.000–1.000 extraction-quality score.
  // Persisted on both success and failure paths so staff can diagnose
  // whether a row was rejected by the OCR hard-guard (LOW_EXTRACTION_QUALITY)
  // vs the AI output validator (LOW_AI_QUALITY). Null for pre-Phase-4 rows.
  // TypeORM maps PG NUMERIC → string; the service layer is responsible for
  // Number() coercion on write and parseFloat on read when arithmetic is needed.
  @Column({
    name: 'ai_extraction_quality_score',
    type: 'numeric',
    precision: 4,
    scale: 3,
    nullable: true,
    transformer: {
      to: (v?: number | null) => (v == null ? null : v),
      from: (v?: string | number | null) =>
        v == null ? null : typeof v === 'string' ? parseFloat(v) : v,
    },
  })
  aiExtractionQualityScore?: number | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @DeleteDateColumn({ name: 'deleted_at', nullable: true })
  deletedAt?: Date;
}
