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
 * MainAssemblyVersionProject — Wave A1 / DB-01.
 *
 * Page-map denormalization join. Mirror of
 * `supplement_assembly_version_projects` (Q1=C convention) for the
 * MAIN_PLAN subsystem. Replaces the inline JSONB
 * `book_assembly_versions.part3_page_map` (`{projectId: pageNumber}`)
 * with row-shaped data so future queries can index / join on
 * `(version_id, project_group_id, page_number)`.
 *
 * Q1=C convention preserved:
 *   - NO unique constraint on `(version_id, project_group_id)`. The
 *     omission leaves room for Wave-B correction / deprecation joins
 *     on the same surface without a destructive migration.
 *   - NO `is_current_leaf` column. Leaf-state lookup lives in the
 *     separate `main_project_lineage` table (mirrors the
 *     supplement-side `supplement_project_lineage` split).
 *
 * FK policy:
 *   - version_id → main_assembly_versions.id ON DELETE CASCADE
 *     (rolling back / dropping a version drops its project assignments)
 *   - project_group_id → project_groups.id ON DELETE RESTRICT
 *     (cannot drop a PG that participates in a published version —
 *     preserves audit / lineage)
 */
@Entity('main_assembly_version_projects')
@Index('idx_mavp_version', ['versionId'])
@Index('idx_mavp_pg', ['projectGroupId'])
export class MainAssemblyVersionProject {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'version_id', type: 'uuid' })
  versionId: string;

  @Column({ name: 'project_group_id', type: 'uuid' })
  projectGroupId: string;

  @Column({ name: 'page_number', type: 'int' })
  pageNumber: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  // Relations

  @ManyToOne(() => MainAssemblyVersion, {
    eager: false,
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'version_id' })
  version: MainAssemblyVersion;

  @ManyToOne(() => ProjectGroup, {
    eager: false,
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'project_group_id' })
  projectGroup: ProjectGroup;
}
