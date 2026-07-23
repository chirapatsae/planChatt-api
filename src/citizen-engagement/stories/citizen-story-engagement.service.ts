import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, IsNull, MoreThan, Repository } from 'typeorm';

import { CitizenBlockService } from '../block/citizen-block.service';
import {
  StoryReactionKey,
  emptyStoryReactionBreakdown,
  isStoryReactionKey,
} from '../constants/citizen-story-reactions';
import {
  StoryAudienceDto,
  StoryAudienceItemDto,
  StoryDto,
  StoryGroupDto,
} from '../dto/citizen-story-response.dto';
import { CitizenIdentity } from '../entities/citizen-identity.entity';
import { CitizenStory } from '../entities/citizen-story.entity';
import { CitizenStoryReaction } from '../entities/citizen-story-reaction.entity';
import { CitizenStoryView } from '../entities/citizen-story-view.entity';
import { citizenAvatarUrl } from '../media/citizen-avatar.util';

/**
 * CitizenStoryEngagementService — VIEW tracking + emoji REACTIONS + the
 * owner-only audience page for the EPHEMERAL 24h stories (FB-6).
 *
 * Kept SEPARATE from `CitizenStoryService` (which owns create / image-serve /
 * delete) so the story-lifecycle service stays lean. §17.3 isolation: touches
 * ONLY `citizen_story` / `citizen_story_views` / `citizen_story_reactions` /
 * `citizen_identities` (+ the block read-filter). NO project / users /
 * work_history / tracking_status. §17.2 advisory — views/reactions gate no
 * workflow transition and, like the POST reaction precedent, write NO audit row
 * (they are the highest-frequency, lowest-value signals).
 *
 * Block semantics DIFFER by action intent:
 *   - a VIEW is a PASSIVE read-signal → a blocked-either-way pair is a SILENT
 *     no-op (never 403 — surfacing the block would leak block state on a read).
 *   - a REACTION is an ACTIVE write → a blocked-either-way pair is refused with
 *     `403 CITIZEN_BLOCKED` (mirrors the post reaction precedent).
 */
@Injectable()
export class CitizenStoryEngagementService {
  constructor(
    @InjectRepository(CitizenStory)
    private readonly storyRepo: Repository<CitizenStory>,
    @InjectRepository(CitizenStoryView)
    private readonly viewRepo: Repository<CitizenStoryView>,
    @InjectRepository(CitizenStoryReaction)
    private readonly reactionRepo: Repository<CitizenStoryReaction>,
    @InjectRepository(CitizenIdentity)
    private readonly identityRepo: Repository<CitizenIdentity>,
    private readonly blockService: CitizenBlockService,
    private readonly dataSource: DataSource,
  ) {}

  // ---------------------------------------------------------------------------
  // VIEW (passive read-signal)
  // ---------------------------------------------------------------------------

  /**
   * Record the caller's view of an ACTIVE story (idempotent first-view).
   *   - missing / expired / soft-deleted → 404 CITIZEN_STORY_NOT_FOUND
   *   - the caller's OWN story            → silent no-op (you don't view yourself)
   *   - a blocked-either-way pair         → SILENT no-op (never 403 on a read)
   *   - otherwise → upsert with ON CONFLICT (story_id, viewer_identity_id) DO
   *     NOTHING, so the FIRST-view timestamp is preserved and the count never
   *     inflates on a repeat open.
   */
  async recordView(viewerId: string, storyId: string): Promise<void> {
    const story = await this.loadActiveStory(storyId);
    if (story.authorIdentityId === viewerId) {
      return; // own story — no self-view row
    }
    if (
      await this.blockService.isBlockedEitherWay(viewerId, story.authorIdentityId)
    ) {
      return; // passive read: never leak block state — silent no-op
    }
    await this.upsertView(this.viewRepo, storyId, viewerId);
  }

  // ---------------------------------------------------------------------------
  // REACTION (active write)
  // ---------------------------------------------------------------------------

