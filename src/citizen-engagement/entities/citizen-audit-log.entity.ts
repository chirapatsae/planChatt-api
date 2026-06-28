import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * citizen_audit_logs — the isolated audit trail for ALL engagement actions
 * (§17.3). It NEVER writes `tracking_status` — §12 audit ownership stays with
 * workflow transitions only. Append-only (no soft-delete).
 *
 * Both citizen and internal actors are stored as a plain `actor_id` uuid with
 * an `actor_kind` discriminator — NO FK into `citizen_identities` / `users` /
 * `work_history` so erasure / role-change never cascade into audit history.
 */
@Entity('citizen_audit_logs')
@Index('ix_citizen_audit_target', ['targetKind', 'targetId', 'createdAt'])
export class CitizenAuditLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** `citizen` | `internal`. CHECK in migration. */
  @Column({ name: 'actor_kind', type: 'varchar', length: 8 })
  actorKind: string;

  /** citizen_identities.id OR work_history uuid — plain, NO FK. */
  @Column({ name: 'actor_id', type: 'uuid', nullable: true })
  actorId: string | null;

  @Column({ name: 'action', type: 'varchar', length: 48 })
  action: string;

  /** Logical discriminator (`post|comment|reaction|grant|identity|…`). Plain varchar — additive. */
  @Column({ name: 'target_kind', type: 'varchar', length: 32 })
  targetKind: string;

  @Column({ name: 'target_id', type: 'uuid', nullable: true })
  targetId: string | null;

  @Column({ name: 'detail', type: 'jsonb', nullable: true })
  detail: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
