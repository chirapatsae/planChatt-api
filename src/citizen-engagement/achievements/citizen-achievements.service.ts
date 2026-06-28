import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  CITIZEN_BADGES,
  CitizenBadge,
  CitizenBadgeMetric,
  CitizenBadgeTier,
} from '../constants/citizen-badges';
import { CitizenPost } from '../entities/citizen-post.entity';
import { CitizenPostComment } from '../entities/citizen-post-comment.entity';
import { CitizenPollVote } from '../entities/citizen-poll-vote.entity';
import { CitizenStory } from '../entities/citizen-story.entity';
import { CitizenFollow } from '../entities/citizen-follow.entity';
import { CitizenOfficialResponse } from '../entities/citizen-official-response.entity';

/** The computed engagement stats for one citizen (all bounded per citizen). */
export interface CitizenStats {
  /** All VISIBLE, not-deleted posts authored by the citizen. */
  posts: number;
  /** VISIBLE, not-deleted posts of `post_kind = 'idea'`. */
  ideaPosts: number;
  /** VISIBLE, not-deleted comments authored by the citizen. */
  comments: number;
  /** SUM(heart_count) over the citizen's own VISIBLE, not-deleted posts. */
  reactionsReceived: number;
  /** Live (not-deleted) poll votes the citizen has cast. */
  pollVotes: number;
  /** Not-deleted stories the citizen has posted. */
  stories: number;
  /** Live (not-deleted) followers of the citizen (target_kind = 'person'). */
  followers: number;
  /** Distinct of the citizen's posts that received an official response. */
  officialResponsesReceived: number;
}

/** A catalog badge enriched with the caller's earned + progress state. */
export interface CitizenBadgeProgress {
  key: string;
  labelTh: string;
  descriptionTh: string;
  iconKey: string;
  tier: CitizenBadgeTier;
  earned: boolean;
  progress: { current: number; target: number };
}

/** Owner view — full stats + every catalog badge with earned + progress. */
export interface CitizenAchievementsMine {
  stats: CitizenStats;
  badges: CitizenBadgeProgress[];
}

/** Public view — ONLY earned badge facts; NO raw stats leak (PDPA / §17.3). */
export interface CitizenEarnedBadge {
  key: string;
  labelTh: string;
  descriptionTh: string;
  iconKey: string;
  tier: CitizenBadgeTier;
}

/**
 * CitizenAchievementsService — W-P4 civic-gamification read aggregator.
 *
 * §18.13 ZERO-WRITE read aggregator: every method is a grouped COUNT / SUM over
 * the `citizen_*` namespace. It inserts NO `tracking_status`, writes NO `ai_*`
 * row, fires NO notification, and mutates NOTHING — badges are recomputed on
 * every read (idempotent, cheap; counts are bounded per citizen). §17.2 advisory
 * — a badge gates no workflow transition and awards nothing persistent. §17.3
 * isolation — the queries touch ONLY citizen_* tables, hold NO new FK, and the
 * public view exposes NO raw counts (earned badge facts only; alias resolved by
 * the caller).
 *
 * VISIBLE-only (`moderation_state = 'visible'`) where the table carries a
 * moderation state (posts, comments); not-deleted (`deleted_at IS NULL`)
 * everywhere.
 */
@Injectable()
export class CitizenAchievementsService {
  constructor(
    @InjectRepository(CitizenPost)
    private readonly postRepo: Repository<CitizenPost>,
    @InjectRepository(CitizenPostComment)
    private readonly commentRepo: Repository<CitizenPostComment>,
    @InjectRepository(CitizenPollVote)
    private readonly pollVoteRepo: Repository<CitizenPollVote>,
    @InjectRepository(CitizenStory)
    private readonly storyRepo: Repository<CitizenStory>,
    @InjectRepository(CitizenFollow)
    private readonly followRepo: Repository<CitizenFollow>,
    @InjectRepository(CitizenOfficialResponse)
    private readonly officialResponseRepo: Repository<CitizenOfficialResponse>,
  ) {}

  // ---------------------------------------------------------------------------
  // computeStats — grouped COUNT / SUM over citizen_* tables (read-only)
  // ---------------------------------------------------------------------------

