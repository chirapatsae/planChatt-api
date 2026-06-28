import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Brackets,
  DataSource,
  EntityManager,
  In,
  IsNull,
  Repository,
  SelectQueryBuilder,
} from 'typeorm';

import { computeRankScore } from './common/citizen-feed-ranking';
import {
  CitizenReactionType,
  DEFAULT_CITIZEN_REACTION,
  emptyReactionBreakdown,
  isCitizenReactionType,
} from './constants/citizen-reactions';
import { CreateCitizenPostDto } from './dto/create-citizen-post.dto';
import { ListCitizenPostsQueryDto } from './dto/list-citizen-posts-query.dto';
import {
  CitizenPostMediaDto,
  CommentDto,
  ListCitizenPostsResponseDto,
  PollDto,
  PostDetailDto,
  PostDto,
  RepostEmbedDto,
  RepostTombstoneDto,
} from './dto/citizen-post-response.dto';
import { CitizenAuditLog } from './entities/citizen-audit-log.entity';
import { CitizenIdentity } from './entities/citizen-identity.entity';
import { CitizenPost } from './entities/citizen-post.entity';
import { CitizenPostComment } from './entities/citizen-post-comment.entity';
import { CitizenPostMedia } from './entities/citizen-post-media.entity';
import { CitizenPostReaction } from './entities/citizen-post-reaction.entity';
import { CitizenMediaService } from './media/citizen-media.service';
import { CitizenMentionService } from './citizen-mention.service';
import { CitizenMentionDto } from './dto/citizen-mention-response.dto';
import { CitizenNotificationService } from './notification/citizen-notification.service';
import { CitizenOfficialResponseService } from './official-response/citizen-official-response.service';
import { CitizenPollService } from './poll/citizen-poll.service';
import { CitizenRepostEmbedService } from './citizen-repost-embed.service';
import { CitizenHashtagService } from './hashtag/citizen-hashtag.service';
import { CitizenPostHashtag } from './entities/citizen-post-hashtag.entity';
import { CitizenHashtag } from './entities/citizen-hashtag.entity';
import { CitizenFollowService } from './follow/citizen-follow.service';
import { FollowSetsDto } from './dto/citizen-follow-response.dto';
import { CitizenPublicProfileDto } from './dto/citizen-public-profile.dto';
import { CitizenBlockService } from './block/citizen-block.service';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
/** Cap on the owner-scoped `/me/reactions` map (newest-first) — bounds the FE marking payload. */
const MAX_MY_REACTIONS = 1000;

/**
 * CitizenPostService — the §17.2 ADVISORY civic-community board.
 *
 * §17.3 isolation: this service touches ONLY `citizen_*` tables. It NEVER reads
 * or writes any project entity / users / work_history / tracking_status. Audit
 * goes EXCLUSIVELY to `citizen_audit_logs` (NEVER `tracking_status`).
 *
 * Every WRITE runs inside `dataSource.transaction(async (em) => …)` (precedent:
 * public-engagement.service.ts toggleLike), so the counter increment + audit
 * row commit atomically with the row mutation.
 */
@Injectable()
export class CitizenPostService {
  constructor(
    @InjectRepository(CitizenPost)
    private readonly postRepo: Repository<CitizenPost>,
    @InjectRepository(CitizenPostComment)
    private readonly commentRepo: Repository<CitizenPostComment>,
    @InjectRepository(CitizenPostMedia)
    private readonly mediaRepo: Repository<CitizenPostMedia>,
    @InjectRepository(CitizenIdentity)
    private readonly identityRepo: Repository<CitizenIdentity>,
    private readonly mediaService: CitizenMediaService,
    private readonly mentionService: CitizenMentionService,
    private readonly notificationService: CitizenNotificationService,
    private readonly officialResponseService: CitizenOfficialResponseService,
    private readonly pollService: CitizenPollService,
    private readonly repostEmbedService: CitizenRepostEmbedService,
    private readonly hashtagService: CitizenHashtagService,
    private readonly followService: CitizenFollowService,
    private readonly blockService: CitizenBlockService,
    private readonly dataSource: DataSource,
  ) {}

  // ---------------------------------------------------------------------------
  // WRITES
  // ---------------------------------------------------------------------------