  /**
   * Upsert the caller's ONE reaction on an ACTIVE story (add / switch-in-place).
   *   - unknown emoji key         → 400 (defensive; the DTO already validates)
   *   - missing / expired         → 404 CITIZEN_STORY_NOT_FOUND
   *   - blocked-either-way pair   → 403 CITIZEN_BLOCKED (active write, unlike view)
   * One row per (story_id, identity_id): no live row → INSERT; different emoji →
   * UPDATE the key in place. Reacting ALSO records a view (upsert), except on the
   * caller's own story (mirrors the view no-op). Self-reaction is allowed
   * (mirrors the post reaction, where `isBlockedEitherWay` is false for self).
   */
  async react(
    reactorId: string,
    storyId: string,
    emoji: StoryReactionKey,
  ): Promise<{ emoji: StoryReactionKey }> {
    if (!isStoryReactionKey(emoji)) {
      throw new BadRequestException('CITIZEN_STORY_REACTION_INVALID');
    }
    const story = await this.loadActiveStory(storyId);
    if (
      await this.blockService.isBlockedEitherWay(reactorId, story.authorIdentityId)
    ) {
      throw new ForbiddenException('CITIZEN_BLOCKED');
    }

    await this.dataSource.transaction(async (em) => {
      const rRepo = em.getRepository(CitizenStoryReaction);
      const live = await rRepo.findOne({
        where: { storyId, identityId: reactorId },
      });
      if (live) {
        // Switch in place. The UNIQUE is on (story_id, identity_id), so an
        // UPDATE of the emoji key never trips it.
        if (live.emoji !== emoji) {
          await rRepo.update(live.id, { emoji });
        }
      } else {
        // Race-safe insert: ON CONFLICT DO NOTHING (orIgnore) lets a concurrent
        // double-tap hit the UNIQUE without ABORTING the transaction, then
        // reconcile the key so the caller's requested emoji is the final state.
        await rRepo
          .createQueryBuilder()
          .insert()
          .into(CitizenStoryReaction)
          .values({ storyId, identityId: reactorId, emoji })
          .orIgnore()
          .execute();
        await rRepo
          .createQueryBuilder()
          .update()
          .set({ emoji })
          .where('story_id = :storyId', { storyId })
          .andWhere('identity_id = :identityId', { identityId: reactorId })
          .execute();
      }

      // Reacting implies a view — upsert one (idempotent), except on own story.
      if (story.authorIdentityId !== reactorId) {
        await this.upsertView(em.getRepository(CitizenStoryView), storyId, reactorId);
      }
    });

    return { emoji };
  }

  /**
   * Remove the caller's reaction (HARD delete — 24h-ephemeral data has no
   * soft-delete). Idempotent: deleting a non-existent reaction is a 204 no-op.
   * No story existence check — a delete scoped to (story_id, identity_id) is
   * inherently safe and owner-scoped by the caller identity.
   */
  async removeReaction(reactorId: string, storyId: string): Promise<void> {
    await this.reactionRepo.delete({ storyId, identityId: reactorId });
  }

  // ---------------------------------------------------------------------------
  // AUDIENCE (owner-only "who viewed my story")
  // ---------------------------------------------------------------------------

