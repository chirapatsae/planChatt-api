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
import { CitizenPollOption } from './citizen-poll-option.entity';
import { CitizenPost } from './citizen-post.entity';

/**
 * citizen_poll_vote — one live vote per citizen per poll (W-S7).
 *
 * The "one live vote per citizen per poll" rule is a PARTIAL-UNIQUE index
 * `(post_id, voter_identity_id) WHERE deleted_at IS NULL` (migration). Toggle
 * shape (mirrors the C2 reaction / C3 follow / W-S3 bookmark toggle):
 *   - no live vote          → INSERT (cast) + increment the option's vote_count
 *   - live vote, DIFF option → soft-delete the old (−1) + insert the new (+1) = change-vote
 *   - live vote, SAME option → soft-delete (un-vote, −1)
 *
 * D16 vote privacy: this row records WHO voted WHAT, but the public read surface
 * NEVER exposes it. Only aggregate `vote_count` per option + the caller's OWN
 * vote (via `/me/poll-votes`, owner-scoped) are returned.
 *
 * §17.3 isolation: FKs are ONLY citizen_* → citizen_* — `post_id → citizen_post`,
 * `option_id → citizen_poll_option`, `voter_identity_id → citizen_identities`,
 * all via the `@ManyToOne` relations below. The migration adds ONLY plain
 * columns + indexes + the partial-unique (NO foreign key clause — the isolation
 * spec bans the bare SQL FK keyword); `synchronize: true` materialises the FKs
 * from these decorators in dev. Zero FK into project / users / work_history /
 * tracking_status. §17.2 ADVISORY.
 */
@Entity('citizen_poll_vote')
@Index('ix_citizen_poll_vote_post', ['postId'])
@Index('ix_citizen_poll_vote_voter', ['voterIdentityId'])
export class CitizenPollVote {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'post_id', type: 'uuid' })
  postId: string;

  @ManyToOne(() => CitizenPost)
  @JoinColumn({ name: 'post_id' })
  post: CitizenPost;

  @Column({ name: 'option_id', type: 'uuid' })
  optionId: string;

  @ManyToOne(() => CitizenPollOption)
  @JoinColumn({ name: 'option_id' })
  option: CitizenPollOption;

  @Column({ name: 'voter_identity_id', type: 'uuid' })
  voterIdentityId: string;

  @ManyToOne(() => CitizenIdentity)
  @JoinColumn({ name: 'voter_identity_id' })
  voter: CitizenIdentity;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt: Date | null;
}
