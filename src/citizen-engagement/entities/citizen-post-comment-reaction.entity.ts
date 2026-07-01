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
import { CitizenPostComment } from './citizen-post-comment.entity';

/**
 * citizen_post_comment_reaction — a citizen's LIKE (heart) on a comment.
 *
 * A comment "like" is a single kind (heart) — no reaction-type variants (the
 * idea board's comment affordance is just a heart, per user). One LIVE like per
 * (comment, identity) via the partial-unique index below; un-liking soft-deletes
 * the row (so re-liking is a fresh insert and history is preserved).
 *
 * §17.3 isolation: FKs are ONLY `comment_id → citizen_post_comment` and
 * `identity_id → citizen_identities` (citizen_* → citizen_*). No project /
 * users / tracking_status FK.
 */
@Entity('citizen_post_comment_reaction')
@Index('ix_citizen_comment_reaction_comment', ['commentId'])
@Index('ux_citizen_comment_reaction_live', ['commentId', 'identityId'], {
  unique: true,
  where: 'deleted_at IS NULL',
})
export class CitizenPostCommentReaction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'comment_id', type: 'uuid' })
  commentId: string;

  @ManyToOne(() => CitizenPostComment)
  @JoinColumn({ name: 'comment_id' })
  comment: CitizenPostComment;

  @Column({ name: 'identity_id', type: 'uuid' })
  identityId: string;

  @ManyToOne(() => CitizenIdentity)
  @JoinColumn({ name: 'identity_id' })
  identity: CitizenIdentity;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt: Date | null;
}
