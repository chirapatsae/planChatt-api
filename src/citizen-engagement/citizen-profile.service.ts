import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, EntityManager, In, IsNull, Not, Repository } from 'typeorm';

import {
  CITIZEN_PRESENCE_VISIBILITY_EVENT,
  type CitizenPresenceVisibilityEvent,
} from './chat/citizen-chat.events';
import { citizenAvatarUrl } from './media/citizen-avatar.util';

import {
  CitizenReactionType,
  emptyReactionBreakdown,
  isCitizenReactionType,
} from './constants/citizen-reactions';
import {
  MyPostDto,
  MyPostsResponseDto,
  MyProfileDto,
} from './dto/citizen-profile-response.dto';
import {
  CitizenPostMediaDto,
  RepostEmbedDto,
  RepostTombstoneDto,
} from './dto/citizen-post-response.dto';
import { CitizenRepostEmbedService } from './citizen-repost-embed.service';
import { UpdateCitizenProfileDto } from './dto/update-citizen-profile.dto';
import { CitizenAuditLog } from './entities/citizen-audit-log.entity';
import { CitizenIdentity } from './entities/citizen-identity.entity';
import { CitizenPost } from './entities/citizen-post.entity';
import { CitizenPostMedia } from './entities/citizen-post-media.entity';
import { CitizenPostReaction } from './entities/citizen-post-reaction.entity';
import { CitizenMediaService } from './media/citizen-media.service';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/**
 * CitizenProfileService — the OWNER-scoped citizen profile surface (C1).
 *
 * §17.3 isolation: this service touches ONLY `citizen_*` tables. It NEVER reads
 * or writes any project entity / users / work_history / tracking_status. The
 * profile-edit audit goes EXCLUSIVELY to `citizen_audit_logs`.
 *
 * The acting identity is ALWAYS passed in as `identityId` (resolved from
 * `req.user.identityId` by `CitizenJwtGuard`) — never from a body/param.
 */
@Injectable()
export class CitizenProfileService {
  constructor(
    @InjectRepository(CitizenIdentity)
    private readonly identityRepo: Repository<CitizenIdentity>,
    @InjectRepository(CitizenPost)
    private readonly postRepo: Repository<CitizenPost>,
    @InjectRepository(CitizenPostMedia)
    private readonly mediaRepo: Repository<CitizenPostMedia>,
    private readonly repostEmbedService: CitizenRepostEmbedService,
    private readonly dataSource: DataSource,
    private readonly events: EventEmitter2,
  ) {}

  // ---------------------------------------------------------------------------
  // READS (owner-scoped)
  // ---------------------------------------------------------------------------

