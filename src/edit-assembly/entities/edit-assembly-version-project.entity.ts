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
 * EditAssemblyVersionProject — Wave A2 / DB-01.
 *
 * Page-map denormalization join. Mirror of
 * `main_assembly_version_projects` / `supplement_assembly_version_projects`
 * (Q1=C convention) for the EDIT_REVISION subsystem. Replaces the
 * inline JSONB `book_assembly_versions.part3_page_map`
 * (`{revisedProjectGroupId: pageNumber}`) with row-shaped data so
 * future queries can index / join on
 * `(version_id, revised_project_group_id, page_number)`.
 *
 * Q1=C convention preserved:
 *   - NO unique constraint on `(version_id, revised_project_group_id)`.
 *     The omission leaves room for Wave-B correction / deprecation joins
 *     on the same surface without a destructive migration.
 *   - NO `is_current_leaf` column. Leaf-state lookup lives in the
 *     separate `edit_project_lineage` table (mirrors the
 *     supplement-side `supplement_project_lineage` split).
 *
 * FK policy:
 *   - version_id → edit_assembly_versions.id ON DELETE CASCADE
 *     (rolling back / dropping a version drops its project assignments)
 *   - revised_project_group_id → revised_project_groups.id
 *     ON DELETE RESTRICT (cannot drop an RPG that participates in a
 *     published version — preserves audit / lineage)
 */
@Entity('edit_assembly_version_projects')
@Index('idx_eavp_version', ['versionId'])
@Index('idx_eavp_rpg', ['revisedProjectGroupId'])
export class EditAssemblyVersionProject {
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

  @ManyToOne(() => EditAssemblyVersion, {
    eager: false,
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'version_id' })
  version: EditAssemblyVersion;

  @ManyToOne(() => RevisedProjectGroup, {
    eager: false,
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'revised_project_group_id' })
  revisedProjectGroup: RevisedProjectGroup;
}
