import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { CitizenIdentity } from './citizen-identity.entity';
import { CitizenPost } from './citizen-post.entity';

/**
 * citizen_post_comment — a citizen comment on a post.
 *
 * §17.3 isolation: FKs are ONLY `post_id → citizen_post` and
 * `author_identity_id → citizen_identities` (citizen_* → citizen_*). No
 * project / users / tracking_status FK.
 */
@Entity('citizen_post_comment')
@Index('ix_citizen_comment_post', ['postId', 'createdAt'])
export class CitizenPostComment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'post_id', type: 'uuid' })
  postId: string;

  @ManyToOne(() => CitizenPost)
  @JoinColumn({ name: 'post_id' })
  post: CitizenPost;

  @Column({ name: 'author_identity_id', type: 'uuid' })
  authorIdentityId: string;

  @ManyToOne(() => CitizenIdentity)
  @JoinColumn({ name: 'author_identity_id' })
  author: CitizenIdentity;

  @Column({ name: 'text', type: 'text' })
  text: string;

  /** `pending|visible|hidden|removed|shadow`. CHECK in migration. */
  @Column({ name: 'moderation_state', type: 'varchar', length: 16, default: 'visible' })
  moderationState: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt: Date | null;
}
