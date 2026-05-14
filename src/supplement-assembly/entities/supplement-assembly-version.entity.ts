import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { SupplementAssemblyVersionStatus } from '../enums/supplement-assembly.enums';

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
 * `createdById` is a bare uuid (no FK relation) — matches BookAssembly
 * precedent for migration-safety.
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

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