  /**
   * Create a post. Cross-field shape is enforced here (not at the DTO layer):
   *   - idea       → lat, lng, category, title required; detail OPTIONAL
   *                  (the citizen composer collapsed to a single idea-text
   *                  field → maps to `title`; `detail` may be null/empty)
   *   - discussion → (title OR detail) required; lat/lng/category FORCED null
   */
  async create(identityId: string, dto: CreateCitizenPostDto): Promise<PostDto> {
    let lat: number | null;
    let lng: number | null;
    let category: string | null;
    const title: string | null = dto.title ?? null;
    const detail: string | null = dto.detail ?? null;

    if (dto.postKind === 'idea') {
      const hasGeo = dto.lat !== undefined && dto.lat !== null && dto.lng !== undefined && dto.lng !== null;
      if (!hasGeo || !dto.category || !dto.title) {
        throw new BadRequestException('CITIZEN_POST_SHAPE_INVALID');
      }
      lat = dto.lat as number;
      lng = dto.lng as number;
      category = dto.category;
    } else {
      // discussion
      if (!dto.title && !dto.detail) {
        throw new BadRequestException('CITIZEN_POST_SHAPE_INVALID');
      }
      lat = null;
      lng = null;
      category = null;
    }

    return this.dataSource.transaction(async (em) => {
      const now = new Date();
      const post = em.getRepository(CitizenPost).create({
        authorIdentityId: identityId,
        postKind: dto.postKind,
        lat: lat === null ? null : String(lat),
        lng: lng === null ? null : String(lng),
        amphoeId: dto.amphoeId ?? null,
        category,
        title,
        detail,
        moderationState: 'visible',
        heartCount: 0,
        commentCount: 0,
        lastActivityAt: now,
      });
      const saved = await em.getRepository(CitizenPost).save(post);

      // W-F2: seed the advisory rank score from the persisted createdAt (zero
      // engagement at create) — same tx. `?? now` guards the create path where
      // the @CreateDateColumn is not yet hydrated on the returned object.
      saved.rankScore = computeRankScore({
        heartCount: 0,
        commentCount: 0,
        createdAt: saved.createdAt ?? now,
      });
      await em.getRepository(CitizenPost).save(saved);

      // Single-attach the caller's uploaded media (ownership + single-attach
      // re-asserted in the media service). Empty / undefined → no-op.
      await this.mediaService.attachMediaToPost(
        em,
        identityId,
        saved.id,
        dto.mediaIds ?? [],
      );

      // W-S4: parse #tags from the post body (title + detail) and link them —
      // IN this transaction, AFTER the post row exists (so `saved.id` is known).
      // No-op when the body carries no tags. §17.2 advisory.
      await this.hashtagService.extractAndLink(
        em,
        saved.id,
        [title, detail].filter((t): t is string => !!t).join(' '),
      );

      // W-S6: resolve + persist + notify @mentions in the SAME transaction. Each
      // requested id is validated (active citizen) + self/dup/blocked-dropped;
      // invalid ids are silently ignored (§17.2 advisory — never blocks the post).
      const mentions = await this.mentionService.processMentions(
        em,
        identityId,
        dto.mentions,
        { post: saved },
      );

      await this.writeAudit(em, identityId, 'post.create', 'post', saved.id, {
        postKind: saved.postKind,
      });

      const alias = await this.resolveAlias(em, identityId);
      const media = await this.loadMediaForPost(em, saved.id);
      return this.toPostDto(saved, alias, media, undefined, undefined, undefined, mentions);
    });
  }

  /**
   * Owner deletes their OWN post (soft-delete). Loads the live post, asserts the
   * caller is the author (`authorIdentityId === identityId`), then sets
   * `deletedAt` — every read filters `deletedAt IS NULL`, so it disappears from
   * the feed / detail / map at once. §17.2 advisory (no project / workflow
   * side-effect); §17.3 (the only FK is the author identity).
   */
  async softDeleteOwn(
    identityId: string,
    id: string,
  ): Promise<{ deleted: boolean }> {
    const post = await this.postRepo.findOne({ where: { id, deletedAt: IsNull() } });
    if (!post) throw new NotFoundException('CITIZEN_POST_NOT_FOUND');
    if (post.authorIdentityId !== identityId) {
      throw new ForbiddenException('NOT_POST_OWNER');
    }
    await this.postRepo.softDelete(id);
    return { deleted: true };
  }