  /**
   * Computes the eight engagement stats for one citizen. Each is a single
   * COUNT / SUM; VISIBLE-only where a moderation state exists, not-deleted
   * everywhere. Zero writes.
   */
  async computeStats(identityId: string): Promise<CitizenStats> {
    // posts — VISIBLE, not-deleted, authored by the citizen.
    const posts = await this.postRepo
      .createQueryBuilder('p')
      .where('p.author_identity_id = :id', { id: identityId })
      .andWhere('p.moderation_state = :state', { state: 'visible' })
      .andWhere('p.deleted_at IS NULL')
      .getCount();

    // ideaPosts — same, narrowed to post_kind = 'idea'.
    const ideaPosts = await this.postRepo
      .createQueryBuilder('p')
      .where('p.author_identity_id = :id', { id: identityId })
      .andWhere('p.post_kind = :kind', { kind: 'idea' })
      .andWhere('p.moderation_state = :state', { state: 'visible' })
      .andWhere('p.deleted_at IS NULL')
      .getCount();

    // reactionsReceived — SUM(heart_count) over the citizen's own VISIBLE posts.
    const reactionsRow = await this.postRepo
      .createQueryBuilder('p')
      .select('COALESCE(SUM(p.heart_count), 0)', 'sum')
      .where('p.author_identity_id = :id', { id: identityId })
      .andWhere('p.moderation_state = :state', { state: 'visible' })
      .andWhere('p.deleted_at IS NULL')
      .getRawOne<{ sum: string }>();
    const reactionsReceived = Number(reactionsRow?.sum ?? 0);

    // comments — VISIBLE, not-deleted, authored by the citizen.
    const comments = await this.commentRepo
      .createQueryBuilder('c')
      .where('c.author_identity_id = :id', { id: identityId })
      .andWhere('c.moderation_state = :state', { state: 'visible' })
      .andWhere('c.deleted_at IS NULL')
      .getCount();

    // pollVotes — live (not-deleted) votes the citizen has cast. No moderation
    // state on the vote table; one live vote per poll by partial-unique.
    const pollVotes = await this.pollVoteRepo
      .createQueryBuilder('v')
      .where('v.voter_identity_id = :id', { id: identityId })
      .andWhere('v.deleted_at IS NULL')
      .getCount();

    // stories — not-deleted stories authored by the citizen (no moderation
    // state; ephemerality is a read-time expiry filter we deliberately ignore
    // for the lifetime "storyteller" count — a story still counts as authored).
    const stories = await this.storyRepo
      .createQueryBuilder('s')
      .where('s.author_identity_id = :id', { id: identityId })
      .andWhere('s.deleted_at IS NULL')
      .getCount();

    // followers — live person-follows pointing AT this citizen. target_key holds
    // the followed citizen's identity_id (plain uuid) when target_kind='person'.
    const followers = await this.followRepo
      .createQueryBuilder('f')
      .where('f.target_kind = :kind', { kind: 'person' })
      .andWhere('f.target_key = :id', { id: identityId })
      .andWhere('f.deleted_at IS NULL')
      .getCount();

    // officialResponsesReceived — distinct of the citizen's posts that received
    // an official staff response. Counting DISTINCT posts (not response rows) so
    // multiple responses on one post still reads as "one post got a reply",
    // matching the verified_civic threshold semantics (>=1 responded post).
    const officialRow = await this.officialResponseRepo
      .createQueryBuilder('orr')
      .innerJoin('citizen_post', 'p', 'p.id = orr.post_id')
      .select('COUNT(DISTINCT orr.post_id)', 'cnt')
      .where('p.author_identity_id = :id', { id: identityId })
      .andWhere('orr.deleted_at IS NULL')
      .andWhere('p.deleted_at IS NULL')
      // VISIBLE-only, consistent with every other stat — a hidden/removed post
      // must not count toward verified_civic.
      .andWhere("p.moderation_state = 'visible'")
      .getRawOne<{ cnt: string }>();
    const officialResponsesReceived = Number(officialRow?.cnt ?? 0);

    return {
      posts,
      ideaPosts,
      comments,
      reactionsReceived,
      pollVotes,
      stories,
      followers,
      officialResponsesReceived,
    };
  }

  // ---------------------------------------------------------------------------
  // getMine — full catalog with earned + progress (owner-scoped)
  // ---------------------------------------------------------------------------

  /**
   * Owner view: the citizen's raw stats plus EVERY catalog badge annotated with
   * `earned` and progress-to-threshold. Only the OWNER ever sees raw stats.
   */
  async getMine(identityId: string): Promise<CitizenAchievementsMine> {
    const stats = await this.computeStats(identityId);
    const badges = CITIZEN_BADGES.map((badge) =>
      this.toProgress(badge, stats),
    );
    return { stats, badges };
  }

  // ---------------------------------------------------------------------------
  // getPublic — earned badges ONLY (no raw stats leak)
  // ---------------------------------------------------------------------------

  /**
   * Public view: ONLY the EARNED badges, projected to badge facts (key, labels,
   * icon, tier). NO raw stats and NO progress are returned — a public profile
   * must not leak how many posts / followers / reactions a citizen has (PDPA /
   * §17.3). The alias is resolved by the caller, not here.
   */
  async getPublic(identityId: string): Promise<CitizenEarnedBadge[]> {
    const stats = await this.computeStats(identityId);
    return CITIZEN_BADGES.filter((badge) => this.isEarned(badge, stats)).map(
      (badge) => ({
        key: badge.key,
        labelTh: badge.labelTh,
        descriptionTh: badge.descriptionTh,
        iconKey: badge.iconKey,
        tier: badge.tier,
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  private metricValue(metric: CitizenBadgeMetric, stats: CitizenStats): number {
    return stats[metric];
  }

  private isEarned(badge: CitizenBadge, stats: CitizenStats): boolean {
    return this.metricValue(badge.metric, stats) >= badge.threshold;
  }

  private toProgress(
    badge: CitizenBadge,
    stats: CitizenStats,
  ): CitizenBadgeProgress {
    const current = this.metricValue(badge.metric, stats);
    return {
      key: badge.key,
      labelTh: badge.labelTh,
      descriptionTh: badge.descriptionTh,
      iconKey: badge.iconKey,
      tier: badge.tier,
      earned: current >= badge.threshold,
      // Clamp the displayed progress at the target so a far-exceeding count
      // (e.g. 250 reactions vs target 100) still renders a full bar, not 250/100.
      progress: { current: Math.min(current, badge.threshold), target: badge.threshold },
    };
  }
}