  /**
   * The owner-only audience page for a story: who viewed it (+ their reaction),
   * newest-first, offset-paged, plus the reaction breakdown.
   *   - missing / expired → 404 CITIZEN_STORY_NOT_FOUND
   *   - caller ≠ owner    → 403 CITIZEN_STORY_NOT_OWNER (mirrors removeOwn)
   * Only ACTIVE identities are listed; viewers the owner mutes/blocks — or who
   * blocked the owner — are anti-joined out (mirrors the feed's block filter).
   * PII guard (§17.3): only the opaque viewer id + public alias + avatar leave
   * the service.
   */
  async getAudience(
    ownerId: string,
    storyId: string,
    limit: number,
    offset: number,
  ): Promise<StoryAudienceDto> {
    const story = await this.loadActiveStory(storyId);
    if (story.authorIdentityId !== ownerId) {
      throw new ForbiddenException('CITIZEN_STORY_NOT_OWNER');
    }

    // Anti-join set: viewers the owner mutes/blocks OR who blocked the owner
    // (mirrors how the feed excludes blocked authors — reused verbatim).
    const excluded = [
      ...(await this.blockService.excludedAuthorIdsForViewer(ownerId)),
    ];

    const base = this.viewRepo
      .createQueryBuilder('v')
      // Only ACTIVE, non-erased viewers surface in the audience.
      .innerJoin(
        CitizenIdentity,
        'idn',
        'idn.id = v.viewer_identity_id AND idn.status = :active AND idn.deleted_at IS NULL',
        { active: 'active' },
      )
      .where('v.story_id = :storyId', { storyId });
    if (excluded.length > 0) {
      base.andWhere('v.viewer_identity_id NOT IN (:...excluded)', { excluded });
    }

    const total = await base.clone().getCount();

    const rows = await base
      .clone()
      // Left-join the viewer's reaction (may be null — viewed without reacting).
      .leftJoin(
        CitizenStoryReaction,
        'r',
        'r.story_id = v.story_id AND r.identity_id = v.viewer_identity_id',
      )
      .select('v.viewer_identity_id', 'viewerId')
      .addSelect('v.viewed_at', 'viewedAt')
      .addSelect('idn.display_alias', 'displayAlias')
      .addSelect('idn.avatar_path', 'avatarPath')
      .addSelect('idn.updated_at', 'updatedAt')
      .addSelect('r.emoji', 'emoji')
      .orderBy('v.viewed_at', 'DESC')
      // Stable tiebreak so offset paging never drops/duplicates on equal times.
      .addOrderBy('v.viewer_identity_id', 'DESC')
      .limit(limit)
      .offset(offset)
      .getRawMany<{
        viewerId: string;
        viewedAt: Date;
        displayAlias: string;
        avatarPath: string | null;
        updatedAt: Date;
        emoji: string | null;
      }>();

    const items: StoryAudienceItemDto[] = rows.map((row) => ({
      viewerId: row.viewerId,
      displayAlias: row.displayAlias ?? '',
      avatarUrl: citizenAvatarUrl(row.viewerId, row.avatarPath, row.updatedAt),
      viewedAt: new Date(row.viewedAt).toISOString(),
      reaction: isStoryReactionKey(row.emoji) ? row.emoji : null,
    }));

    const reactionBreakdown = await this.loadAudienceBreakdown(storyId, excluded);

    return { items, total, reactionBreakdown };
  }

  // ---------------------------------------------------------------------------
  // PERSONALIZATION of the public active feed (FB-6)
  // ---------------------------------------------------------------------------

