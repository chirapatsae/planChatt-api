import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { SupplementAssemblyVersion } from './supplement-assembly-version.entity';
import { SupplementProjectGroup } from 'src/supplement-project-group/entities/supplement-project-group.entity';

/**
 * SupplementProjectLineage — wave-supplement-convergence-milestone-5
 * (CTO M4 decision: Option B — dual segregated DAG).
 *
 * Per-type segregated mirror of `book_project_lineage` for the
 * supplement-book domain. Tracks the current leaf status of every
 * SupplementProjectGroup (SPG) across all published
 * SupplementAssemblyVersion rows.
 *
 * Q3=B (PLAN.md / SUPP_STANDALONE) — this table lives in the
 * supplement-assembly module and intentionally DOES NOT share storage
 * with `book_project_lineage`. The two lineage tables form the
 * "dual segregated DAG":
 *
 *   book_project_lineage         → PG / RPG ↔ BookAssemblyVersion
 *   supplement_project_lineage   → SPG       ↔ SupplementAssemblyVersion
 *
 * Differences from `book_project_lineage` (intentional):
 *
 *   - NO `project_type` enum column. Membership in this table is the
 *     type discriminator: every row is implicitly an SPG. The supplement
 *     subsystem is single-type by design (SPG only); mixing PG / RPG in
 *     here would re-introduce the §15 / §18 cross-coupling that the
 *     segregated DAG decision was made to avoid.
 *
 *   - Column names mirror the main-plan precedent verbatim (snake_case
 *     via explicit `name:` overrides) — see `book-project-lineage.entity.ts`
 *     lines 45-66 for the canonical naming convention.
 *
 * Partial unique index `idx_spl_one_leaf_per_spg` enforces "at most one
 * leaf row per SPG" at the DB layer. TypeORM has no decorator for partial
 * unique indexes, so the index is declared in the migration only —
 * mirrors the main-plan precedent at
 * `1744416000000-AddBookProjectLineageAndPlanFrozen.ts:118-122`.
 *
 * FK ON DELETE policy:
 *   - supplement_project_group_id → RESTRICT
 *     (an SPG with lineage rows must not be hard-deleted — lineage is
 *     the source of truth for leaf state)
 *   - supplement_assembly_version_id → RESTRICT
 *     (a version with lineage rows must not be hard-deleted — see above)
 *   - parent_supplement_assembly_version_id → SET NULL
 *     (matches main-plan precedent for parent links; preserves the child
 *     lineage row for audit while clearing the dangling pointer)
 *
 * CLAUDE.md interaction:
 *   - §15 — additive table; no book-lineage invariant changes
 *   - §17.2 — advisory-only AI is unaffected (no AI table touches lineage)
 *   - §18 — orphan cleanup is unaffected (this table is read-only from
 *     the cascade's perspective; the existing §18.4.2 SPG soft-delete
 *     path simply leaves these rows in place)
 */
@Entity('supplement_project_lineage')
@Index('idx_spl_spg', ['supplementProjectGroupId'])
@Index('idx_spl_version', ['supplementAssemblyVersionId'])
@Index('idx_spl_parent_version', ['parentSupplementAssemblyVersionId'])
export class SupplementProjectLineage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'supplement_project_group_id', type: 'uuid' })
  supplementProjectGroupId: string;

  @Column({ name: 'supplement_assembly_version_id', type: 'uuid' })
  supplementAssemblyVersionId: string;

  @Column({
    name: 'parent_supplement_assembly_version_id',
    type: 'uuid',
    nullable: true,
  })
  parentSupplementAssemblyVersionId: string | null;

  @Column({ name: 'is_current_leaf', type: 'boolean', default: false })
  isCurrentLeaf: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  // Relations

  @ManyToOne(() => SupplementProjectGroup, {
    eager: false,
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'supplement_project_group_id' })
  supplementProjectGroup: SupplementProjectGroup;

  @ManyToOne(() => SupplementAssemblyVersion, {
    eager: false,
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'supplement_assembly_version_id' })
  supplementAssemblyVersion: SupplementAssemblyVersion;

  @ManyToOne(() => SupplementAssemblyVersion, {
    eager: false,
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'parent_supplement_assembly_version_id' })
  parentSupplementAssemblyVersion: SupplementAssemblyVersion | null;
}
