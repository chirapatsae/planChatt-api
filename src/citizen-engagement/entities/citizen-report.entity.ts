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
 * citizen_report — a first-class citizen report on a post (C5, plan D13
 * moderation-at-scale). De-duplicated to ONE live report per (post, reporter)
 * via the partial-unique `(post_id, reporter_identity_id) WHERE deleted_at IS
 * NULL` (migration), so the DISTINCT-reporter count drives the auto-hide
 * threshold. When that count reaches the threshold a still-`visible` post is
 * auto-moved to the `shadow` state (hidden from the public list/detail reads)
 * pending staff review. (An author-scoped read that lets the owner still see
 * their own shadowed post is a noted future enhancement — today list()/detail()
 * filter strictly on `moderationState = 'visible'`.)
 *
 * §17.3 isolation: FKs are ONLY `post_id → citizen_post` and
 * `reporter_identity_id → citizen_identities` (citizen_* → citizen_*). The
 * moderation ACTION audit trail lives in `citizen_moderation_log`; this table
 * is the report ledger that powers the threshold.
 */
@Entity('citizen_report')
@Index('ix_citizen_report_post', ['postId', 'status'])
export class CitizenReport {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'post_id', type: 'uuid' })
  postId: string;

  @ManyToOne(() => CitizenPost)
  @JoinColumn({ name: 'post_id' })
  post: CitizenPost;

  @Column({ name: 'reporter_identity_id', type: 'uuid' })
  reporterIdentityId: string;

  @ManyToOne(() => CitizenIdentity)
  @JoinColumn({ name: 'reporter_identity_id' })
  reporter: CitizenIdentity;

  @Column({ name: 'reason', type: 'text', nullable: true })
  reason: string | null;

  /** `open` | `actioned` | `dismissed`. CHECK in migration. */
  @Column({ name: 'status', type: 'varchar', length: 16, default: 'open' })
  status: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt: Date | null;
}
