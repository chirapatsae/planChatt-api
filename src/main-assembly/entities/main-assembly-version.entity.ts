import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Exclude } from 'class-transformer';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import {
  MainAssemblyCorrectionMode,
  MainAssemblyPartSource,
  MainAssemblyVersionStatus,
} from '../enums/main-assembly.enums';

/**
 * MainAssemblyVersion — Wave A1 / DB-01.
 *
 * Immutable published-version row produced by `finalize` on a main-plan
 * book. Dedicated table; NOT shared with `book_assembly_versions`. Q3=B
 * duplicate of the BookAssembly shape — same columns minus the
 * `(source_type, source_id)` discriminator pair (replaced by a single
 * `development_plan_id` FK column).
 *
 * Key shape differences vs `book_assembly_versions`:
 *   - `source_type` removed (always main_plan; implicit by table)
 *   - `source_id` → `development_plan_id` (renamed for semantic clarity,
 *     wired to a real FK with ON DELETE RESTRICT)
 *   - `part3_page_map` (JSONB) REMOVED — denormalized into the new
 *     `main_assembly_version_projects` join table per Wave A1 spec.
 *     Page-map reads MUST go through that join going forward.
 *   - `part3_project_snapshot` KEPT (still useful for backfill
 *     matching + display of the per-version snapshot ordered list).
 *   - All deprecation columns KEPT (deprecated_at / deprecated_by_id /
 *     deprecation_reason).
 *   - All correction columns KEPT (correction_mode / correction_reason).
 *
 * Uniqueness:
 *   - `UNIQUE(development_plan_id, version_number)` for per-plan
 *     version monotonicity (declared in migration as
 *     `idx_main_version_plan_number`).
 *   - Partial unique `idx_main_single_completed_per_plan` enforces "at
 *     most one COMPLETED version per plan" (mirrors the existing
 *     `idx_single_completed_per_source` semantics). Declared in
 *     migration only — TypeORM has no partial-unique decorator.
 */
@Entity('main_assembly_versions')
@Index('idx_main_version_plan', ['developmentPlanId'])
@Index('idx_main_version_plan_number', ['developmentPlanId', 'versionNumber'], {
  unique: true,
})
@Index('idx_main_version_status', ['status'])
export class MainAssemblyVersion {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'development_plan_id', type: 'uuid' })
  developmentPlanId: string;

  @Column({ name: 'version_number', type: 'int' })
  versionNumber: number;

  @Column({
    name: 'status',
    type: 'enum',
    enum: MainAssemblyVersionStatus,
    enumName: 'main_assembly_version_status',
    default: MainAssemblyVersionStatus.COMPLETED,
  })
  status: MainAssemblyVersionStatus;

  @Column({
    name: 'correction_mode',
    type: 'enum',
    enum: MainAssemblyCorrectionMode,
    enumName: 'main_assembly_correction_mode',
    nullable: true,
  })
  correctionMode: MainAssemblyCorrectionMode | null;

  @Column({ name: 'correction_reason', type: 'text', nullable: true })
  correctionReason: string | null;

  // Part 1

  @Exclude()
  @Column({ name: 'part1_file_path', type: 'varchar' })
  part1FilePath: string;

  @Column({
    name: 'part1_source',
    type: 'enum',
    enum: MainAssemblyPartSource,
    enumName: 'main_assembly_part_source',
  })
  part1Source: MainAssemblyPartSource;

  @Column({ name: 'part1_original_file_name', type: 'varchar', nullable: true })
  part1OriginalFileName: string | null;

  // Part 2

  @Exclude()
  @Column({ name: 'part2_file_path', type: 'varchar' })
  part2FilePath: string;

  @Column({
    name: 'part2_source',
    type: 'enum',
    enum: MainAssemblyPartSource,
    enumName: 'main_assembly_part_source',
  })
  part2Source: MainAssemblyPartSource;

  @Column({ name: 'part2_original_file_name', type: 'varchar', nullable: true })
  part2OriginalFileName: string | null;

  // Part 3

  @Exclude()
  @Column({ name: 'part3_file_path', type: 'varchar' })
  part3FilePath: string;

  @Column({
    name: 'part3_source',
    type: 'enum',
    enum: MainAssemblyPartSource,
    enumName: 'main_assembly_part_source',
  })
  part3Source: MainAssemblyPartSource;

  // Wave A1 / DB-01 — KEPT (still useful for backfill matching +
  // version-card snapshot display). The companion `part3_page_map`
  // JSONB on `book_assembly_versions` is INTENTIONALLY NOT mirrored
  // here — page mappings live in `main_assembly_version_projects`.
  @Column({ name: 'part3_project_snapshot', type: 'jsonb' })
  part3ProjectSnapshot: string[];

  @Column({ name: 'part3_project_count', type: 'int' })
  part3ProjectCount: number;

  /**
   * §21.4 — equipment (ผ.03) UUID snapshot captured at merge time.
   * Used by the read-time staleness diff in
   * `MainAssemblyService.computePart3Staleness` to compute
   * `part3StaleEquipmentCount` / `part3RemovedEquipmentCount`.
   *
   * NULL on historical rows merged before §21.4 landed; the staleness
   * computation degrades to "equipment snapshot unavailable" and only
   * reports PG-side staleness.
   *
   * §17.5 — no auto-recompute. The snapshot is captured ONLY at merge
   * time and never updated; staleness is detected by a read-time diff
   * against the current Approved set.
   */
  @Column({
    name: 'part3_equipment_snapshot',
    type: 'uuid',
    array: true,
    nullable: true,
  })
  part3EquipmentSnapshot: string[] | null;

  // Merged output

  @Exclude()
  @Column({ name: 'merged_file_path', type: 'varchar' })
  mergedFilePath: string;

  @Column({ name: 'merged_at', type: 'timestamp' })
  mergedAt: Date;

  @Column({ name: 'total_pages', type: 'int', nullable: true })
  totalPages: number | null;

  // Creator

  @Column({ name: 'created_by_id', type: 'uuid' })
  createdById: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  // Deprecation

  @Column({ name: 'deprecated_at', type: 'timestamp', nullable: true })
  deprecatedAt: Date | null;

  @Column({ name: 'deprecated_by_id', type: 'uuid', nullable: true })
  deprecatedById: string | null;

  @Column({ name: 'deprecation_reason', type: 'text', nullable: true })
  deprecationReason: string | null;

  // Relations

  @ManyToOne(() => WorkHistory)
  @JoinColumn({ name: 'created_by_id' })
  createdBy: WorkHistory;

  @ManyToOne(() => WorkHistory, { nullable: true })
  @JoinColumn({ name: 'deprecated_by_id' })
  deprecatedBy: WorkHistory | null;

  @ManyToOne(() => DevelopmentPlan, { nullable: false })
  @JoinColumn({ name: 'development_plan_id' })
  developmentPlan: DevelopmentPlan;
}
