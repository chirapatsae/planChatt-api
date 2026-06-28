import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { CitizenIdentity } from './citizen-identity.entity';
import { CitizenPost } from './citizen-post.entity';

/**
 * citizen_mention — W-S6 @mention edge (identity-resolved, alias-display).
 *
 * When a citizen @mentions another citizen in a POST or a COMMENT, ONE row is
 * inserted here pointing at the resolved `mentioned_identity_id` (the real
 * target — the alias is only what the FE renders). The composer autocomplete
 * picked a SPECIFIC identity id, so "two citizens named สมชาย" is disambiguated
 * at pick-time — the stored mention is never ambiguous.
 *
 * Source discriminator: EXACTLY ONE of `post_id` / `comment_id` is set (DB CHECK
 * `ck_citizen_mention_source` in the migration). `post_id` is a real
 * `@ManyToOne` relation to citizen_post; `comment_id` is a PLAIN uuid (NOT a
 * cross-FK) because comments live in `citizen_post_comment` and the mention need
 * not couple to a comment row's lifecycle — mirrors `citizen_notification.
 * comment_id`.
 *
 * §17.3 isolation: ALL FKs are citizen_* → citizen_* —
 * `post_id → citizen_post` and `mentioned_identity_id → citizen_identities`.
 * `comment_id` is a plain uuid (no relation). Zero FK into project / users /
 * work_history / tracking_status. §17.2 advisory — a mention notifies; it gates
 * NOTHING.
 */
@Entity('citizen_mention')
// Lookup all mentions for a post / a comment (render-time linkify resolution).
@Index('ix_citizen_mention_post', ['postId'])
@Index('ix_citizen_mention_comment', ['commentId'])
// Lookup "who mentioned me" (advisory; never a queryable mentioner-of-me list).
@Index('ix_citizen_mention_mentioned', ['mentionedIdentityId'])
export class CitizenMention {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Source POST (real FK). NULL when the mention is on a comment. */
  @Column({ name: 'post_id', type: 'uuid', nullable: true })
  postId: string | null;

  @ManyToOne(() => CitizenPost, { nullable: true })
  @JoinColumn({ name: 'post_id' })
  post: CitizenPost | null;

  /**
   * Source COMMENT. PLAIN uuid — NO relation (comments live in
   * citizen_post_comment; the mention does not couple to its lifecycle).
   * NULL when the mention is on a post. Exactly-one-of (post_id, comment_id)
   * is enforced by the migration CHECK.
   */
  @Column({ name: 'comment_id', type: 'uuid', nullable: true })
  commentId: string | null;

  /** The resolved citizen who was mentioned (real FK, citizen_* → citizen_*). */
  @Column({ name: 'mentioned_identity_id', type: 'uuid' })
  mentionedIdentityId: string;

  @ManyToOne(() => CitizenIdentity)
  @JoinColumn({ name: 'mentioned_identity_id' })
  mentioned: CitizenIdentity;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
