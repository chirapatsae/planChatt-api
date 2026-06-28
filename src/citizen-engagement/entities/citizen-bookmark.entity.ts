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
 * citizen_bookmark — a citizen SAVES a post (the X/IG "bookmark"). Private:
 * only the owner ever reads their saved list; there is no public count.
 *
 * A live bookmark is a row with `deleted_at IS NULL`; toggle = soft-delete /
 * re-insert (same race-safe shape as `citizen_follow` / the C2 reaction
 * toggle). The partial-unique `(bookmarker_identity_id, post_id) WHERE
 * deleted_at IS NULL` (migration) keeps at most one live bookmark per pair.
 *
 * §17.3 isolation: the ONLY two foreign keys are citizen_* → citizen_*
 * (`bookmarker_identity_id → citizen_identities`, `post_id → citizen_post`).
 * Zero FK into project / users / work_history / tracking_status. This is
 * §17.2 ADVISORY — a bookmark gates nothing.
 */
@Entity('citizen_bookmark')
@Index('ix_citizen_bookmark_bookmarker', ['bookmarkerIdentityId'])
export class CitizenBookmark {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'bookmarker_identity_id', type: 'uuid' })
  bookmarkerIdentityId: string;

  @ManyToOne(() => CitizenIdentity)
  @JoinColumn({ name: 'bookmarker_identity_id' })
  bookmarker: CitizenIdentity;

  @Column({ name: 'post_id', type: 'uuid' })
  postId: string;

  @ManyToOne(() => CitizenPost)
  @JoinColumn({ name: 'post_id' })
  post: CitizenPost;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt: Date | null;
}
