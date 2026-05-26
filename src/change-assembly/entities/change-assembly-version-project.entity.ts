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
 * ChangeAssemblyVersionProject — Wave A3 / DB-01.
 *
 * Page-map denormalization join. Mirror of
 * `main_assembly_version_projects` / `edit_assembly_version_projects` /
 * `supplement_assembly_version_projects` (Q1=C convention) for the
 * CHANGE_REVISION subsystem. Replaces the inline JSONB
 * `book_assembly_versions.part3_page_map`
 * (`{revisedProjectGroupId: pageNumber}`) with row-shaped data so
 * future queries can index / join on
 * `(version_id, revised_project_group_id, page_number)`.
 *
 * Q1=C convention preserved:
 *   - NO unique constraint on `(version_id, revised_project_group_id)`.
 *     The omission leaves room for Wave-B correction / deprecation joins
 *     on the same surface without a destructive migration.
 *   - NO `is_current_leaf` column. Leaf-state lookup lives in the
 *     separate `change_project_lineage` table (mirrors the
 *     supplement-side `supplement_project_lineage` split).
 *
 * FK policy:
 *   - version_id → change_assembly_versions.id ON DELETE CASCADE
 *     (rolling back / dropping a version drops its project assignments)
 *   - revised_project_group_id → revised_project_groups.id
 *     ON DELETE RESTRICT (cannot drop an RPG that participates in a
 *     published version — preserves audit / lineage)
 */
@Entity('change_assembly_version_projects')
@Index('idx_cavp_version', ['versionId'])
@Index('idx_cavp_rpg', ['revisedProjectGroupId'])
export class ChangeAssemblyVersionProject {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'version_id', type: 'uuid' })
  versionId: string;

  @Column({ name: 'revised_project_group_id', type: 'uuid' })
  revisedProjectGroupId: string;

  @Column({ name: 'page_number', type: 'int' })
  pageNumber: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  // Relations

  @ManyToOne(() => ChangeAssemblyVersion, {
    eager: false,
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'version_id' })
  version: ChangeAssemblyVersion;

  @ManyToOne(() => RevisedProjectGroup, {
    eager: false,
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'revised_project_group_id' })
  revisedProjectGroup: RevisedProjectGroup;
}