  /**
   * W-S2 repost / quote. Share another post into the caller's feed, optionally
   * with a quote (their own text above the embedded original).
   *
   * A repost is a normal `citizen_post` row (`postKind = 'discussion'`,
   * geo/category null) whose `repostOfId` is set to the ROOT original and whose
   * `detail` holds the optional quote (`null` = pure share).
   *
   * FLATTEN-TO-ROOT: reposting a repost X references `X.repostOfId ?? X.id`, so
   * the embed is never nested. The target MUST be `visible` + not-deleted
   * (`404` otherwise); the root's denormalized `repostCount` is incremented in
   * the SAME transaction; an audit row is written (§17.3 — never
   * tracking_status). §17.2 advisory.
   */
  async repost(
    identityId: string,
    targetPostId: string,
    quoteText?: string,
  ): Promise<PostDto> {
    const quote: string | null = quoteText ?? null;

    return this.dataSource.transaction(async (em) => {
      const postRepo = em.getRepository(CitizenPost);

      // The TARGET (what the user clicked) MUST be visible + not-deleted. A
      // hidden / removed / deleted post cannot be reposted.
      const target = await postRepo.findOne({
        where: { id: targetPostId, moderationState: 'visible', deletedAt: IsNull() },
      });
      if (!target) {
        throw new NotFoundException('CITIZEN_POST_NOT_FOUND');
      }

      // W-T1 INTERACTION GUARD (block only): an actor blocked by the target
      // author — or who blocked them — cannot repost. `mute` does NOT restrict.
      if (await this.blockService.isBlockedEitherWay(identityId, target.authorIdentityId)) {
        throw new ForbiddenException('CITIZEN_BLOCKED');
      }

      // FLATTEN-TO-ROOT: if the target is itself a repost, reference its root so
      // the embed is never a repost-of-a-repost.
      const rootId = target.repostOfId ?? target.id;

      // Re-load the ROOT to increment its share count and confirm it is still a
      // live, visible post (defends against reposting via a repost whose root
      // was hidden after the repost was created). When the target IS the root
      // this is the same row.
      const root =
        rootId === target.id
          ? target
          : await postRepo.findOne({
              where: { id: rootId, moderationState: 'visible', deletedAt: IsNull() },
            });
      if (!root) {
        throw new NotFoundException('CITIZEN_POST_NOT_FOUND');
      }

      const now = new Date();
      const repost = postRepo.create({
        authorIdentityId: identityId,
        postKind: 'discussion',
        lat: null,
        lng: null,
        amphoeId: null,
        category: null,
        title: null,
        detail: quote,
        repostOfId: root.id,
        repostCount: 0,
        moderationState: 'visible',
        heartCount: 0,
        commentCount: 0,
        lastActivityAt: now,
      });
      const saved = await postRepo.save(repost);

      // W-F2: seed the advisory rank score (zero engagement at create) — same tx.
      saved.rankScore = computeRankScore({
        heartCount: 0,
        commentCount: 0,
        createdAt: saved.createdAt ?? now,
      });
      await postRepo.save(saved);

      // Increment the ROOT's denormalized share count in the same tx.
      root.repostCount = root.repostCount + 1;
      await postRepo.save(root);

      await this.writeAudit(em, identityId, 'post.repost', 'post', saved.id, {
        repostOfId: root.id,
        hasQuote: quote !== null,
      });

      const alias = await this.resolveAlias(em, identityId);
      // The embed is the ROOT — visible here (guarded above) — with author +
      // media in ONE batch call. The new repost carries no media of its own.
      const embedByRoot = await this.repostEmbedService.batchLoadEmbeds([root.id]);
      return this.toPostDto(saved, alias, [], undefined, embedByRoot.get(root.id));
    });
  }

  /** Add a comment to a visible post; increments commentCount in the same tx. */
  async addComment(
    identityId: string,
    postId: string,
    text: string,
    mentionIds?: string[],
  ): Promise<CommentDto> {
    return this.dataSource.transaction(async (em) => {
      const post = await em.getRepository(CitizenPost).findOne({
        where: { id: postId, moderationState: 'visible', deletedAt: IsNull() },
      });
      if (!post) {
        throw new NotFoundException('CITIZEN_POST_NOT_FOUND');
      }

      // W-T1 INTERACTION GUARD (block only): an actor blocked by the author —
      // or who blocked the author — cannot comment. `mute` does NOT restrict.
      if (await this.blockService.isBlockedEitherWay(identityId, post.authorIdentityId)) {
        throw new ForbiddenException('CITIZEN_BLOCKED');
      }

      const comment = em.getRepository(CitizenPostComment).create({
        postId,
        authorIdentityId: identityId,
        text,
        moderationState: 'visible',
      });
      const saved = await em.getRepository(CitizenPostComment).save(comment);

      post.commentCount = post.commentCount + 1;
      // W-F2: recompute the advisory rank score after the comment lands —
      // recency stays anchored to createdAt (no necro-bump). Same tx.
      post.lastActivityAt = new Date();
      post.rankScore = computeRankScore({
        heartCount: post.heartCount,
        commentCount: post.commentCount,
        createdAt: post.createdAt,
      });
      await em.getRepository(CitizenPost).save(post);

      // Notify the post author "X commented on your post" (D14) — same tx,
      // self-comment is a NO-OP in the notification service.
      await this.notificationService.notifyOnComment(
        em,
        post,
        identityId,
        saved.id,
      );

      // W-S6: resolve + persist + notify @mentions on the COMMENT in the SAME tx.
      // The source carries the parent post (for the notification post pointer) +
      // the new comment id (so the mention rows + the FE link target a comment).
      const mentions = await this.mentionService.processMentions(
        em,
        identityId,
        mentionIds,
        { post, commentId: saved.id },
      );

      await this.writeAudit(em, identityId, 'comment.create', 'comment', saved.id, {
        postId,
      });

      const alias = await this.resolveAlias(em, identityId);
      return this.toCommentDto(saved, alias, mentions);
    });
  }

