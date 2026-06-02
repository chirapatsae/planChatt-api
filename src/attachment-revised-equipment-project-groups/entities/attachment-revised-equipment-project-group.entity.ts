import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  DeleteDateColumn,
} from 'typeorm';
import { RevisedEquipmentProjectGroup } from 'src/revised-equipment-project-group/entities/revised-equipment-project-group.entity';

/**
 * Wave Equipment Revision Management — attachment support for RELPG.
 *
 * Structural clone of `AttachmentRevisedProjectGroup` (the RPG attachment
 * entity). Backs the `/v1/attachment-revised-equipment-project-groups`
 * surface so the equipment revision wizard can attach files, mirroring the
 * project revision attachment flow.
 *
 * # Deliberate divergence from the RPG attachment entity
 * The AI-analysis metadata columns (`ai_topic` / `ai_summary` / ...) are
 * retained for STRUCTURAL parity with the PG / RPG / SPG attachment tables
 * (so ops/backup tooling treats all attachment tables uniformly), but the
 * equipment attachment service does NOT trigger `DocumentAnalysisService`:
 * the `DocumentAnalysisService.AttachmentKind` union is closed and does not
 * include an equipment kind. Equipment AI document-analysis is out of scope
 * for this wave (Phase 3 deferred AI scoring for equipment per §5.3); these
 * columns remain null. They can be wired to the analysis pipeline later by
 * widening the `AttachmentKind` union without a schema change.
 */
@Entity('attachment_revised_equipment_project_groups')
export class AttachmentRevisedEquipmentProjectGroup {
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

  @ManyToOne(() => RevisedEquipmentProjectGroup, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'revised_equipment_project_group_id' })
  revisedEquipmentProjectGroup: RevisedEquipmentProjectGroup;

  // --- AI analysis metadata (structural parity with PG / RPG / SPG). ----------
  // Currently always null on equipment — DocumentAnalysisService is not
  // wired for the equipment kind (see entity-level note above). Kept for
  // forward-compat and uniform table shape across attachment surfaces.
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
