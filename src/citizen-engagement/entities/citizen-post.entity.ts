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

/**
 * citizen_post — a citizen post on the civic community board.
 *
 * Generalises the prototype "idea" (plan D9): a post may be an `idea`
 * (geo-pinned, category required) or a `discussion` (no pin, no category).
 * Comments + hearts hang off it.
 *
 * §17.3 isolation: the ONLY FK is `author_identity_id → citizen_identities`
 * (citizen_* → citizen_*). `amphoe_id` is a PLAIN string amphoe code (e.g.
 * "3001" — matches `amphoes.id`, the same code the FE map / follows use; NO FK
 * to the amphoes master, validated in-app) so the table stays purely within the
 * engagement namespace. It is derived from the pin (lat/lng) at create time via
 * point-in-polygon. Zero FK into project / users / tracking_status. This board
 * is §17.2 ADVISORY — it creates no project and changes no workflow status.
 */
@Entity('citizen_post')
@Index('ix_citizen_post_author', ['authorIdentityId'])
@Index('ix_citizen_post_amphoe_state', ['amphoeId', 'moderationState'])
@Index('ix_citizen_post_feed', ['moderationState', 'createdAt'])
// W-F1: ranked keyset feed index. The chronological `ix_citizen_post_feed`
// above is kept — the map/profile reads still order by createdAt.
@Index('ix_citizen_post_feed_rank', ['moderationState', 'rankScore', 'id'])
// W-S2: index the repost self-ref so the embed batch-load + root repost_count
// reconciliation stay O(set), not O(table).
@Index('ix_citizen_post_repost_of', ['repostOfId'])
export class CitizenPost {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'author_identity_id', type: 'uuid' })
  authorIdentityId: string;

  @ManyToOne(() => CitizenIdentity)
  @JoinColumn({ name: 'author_identity_id' })
  author: CitizenIdentity;

  /**
   * W-S2 repost/quote. When set, THIS row is a repost (share) of the post at
   * `repostOfId`; `detail` holds the optional quote text (null = pure share).
   * FLATTEN-TO-ROOT: this always points at the ROOT original, never at another
   * repost, so embeds are never nested (set in the service to
   * `target.repostOfId ?? target.id`).
   *
   * §17.3 isolation: this is a citizen_* → citizen_* self-FK (the ONLY new FK),
   * expressed via the `@ManyToOne(() => CitizenPost)` relation below. The
   * migration adds ONLY the plain column + index (NO `REFERENCES` clause) — the
   * isolation spec bans the bare word "REFERENCES" in any citizen migration;
   * `synchronize: true` materialises the actual FK from this decorator in dev.
   */
  @Column({ name: 'repost_of_id', type: 'uuid', nullable: true })
  repostOfId: string | null;

  @ManyToOne(() => CitizenPost, { nullable: true })
  @JoinColumn({ name: 'repost_of_id' })
  repostOf: CitizenPost | null;

  /**
   * W-S2: denormalized share count on the ROOT original (incremented in-tx on
   * every repost). A repost row carries its own `repostCount = 0`.
   */
  @Column({ name: 'repost_count', type: 'int', default: 0 })
  repostCount: number;

  /** `idea` | `discussion` | `poll` (W-S7). CHECK enforced in migration. */
  @Column({ name: 'post_kind', type: 'varchar', length: 16 })
  postKind: string;

  /**
   * W-S7: optional poll close time. Present (may be null = never closes) only
   * when `post_kind = 'poll'`; a poll is CLOSED when this is non-null AND in the
   * past — a closed poll is read-only (no votes / no change-vote). The poll
   * question is `detail`; the 2..6 options live in `citizen_poll_option`.
   */
  @Column({ name: 'poll_closes_at', type: 'timestamptz', nullable: true })
  pollClosesAt: Date | null;

  /** Geo pin — present for `idea`, null for `discussion`. */
  @Column({ name: 'lat', type: 'decimal', precision: 10, scale: 7, nullable: true })
  lat: string | null;

  @Column({ name: 'lng', type: 'decimal', precision: 10, scale: 7, nullable: true })
  lng: string | null;

  /** Amphoe CODE string (e.g. "3001" — matches `amphoes.id`), NOT a uuid.
   *  Derived at write from the pin via
   *  `GeoBoundaryService.resolveAmphoeForPoint(lat,lng)?.amphoeCode`. No FK. */
  @Column({ name: 'amphoe_id', type: 'varchar', length: 16, nullable: true })
  amphoeId: string | null;

  /** `road|water|public|safety|other`. Required for `idea`, null for `discussion`. CHECK in migration. */
  @Column({ name: 'category', type: 'varchar', length: 16, nullable: true })
  category: string | null;

  @Column({ name: 'title', type: 'varchar', length: 255, nullable: true })
  title: string | null;

  @Column({ name: 'detail', type: 'text', nullable: true })
  detail: string | null;

  /** `pending|visible|hidden|removed|shadow`. CHECK in migration. */
  @Column({ name: 'moderation_state', type: 'varchar', length: 16, default: 'visible' })
  moderationState: string;

  /**
   * Owner-controlled "hide from everyone but me" flag (ซ่อนให้เห็นเฉพาะฉัน).
   * DISTINCT from `moderationState` (staff / auto moderation): the owner sets
   * this on their OWN post, and every public read excludes `owner_hidden = true`
   * unless the viewer IS the author. Default false; existing rows stay visible.
   */
  @Column({ name: 'owner_hidden', type: 'boolean', default: false })
  ownerHidden: boolean;

  /** Denormalized counters (reconciled nightly). */
  @Column({ name: 'heart_count', type: 'int', default: 0 })
  heartCount: number;

  @Column({ name: 'comment_count', type: 'int', default: 0 })
  commentCount: number;

  /**
   * W-F1: advisory feed rank score (recency + log-damped engagement). Recomputed
   * on write via `computeRankScore` (citizen-feed-ranking.ts) in the SAME
   * transaction as create / comment / heart. §17.2 advisory — sorts only.
   */
  @Column({ name: 'rank_score', type: 'double precision', default: 0 })
  rankScore: number;

  /**
   * W-F1: last engagement timestamp (bumped on comment / heart). Recorded for
   * observability; the rank recency term deliberately uses `createdAt`, not this
   * field, to avoid necro-bumping.
   */
  @Column({ name: 'last_activity_at', type: 'timestamptz', default: () => 'now()' })
  lastActivityAt: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt: Date | null;
}