  /**
   * Toggle / switch the caller's reaction on a visible post (W-S1). ONE reaction
   * per citizen via the partial-unique `(post_id, identity_id) WHERE deleted_at
   * IS NULL`; `reaction_type` is which of the 4 keys. State machine:
   *   - no live reaction        → INSERT with `reactionType` (add)
   *   - live reaction SAME type → soft-delete (remove)
   *   - live reaction DIFF type → UPDATE the type in place (switch)
   *
   * `heartCount` / `reactionCount` = the authoritative count of ALL live
   * reactions for the post (ANY type), so ranking is unchanged (more reactions =
   * higher engagement). `rankScore` is recomputed in-tx (W-F2).
   */
  async toggleReaction(
    identityId: string,
    postId: string,
    reactionType: CitizenReactionType = DEFAULT_CITIZEN_REACTION,
  ): Promise<{
    reacted: boolean;
    reactionType: CitizenReactionType | null;
    reactionCount: number;
    breakdown: Record<CitizenReactionType, number>;
  }> {
    // Defensive: the controller DTO already validates, but never trust the type.
    const type: CitizenReactionType = isCitizenReactionType(reactionType)
      ? reactionType
      : DEFAULT_CITIZEN_REACTION;

    return this.dataSource.transaction(async (em) => {
      const post = await em.getRepository(CitizenPost).findOne({
        where: { id: postId, moderationState: 'visible', deletedAt: IsNull() },
      });
      if (!post) {
        throw new NotFoundException('CITIZEN_POST_NOT_FOUND');
      }

      // W-T1 INTERACTION GUARD (block only): an actor blocked by the author —
      // or who blocked the author — cannot react. `mute` does NOT restrict.
      if (await this.blockService.isBlockedEitherWay(identityId, post.authorIdentityId)) {
        throw new ForbiddenException('CITIZEN_BLOCKED');
      }

      const reactionRepo = em.getRepository(CitizenPostReaction);
      const live = await reactionRepo.findOne({
        where: {
          postId,
          identityId,
          reaction: 'heart',
          deletedAt: IsNull(),
        },
      });

      let reacted: boolean;
      let resultType: CitizenReactionType | null;
      if (live && live.reactionType === type) {
        // SAME type → remove (un-react).
        await reactionRepo.softDelete(live.id);
        reacted = false;
        resultType = null;
      } else if (live) {
        // DIFFERENT type → switch in place. The partial-unique is on
        // `(post_id, identity_id)`, so an UPDATE of the type never trips it.
        await reactionRepo.update(live.id, { reactionType: type });
        reacted = true;
        resultType = type;
      } else {
        // No live reaction → ADD. Race-safe insert: `ON CONFLICT DO NOTHING`
        // (orIgnore) lets a concurrent double-toggle hit the partial-unique
        // `… WHERE deleted_at IS NULL` without ABORTING the surrounding
        // transaction (a plain INSERT would put the tx in the 25P02 aborted
        // state and break the recovery read). Either way the caller ends up
        // reacted with `type`.
        await reactionRepo
          .createQueryBuilder()
          .insert()
          .values({ postId, identityId, reaction: 'heart', reactionType: type })
          .orIgnore()
          .execute();
        reacted = true;
        resultType = type;

        // Notify the post author (D14) — ONLY on the first add, never on switch
        // or un-react; same tx, self-react is a NO-OP in the service.
        await this.notificationService.notifyOnHeart(em, post, identityId);
      }

      // Authoritative recount of ALL live reactions (any type) — never drifts
      // negative, race-safe. This is the engagement signal that drives ranking.
      const reactionCount = await reactionRepo.count({
        where: { postId, reaction: 'heart', deletedAt: IsNull() },
      });
      post.heartCount = reactionCount;
      // W-F2: recompute the advisory rank score after the authoritative recount
      // (covers add / switch / remove) — recency anchored to createdAt. Same tx.
      post.lastActivityAt = new Date();
      post.rankScore = computeRankScore({
        heartCount: post.heartCount,
        commentCount: post.commentCount,
        createdAt: post.createdAt,
      });
      await em.getRepository(CitizenPost).save(post);

      // Live breakdown for THIS post — ONE grouped query (no per-type counts).
      const breakdown = await this.loadReactionBreakdownForPost(em, postId);

      await this.writeAudit(em, identityId, 'reaction.toggle', 'reaction', postId, {
        postId,
        reacted,
        reactionType: resultType,
      });

      return { reacted, reactionType: resultType, reactionCount, breakdown };
    });
  }

  /**
   * The caller's live reactions as a `{ [postId]: reactionType }` map (W-S1 FE
   * card marking). Owner-scoped from `req.user.identityId` — NO IDOR. Capped to
   * the most recent `MAX_MY_REACTIONS` live reactions (newest first) so the map
   * stays bounded for the feed.
   */
  async listMyReactions(
    identityId: string,
  ): Promise<Record<string, CitizenReactionType>> {
    const rows = await this.dataSource
      .getRepository(CitizenPostReaction)
      .find({
        where: { identityId, reaction: 'heart', deletedAt: IsNull() },
        select: ['postId', 'reactionType'],
        order: { createdAt: 'DESC' },
        take: MAX_MY_REACTIONS,
      });
    const map: Record<string, CitizenReactionType> = {};
    for (const r of rows) {
      if (isCitizenReactionType(r.reactionType)) {
        map[r.postId] = r.reactionType;
      }
    }
    return map;
  }


  // ---------------------------------------------------------------------------
  // READS (public — visible + not-soft-deleted only)
  // ---------------------------------------------------------------------------

