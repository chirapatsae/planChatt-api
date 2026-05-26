import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { EditAssemblyVersion } from './edit-assembly-version.entity';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';

/**
 * EditProjectLineage — Wave A2 / DB-01.
 *
 * Per-type segregated mirror of `book_project_lineage` for the
 * EDIT_REVISION domain. Tracks the current leaf status of every
 * RevisedProjectGroup (RPG) across all published `EditAssemblyVersion`
 * rows whose source is an EDIT revision book.
 *
 * Q3=B (OPTION-A-FULL-SPLIT) — table lives in the edit-assembly module
 * and intentionally DOES NOT share storage with `book_project_lineage`,
 * `main_project_lineage`, or `supplement_project_lineage`. The split
 * mirrors the supplement subsystem's segregated lineage
 * (`supplement_project_lineage`); when Wave A3 (CHANGE) ships, it will
 * get its own analogous `change_project_lineage` table.
 *
 * Differences from `book_project_lineage` (intentional):
 *
 *   - NO `project_type` enum column. Membership in this table is the
 *     type discriminator: every row is implicitly an RPG.
 *
 *   - Column name `revised_project_group_id` reflects the actual entity
 *     type (RPG, not PG). Mirrors the supplement-side
 *     `supplement_project_lineage.supplement_project_group_id` naming
 *     convention. NOT `project_group_id` like MAIN's lineage table.
 *
 *   - Column names use `edit_assembly_version_id` /
 *     `parent_edit_assembly_version_id` so cross-domain joins remain
 *     unambiguous.
 *
 * Partial unique index `idx_edit_spl_one_leaf_per_rpg` enforces "at most
 * one leaf row per RPG" at the DB layer. Declared in migration only —
 * TypeORM has no partial-unique decorator.
 *
 * FK ON DELETE policy:
 *   - revised_project_group_id → RESTRICT (RPG with lineage rows MUST
 *     NOT be hard-deleted; lineage is the source of truth for leaf state)
 *   - edit_assembly_version_id → RESTRICT (same rationale on the
 *     version side)
 *   - parent_edit_assembly_version_id → SET NULL (matches main-plan /
 *     supplement precedent for parent links; preserves child lineage
 *     row for audit while clearing the dangling pointer)
 *
 * CLAUDE.md interaction:
 *   - §15 — additive table; no book-lineage invariant changes
 *   - §17.2 — advisory-only AI is unaffected (no AI table touches
 *     lineage)
 *   - §18 — orphan cleanup is unaffected (this table is read-only from
 *     the cascade's perspective)
 */
@Entity('edit_project_lineage')
@Index('idx_edit_spl_rpg', ['revisedProjectGroupId'])
@Index('idx_edit_spl_version', ['editAssemblyVersionId'])
@Index('idx_edit_spl_parent_version', ['parentEditAssemblyVersionId'])
export class EditProjectLineage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'revised_project_group_id', type: 'uuid' })
  revisedProjectGroupId: string;

  @Column({ name: 'edit_assembly_version_id', type: 'uuid' })
  editAssemblyVersionId: string;

  @Column({
    name: 'parent_edit_assembly_version_id',
    type: 'uuid',
    nullable: true,
  })
  parentEditAssemblyVersionId: string | null;

  @Column({ name: 'is_current_leaf', type: 'boolean', default: false })
  isCurrentLeaf: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  // Relations

  @ManyToOne(() => RevisedProjectGroup, {
    eager: false,
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'revised_project_group_id' })
  revisedProjectGroup: RevisedProjectGroup;

  @ManyToOne(() => EditAssemblyVersion, {
    eager: false,
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'edit_assembly_version_id' })
  editAssemblyVersion: EditAssemblyVersion;

  @ManyToOne(() => EditAssemblyVersion, {
    eager: false,
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'parent_edit_assembly_version_id' })
  parentEditAssemblyVersion: EditAssemblyVersion | null;
}
