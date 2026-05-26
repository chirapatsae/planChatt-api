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

/**
 * Surviving shared-infrastructure entity (CLEANUP wave BE-02, 2026-05-26).
 *
 * The legacy `BookAssemblyService.validateDeprecationAuth` and its sibling
 * `SupplementAssemblyService.validateSupplementDeprecationAuth` both wrote
 * rows into the `deprecation_audit_logs` table. The legacy
 * `BookAssemblyService` has been deleted as part of the OPTION-A-FULL-SPLIT
 * CLEANUP wave; the supplement-side writer remains (and the four standalone
 * services may grow audit-write parity in a future wave).
 *
 * Per CLAUDE.md §20.10.3 (Q3=B file-service exemption) and the CLEANUP-BE-02
 * brief, the ENTITY is preserved so existing rows remain queryable and the
 * `DeprecationAuditLog` repo continues to bind cleanly at boot. The
 * supplement writer continues to work because it uses TypeORM's `manager.
 * save(DeprecationAuditLog, {...})` shape that does not depend on the
 * legacy `@ManyToOne(() => BookAssemblyVersion)` relation.
 *
 * Two intentional changes vs the pre-CLEANUP entity definition:
 *   1. The `BookAssemblyVersion` `@ManyToOne` relation has been removed.
 *      The `version_id` UUID column is preserved as a raw FK-less reference
 *      so historical rows still resolve via direct UUID lookup. The legacy
 *      `BookAssemblyVersion` entity is being deleted in this same wave.
 *   2. The `BookAssemblySourceType` and `DeprecationAuditAction` enums are
 *      now declared INLINE in this file (formerly imported from
 *      `../enums/book-assembly.enums.ts` which is being deleted). Values
 *      are byte-for-byte unchanged so the underlying Postgres
 *      `source_type_enum` and `deprecation_audit_action_enum` types are
 *      untouched — migration `1744070400000-FixAuditLogNullableAndRestored
 *      Enum.ts` remains the source of truth for the DB enum shape.
 */
export enum DeprecationAuditSourceType {
  MAIN_PLAN = 'main_plan',
  EDIT_REVISION = 'edit_revision',
  CHANGE_REVISION = 'change_revision',
}

export enum DeprecationAuditAction {
  SUCCESS = 'success',
  FAILED = 'failed',
  RESTORED = 'restored',
}

@Entity('deprecation_audit_logs')
@Index('idx_deprecation_audit_version_id', ['versionId'])
@Index('idx_deprecation_audit_operator', ['operatorWorkHistoryId'])
@Index('idx_deprecation_audit_created_at', ['createdAt'])
export class DeprecationAuditLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({
    name: 'action',
    type: 'enum',
    enum: DeprecationAuditAction,
    // Pin to the existing Postgres enum type name created by migration
    // `1743724800000-CreateBookAssemblyTables.ts`. Without `enumName`,
    // TypeORM `synchronize: true` would otherwise generate a default
    // type name and attempt to ALTER the column away from the existing
    // `deprecation_audit_action_enum` type.
    enumName: 'deprecation_audit_action_enum',
  })
  action: DeprecationAuditAction;

  /**
   * UUID-only reference to the deprecated assembly version (BookAssembly
   * legacy, or any future standalone assembly version table). Nullable
   * because FAILED audit rows can be written before a version id is
   * known. NO `@ManyToOne` relation — the legacy `BookAssemblyVersion`
   * entity has been deleted in the CLEANUP wave and no replacement
   * single-table target exists for the relation.
   */
  @Column({ name: 'version_id', type: 'uuid', nullable: true })
  versionId: string | null;

  @Column({
    name: 'source_type',
    type: 'enum',
    enum: DeprecationAuditSourceType,
    // Pin to the existing Postgres enum type name created by migration
    // `1743724800000-CreateBookAssemblyTables.ts` (shared with the now-
    // deleted `book_assembly_*` tables). The enum VALUES are unchanged
    // from the legacy `BookAssemblySourceType` so the Postgres type
    // definition is byte-for-byte the same.
    enumName: 'book_assembly_source_type_enum',
  })
  sourceType: DeprecationAuditSourceType;

  @Column({ name: 'source_id', type: 'uuid' })
  sourceId: string;

  @Column({ name: 'operator_work_history_id', type: 'uuid', nullable: true })
  operatorWorkHistoryId: string | null;

  @Column({ name: 'operator_role', type: 'varchar', nullable: true })
  operatorRole: string | null;

  @Column({
    name: 'identity_verified',
    type: 'boolean',
  })
  identityVerified: boolean;

  @Column({ name: 'identity_masked', type: 'varchar', nullable: true })
  identityMasked: string | null;

  @Column({ name: 'reason', type: 'text', nullable: true })
  reason: string | null;

  @Column({ name: 'failure_reason', type: 'text', nullable: true })
  failureReason: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  // Relations

  @ManyToOne(() => WorkHistory, { nullable: true })
  @JoinColumn({ name: 'operator_work_history_id' })
  operatorWorkHistory: WorkHistory | null;
}