  /**
   * The caller's own profile + lifetime stats.
   *
   *   postCount      = own posts, NOT soft-deleted, NOT removed
   *   heartsReceived = SUM(heartCount) over own VISIBLE, NOT-soft-deleted posts
   *   joinedAt       = identity.createdAt
   */
  async getProfile(identityId: string): Promise<MyProfileDto> {
    // §17.3 / PDPA: load ONLY the fields the profile DTO needs (id, alias,
    // joinedAt) — never the *_enc / *_hash PII columns.
    const identity = await this.identityRepo.findOne({
      where: { id: identityId, deletedAt: IsNull() },
      select: {
        id: true,
        displayAlias: true,
        bio: true,
        showOnlineStatus: true,
        avatarPath: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (!identity) {
      throw new NotFoundException('CITIZEN_IDENTITY_NOT_FOUND');
    }
    return this.computeProfile(identity);
  }

  /**
   * The caller's own posts, newest first, keyset-paginated.
   *
   * OWN posts only (`authorIdentityId = me`), `deletedAt IS NULL`, ALL
   * moderation states (the owner sees their own posts even when hidden /
   * pending). Keyset shape mirrors `CitizenPostService.list` exactly.
   */
  async getMyPosts(
    identityId: string,
    limit?: number,
    beforeCreatedAt?: string,
    beforeId?: string,
  ): Promise<MyPostsResponseDto> {
    const take = Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT);

    // §17.3 / PDPA: alias + avatar only — never the *_enc / *_hash PII columns.
    // `avatarPath` / `updatedAt` feed the owner's own avatar on the card.
    const identity = await this.identityRepo.findOne({
      where: { id: identityId, deletedAt: IsNull() },
      select: { id: true, displayAlias: true, avatarPath: true, updatedAt: true },
    });
    if (!identity) {
      throw new NotFoundException('CITIZEN_IDENTITY_NOT_FOUND');
    }
    const authorAvatarUrl = citizenAvatarUrl(
      identity.id,
      identity.avatarPath,
      identity.updatedAt,
    );

    const qb = this.postRepo
      .createQueryBuilder('p')
      .where('p.authorIdentityId = :identityId', { identityId })
      .andWhere('p.deletedAt IS NULL');

    if (beforeCreatedAt && beforeId) {
      // Keyset: rows strictly older than the cursor by (createdAt, id) DESC.
      qb.andWhere(
        '(p.createdAt < :beforeCreatedAt OR (p.createdAt = :beforeCreatedAt AND p.id < :beforeId))',
        { beforeCreatedAt, beforeId },
      );
    }

    qb.orderBy('p.createdAt', 'DESC').addOrderBy('p.id', 'DESC').take(take);

    const rows = await qb.getMany();
    // Batch-load media for the page in ONE query (avoid N+1), mirroring
    // CitizenPostService.list so "my posts" shows the owner's photos too.
    const mediaByPost = await this.batchLoadMediaForPosts(rows.map((p) => p.id));
    const breakdownByPost = await this.batchLoadReactionBreakdowns(
      rows.map((p) => p.id),
    );
    // W-S2: resolve the repost embed for every repost in the page in ONE batch.
    const embedByRoot = await this.repostEmbedService.batchLoadEmbeds(
      rows.map((p) => p.repostOfId),
    );
    const items = rows.map((p) =>
      this.toMyPostDto(
        p,
        identity.displayAlias,
        mediaByPost.get(p.id) ?? [],
        breakdownByPost.get(p.id),
        p.repostOfId ? embedByRoot.get(p.repostOfId) : undefined,
        authorAvatarUrl,
      ),
    );

    const nextCursor =
      rows.length === take
        ? {
            createdAt: rows[rows.length - 1].createdAt.toISOString(),
            id: rows[rows.length - 1].id,
          }
        : null;

    return { items, nextCursor };
  }

  // ---------------------------------------------------------------------------
  // WRITE (owner-scoped)
  // ---------------------------------------------------------------------------

  /**
   * Edit the caller's `displayAlias` — the ONLY editable PII-safe field.
   * Runs in a transaction: load (404 if missing/deleted), set the trimmed
   * alias, save, write a `profile.update` audit row, return the fresh profile.
   */
  async updateProfile(
    identityId: string,
    dto: UpdateCitizenProfileDto,
  ): Promise<MyProfileDto> {
    return this.dataSource.transaction(async (em) => {
      const identity = await em.getRepository(CitizenIdentity).findOne({
        where: { id: identityId, deletedAt: IsNull() },
      });
      if (!identity) {
        throw new NotFoundException('CITIZEN_IDENTITY_NOT_FOUND');
      }

      identity.displayAlias = dto.displayAlias.trim();
      // bio: absent (undefined) = leave unchanged; empty/whitespace = clear.
      if (dto.bio !== undefined) {
        const trimmedBio = dto.bio.trim();
        identity.bio = trimmedBio.length > 0 ? trimmedBio : null;
      }
      // Presence privacy toggle — absent = leave unchanged.
      let onlineStatusChanged = false;
      if (dto.showOnlineStatus !== undefined && dto.showOnlineStatus !== identity.showOnlineStatus) {
        identity.showOnlineStatus = dto.showOnlineStatus;
        onlineStatusChanged = true;
      }
      await em.getRepository(CitizenIdentity).save(identity);

      await this.writeAudit(em, identityId, 'profile.update', 'identity', identityId, {
        displayAlias: identity.displayAlias,
        bio: identity.bio,
        showOnlineStatus: identity.showOnlineStatus,
      });

      const profile = await this.computeProfile(identity, em);
      // Tell the presence gateway to re-broadcast the (now hidden/visible) state
      // mid-session. Fired AFTER the row is saved; the gateway is decoupled via
      // the global EventEmitter (no WS dependency in this service).
      if (onlineStatusChanged) {
        this.events.emit(CITIZEN_PRESENCE_VISIBILITY_EVENT, {
          identityId,
          showOnlineStatus: identity.showOnlineStatus,
        } satisfies CitizenPresenceVisibilityEvent);
      }
      return profile;
    });
  }

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  /**
   * Build the MyProfileDto for a loaded identity, computing the two stats.
   * Uses the supplied EntityManager's repo when inside a transaction, otherwise
   * the injected repo.
   */
  private async computeProfile(
    identity: CitizenIdentity,
    em?: EntityManager,
  ): Promise<MyProfileDto> {
    const postRepo = em ? em.getRepository(CitizenPost) : this.postRepo;

    const postCount = await postRepo.count({
      where: {
        authorIdentityId: identity.id,
        deletedAt: IsNull(),
        moderationState: Not('removed'),
      },
    });

    const raw = await postRepo
      .createQueryBuilder('p')
      .select('COALESCE(SUM(p.heartCount), 0)', 'sum')
      .where('p.authorIdentityId = :identityId', { identityId: identity.id })
      .andWhere('p.deletedAt IS NULL')
      .andWhere('p.moderationState = :state', { state: 'visible' })
      .getRawOne<{ sum: string }>();
    const heartsReceived = Number(raw?.sum ?? 0);

    return {
      id: identity.id,
      displayAlias: identity.displayAlias,
      bio: identity.bio ?? null,
      showOnlineStatus: identity.showOnlineStatus ?? true,
      avatarUrl: citizenAvatarUrl(identity.id, identity.avatarPath, identity.updatedAt),
      joinedAt: (identity.createdAt ?? new Date()).toISOString(),
      postCount,
      heartsReceived,
    };
  }

  /** Insert the isolated audit row (§17.3 — NEVER tracking_status). */
  private async writeAudit(
    em: EntityManager,
    identityId: string,
    action: string,
    targetKind: string,
    targetId: string | null,
    detail: Record<string, unknown>,
  ): Promise<void> {
    const row = em.getRepository(CitizenAuditLog).create({
      actorKind: 'citizen',
      actorId: identityId,
      action,
      targetKind,
      targetId,
      detail,
    });
    await em.getRepository(CitizenAuditLog).save(row);
  }

  private toMyPostDto(
    post: CitizenPost,
    displayAlias: string,
    media: CitizenPostMediaDto[],
    breakdown?: Record<CitizenReactionType, number>,
    repostOf?: RepostEmbedDto | RepostTombstoneDto,
    avatarUrl: string | null = null,
  ): MyPostDto {
    const reactionBreakdown = breakdown ?? emptyReactionBreakdown();
    return {
      id: post.id,
      postKind: post.postKind,
      lat: post.lat === null ? null : Number(post.lat),
      lng: post.lng === null ? null : Number(post.lng),
      amphoeId: post.amphoeId,
      category: post.category,
      title: post.title,
      detail: post.detail,
      // alias-only: `heartCount` mirrors `reactionCount` for back-compat (W-S1).
      heartCount: post.heartCount,
      reactionCount: post.heartCount,
      reactionBreakdown,
      commentCount: post.commentCount,
      // W-S2: this row's own denormalized share count.
      repostCount: post.repostCount ?? 0,
      createdAt: (post.createdAt ?? new Date()).toISOString(),
      moderationState: post.moderationState,
      // W-GATE-1: `author.id` = the authorIdentityId (opaque uuid handle).
      author: { id: post.authorIdentityId, displayAlias, avatarUrl },
      // Owner-hide flag so the profile "my posts" view can badge a hidden post.
      ownerHidden: post.ownerHidden ?? false,
      media,
      // W-S2: present ONLY when this owned post is a repost.
      ...(repostOf !== undefined ? { repostOf } : {}),
    };
  }

  /**
   * Batch-load the live reaction breakdown for MANY posts in ONE grouped query
   * (avoid N+1 on the my-posts page), grouped by `(post_id, reaction_type)`.
   * Empty input → empty map.
   */
  private async batchLoadReactionBreakdowns(
    postIds: string[],
  ): Promise<Map<string, Record<CitizenReactionType, number>>> {
    const grouped = new Map<string, Record<CitizenReactionType, number>>();
    if (postIds.length === 0) {
      return grouped;
    }
    const rows = await this.dataSource
      .getRepository(CitizenPostReaction)
      .createQueryBuilder('r')
      .select('r.post_id', 'postId')
      .addSelect('r.reaction_type', 'reactionType')
      .addSelect('COUNT(*)', 'count')
      .where('r.post_id IN (:...postIds)', { postIds })
      .andWhere('r.reaction = :reaction', { reaction: 'heart' })
      .andWhere('r.deleted_at IS NULL')
      .groupBy('r.post_id')
      .addGroupBy('r.reaction_type')
      .getRawMany<{ postId: string; reactionType: string; count: string }>();

    for (const row of rows) {
      const bucket = grouped.get(row.postId) ?? emptyReactionBreakdown();
      if (isCitizenReactionType(row.reactionType)) {
        bucket[row.reactionType] = Number(row.count);
      }
      grouped.set(row.postId, bucket);
    }
    return grouped;
  }

  /** Map a media row to its public DTO (single URL-prefix source of truth). */
  private toMediaDto(media: CitizenPostMedia): CitizenPostMediaDto {
    return { id: media.id, url: CitizenMediaService.urlFor(media.id) };
  }

  /**
   * Batch-load ready media for MANY posts in ONE query, grouped by postId and
   * ordered by sortOrder ASC (avoid N+1). Empty input → empty map. Mirrors
   * CitizenPostService.batchLoadMediaForPosts.
   */
  private async batchLoadMediaForPosts(
    postIds: string[],
  ): Promise<Map<string, CitizenPostMediaDto[]>> {
    const grouped = new Map<string, CitizenPostMediaDto[]>();
    if (postIds.length === 0) {
      return grouped;
    }
    const rows = await this.mediaRepo.find({
      where: { postId: In(postIds), status: 'ready', deletedAt: IsNull() },
      order: { sortOrder: 'ASC' },
    });
    for (const m of rows) {
      const key = m.postId as string;
      const bucket = grouped.get(key) ?? [];
      bucket.push(this.toMediaDto(m));
      grouped.set(key, bucket);
    }
    return grouped;
  }
}
