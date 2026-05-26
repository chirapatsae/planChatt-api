import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import {
  SupplementAssemblyCorrectionMode,
  SupplementAssemblyVersionStatus,
} from '../enums/supplement-assembly.enums';

/**
 * SupplementAssemblyVersion — SUPP_STANDALONE_DB_01.
 *
 * Immutable published-version row produced by `finalize`. Mirrors the
 * `book_assembly_versions` shape (Q3=B duplicate) but in a dedicated
 * table.
 *
 * Q8=A — Multi-version: `UNIQUE(development_plan_supplement_id, version_number)`
 * only. There is intentionally NO `UNIQUE(development_plan_supplement_id)`
 * so a single supplement can carry v1..vN.
 *
 * Q9=A — Version numbers reset per-supplement (per-supplement monotonic).
 *
 * Q4=C — Wave A status enum carries `COMPLETED` only. A future
 * `DEPRECATED` value (with `deprecated_at` / `deprecated_by_id` /
 * `deprecation_reason` columns) is intentionally deferred to Wave B.
 *
 * `createdById` carries a bare `created_by_id` UUID column. As of
 * wave-supplement-assembly-metadata-parity / BE-01 the column is ALSO
 * decorated as a `@ManyToOne(WorkHistory)` relation so the version-card
 * version DTO can surface `createdBy.user.{prefix,firstName,lastName}`
 * — mirrors the main-plan precedent at
 * `book-assembly/entities/book-assembly-version.entity.ts:153-155`. The
 * relation is NOT `eager: true`; callers MUST explicitly request
 * `relations: ['createdBy', 'createdBy.user']`.
 *
 * Wave A.5 — column / property names aligned with `book_assembly_*`:
 *   version → version_number (versionNumber)
 *   created_by_work_history_id → created_by_id (createdById)
 */
@Entity('supplement_assembly_versions')
@Index('idx_sav_supplement', ['developmentPlanSupplementId'])
@Index('uniq_sav_supplement_version', ['developmentPlanSupplementId', 'versionNumber'], {
  unique: true,
})
export class SupplementAssemblyVersion {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({
    name: 'development_plan_supplement_id',
    type: 'uuid',
  })
  developmentPlanSupplementId: string;

  @Column({ name: 'version_number', type: 'int' })
  versionNumber: number;

  @Column({
    name: 'status',
    type: 'enum',
    enum: SupplementAssemblyVersionStatus,
    enumName: 'supplement_assembly_version_status',
    default: SupplementAssemblyVersionStatus.COMPLETED,
  })
  status: SupplementAssemblyVersionStatus;

  @Column({ name: 'merged_file_path', type: 'text' })
  mergedFilePath: string;

  @Column({ name: 'merged_file_sha256', type: 'text' })
  mergedFileSha256: string;

  @Column({
    name: 'merged_at',
    type: 'timestamptz',
    default: () => 'NOW()',
  })
  mergedAt: Date;

  @Column({ name: 'created_by_id', type: 'uuid' })
  createdById: string;

  @Column({
    name: 'metadata_json',
    type: 'jsonb',
    nullable: true,
  })
  metadataJson: Record<string, unknown> | null;

  // wave-supplement-assembly-metadata-parity / DB-01 — three nullable
  // read-side display columns. All NULL for pre-DB-01 rows; BE-01
  // populates them on every new merge.

  @Column({ name: 'part3_project_count', type: 'int', nullable: true })
  part3ProjectCount: number | null;

  @Column({ name: 'part3_project_snapshot', type: 'jsonb', nullable: true })
  part3ProjectSnapshot: string[] | null;

  @Column({ name: 'total_pages', type: 'int', nullable: true })
  totalPages: number | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  // wave-supplement-assembly-metadata-parity / BE-01 — read-side relation
  // for surfacing creator name on the version card. Reuses the existing
  // `created_by_id` column; no schema drift. Mirrors main-plan
  // `BookAssemblyVersion.createdBy` (lines 153-155 in
  // `book-assembly-version.entity.ts`).
  @ManyToOne(() => WorkHistory)
  @JoinColumn({ name: 'created_by_id' })
  createdBy: WorkHistory;

  // wave-supplement-correction-workflow / DB-01 — correction-lineage and
  // deprecation columns. All NULL-able; pre-existing Wave-A version rows
  // stay unaffected. Mirrors main-plan precedent at
  // `book-assembly-version.entity.ts` lines 50-59, 142-159.
  //
  // `correctionMode` / `correctionReason` describe HOW this version was
  // produced from a prior corrected version (NULL for the original v1).
  // `deprecatedAt` / `deprecatedById` / `deprecationReason` describe
  // WHEN this version was retired in favor of a later one. Together they
  // form a complete correction audit chain that BE-01 will exploit when
  // implementing `/correct` + `/deprecate`.
  //
  // Bare-UUID column convention preserved (no FK at SQL level for
  // `deprecated_by_id` per supplement entity convention); the
  // `@ManyToOne(WorkHistory)` relation is registered at the TypeORM
  // level only — symmetric to the `createdBy` relation above.

  @Column({
    name: 'correction_mode',
    type: 'enum',
    enum: SupplementAssemblyCorrectionMode,
    enumName: 'supplement_assembly_correction_mode',
    nullable: true,
  })
  correctionMode: SupplementAssemblyCorrectionMode | null;

  @Column({ name: 'correction_reason', type: 'text', nullable: true })
  correctionReason: string | null;

  @Column({ name: 'deprecated_at', type: 'timestamptz', nullable: true })
  deprecatedAt: Date | null;

  @Column({ name: 'deprecated_by_id', type: 'uuid', nullable: true })
  deprecatedById: string | null;

  @Column({ name: 'deprecation_reason', type: 'text', nullable: true })
  deprecationReason: string | null;

  @ManyToOne(() => WorkHistory, { nullable: true })
  @JoinColumn({ name: 'deprecated_by_id' })
  deprecatedBy: WorkHistory | null;
}