  /**
   * Enrich the public active-story groups for a LOGGED-IN caller: per story add
   * `viewedByMe` + `myReaction`, and `viewCount` ONLY on the caller's OWN
   * stories (counts are owner-private). Batched — three grouped queries total,
   * never N+1. The ANONYMOUS path never calls this, so its JSON stays
   * byte-identical to the pre-FB-6 shape.
   */
  async personalizeActive(
    groups: StoryGroupDto[],
    viewerId: string,
  ): Promise<StoryGroupDto[]> {
    const storyIds: string[] = [];
    const ownStoryIds: string[] = [];
    for (const group of groups) {
      const isOwner = group.author.id === viewerId;
      for (const story of group.stories) {
        storyIds.push(story.id);
        if (isOwner) ownStoryIds.push(story.id);
      }
    }
    if (storyIds.length === 0) {
      return groups;
    }

    // (1) which of these stories the caller has viewed.
    const viewedRows = await this.viewRepo.find({
      where: { storyId: In(storyIds), viewerIdentityId: viewerId },
      select: { storyId: true },
    });
    const viewedSet = new Set(viewedRows.map((r) => r.storyId));

    // (2) the caller's reaction per story.
    const reactionRows = await this.reactionRepo.find({
      where: { storyId: In(storyIds), identityId: viewerId },
      select: { storyId: true, emoji: true },
    });
    const myReactionByStory = new Map<string, StoryReactionKey>();
    for (const r of reactionRows) {
      if (isStoryReactionKey(r.emoji)) myReactionByStory.set(r.storyId, r.emoji);
    }

    // (3) viewCount for the caller's OWN stories only (owner-private).
    const viewCountByStory = await this.batchViewCounts(ownStoryIds);

    return groups.map((group) => {
      const isOwner = group.author.id === viewerId;
      return {
        ...group,
        stories: group.stories.map((story) => {
          const enriched: StoryDto = {
            ...story,
            viewedByMe: viewedSet.has(story.id),
            myReaction: myReactionByStory.get(story.id) ?? null,
          };
          if (isOwner) {
            enriched.viewCount = viewCountByStory.get(story.id) ?? 0;
          }
          return enriched;
        }),
      };
    });
  }

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  /**
   * Load an ACTIVE story (not expired, not soft-deleted) or throw the uniform
   * 404 — the SAME semantics as CitizenStoryService.getImage / removeOwn.
   */
  private async loadActiveStory(storyId: string): Promise<CitizenStory> {
    const story = await this.storyRepo.findOne({
      where: { id: storyId, expiresAt: MoreThan(new Date()), deletedAt: IsNull() },
    });
    if (!story) {
      throw new NotFoundException('CITIZEN_STORY_NOT_FOUND');
    }
    return story;
  }

  /**
   * Idempotent first-view upsert: ON CONFLICT (story_id, viewer_identity_id) DO
   * NOTHING (orIgnore) preserves the original `viewed_at` and never inflates the
   * count on a repeat open. Race-safe (never aborts the surrounding tx).
   */
  private async upsertView(
    repo: Repository<CitizenStoryView>,
    storyId: string,
    viewerId: string,
  ): Promise<void> {
    await repo
      .createQueryBuilder()
      .insert()
      .into(CitizenStoryView)
      .values({ storyId, viewerIdentityId: viewerId })
      .orIgnore()
      .execute();
  }

  /** Distinct viewer count per story (one grouped query). Empty input → empty map. */
  private async batchViewCounts(
    storyIds: string[],
  ): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    if (storyIds.length === 0) {
      return map;
    }
    const rows = await this.viewRepo
      .createQueryBuilder('v')
      .select('v.story_id', 'storyId')
      .addSelect('COUNT(*)', 'cnt')
      .where('v.story_id IN (:...storyIds)', { storyIds })
      .groupBy('v.story_id')
      .getRawMany<{ storyId: string; cnt: string }>();
    for (const row of rows) {
      map.set(row.storyId, Number(row.cnt));
    }
    return map;
  }

  /**
   * The per-emoji reaction breakdown for the audience — one grouped query,
   * counting only reactions from ACTIVE, non-excluded viewers. Zero-filled
   * (every key present).
   */
  private async loadAudienceBreakdown(
    storyId: string,
    excluded: string[],
  ): Promise<Record<StoryReactionKey, number>> {
    const qb = this.reactionRepo
      .createQueryBuilder('r')
      .innerJoin(
        CitizenIdentity,
        'idn',
        'idn.id = r.identity_id AND idn.status = :active AND idn.deleted_at IS NULL',
        { active: 'active' },
      )
      .select('r.emoji', 'emoji')
      .addSelect('COUNT(*)', 'cnt')
      .where('r.story_id = :storyId', { storyId });
    if (excluded.length > 0) {
      qb.andWhere('r.identity_id NOT IN (:...excluded)', { excluded });
    }
    const rows = await qb
      .groupBy('r.emoji')
      .getRawMany<{ emoji: string; cnt: string }>();

    const breakdown = emptyStoryReactionBreakdown();
    for (const row of rows) {
      if (isStoryReactionKey(row.emoji)) {
        breakdown[row.emoji] = Number(row.cnt);
      }
    }
    return breakdown;
  }
}
