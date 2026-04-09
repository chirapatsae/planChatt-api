import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { BookAssemblyVersion } from './book-assembly-version.entity';
import { BookProjectType } from '../enums/book-assembly.enums';

/**
 * BookProjectLineage
 *
 * Tracks the current leaf status of every project across all published book
 * versions. Each row records the assignment of a single project to a single
 * BookAssemblyVersion, together with an optional parent-version back-link.
 *
 * This table is the O(1) lookup mechanism for:
 *   - Rollback guard (Rule 4): only the latest leaf may be rolled back
 *   - Correction guard (Rule 5): correction blocked when child dependency exists
 *   - Single-effective-book exclusivity (Rule 2): a project must not appear in
 *     two simultaneously active revision books
 *
 * The `isCurrentLeaf` flag on a row is TRUE when this record represents the
 * most recent published book that includes this project. A partial unique index
 * enforces that at most one row per (projectId, projectType) may have
 * isCurrentLeaf = true. That index is declared in the migration only — it
 * cannot be expressed as a TypeORM decorator because TypeORM does not support
 * partial unique indexes via @Unique.
 *
 * parentBookVersionId is NULL only for the first appearance of a project in a
 * main_plan book. For all revision books it points to the BookAssemblyVersion
 * that previously held this project as its leaf.
 */
@Entity('book_project_lineage')
@Index('idx_bpl_project', ['projectId', 'projectType'])
@Index('idx_bpl_version', ['bookVersionId'])
@Index('idx_bpl_parent_version', ['parentBookVersionId'])
export class BookProjectLineage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'project_id', type: 'uuid' })
  projectId: string;

  @Column({
    name: 'project_type',
    type: 'enum',
    enum: BookProjectType,
  })
  projectType: BookProjectType;

  @Column({ name: 'book_version_id', type: 'uuid' })
  bookVersionId: string;

  @Column({ name: 'parent_book_version_id', type: 'uuid', nullable: true })
  parentBookVersionId: string | null;

  @Column({ name: 'is_current_leaf', type: 'boolean', default: false })
  isCurrentLeaf: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  // Relations

  @ManyToOne(() => BookAssemblyVersion, { eager: false, nullable: false })
  @JoinColumn({ name: 'book_version_id' })
  bookVersion: BookAssemblyVersion;

  @ManyToOne(() => BookAssemblyVersion, { eager: false, nullable: true })
  @JoinColumn({ name: 'parent_book_version_id' })
  parentBookVersion: BookAssemblyVersion | null;
}
