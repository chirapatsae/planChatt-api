import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { CitizenHashtag } from './citizen-hashtag.entity';
import { CitizenPost } from './citizen-post.entity';

/**
 * citizen_post_hashtag — the link between a post and a hashtag (W-S4).
 *
 * One row per (post, hashtag). Created in-tx by `CitizenHashtagService.extractAndLink`
 * AFTER the post row exists (so `post_id` is known). The partial-unique
 * `(post_id, hashtag_id)` keeps a tag from linking twice to the same post even
 * if it appears twice in the body (the extractor dedupes too — this is the DB
 * belt-and-braces). Trending = a grouped COUNT of these rows in a recent window;
 * tag-search = the visible posts joined through these rows.
 *
 * §17.3 isolation: the ONLY two foreign keys are citizen_* → citizen_*
 * (`post_id → citizen_post`, `hashtag_id → citizen_hashtag`), expressed via the
 * `@ManyToOne` relations below. The migration adds ONLY the plain columns +
 * indexes + unique (NO foreign key clause — the isolation spec bans the bare
 * SQL FK keyword in any citizen migration); `synchronize: true` materialises the
 * actual FKs from these decorators in dev. Zero FK into project / users /
 * work_history / tracking_status. §17.2 ADVISORY.
 */
@Entity('citizen_post_hashtag')
@Index('ix_citizen_post_hashtag_post', ['postId'])
// Trending groups by hashtag within a recent window — index the tag side + time.
@Index('ix_citizen_post_hashtag_tag_time', ['hashtagId', 'createdAt'])
// At most one link per (post, hashtag) — the extractor dedupes, this is the
// DB-level guard so a re-run / concurrent insert cannot duplicate the link.
@Index('uq_citizen_post_hashtag', ['postId', 'hashtagId'], { unique: true })
export class CitizenPostHashtag {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'post_id', type: 'uuid' })
  postId: string;

  @ManyToOne(() => CitizenPost)
  @JoinColumn({ name: 'post_id' })
  post: CitizenPost;

  @Column({ name: 'hashtag_id', type: 'uuid' })
  hashtagId: string;

  @ManyToOne(() => CitizenHashtag)
  @JoinColumn({ name: 'hashtag_id' })
  hashtag: CitizenHashtag;

  /**
   * Denormalized link time = the post's create time. The trending window filters
   * on this so the grouped COUNT stays index-backed (no join to citizen_post for
   * the time filter).
   */
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