  async list(
    query: ListCitizenPostsQueryDto,
    viewerId?: string,
  ): Promise<ListCitizenPostsResponseDto> {
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
    await this.applyBlockFilter(qb, viewerId);

    if (query.kind) {
      qb.andWhere('p.postKind = :kind', { kind: query.kind });
    }
    if (query.category) {
      qb.andWhere('p.category = :category', { category: query.category });
    }
    if (query.amphoeId) {
      qb.andWhere('p.amphoeId = :amphoeId', { amphoeId: query.amphoeId });
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

    // Shared hydration tail: PostDto + media / reactions / embed / poll
    // batch-load (no N+1) + (rankScore, id) cursor.
    return this.hydratePostPage(rows, limit, viewerId);
  }

  /**
   * Personalized "following" feed (C3 / W-GATE-1): visible + not-deleted posts
   * whose amphoe is a followed AREA OR whose category is a followed TOPIC OR
   * whose author is a followed PERSON. The three predicates are OR-UNIONed in
   * ONE query (a post matching more than one is naturally de-duped — a single
   * row can only return once). Same keyset + author + media batch-load as
   * `list()`. No follows (all three sets empty) → empty page (following nobody
   * yields nothing, never the global feed).
   */
  async listFollowedFeed(
    identityId: string,
    sets: FollowSetsDto,
    query: ListCitizenPostsQueryDto,
  ): Promise<ListCitizenPostsResponseDto> {
    const viewerId = identityId; // the follower IS the viewer (W-T1 embed filter)
    const amphoes = sets.amphoes ?? [];
    const categories = sets.categories ?? [];
    const people = sets.people ?? [];
    if (amphoes.length === 0 && categories.length === 0 && people.length === 0) {
      return { items: [], nextCursor: null };
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

    // W-T1: the followed feed is always viewed by the authenticated follower —
    // hide muted/blocked authors + authors who blocked the viewer.
    await this.applyBlockFilter(qb, identityId);

    // Match a followed target: amphoe IN followed-areas OR category IN
    // followed-topics OR author IN followed-people (W-GATE-1). At least one set
    // is non-empty (guarded above). A row matching multiple predicates returns
    // exactly once (one DB row → one result), so the UNION is inherently de-duped.
    qb.andWhere(
      new Brackets((b) => {
        let matched = false;
        if (amphoes.length > 0) {
          b.orWhere('p.amphoeId IN (:...amphoes)', { amphoes });
          matched = true;
        }
        if (categories.length > 0) {
          b.orWhere('p.category IN (:...categories)', { categories });
          matched = true;
        }
        if (people.length > 0) {
          b.orWhere('p.authorIdentityId IN (:...people)', { people });
          matched = true;
        }
        // Defensive: an impossible no-match would otherwise widen to all rows.
        if (!matched) {
          b.where('1 = 0');
        }
      }),
    );

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

    // Shared hydration tail (no N+1) — see hydratePostPage.
    return this.hydratePostPage(rows, limit, viewerId);
  }

  async detail(id: string, viewerId?: string): Promise<PostDetailDto> {
    // §17.3 / PDPA: load ONLY the author's id + public alias — never the
    // *_enc / *_hash PII columns (the response exposes displayAlias only).
    const post = await this.postRepo
      .createQueryBuilder('p')
      .leftJoin('p.author', 'author')
      .addSelect(['author.id', 'author.displayAlias'])
      .where('p.id = :id', { id })
      .andWhere('p.moderationState = :state', { state: 'visible' })
      .andWhere('p.deletedAt IS NULL')
      .getOne();
    if (!post) {
      throw new NotFoundException('CITIZEN_POST_NOT_FOUND');
    }

    // W-T1: if the viewer mutes/blocks the post author (or that author blocked
    // the viewer), the detail page is hidden — behave as not-found (consistent
    // with the feed never surfacing the post in the first place).
    const excluded = await this.blockService.excludedAuthorIdsForViewer(viewerId);
    if (excluded.has(post.authorIdentityId)) {
      throw new NotFoundException('CITIZEN_POST_NOT_FOUND');
    }

    const commentsQb = this.commentRepo
      .createQueryBuilder('c')
      .leftJoin('c.author', 'author')
      .addSelect(['author.id', 'author.displayAlias'])
      .where('c.postId = :id', { id })
      .andWhere('c.moderationState = :state', { state: 'visible' })
      .andWhere('c.deletedAt IS NULL');
    // W-T1: filter comments from muted/blocked authors + authors who blocked the
    // viewer (mutual invisibility on the comment author dimension).
    if (excluded.size > 0) {
      commentsQb.andWhere('c.authorIdentityId NOT IN (:...excludedAuthorIds)', {
        excludedAuthorIds: [...excluded],
      });
    }
    const comments = await commentsQb.orderBy('c.createdAt', 'ASC').getMany();

    const media = await this.loadMediaForPost(this.dataSource.manager, id);

    // W-S1: live reaction breakdown for the detail view (single grouped query).
    const breakdown = await this.loadReactionBreakdownForPost(
      this.dataSource.manager,
      id,
    );

    // C4 (plan D12): official staff responses — DETAIL read only (list() omits).
    const officialResponses = await this.officialResponseService.listForPost(id);

    // W-S2: if this post is a repost, resolve its embed (or tombstone).
    const repostOf = post.repostOfId
      ? (
          await this.repostEmbedService.batchLoadEmbeds(
            [post.repostOfId],
            excluded,
          )
        ).get(post.repostOfId)
      : undefined;

    // W-S7: if this post is a poll, resolve its options + aggregate counts.
    const poll =
      post.postKind === 'poll'
        ? (await this.pollService.batchLoadPolls([post])).get(post.id)
        : undefined;

    // W-S6: hydrate @mentions for the post + every comment (reload-linkify).
    const postMentions = (await this.mentionService.loadMentionsForPosts([id])).get(
      id,
    );
    const mentionsByComment = await this.mentionService.loadMentionsForComments(
      comments.map((c) => c.id),
    );

    return {
      ...this.toPostDto(
        post,
        post.author?.displayAlias ?? '',
        media,
        breakdown,
        repostOf,
        poll,
        postMentions,
      ),
      comments: comments.map((c) =>
        this.toCommentDto(
          c,
          c.author?.displayAlias ?? '',
          mentionsByComment.get(c.id),
        ),
      ),
      officialResponses,
    };
  }

  /**
   * W-GATE-1: PUBLIC profile of any citizen — `{ id, displayAlias, postCount,
   * followerCount }`. No auth (a citizen profile is public). 404 when the
   * identity is missing / blocked / soft-deleted.
   *
   * PRIVACY (D16): `followerCount` is a public COUNT; the follower ROSTER is
   * NEVER exposed. PII guard (§17.3): only the uuid + alias leave the service.
   */
  async getPublicProfile(identityId: string): Promise<CitizenPublicProfileDto> {
    // §17.3 / PDPA: load ONLY the id + public alias — never the *_enc / *_hash
    // PII columns (only the uuid + alias leave this service).
    const identity = await this.identityRepo.findOne({
      where: { id: identityId, status: 'active', deletedAt: IsNull() },
      select: { id: true, displayAlias: true },
    });
    if (!identity) {
      throw new NotFoundException('CITIZEN_IDENTITY_NOT_FOUND');
    }

    // postCount = the citizen's PUBLIC posts (visible, not removed/hidden, not
    // soft-deleted) — mirrors what the public `getPublicPosts` page would show.
    const postCount = await this.postRepo.count({
      where: {
        authorIdentityId: identityId,
        moderationState: 'visible',
        deletedAt: IsNull(),
      },
    });

    const followerCount = await this.followService.getFollowerCount(identityId);

    return {
      id: identity.id,
      displayAlias: identity.displayAlias,
      postCount,
      followerCount,
    };
  }

  /**
   * W-GATE-1: PUBLIC keyset list of a citizen's `visible` + not-deleted posts.
   * Same PostDto + batch-load (media / reactions / embed / poll) AND the same
   * (rankScore, id) DESC keyset + cursor shape as the global feed `list()`, so
   * the FE consumes the identical `ListCitizenPostsResponseDto`. 404 when the
   * identity is missing / blocked / soft-deleted.
   */
  async getPublicPosts(
    identityId: string,
    query: ListCitizenPostsQueryDto,
    viewerId?: string,
  ): Promise<ListCitizenPostsResponseDto> {
    // §17.3 / PDPA: existence/active check only — load just the id, never the
    // *_enc / *_hash PII columns (the alias is resolved via the join below).
    const identity = await this.identityRepo.findOne({
      where: { id: identityId, status: 'active', deletedAt: IsNull() },
      select: { id: true },
    });
    if (!identity) {
      throw new NotFoundException('CITIZEN_IDENTITY_NOT_FOUND');
    }

    const limit = Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

    const qb = this.postRepo
      .createQueryBuilder('p')
      // §17.3 / PDPA: load ONLY the author's id + public alias — never the
      // *_enc / *_hash PII columns (the response exposes displayAlias only).
      .leftJoin('p.author', 'author')
      .addSelect(['author.id', 'author.displayAlias'])
      .where('p.authorIdentityId = :identityId', { identityId })
      .andWhere('p.moderationState = :state', { state: 'visible' })
      .andWhere('p.deletedAt IS NULL');

    // W-T1: if the viewer mutes/blocks this author (or this author blocked the
    // viewer), the whole page is filtered out → an empty page.
    await this.applyBlockFilter(qb, viewerId);

    if (query.beforeRankScore !== undefined && query.beforeId) {
      // W-F2 keyset: rows strictly after the cursor by (rankScore, id) DESC.
      qb.andWhere(
        '(p.rankScore < :beforeRankScore OR (p.rankScore = :beforeRankScore AND p.id < :beforeId))',
        { beforeRankScore: query.beforeRankScore, beforeId: query.beforeId },
      );
    }

    qb.orderBy('p.rankScore', 'DESC').addOrderBy('p.id', 'DESC').take(limit);

    const rows = await qb.getMany();

    // Shared hydration tail (no N+1) — see hydratePostPage.
    return this.hydratePostPage(rows, limit, viewerId);
  }

  /**
   * W-S4: PUBLIC keyset list of VISIBLE posts that carry a given hashtag. The
   * raw `:tag` path param is normalized to its canonical key
   * (`CitizenHashtagService.normalizeTag`) before the lookup, so `#สวน`, `สวน`,
   * and `Park` all resolve. Joins through `citizen_post_hashtag` →
   * `citizen_hashtag` to filter, then reuses the SAME PostDto + batch-load
   * (media / reactions / embed / poll) + (rankScore, id) DESC keyset + cursor
   * shape as the global feed `list()`, so the FE consumes the identical
   * `ListCitizenPostsResponseDto`. An unknown tag → an empty page (never 404 —
   * a tag with no posts is a valid empty search).
   */
  async listByHashtag(
    rawTag: string,
    query: ListCitizenPostsQueryDto,
    viewerId?: string,
  ): Promise<ListCitizenPostsResponseDto> {
    const tag = CitizenHashtagService.normalizeTag(rawTag);
    if (!tag) {
      return { items: [], nextCursor: null };
    }

    const limit = Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

    const qb = this.postRepo
      .createQueryBuilder('p')
      // Join through the link table to the dictionary; filter visible posts that
      // carry this exact normalized tag.
      .innerJoin(CitizenPostHashtag, 'ph', 'ph.post_id = p.id')
      .innerJoin(CitizenHashtag, 'h', 'h.id = ph.hashtag_id AND h.tag = :tag', {
        tag,
      })
      // §17.3 / PDPA: load ONLY the author's id + public alias — never the
      // *_enc / *_hash PII columns (the response exposes displayAlias only).
      .leftJoin('p.author', 'author')
      .addSelect(['author.id', 'author.displayAlias'])
      .where('p.moderationState = :state', { state: 'visible' })
      .andWhere('p.deletedAt IS NULL');

    // W-T1: hide muted/blocked authors + authors who blocked the viewer.
    await this.applyBlockFilter(qb, viewerId);

    if (query.beforeRankScore !== undefined && query.beforeId) {
      // W-F2 keyset: rows strictly after the cursor by (rankScore, id) DESC.
      qb.andWhere(
        '(p.rankScore < :beforeRankScore OR (p.rankScore = :beforeRankScore AND p.id < :beforeId))',
        { beforeRankScore: query.beforeRankScore, beforeId: query.beforeId },
      );
    }

    qb.orderBy('p.rankScore', 'DESC').addOrderBy('p.id', 'DESC').take(limit);

    const rows = await qb.getMany();

    // Shared hydration tail (no N+1) — see hydratePostPage.
    return this.hydratePostPage(rows, limit, viewerId);
  }

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  /**
   * Shared keyset-page hydration: turn already-fetched, already-ordered
   * `(rankScore, id) DESC` rows into a `ListCitizenPostsResponseDto`. Batch-loads
   * media / reaction breakdowns / repost embeds / polls in ONE query EACH (no
   * N+1), maps each row through `toPostDto`, and emits the (rankScore, id) cursor
   * when the page is full.
   *
   * PUBLIC so sibling read services (W-S5 search) reuse the EXACT same PostDto +
   * batch-load + cursor shape as the feed without duplicating the logic. The
   * caller owns the `WHERE` clause + ordering; this owns the hydration tail.
   */
  async hydratePostPage(
    rows: CitizenPost[],
    limit: number,
    viewerId?: string,
  ): Promise<ListCitizenPostsResponseDto> {
    const mediaByPost = await this.batchLoadMediaForPosts(rows.map((p) => p.id));
    const breakdownByPost = await this.batchLoadReactionBreakdowns(
      rows.map((p) => p.id),
    );
    // W-T1: tombstone repost embeds whose ORIGINAL author the viewer mutes/blocks
    // (or who blocked the viewer) — so a blocked author's post can't leak via
    // someone else's repost embed. Anonymous viewer → empty set → unchanged.
    const excludedAuthorIds =
      await this.blockService.excludedAuthorIdsForViewer(viewerId);
    const embedByRoot = await this.repostEmbedService.batchLoadEmbeds(
      rows.map((p) => p.repostOfId),
      excludedAuthorIds,
    );
    const pollByPost = await this.pollService.batchLoadPolls(rows);
    // W-S6: hydrate resolved @mentions so they linkify on reload (not just on
    // the create response). One batched query, alias-only.
    const mentionsByPost = await this.mentionService.loadMentionsForPosts(
      rows.map((p) => p.id),
    );
    const items = rows.map((p) =>
      this.toPostDto(
        p,
        p.author?.displayAlias ?? '',
        mediaByPost.get(p.id) ?? [],
        breakdownByPost.get(p.id),
        p.repostOfId ? embedByRoot.get(p.repostOfId) : undefined,
        pollByPost.get(p.id),
        mentionsByPost.get(p.id),
      ),
    );

    const nextCursor =
      rows.length === limit
        ? {
            rankScore: rows[rows.length - 1].rankScore,
            id: rows[rows.length - 1].id,
          }
        : null;

    return { items, nextCursor };
  }

  /**
   * W-T1 READ-FILTER: when a viewer identity is present, exclude posts whose
   * author the viewer mutes-or-blocks AND posts whose author has BLOCKED the
   * viewer (mutual invisibility for 'block'). Anonymous viewer (no id) → no-op
   * (the public board is shown unfiltered). Mutates `qb` in place so the keyset
   * cursor (which counts the post-filter rows) stays correct.
   */
  private async applyBlockFilter(
    qb: SelectQueryBuilder<CitizenPost>,
    viewerId: string | undefined,
  ): Promise<void> {
    const excluded = await this.blockService.excludedAuthorIdsForViewer(viewerId);
    if (excluded.size > 0) {
      qb.andWhere('p.authorIdentityId NOT IN (:...excludedAuthorIds)', {
        excludedAuthorIds: [...excluded],
      });
    }
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

  private async resolveAlias(
    em: EntityManager,
    identityId: string,
  ): Promise<string> {
    const identity = await em.getRepository(CitizenIdentity).findOne({
      where: { id: identityId },
      // §17.3 / PDPA: alias-only — never pull *_enc / *_hash into memory just to
      // read the public alias.
      select: { id: true, displayAlias: true },
    });
    return identity?.displayAlias ?? '';
  }

  private toPostDto(
    post: CitizenPost,
    displayAlias: string,
    media: CitizenPostMediaDto[],
    breakdown?: Record<CitizenReactionType, number>,
    repostOf?: RepostEmbedDto | RepostTombstoneDto,
    poll?: PollDto,
    mentions?: CitizenMentionDto[],
  ): PostDto {
    // W-S1: `reactionCount` is the total live engagement (= `heartCount`); the
    // breakdown is zero-filled (every key present) when not batch-loaded.
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
      // alias-only: `heartCount` mirrors `reactionCount` for back-compat.
      heartCount: post.heartCount,
      reactionCount: post.heartCount,
      reactionBreakdown,
      commentCount: post.commentCount,
      // W-S2: this row's own denormalized share count.
      repostCount: post.repostCount ?? 0,
      // `?? new Date()` guards the create/insert path where the DB-populated
      // @CreateDateColumn is not yet hydrated on the returned object.
      createdAt: (post.createdAt ?? new Date()).toISOString(),
      // W-GATE-1: `author.id` = the authorIdentityId (an opaque uuid handle for
      // follow + profile link). NEVER the *_enc / *_hash PII columns.
      author: { id: post.authorIdentityId, displayAlias },
      media,
      // W-S2: present ONLY when this post is a repost; the caller resolves the
      // embed (or tombstone) via CitizenRepostEmbedService.
      ...(repostOf !== undefined ? { repostOf } : {}),
      // W-S7: present ONLY when this post is a poll (`postKind = 'poll'`); the
      // caller batch-loads the options + aggregate counts via
      // CitizenPollService.batchLoadPolls (D16 — counts only, no who-voted-what).
      ...(poll !== undefined ? { poll } : {}),
      // W-S6: present ONLY when the post carries @mentions (resolved at create
      // time, alias-only) so the FE can linkify @alias → profile.
      ...(mentions !== undefined && mentions.length > 0 ? { mentions } : {}),
    };
  }

  /**
   * Live reaction breakdown for ONE post — a single grouped query. Returns a
   * zero-filled `{ like, love, support, insightful }` (every key present).
   */
  private async loadReactionBreakdownForPost(
    em: EntityManager,
    postId: string,
  ): Promise<Record<CitizenReactionType, number>> {
    const rows = await em
      .getRepository(CitizenPostReaction)
      .createQueryBuilder('r')
      .select('r.reaction_type', 'reactionType')
      .addSelect('COUNT(*)', 'count')
      .where('r.post_id = :postId', { postId })
      .andWhere('r.reaction = :reaction', { reaction: 'heart' })
      .andWhere('r.deleted_at IS NULL')
      .groupBy('r.reaction_type')
      .getRawMany<{ reactionType: string; count: string }>();

    const breakdown = emptyReactionBreakdown();
    for (const row of rows) {
      if (isCitizenReactionType(row.reactionType)) {
        breakdown[row.reactionType] = Number(row.count);
      }
    }
    return breakdown;
  }

  /**
   * Batch-load the live reaction breakdown for MANY posts in ONE grouped query
   * (avoid N+1 on the feed), grouped by `(post_id, reaction_type)`. Every
   * returned post id gets a zero-filled breakdown; ids absent from the result
   * map fall back to a zeroed breakdown at the call site. Empty input → empty map.
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

  /** Load one post's ready, non-deleted media in sortOrder ASC. */
  private async loadMediaForPost(
    em: EntityManager,
    postId: string,
  ): Promise<CitizenPostMediaDto[]> {
    const rows = await em.getRepository(CitizenPostMedia).find({
      where: { postId, status: 'ready', deletedAt: IsNull() },
      order: { sortOrder: 'ASC' },
    });
    return rows.map((m) => this.toMediaDto(m));
  }

  /**
   * Batch-load ready media for MANY posts in ONE query, grouped by postId and
   * ordered by sortOrder ASC (avoid N+1 on the feed). Empty input → empty map.
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

  private toCommentDto(
    comment: CitizenPostComment,
    displayAlias: string,
    mentions?: CitizenMentionDto[],
  ): CommentDto {
    return {
      id: comment.id,
      text: comment.text,
      createdAt: (comment.createdAt ?? new Date()).toISOString(),
      // W-GATE-1: `author.id` = the comment author's identity uuid (opaque handle).
      author: { id: comment.authorIdentityId, displayAlias },
      // W-S6: present ONLY when the comment carries @mentions (alias-only).
      ...(mentions !== undefined && mentions.length > 0 ? { mentions } : {}),
    };
  }
}
