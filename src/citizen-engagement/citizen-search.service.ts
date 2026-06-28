import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CitizenBlockService } from './block/citizen-block.service';
import { CitizenPostService } from './citizen-post.service';
import { escapeLike } from './citizen-search.util';
import { ListCitizenPostsResponseDto } from './dto/citizen-post-response.dto';
import { SearchCitizenPostsQueryDto } from './dto/search-citizen-posts-query.dto';
import { CitizenPost } from './entities/citizen-post.entity';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/** deg-per-km approximation for the geo bounding box (1 deg ≈ 111 km). */
const KM_PER_DEGREE = 111.0;

/**
 * Escape the LIKE/ILIKE wildcard metacharacters so user text matches LITERALLY.
 *
 * `%`, `_`, and the escape char `\` are neutralised; the result is then wrapped
 * `%…%` by the caller for a substring match. The escaped string is ALWAYS bound
 * as a parameter (never concatenated into SQL), so there is no SQL injection and
 * no ReDoS (ILIKE is not a regex). Thai has no word boundaries, so a substring
 * ILIKE is the correct + simple match.
 */
// `escapeLike` moved to the service-free `citizen-search.util` to break a
// require cycle (CitizenMentionService also imports it). Imported above for
// local use; re-exported here so existing importers of this module keep working.
export { escapeLike };

/**
 * CitizenSearchService — W-S5 discovery (§17.2 advisory). Reads the EXISTING
 * `citizen_post` table ONLY (§17.3 isolation — no new table, no new FK).
 *
 * Combines an OPTIONAL Thai-substring TEXT filter with an OPTIONAL GEO bounding
 * box (idea posts near a point), AND-combined. Reuses the W-F2 ranked keyset
 * (rankScore, id) DESC + the shared `CitizenPostService.hydratePostPage` so the
 * FE consumes the identical `ListCitizenPostsResponseDto` as the feed.
 */
@Injectable()
export class CitizenSearchService {
  constructor(
    @InjectRepository(CitizenPost)
    private readonly postRepo: Repository<CitizenPost>,
    private readonly postService: CitizenPostService,
    private readonly blockService: CitizenBlockService,
  ) {}

  async search(
    query: SearchCitizenPostsQueryDto,
    viewerId?: string,
  ): Promise<ListCitizenPostsResponseDto> {
    const q = query.q?.trim() ?? '';
    const hasText = q.length >= 1;

    // GEO is all-or-none: lat + lng + radiusKm must ALL be present, or NONE.
    const geoParts = [query.lat, query.lng, query.radiusKm].filter(
      (v) => v !== undefined && v !== null,
    );
    if (geoParts.length > 0 && geoParts.length < 3) {
      throw new BadRequestException('CITIZEN_SEARCH_EMPTY');
    }
    const hasGeo = geoParts.length === 3;

    // Require at least one of: text OR the full geo triple.
    if (!hasText && !hasGeo) {
      throw new BadRequestException('CITIZEN_SEARCH_EMPTY');
    }

    const limit = Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

    const qb = this.postRepo
      .createQueryBuilder('p')
      // §17.3 / PDPA: load ONLY the author's id + public alias — never the
      // *_enc / *_hash PII columns (the response exposes displayAlias only).
      .leftJoin('p.author', 'author')
      .addSelect(['author.id', 'author.displayAlias'])
      .where('p.moderationState = :state', { state: 'visible' })
      .andWhere('p.deletedAt IS NULL');

    // W-T1: hide muted/blocked authors + authors who blocked the viewer.
    const excluded = await this.blockService.excludedAuthorIdsForViewer(viewerId);
    if (excluded.size > 0) {
      qb.andWhere('p.authorIdentityId NOT IN (:...excludedAuthorIds)', {
        excludedAuthorIds: [...excluded],
      });
    }

    if (hasText) {
      // Thai substring ILIKE over title OR detail. The query is LIKE-escaped and
      // bound as a parameter (no SQL injection, no ReDoS).
      const like = `%${escapeLike(q)}%`;
      qb.andWhere('(p.title ILIKE :like OR p.detail ILIKE :like)', { like });
    }

    if (hasGeo) {
      // GEO restricts to idea posts inside a bounding box centred on (lat,lng).
      // d = radiusKm / 111 (deg≈km). A box, not a circle — cheap + index-able;
      // the FE may refine by exact distance.
      const lat = query.lat as number;
      const lng = query.lng as number;
      const radiusKm = query.radiusKm as number;
      const d = radiusKm / KM_PER_DEGREE;
      // A degree of longitude shrinks by cos(latitude), so to cover the same
      // km east-west we need a WIDER degree delta. Clamp cos to avoid blow-up
      // near the poles (irrelevant for นครราชสีมา but defensive).
      const lngD = d / Math.max(0.01, Math.cos((lat * Math.PI) / 180));
      qb.andWhere('p.postKind = :ideaKind', { ideaKind: 'idea' })
        .andWhere('p.lat BETWEEN :latMin AND :latMax', {
          latMin: lat - d,
          latMax: lat + d,
        })
        .andWhere('p.lng BETWEEN :lngMin AND :lngMax', {
          lngMin: lng - lngD,
          lngMax: lng + lngD,
        });
    }

    if (query.kind) {
      qb.andWhere('p.postKind = :kind', { kind: query.kind });
    }

    if (query.beforeRankScore !== undefined && query.beforeId) {
      // W-F2 keyset: rows strictly after the cursor by (rankScore, id) DESC.
      qb.andWhere(
        '(p.rankScore < :beforeRankScore OR (p.rankScore = :beforeRankScore AND p.id < :beforeId))',
        { beforeRankScore: query.beforeRankScore, beforeId: query.beforeId },
      );
    }

    qb.orderBy('p.rankScore', 'DESC').addOrderBy('p.id', 'DESC').take(limit);

    const rows = await qb.getMany();

    // Reuse the feed's PostDto + batch-load (media / reactions / embed / poll) +
    // (rankScore, id) cursor shape — no duplication. Pass viewerId so repost
    // embeds of muted/blocked authors are tombstoned too (W-T1).
    return this.postService.hydratePostPage(rows, limit, viewerId);
  }
}
