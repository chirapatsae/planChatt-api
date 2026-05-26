import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { MainAssemblyVersion } from './main-assembly-version.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';

/**
 * MainProjectLineage — Wave A1 / DB-01.
 *
 * Per-type segregated mirror of `book_project_lineage` for the
 * MAIN_PLAN domain. Tracks the current leaf status of every
 * ProjectGroup (PG) across all published `MainAssemblyVersion` rows.
 *
 * Q3=B (OPTION-A-FULL-SPLIT) — table lives in the main-assembly module
 * and intentionally DOES NOT share storage with `book_project_lineage`.
 * The split mirrors the supplement subsystem's segregated lineage
 * (`supplement_project_lineage`); when Wave A2 (EDIT) and A3 (CHANGE)
 * ship, each will get its own analogous lineage table.
 *
 * Differences from `book_project_lineage` (intentional):
 *
 *   - NO `project_type` enum column. Membership in this table is the
 *     type discriminator: every row is implicitly a PG.
 *
 *   - Column names use `main_assembly_version_id` /
 *     `parent_main_assembly_version_id` so cross-domain joins remain
 *     unambiguous.
 *
 * Partial unique index `idx_main_spl_one_leaf_per_pg` enforces "at most
 * one leaf row per PG" at the DB layer. Declared in migration only —
 * TypeORM has no partial-unique decorator.
 *
 * FK ON DELETE policy:
 *   - project_group_id → RESTRICT (PG with lineage rows MUST NOT be
 *     hard-deleted; lineage is the source of truth for leaf state)
 *   - main_assembly_version_id → RESTRICT (same rationale on the
 *     version side)
 *   - parent_main_assembly_version_id → SET NULL (matches main-plan
 *     precedent for parent links; preserves child lineage row for
 *     audit while clearing the dangling pointer)
 *
 * CLAUDE.md interaction:
 *   - §15 — additive table; no book-lineage invariant changes
 *   - §17.2 — advisory-only AI is unaffected (no AI table touches
 *     lineage)
 *   - §18 — orphan cleanup is unaffected (this table is read-only from
 *     the cascade's perspective)
 */
@Entity('main_project_lineage')
@Index('idx_main_spl_pg', ['projectGroupId'])
@Index('idx_main_spl_version', ['mainAssemblyVersionId'])
@Index('idx_main_spl_parent_version', ['parentMainAssemblyVersionId'])
export class MainProjectLineage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'project_group_id', type: 'uuid' })
  projectGroupId: string;

  @Column({ name: 'main_assembly_version_id', type: 'uuid' })
  mainAssemblyVersionId: string;

  @Column({
    name: 'parent_main_assembly_version_id',
    type: 'uuid',
    nullable: true,
  })
  parentMainAssemblyVersionId: string | null;

  @Column({ name: 'is_current_leaf', type: 'boolean', default: false })
  isCurrentLeaf: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  // Relations

  @ManyToOne(() => ProjectGroup, {
    eager: false,
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'project_group_id' })
  projectGroup: ProjectGroup;

  @ManyToOne(() => MainAssemblyVersion, {
    eager: false,
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'main_assembly_version_id' })
  mainAssemblyVersion: MainAssemblyVersion;

  @ManyToOne(() => MainAssemblyVersion, {
    eager: false,
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'parent_main_assembly_version_id' })
  parentMainAssemblyVersion: MainAssemblyVersion | null;
}
