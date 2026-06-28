import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { CitizenPost } from './citizen-post.entity';

/**
 * citizen_poll_option — one selectable option on a poll post (W-S7).
 *
 * A poll is a `citizen_post` with `post_kind = 'poll'`; its 2..6 options live
 * here. `vote_count` is a denormalized live tally maintained in-tx by the vote
 * toggle (insert +1 / change-vote ±1 / un-vote −1) so the result bars render
 * without a per-render GROUP BY; the authoritative source remains the live
 * `citizen_poll_vote` rows (counts are reconcilable).
 *
 * §17.3 isolation: the ONLY foreign key is `post_id → citizen_post`
 * (citizen_* → citizen_*), expressed via the `@ManyToOne(() => CitizenPost)`
 * relation below. The migration adds ONLY the plain columns + index (NO foreign
 * key clause — the isolation spec bans the bare SQL FK keyword in any citizen
 * migration); `synchronize: true` materialises the actual FK from this
 * decorator in dev. Zero FK into project / users / work_history /
 * tracking_status. §17.2 ADVISORY — a poll result drives no workflow.
 */
@Entity('citizen_poll_option')
@Index('ix_citizen_poll_option_post', ['postId'])
export class CitizenPollOption {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'post_id', type: 'uuid' })
  postId: string;

  @ManyToOne(() => CitizenPost)
  @JoinColumn({ name: 'post_id' })
  post: CitizenPost;

  @Column({ name: 'label', type: 'varchar', length: 120 })
  label: string;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder: number;

  /** Denormalized live tally (maintained in-tx by the vote toggle). */
  @Column({ name: 'vote_count', type: 'int', default: 0 })
  voteCount: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
