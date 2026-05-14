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
 * SupplementAssemblyVersionProject — SUPP_STANDALONE_DB_01.
 *
 * Q1=C — Lightweight join (versionId, spgId, pageNumber). NO
 * `isCurrentLeaf` column, NO `UNIQUE(version_id, supplement_project_group_id)`
 * constraint. Both omissions are deliberate so that Wave B may introduce
 * correction / deprecation joins on the same surface without a destructive
 * migration.
 *
 * FK policy (per task §7):
 *   - version_id → supplement_assembly_versions.id ON DELETE CASCADE
 *     (rolling back / dropping a version drops its project assignments)
 *   - supplement_project_group_id → supplement_project_groups.id
 *     ON DELETE RESTRICT (cannot drop an SPG that participates in a
 *     published version — preserves audit / lineage)
 */
@Entity('supplement_assembly_version_projects')
@Index('idx_savp_version', ['versionId'])
@Index('idx_savp_spg', ['supplementProjectGroupId'])
export class SupplementAssemblyVersionProject {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'version_id', type: 'uuid' })
  versionId: string;

  @Column({ name: 'supplement_project_group_id', type: 'uuid' })
  supplementProjectGroupId: string;

  @Column({ name: 'page_number', type: 'int' })
  pageNumber: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  // Relations

  @ManyToOne(() => SupplementAssemblyVersion, {
    eager: false,
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'version_id' })
  version: SupplementAssemblyVersion;

  @ManyToOne(() => SupplementProjectGroup, {
    eager: false,
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'supplement_project_group_id' })
  supplementProjectGroup: SupplementProjectGroup;
}
