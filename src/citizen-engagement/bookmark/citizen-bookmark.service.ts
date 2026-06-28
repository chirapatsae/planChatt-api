import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, IsNull, Repository } from 'typeorm';

import {
  CitizenReactionType,
  emptyReactionBreakdown,
  isCitizenReactionType,
} from '../constants/citizen-reactions';
import { CitizenAuditLog } from '../entities/citizen-audit-log.entity';
import { CitizenBookmark } from '../entities/citizen-bookmark.entity';
import { CitizenPost } from '../entities/citizen-post.entity';
import { CitizenPostMedia } from '../entities/citizen-post-media.entity';
import { CitizenPostReaction } from '../entities/citizen-post-reaction.entity';
import { CitizenMediaService } from '../media/citizen-media.service';
import { CitizenPollService } from '../poll/citizen-poll.service';
import { CitizenRepostEmbedService } from '../citizen-repost-embed.service';
import {
  CitizenPostMediaDto,
  PollDto,
  PostDto,
  RepostEmbedDto,
  RepostTombstoneDto,
} from '../dto/citizen-post-response.dto';
import { ListCitizenBookmarksResponseDto } from '../dto/citizen-bookmark-response.dto';
import { ListCitizenBookmarksQueryDto } from '../dto/list-citizen-bookmarks-query.dto';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/**
 * CitizenBookmarkService — save / un-save posts (the X/IG "bookmark", W-S3).
 *
 * Private: only the owner reads their saved list (no public count). The toggle
 * mirrors the C3 follow toggle: find the live row → soft-delete it (un-save)
 * OR insert via `orIgnore()` (race-safe save). `listMine` re-uses the SAME
 * `PostDto` shape + author/media batch-load as the feed, newest-bookmark first.
 *
 * §17.3 isolation: touches ONLY `citizen_*` tables. Audit goes EXCLUSIVELY to
 * `citizen_audit_logs` (NEVER `tracking_status`). §17.2 advisory — a bookmark
 * gates no workflow transition.
 */
