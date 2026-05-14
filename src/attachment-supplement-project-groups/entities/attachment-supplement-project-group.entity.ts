import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  DeleteDateColumn,
} from 'typeorm';
import { SupplementProjectGroup } from 'src/supplement-project-group/entities/supplement-project-group.entity';

/**
 * SUPP-3 / BE-07 — Attachment row for `SupplementProjectGroup`.
 *
 * Mirrors `AttachmentProjectGroup` and `AttachmentRevisedProjectGroup`
 * column-for-column so the PG / RPG / SPG attachment surfaces stay in
 * structural lockstep. The split into a dedicated table follows the
 * user-confirmed default (new table — clean FK, no polymorphic JOIN).
 *
 * §12 audit interaction: this table is INTERNAL derived metadata for the
 * SPG it attaches to. It does NOT participate in `TrackingStatus` and
 * does NOT contribute to lineage detection (§14). The FK uses
 * `ON DELETE RESTRICT` so a soft-deleted SPG does not cascade-drop its
 * attachments — preserving the audit trail per CLAUDE.md §12.
 *
 * §17.4 AI baseline `content_hash` reads the attachments digest list for
 * an SPG via the existing PreSubmitSnapshot pipeline. Adding rows here
 * therefore changes the snapshot's input; the snapshot itself is
 * `snapshot-only` (§17.4) and never auto-recomputes (§17.5).
 *
 * AI document-analysis columns (`ai_*`, `ai_extraction_quality_score`)
 * are included on parity with PG / RPG for forward-compat. They remain
 * `null` until `DocumentAnalysisService` gains an SPG `kind`
 * (deferred — see `TODO(SUPP-3-later)` in the service).
 */
@Entity('attachment_supplement_project_groups')
export class AttachmentSupplementProjectGroup {
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

  @ManyToOne(
    () => SupplementProjectGroup,
    (spg) => spg.attachments,
    {
      // §12 audit preservation: do NOT cascade hard-delete on SPG removal.
      // SPG cleanup is soft-delete + tombstone audit row (workflow §16);
      // attachments outlive the soft-deleted SPG for forensic review.
      onDelete: 'RESTRICT',
      onUpdate: 'CASCADE',
    },
  )
  @JoinColumn({ name: 'supplement_project_group_id' })
  supplementProjectGroup: SupplementProjectGroup;

  // --- AI analysis metadata (parity with PG / RPG attachment tables). -------
  // Populated asynchronously by `DocumentAnalysisService` once the SPG
  // `kind` is added. Never user-editable. §14 lineage lock does not
  // apply: these columns are internal derived metadata, not user-driven
  // project mutation.
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

  // Deterministic 0.000–1.000 extraction-quality score (parity with PG/RPG).
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
