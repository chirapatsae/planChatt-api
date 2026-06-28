import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { CitizenIdentity } from './citizen-identity.entity';
import { CitizenPost } from './citizen-post.entity';

/**
 * citizen_appeal — W-T3 moderation v2. A citizen whose post was hidden / removed
 * / shadowed may appeal ONCE; staff review the appeal in a queue and either
 * REVERSE (restore the post → `visible`) or UPHOLD (keep it removed).
 *
 * One OPEN appeal per (post, appellant) via the partial-unique
 * `(post_id, appellant_identity_id) WHERE deleted_at IS NULL AND status='open'`
 * (migration) — a citizen can re-appeal only after a prior appeal is resolved.
 *
 * §17.3 isolation: the only FKs are `post_id → citizen_post` and
 * `appellant_identity_id → citizen_identities` (citizen_* → citizen_*). The
 * resolving STAFF member is stored as a PLAIN uuid + SNAPSHOT name string — NO
 * FK into `users` / `work_history` (mirrors `citizen_official_response`, C4).
 * §17.2 advisory — an appeal changes a post's display state only; it creates no
 * project and writes no `tracking_status`.
 */
@Entity('citizen_appeal')
@Index('ix_citizen_appeal_status', ['status', 'createdAt'])
@Index('ix_citizen_appeal_post', ['postId'])
export class CitizenAppeal {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'post_id', type: 'uuid' })
  postId: string;

  @ManyToOne(() => CitizenPost)
  @JoinColumn({ name: 'post_id' })
  post: CitizenPost;

  @Column({ name: 'appellant_identity_id', type: 'uuid' })
  appellantIdentityId: string;

  @ManyToOne(() => CitizenIdentity)
  @JoinColumn({ name: 'appellant_identity_id' })
  appellant: CitizenIdentity;

  @Column({ name: 'reason', type: 'varchar', length: 500 })
  reason: string;

  /** `open` | `upheld` | `reversed`. CHECK in migration. */
  @Column({ name: 'status', type: 'varchar', length: 12, default: 'open' })
  status: string;

  /**
   * The resolving STAFF member — PLAIN uuid + SNAPSHOT name (§17.3, no FK).
   * Both NULL while the appeal is `open`; populated at resolve time.
   */
  @Column({ name: 'resolver_work_history_id', type: 'uuid', nullable: true })
  resolverWorkHistoryId: string | null;

  @Column({ name: 'resolver_name', type: 'varchar', length: 255, nullable: true })
  resolverName: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'resolved_at', type: 'timestamptz', nullable: true })
  resolvedAt: Date | null;

  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt: Date | null;
}
