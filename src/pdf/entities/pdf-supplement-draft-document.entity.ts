import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { DevelopmentPlanSupplement } from 'src/development-plan-supplement/entities/development-plan-supplement.entity';
import { User } from 'src/users/entities/user.entity';

/**
 * PdfSupplementDraftDocument — SUPP_PRINT_DB_01.
 *
 * Persists generated supplement PDFs in the DRAFT variant (Q2 = default
 * flavor only). Mirrors the shape of `PdfRevisionEditDraftDocument`
 * byte-for-byte; only the parent-book FK differs.
 *
 * The parent book is `development_plan_supplement` (singular table name,
 * SPG aggregation root) instead of `development_plan_revision`. All other
 * columns, indexes, and cascade rules match the revision analog so that
 * `PdfService` can route to draft/approved supplement variants with the
 * same repository pattern it already uses for revision drafts.
 *
 * CLAUDE.md compliance:
 *   - §12 audit — this table is read-write file metadata; it NEVER
 *     mutates `tracking_status`. PDF finalize is NOT a workflow
 *     transition event.
 *   - §17 audit separation — `createdBy` is a WorkHistory-adjacent FK
 *     (via `users.id`) only; no person-level PII columns. Matches the
 *     analog entity exactly.
 *   - §15 / §18 — finalize / cancel cascades are handled at the service
 *     layer (SUPP_PRINT_BE_01); this entity merely persists the file
 *     row. ON DELETE CASCADE on `development_plan_supplement_id`
 *     guarantees the row disappears when the parent supplement is
 *     hard-removed.
 */
@Entity('pdf_supplement_draft_documents')
export class PdfSupplementDraftDocument {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'development_plan_supplement_id' })
  developmentPlanSupplementId: string;

  @Column({ name: 'version' })
  version: number;

  @Column({ name: 'file_path' })
  filePath: string;

  @Column({ name: 'project_ids_snapshot', type: 'jsonb' })
  projectIdsSnapshot: Array<string | number>;

  @Column({ name: 'project_count' })
  projectCount: number;

  @Column({ name: 'created_by_id' })
  createdById: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  // Relations
  @ManyToOne(() => DevelopmentPlanSupplement, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'development_plan_supplement_id' })
  developmentPlanSupplement: DevelopmentPlanSupplement;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'created_by_id' })
  createdBy: User;
}
