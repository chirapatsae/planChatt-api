import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { ChangeAssemblyVersion } from './change-assembly-version.entity';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';

/**
 * ChangeProjectLineage — Wave A3 / DB-01.
 *
 * Per-type segregated mirror of `book_project_lineage` for the
 * CHANGE_REVISION domain. Tracks the current leaf status of every
 * RevisedProjectGroup (RPG) across all published `ChangeAssemblyVersion`
 * rows whose source is a CHANGE revision book.
 *
 * Q3=B (OPTION-A-FULL-SPLIT) — table lives in the change-assembly module
 * and intentionally DOES NOT share storage with `book_project_lineage`,
 * `main_project_lineage`, `edit_project_lineage`, or
 * `supplement_project_lineage`. The split mirrors the supplement
 * subsystem's segregated lineage (`supplement_project_lineage`) and
 * Wave A2's EDIT analog (`edit_project_lineage`).
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
 *   - Column names use `change_assembly_version_id` /
 *     `parent_change_assembly_version_id` so cross-domain joins remain
 *     unambiguous.
 *
 * Partial unique index `idx_change_spl_one_leaf_per_rpg` enforces "at
 * most one leaf row per RPG" at the DB layer. Declared in migration only
 * — TypeORM has no partial-unique decorator.
 *
 * FK ON DELETE policy:
 *   - revised_project_group_id → RESTRICT (RPG with lineage rows MUST
 *     NOT be hard-deleted; lineage is the source of truth for leaf state)
 *   - change_assembly_version_id → RESTRICT (same rationale on the
 *     version side)
 *   - parent_change_assembly_version_id → SET NULL (matches main-plan /
 *     edit / supplement precedent for parent links; preserves child
 *     lineage row for audit while clearing the dangling pointer)
 *
 * CLAUDE.md interaction:
 *   - §15 — additive table; no book-lineage invariant changes
 *   - §17.2 — advisory-only AI is unaffected (no AI table touches
 *     lineage)
 *   - §18 — orphan cleanup is unaffected (this table is read-only from
 *     the cascade's perspective)
 */
@Entity('change_project_lineage')
@Index('idx_change_spl_rpg', ['revisedProjectGroupId'])
@Index('idx_change_spl_version', ['changeAssemblyVersionId'])
@Index('idx_change_spl_parent_version', ['parentChangeAssemblyVersionId'])
export class ChangeProjectLineage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'revised_project_group_id', type: 'uuid' })
  revisedProjectGroupId: string;

  @Column({ name: 'change_assembly_version_id', type: 'uuid' })
  changeAssemblyVersionId: string;

  @Column({
    name: 'parent_change_assembly_version_id',
    type: 'uuid',
    nullable: true,
  })
  parentChangeAssemblyVersionId: string | null;

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

  @ManyToOne(() => ChangeAssemblyVersion, {
    eager: false,
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'change_assembly_version_id' })
  changeAssemblyVersion: ChangeAssemblyVersion;

  @ManyToOne(() => ChangeAssemblyVersion, {
    eager: false,
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'parent_change_assembly_version_id' })
  parentChangeAssemblyVersion: ChangeAssemblyVersion | null;
}