@Injectable()
export class CitizenBookmarkService {
  constructor(
    @InjectRepository(CitizenBookmark)
    private readonly bookmarkRepo: Repository<CitizenBookmark>,
    @InjectRepository(CitizenPostMedia)
    private readonly mediaRepo: Repository<CitizenPostMedia>,
    private readonly pollService: CitizenPollService,
    private readonly repostEmbedService: CitizenRepostEmbedService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Toggle the caller's bookmark of `postId`. The post MUST exist, be
   * `visible`, and not soft-deleted (`404 CITIZEN_POST_NOT_FOUND` otherwise).
   * Race-safe (`ON CONFLICT DO NOTHING` on re-save). Returns the resulting state.
   */
  async toggle(
    identityId: string,
    postId: string,
  ): Promise<{ bookmarked: boolean }> {
    return this.dataSource.transaction(async (em) => {
      const post = await em.getRepository(CitizenPost).findOne({
        where: { id: postId, moderationState: 'visible', deletedAt: IsNull() },
      });
      if (!post) {
        throw new NotFoundException('CITIZEN_POST_NOT_FOUND');
      }

      const repo = em.getRepository(CitizenBookmark);
      const live = await repo.findOne({
        where: { bookmarkerIdentityId: identityId, postId, deletedAt: IsNull() },
      });

      let bookmarked: boolean;
      if (live) {
        await repo.softDelete(live.id);
        bookmarked = false;
      } else {
        // Race-safe insert (same as the C3 follow toggle): `ON CONFLICT DO
        // NOTHING` lets a concurrent double-toggle hit the partial-unique
        // `… WHERE deleted_at IS NULL` without ABORTING the transaction.
        await repo
          .createQueryBuilder()
          .insert()
          .values({ bookmarkerIdentityId: identityId, postId })
          .orIgnore()
          .execute();
        bookmarked = true;
      }

      await this.writeAudit(em, identityId, postId, bookmarked);

      return { bookmarked };
    });
  }

  /**
   * The caller's saved posts — visible + not-deleted only, newest-bookmark
   * first. Same `PostDto` shape + author + media batch-load as the feed.
   * Keyset paginates by the bookmark's `createdAt` (then id) DESC.
   */
  async listMine(
    identityId: string,
    query: ListCitizenBookmarksQueryDto,
  ): Promise<ListCitizenBookmarksResponseDto> {
    const limit = Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

    const qb = this.bookmarkRepo
      .createQueryBuilder('b')
      .innerJoinAndSelect('b.post', 'p')
      // §17.3 / PDPA: load ONLY the author's id + public alias — never the
      // *_enc / *_hash PII columns (the response exposes displayAlias only).
      .leftJoin('p.author', 'author')
      .addSelect(['author.id', 'author.displayAlias'])
      .where('b.bookmarkerIdentityId = :identityId', { identityId })
      .andWhere('b.deletedAt IS NULL')
      .andWhere('p.moderationState = :state', { state: 'visible' })
      .andWhere('p.deletedAt IS NULL');

    if (query.beforeCreatedAt && query.beforeId) {
      // Keyset: bookmarks strictly after the cursor by (createdAt, id) DESC.
      qb.andWhere(
        '(b.createdAt < :beforeCreatedAt OR (b.createdAt = :beforeCreatedAt AND b.id < :beforeId))',
        { beforeCreatedAt: query.beforeCreatedAt, beforeId: query.beforeId },
      );
    }

    qb.orderBy('b.createdAt', 'DESC').addOrderBy('b.id', 'DESC').take(limit);

    const rows = await qb.getMany();

    // Batch-load media + reaction breakdowns for ALL returned posts in ONE
    // query EACH (avoid N+1).
    const mediaByPost = await this.batchLoadMediaForPosts(
      rows.map((b) => b.post.id),
    );
    const breakdownByPost = await this.batchLoadReactionBreakdowns(
      rows.map((b) => b.post.id),
    );
    // W-S2: resolve the repost embed for every bookmarked repost in ONE batch.
    const embedByRoot = await this.repostEmbedService.batchLoadEmbeds(
      rows.map((b) => b.post.repostOfId),
    );
    // W-S7: resolve the poll block for every bookmarked poll in TWO batched
    // queries (no N+1); non-poll rows produce no map entry.
    const pollByPost = await this.pollService.batchLoadPolls(
      rows.map((b) => b.post),
    );
    const items = rows.map((b) =>
      this.toPostDto(
        b.post,
        b.post.author?.displayAlias ?? '',
        mediaByPost.get(b.post.id) ?? [],
        breakdownByPost.get(b.post.id),
        b.post.repostOfId ? embedByRoot.get(b.post.repostOfId) : undefined,
        pollByPost.get(b.post.id),
      ),
    );

    const nextCursor =
      rows.length === limit
        ? {
            createdAt: rows[rows.length - 1].createdAt.toISOString(),
            id: rows[rows.length - 1].id,
          }
        : null;

    return { items, nextCursor };
  }

  /** The caller's live-bookmarked post ids (for FE card marking). */
  async listMyIds(identityId: string): Promise<string[]> {
    const rows = await this.bookmarkRepo.find({
      where: { bookmarkerIdentityId: identityId, deletedAt: IsNull() },
      select: ['postId'],
    });
    return rows.map((b) => b.postId);
  }

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  /** Insert the isolated audit row (§17.3 — NEVER tracking_status). */
  private async writeAudit(
    em: EntityManager,
    identityId: string,
    postId: string,
    bookmarked: boolean,
  ): Promise<void> {
    const row = em.getRepository(CitizenAuditLog).create({
      actorKind: 'citizen',
      actorId: identityId,
      action: 'bookmark.toggle',
      targetKind: 'post',
      targetId: postId,
      detail: { postId, bookmarked },
    });
    await em.getRepository(CitizenAuditLog).save(row);
  }

  private toPostDto(
    post: CitizenPost,
    displayAlias: string,
    media: CitizenPostMediaDto[],
    breakdown?: Record<CitizenReactionType, number>,
    repostOf?: RepostEmbedDto | RepostTombstoneDto,
    poll?: PollDto,
  ): PostDto {
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
      // W-GATE-1: `author.id` = the authorIdentityId (opaque uuid handle).
      author: { id: post.authorIdentityId, displayAlias },
      media,
      // W-S2: present ONLY when this bookmarked post is a repost.
      ...(repostOf !== undefined ? { repostOf } : {}),
      // W-S7: present ONLY when this bookmarked post is a poll.
      ...(poll !== undefined ? { poll } : {}),
    };
  }

  /**
   * Batch-load the live reaction breakdown for MANY posts in ONE grouped query
   * (avoid N+1), grouped by `(post_id, reaction_type)`. Empty input → empty map.
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

  private toMediaDto(media: CitizenPostMedia): CitizenPostMediaDto {
    return { id: media.id, url: CitizenMediaService.urlFor(media.id) };
  }

  /**
   * Batch-load ready media for MANY posts in ONE query, grouped by postId and
   * ordered by sortOrder ASC (avoid N+1). Empty input → empty map.
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
