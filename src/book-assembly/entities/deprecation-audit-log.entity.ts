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
import { BookAssemblyVersion } from './book-assembly-version.entity';
import {
  BookAssemblySourceType,
  DeprecationAuditAction,
} from '../enums/book-assembly.enums';

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
  })
  action: DeprecationAuditAction;

  @Column({ name: 'version_id', type: 'uuid' })
  versionId: string;

  @Column({
    name: 'source_type',
    type: 'enum',
    enum: BookAssemblySourceType,
  })
  sourceType: BookAssemblySourceType;

  @Column({ name: 'source_id', type: 'uuid' })
  sourceId: string;

  @Column({ name: 'operator_work_history_id', type: 'uuid' })
  operatorWorkHistoryId: string;

  @Column({ name: 'operator_role', type: 'varchar' })
  operatorRole: string;

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

  @ManyToOne(() => BookAssemblyVersion)
  @JoinColumn({ name: 'version_id' })
  version: BookAssemblyVersion;

  @ManyToOne(() => WorkHistory)
  @JoinColumn({ name: 'operator_work_history_id' })
  operatorWorkHistory: WorkHistory;
}
