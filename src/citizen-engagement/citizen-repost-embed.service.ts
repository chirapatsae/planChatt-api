import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';

import {
  CitizenPostMediaDto,
  RepostEmbedDto,
  RepostTombstoneDto,
} from './dto/citizen-post-response.dto';
import { CitizenPost } from './entities/citizen-post.entity';
import { CitizenPostMedia } from './entities/citizen-post-media.entity';
import { CitizenMediaService } from './media/citizen-media.service';
import { citizenAvatarUrl } from './media/citizen-avatar.util';

/**
 * CitizenRepostEmbedService — W-S2 shared embed batch-loader.
 *
 * Every read path that returns `PostDto`s (feed `list`, `detail`, bookmarks
 * `listMine`, profile `getMyPosts`) calls `batchLoadEmbeds(rootIds)` ONCE per
 * page to resolve the `repostOf` embed for the page's reposts. This avoids the
 * N+1 a per-row embed load would cause: ONE query for the originals (author
 * joined), ONE query for their media.
 *
 * Tombstone (§17.3 — hidden/removed originals NEVER leak): an original that is
 * NOT `moderation_state = 'visible'` OR is soft-deleted OR is simply missing
 * resolves to `{ unavailable: true }` instead of an embed. The embed carries
 * alias-only author data (never the *_enc / *_hash PII columns).
 *
 * Flatten-to-root (set at write time) guarantees `repostOfId` always points at
 * a ROOT original, so the embed itself is never a repost — no nested embeds.
 *
 * §17.2 advisory / §17.3 isolation: touches ONLY `citizen_*` tables.
 */
@Injectable()
export class CitizenRepostEmbedService {
  constructor(
    @InjectRepository(CitizenPost)
    private readonly postRepo: Repository<CitizenPost>,
    @InjectRepository(CitizenPostMedia)
    private readonly mediaRepo: Repository<CitizenPostMedia>,
  ) {}

  /**
   * Resolve the embed for every distinct root id in `rootIds`. Returns a map
   * `rootId → RepostEmbedDto | RepostTombstoneDto`. A root that is missing /
   * hidden / removed / deleted maps to the tombstone. Empty input → empty map.
   */
  async batchLoadEmbeds(
    rootIds: Array<string | null | undefined>,
    // W-T1: original authors the VIEWER mutes/blocks (or who blocked the viewer)
    // — their embedded post resolves to a TOMBSTONE so a block can't be evaded
    // via someone else's repost. Empty set (anonymous / no blocks) → unchanged.
    excludedAuthorIds: Set<string> = new Set(),
  ): Promise<Map<string, RepostEmbedDto | RepostTombstoneDto>> {
    const out = new Map<string, RepostEmbedDto | RepostTombstoneDto>();

    // De-duplicate + drop nulls (non-repost rows pass null here).
    const ids = [...new Set(rootIds.filter((id): id is string => !!id))];
    if (ids.length === 0) {
      return out;
    }

    // ONE query for the originals, alias-only author (§17.3 / PDPA: never the
    // *_enc / *_hash columns). NOTE: no `moderationState` filter here — a row
    // that exists but is hidden/removed must resolve to a TOMBSTONE, not be
    // absent (absent would be indistinguishable from a hard-deleted root, which
    // is also a tombstone — so the per-row branch below decides).
    const originals = await this.postRepo
      .createQueryBuilder('p')
      .leftJoin('p.author', 'author')
      .addSelect([
        'author.id',
        'author.displayAlias',
        'author.avatarPath',
        'author.updatedAt',
      ])
      .where('p.id IN (:...ids)', { ids })
      .andWhere('p.deletedAt IS NULL')
      .getMany();

    const visibleOriginals = originals.filter(
      (p) => p.moderationState === 'visible',
    );

    // ONE query for the VISIBLE originals' ready media, grouped by postId.
    const mediaByPost = await this.batchLoadMedia(
      visibleOriginals.map((p) => p.id),
    );

    const byId = new Map(originals.map((p) => [p.id, p]));
    const tombstone: RepostTombstoneDto = { unavailable: true };

    for (const id of ids) {
      const original = byId.get(id);
      if (!original || original.moderationState !== 'visible') {
        // Missing / hidden / removed / shadow → tombstone (never leak).
        out.set(id, tombstone);
        continue;
      }
      // W-T1: the viewer mutes/blocks this original's author → tombstone.
      if (excludedAuthorIds.has(original.authorIdentityId)) {
        out.set(id, tombstone);
        continue;
      }
      out.set(id, this.toEmbedDto(original, mediaByPost.get(id) ?? []));
    }

    return out;
  }

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  private toEmbedDto(
    post: CitizenPost,
    media: CitizenPostMediaDto[],
  ): RepostEmbedDto {
    return {
      id: post.id,
      postKind: post.postKind,
      lat: post.lat === null ? null : Number(post.lat),
      lng: post.lng === null ? null : Number(post.lng),
      amphoeId: post.amphoeId,
      category: post.category,
      title: post.title,
      detail: post.detail,
      heartCount: post.heartCount,
      reactionCount: post.heartCount,
      commentCount: post.commentCount,
      repostCount: post.repostCount,
      createdAt: (post.createdAt ?? new Date()).toISOString(),
      // W-GATE-1: `author.id` = the original author's identity uuid (opaque
      // handle; `authorIdentityId` is always persisted even if the join is lean).
      author: {
        id: post.author?.id ?? post.authorIdentityId,
        displayAlias: post.author?.displayAlias ?? '',
        avatarUrl: citizenAvatarUrl(
          post.author?.id ?? post.authorIdentityId,
          post.author?.avatarPath,
          post.author?.updatedAt,
        ),
      },
      media,
    };
  }

  private toMediaDto(media: CitizenPostMedia): CitizenPostMediaDto {
    return { id: media.id, url: CitizenMediaService.urlFor(media.id) };
  }

  private async batchLoadMedia(
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
