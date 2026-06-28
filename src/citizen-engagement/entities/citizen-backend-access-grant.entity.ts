import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * citizen_backend_access_grants — per-feature backend access for INTERNAL
 * users (plan D6). Un-granted internal users are VIEW-ONLY; a `staff`/`admin`
 * grant unlocks a capability (moderation / insight / access_mgmt / respond).
 *
 * This is a GRANT TABLE, NOT a new global role — `roles.enum.ts` is untouched.
 *
 * §17.3 isolation: `user_id` and `decided_by_work_history_id` are PLAIN uuids
 * with NO FK into `users` / `work_history`. The "one active grant per
 * (user, capability)" rule is a PARTIAL-UNIQUE index `WHERE state = 'granted'`
 * (migration).
 */
@Entity('citizen_backend_access_grants')
@Index('ix_citizen_grant_user', ['userId'])
export class CitizenBackendAccessGrant {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Internal user uuid — NO FK (§17.3). */
  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  /** `moderate|insight|access_mgmt|respond`. CHECK in migration. */
  @Column({ name: 'capability', type: 'varchar', length: 24 })
  capability: string;

  /** `pending|granted|revoked`. CHECK in migration. */
  @Column({ name: 'state', type: 'varchar', length: 16, default: 'pending' })
  state: string;

  @CreateDateColumn({ name: 'requested_at', type: 'timestamptz' })
  requestedAt: Date;

  /** Internal granter WorkHistory uuid — NO FK (§17.3). */
  @Column({ name: 'decided_by_work_history_id', type: 'uuid', nullable: true })
  decidedByWorkHistoryId: string | null;

  @Column({ name: 'decided_at', type: 'timestamptz', nullable: true })
  decidedAt: Date | null;

  @Column({ name: 'reason', type: 'text', nullable: true })
  reason: string | null;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
