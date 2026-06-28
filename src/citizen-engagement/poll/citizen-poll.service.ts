import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, IsNull, Repository } from 'typeorm';

import { computeRankScore } from '../common/citizen-feed-ranking';
import { emptyReactionBreakdown } from '../constants/citizen-reactions';
import { CreateCitizenPollDto } from '../dto/create-citizen-poll.dto';
import {
  PollDto,
  PollOptionDto,
  PostDto,
} from '../dto/citizen-post-response.dto';
import { CitizenAuditLog } from '../entities/citizen-audit-log.entity';
import { CitizenIdentity } from '../entities/citizen-identity.entity';
import { CitizenPollOption } from '../entities/citizen-poll-option.entity';
import { CitizenPollVote } from '../entities/citizen-poll-vote.entity';
import { CitizenPost } from '../entities/citizen-post.entity';
import { CitizenHashtagService } from '../hashtag/citizen-hashtag.service';

/** Max options per poll — mirrors the DTO `@ArrayMaxSize(6)` / contract 2..6. */
const MAX_POLL_OPTIONS = 6;
const MIN_POLL_OPTIONS = 2;

/**
 * CitizenPollService — civic polls (W-S7, §17.2 ADVISORY).
 *
 * A poll is a `citizen_post` with `post_kind = 'poll'` (question = `detail`),
 * 2..6 `citizen_poll_option` rows, and one live `citizen_poll_vote` per citizen.
 * The vote toggle mirrors the C2 reaction / C3 follow / W-S3 bookmark toggle:
 *   - no live vote          → INSERT (cast) + option `vote_count` +1
 *   - live vote, DIFF option → soft-delete old (−1) + insert new (+1) = change-vote
 *   - live vote, SAME option → soft-delete (un-vote, −1)
 *
 * D16 vote privacy: who-voted-what is recorded on `citizen_poll_vote` but NEVER
 * exposed publicly. Public reads return aggregate `vote_count` per option; the
 * caller's OWN vote comes from the owner-scoped `listMyVotes`.
 *
 * §17.3 isolation: touches ONLY `citizen_*` tables. Audit goes EXCLUSIVELY to
 * `citizen_audit_logs` (NEVER `tracking_status`). Every WRITE runs inside
 * `dataSource.transaction(async (em) => …)` so the option-tally increment + the
 * vote row + the audit row commit atomically.
 */
@Injectable()
export class CitizenPollService {
  constructor(
    @InjectRepository(CitizenPollOption)
    private readonly optionRepo: Repository<CitizenPollOption>,
    @InjectRepository(CitizenPollVote)
    private readonly voteRepo: Repository<CitizenPollVote>,
    private readonly hashtagService: CitizenHashtagService,
    private readonly dataSource: DataSource,
  ) {}

  // ---------------------------------------------------------------------------
  // WRITES
  // ---------------------------------------------------------------------------

  /**
   * Create a poll post: the `citizen_post` (`post_kind='poll'`, detail=question,
   * geo/category null) + its 2..6 option rows + the seeded rank score, all in
   * ONE transaction. Returns the `PostDto` with the attached freshly-zeroed
   * `poll` block.
   *
   * Validation (re-asserted beyond the DTO bounds): 2..6 options, each non-empty
   * after trim → `CITIZEN_POLL_OPTIONS_INVALID` otherwise; an empty question →
   * `CITIZEN_POLL_QUESTION_REQUIRED`.
   */
  async createPoll(
    identityId: string,
    dto: CreateCitizenPollDto,
  ): Promise<PostDto> {
    const question = (dto.question ?? '').trim();
    if (!question) {
      throw new BadRequestException('CITIZEN_POLL_QUESTION_REQUIRED');
    }

    const labels = (dto.options ?? [])
      .map((o) => (o ?? '').trim())
      .filter((o) => o.length > 0);
    if (labels.length < MIN_POLL_OPTIONS || labels.length > MAX_POLL_OPTIONS) {
      throw new BadRequestException('CITIZEN_POLL_OPTIONS_INVALID');
    }

    // Optional close time. A past close time at creation would make the poll
    // born-closed — reject it (a poll must be votable when posted).
    let closesAt: Date | null = null;
    if (dto.closesAt) {
      const parsed = new Date(dto.closesAt);
      if (Number.isNaN(parsed.getTime())) {
        throw new BadRequestException('CITIZEN_POLL_CLOSES_AT_INVALID');
      }
      if (parsed.getTime() <= Date.now()) {
        throw new BadRequestException('CITIZEN_POLL_CLOSES_AT_INVALID');
      }
      closesAt = parsed;
    }

    return this.dataSource.transaction(async (em) => {
      const now = new Date();
      const postRepo = em.getRepository(CitizenPost);
      const post = postRepo.create({
        authorIdentityId: identityId,
        postKind: 'poll',
        lat: null,
        lng: null,
        amphoeId: null,
        category: null,
        title: null,
        detail: question,
        pollClosesAt: closesAt,
        moderationState: 'visible',
        heartCount: 0,
        commentCount: 0,
        lastActivityAt: now,
      });
      const saved = await postRepo.save(post);

      // W-F2: seed the advisory rank score (zero engagement at create) — same tx.
      saved.rankScore = computeRankScore({
        heartCount: 0,
        commentCount: 0,
        createdAt: saved.createdAt ?? now,
      });
      await postRepo.save(saved);

      // Insert the option rows in submitted order (sortOrder = index).
      const optionRepo = em.getRepository(CitizenPollOption);
      const options: CitizenPollOption[] = [];
      for (let i = 0; i < labels.length; i++) {
        const option = optionRepo.create({
          postId: saved.id,
          label: labels[i],
          sortOrder: i,
          voteCount: 0,
        });
        options.push(await optionRepo.save(option));
      }

      // W-S4: parse #tags from the poll question (= the post `detail`) and link
      // them — IN this transaction, AFTER the post row exists. No-op when the
      // question carries no tags. §17.2 advisory.
      await this.hashtagService.extractAndLink(em, saved.id, question);

      await this.writeAudit(em, identityId, 'poll.create', 'post', saved.id, {
        optionCount: options.length,
        hasCloseTime: closesAt !== null,
      });

      const alias = await this.resolveAlias(em, identityId);
      const poll = this.toPollDto(saved, options, now);
      return this.toPostDto(saved, alias, poll);
    });
  }

  /**
   * Cast / change / un-cast the caller's vote on a poll (W-S7). The post MUST be
   * a visible, not-deleted `poll` that is NOT closed; the option MUST belong to
   * that poll. State machine (one live vote per citizen):
   *   - no live vote          → INSERT (orIgnore, race-safe) + option +1
   *   - live vote, DIFF option → soft-delete old (−1) + insert new (+1)
   *   - live vote, SAME option → soft-delete (un-vote, −1)  ← same option twice removes
   *
   * Returns the fresh aggregate result + the caller's resulting `myOptionId`
   * (`null` after un-vote). The option counts are RECONCILED from the live vote
   * rows (never drift negative; race-safe) rather than trusting the in-memory
   * denormalized field.
   */
  async vote(
    identityId: string,
    postId: string,
    optionId: string,
  ): Promise<{
    options: PollOptionDto[];
    totalVotes: number;
    myOptionId: string | null;
    closesAt: string | null;
    closed: boolean;
  }> {
    return this.dataSource.transaction(async (em) => {
      const post = await em.getRepository(CitizenPost).findOne({
        where: {
          id: postId,
          postKind: 'poll',
          moderationState: 'visible',
          deletedAt: IsNull(),
        },
      });
      if (!post) {
        throw new NotFoundException('CITIZEN_POLL_NOT_FOUND');
      }
      if (this.isClosed(post, new Date())) {
        throw new BadRequestException('CITIZEN_POLL_CLOSED');
      }

      const optionRepo = em.getRepository(CitizenPollOption);
      const option = await optionRepo.findOne({ where: { id: optionId, postId } });
      if (!option) {
        // Option missing OR belongs to a different poll → reject (not-in-poll).
        throw new BadRequestException('CITIZEN_POLL_OPTION_INVALID');
      }

      const voteRepo = em.getRepository(CitizenPollVote);
      const live = await voteRepo.findOne({
        where: { postId, voterIdentityId: identityId, deletedAt: IsNull() },
      });

      let myOptionId: string | null;
      if (live && live.optionId === optionId) {
        // SAME option → un-vote (remove).
        await voteRepo.softDelete(live.id);
        myOptionId = null;
      } else if (live) {
        // DIFFERENT option → change-vote: drop the old, insert the new.
        await voteRepo.softDelete(live.id);
        await voteRepo
          .createQueryBuilder()
          .insert()
          .values({ postId, optionId, voterIdentityId: identityId })
          .orIgnore()
          .execute();
        myOptionId = optionId;
      } else {
        // No live vote → cast. Race-safe insert: `ON CONFLICT DO NOTHING`
        // (orIgnore) lets a concurrent double-vote hit the partial-unique
        // `(post_id, voter_identity_id) WHERE deleted_at IS NULL` WITHOUT
        // aborting the surrounding transaction (a plain INSERT would put the tx
        // in the 25P02 aborted state and break the recovery recount).
        await voteRepo
          .createQueryBuilder()
          .insert()
          .values({ postId, optionId, voterIdentityId: identityId })
          .orIgnore()
          .execute();
        myOptionId = optionId;
      }

      // Authoritative per-option recount from the live vote rows (race-safe,
      // never negative), then persist the reconciled denormalized counts.
      const options = await optionRepo.find({
        where: { postId },
        order: { sortOrder: 'ASC' },
      });
      const counts = await this.recountOptions(em, postId);
      for (const o of options) {
        const fresh = counts.get(o.id) ?? 0;
        if (o.voteCount !== fresh) {
          o.voteCount = fresh;
          await optionRepo.save(o);
        }
      }

      await this.writeAudit(em, identityId, 'poll.vote', 'post', postId, {
        // D16: the audit records WHETHER the caller now has a vote, never
        // surfaces who-voted-what to any read surface.
        voted: myOptionId !== null,
      });

      const optionDtos: PollOptionDto[] = options.map((o) => ({
        id: o.id,
        label: o.label,
        voteCount: counts.get(o.id) ?? 0,
      }));
      const totalVotes = optionDtos.reduce((sum, o) => sum + o.voteCount, 0);
      const closed = this.isClosed(post, new Date());
      return {
        options: optionDtos,
        totalVotes,
        myOptionId,
        closesAt: post.pollClosesAt ? post.pollClosesAt.toISOString() : null,
        closed,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // READS
  // ---------------------------------------------------------------------------

  /**
   * Batch-load the poll block for MANY poll posts in TWO grouped queries (no
   * N+1): ONE for all options, ONE for the live per-option vote counts. Returns
   * `postId → PollDto`. Non-poll ids simply produce no entry. Empty input →
   * empty map. D16: aggregate counts only — never who-voted-what.
   *
   * Callers pass the FULL set of post ids on a feed page (poll + non-poll); the
   * map entry is present only for ids that actually have options, so the call
   * site does `pollByPost.get(p.id)` and attaches `poll` only when defined.
   */
  async batchLoadPolls(posts: CitizenPost[]): Promise<Map<string, PollDto>> {
    const out = new Map<string, PollDto>();
    const pollPosts = posts.filter((p) => p.postKind === 'poll');
    if (pollPosts.length === 0) {
      return out;
    }
    const postIds = pollPosts.map((p) => p.id);

    // ONE query: all options for the page's polls, ordered (post, sortOrder).
    const options = await this.optionRepo.find({
      where: { postId: In(postIds) },
      order: { sortOrder: 'ASC' },
    });

    // ONE query: live vote counts grouped by (post, option).
    const counts = await this.batchRecountOptions(postIds);

    const now = new Date();
    const byPost = new Map<string, CitizenPost>(pollPosts.map((p) => [p.id, p]));
    const optionsByPost = new Map<string, CitizenPollOption[]>();
    for (const o of options) {
      const bucket = optionsByPost.get(o.postId) ?? [];
      bucket.push(o);
      optionsByPost.set(o.postId, bucket);
    }

    for (const [postId, post] of byPost) {
      const opts = optionsByPost.get(postId) ?? [];
      const optionDtos: PollOptionDto[] = opts.map((o) => ({
        id: o.id,
        label: o.label,
        voteCount: counts.get(o.id) ?? 0,
      }));
      const totalVotes = optionDtos.reduce((sum, o) => sum + o.voteCount, 0);
      out.set(postId, {
        options: optionDtos,
        totalVotes,
        closesAt: post.pollClosesAt ? post.pollClosesAt.toISOString() : null,
        closed: this.isClosed(post, now),
      });
    }
    return out;
  }

  /**
   * The caller's LIVE poll votes as a `{ [postId]: optionId }` map (D16 —
   * owner-scoped, like `/me/reactions` / `/me/bookmark-ids`). This is the ONLY
   * surface that reveals a vote, and ONLY the caller's own. NO IDOR — scoped to
   * `req.user.identityId`. Closed polls still report the caller's historical
   * vote.
   */
  async listMyVotes(identityId: string): Promise<Record<string, string>> {
    const rows = await this.voteRepo.find({
      where: { voterIdentityId: identityId, deletedAt: IsNull() },
      select: ['postId', 'optionId'],
    });
    const map: Record<string, string> = {};
    for (const r of rows) {
      map[r.postId] = r.optionId;
    }
    return map;
  }

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  /** A poll is closed when `pollClosesAt` is non-null AND in the past. */
  private isClosed(post: CitizenPost, now: Date): boolean {
    return post.pollClosesAt !== null && post.pollClosesAt.getTime() <= now.getTime();
  }

  /** Live per-option vote count for ONE poll — single grouped query. */
  private async recountOptions(
    em: EntityManager,
    postId: string,
  ): Promise<Map<string, number>> {
    const rows = await em
      .getRepository(CitizenPollVote)
      .createQueryBuilder('v')
      .select('v.option_id', 'optionId')
      .addSelect('COUNT(*)', 'count')
      .where('v.post_id = :postId', { postId })
      .andWhere('v.deleted_at IS NULL')
      .groupBy('v.option_id')
      .getRawMany<{ optionId: string; count: string }>();
    const map = new Map<string, number>();
    for (const r of rows) {
      map.set(r.optionId, Number(r.count));
    }
    return map;
  }

  /** Live per-option vote count for MANY polls — single grouped query. */
  private async batchRecountOptions(
    postIds: string[],
  ): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    if (postIds.length === 0) {
      return map;
    }
    const rows = await this.voteRepo
      .createQueryBuilder('v')
      .select('v.option_id', 'optionId')
      .addSelect('COUNT(*)', 'count')
      .where('v.post_id IN (:...postIds)', { postIds })
      .andWhere('v.deleted_at IS NULL')
      .groupBy('v.option_id')
      .getRawMany<{ optionId: string; count: string }>();
    for (const r of rows) {
      map.set(r.optionId, Number(r.count));
    }
    return map;
  }

  /** Build the poll block from freshly-created options (zeroed counts). */
  private toPollDto(
    post: CitizenPost,
    options: CitizenPollOption[],
    now: Date,
  ): PollDto {
    const optionDtos: PollOptionDto[] = options.map((o) => ({
      id: o.id,
      label: o.label,
      voteCount: o.voteCount ?? 0,
    }));
    return {
      options: optionDtos,
      totalVotes: optionDtos.reduce((sum, o) => sum + o.voteCount, 0),
      closesAt: post.pollClosesAt ? post.pollClosesAt.toISOString() : null,
      closed: this.isClosed(post, now),
    };
  }

  /** Map a poll post → PostDto with the poll block attached. */
  private toPostDto(
    post: CitizenPost,
    displayAlias: string,
    poll: PollDto,
  ): PostDto {
    return {
      id: post.id,
      postKind: post.postKind,
      lat: null,
      lng: null,
      amphoeId: null,
      category: null,
      title: post.title,
      detail: post.detail,
      heartCount: post.heartCount,
      reactionCount: post.heartCount,
      reactionBreakdown: emptyReactionBreakdown(),
      commentCount: post.commentCount,
      repostCount: post.repostCount ?? 0,
      createdAt: (post.createdAt ?? new Date()).toISOString(),
      // W-GATE-1: `author.id` = the authorIdentityId (opaque uuid handle).
      author: { id: post.authorIdentityId, displayAlias },
      media: [],
      poll,
    };
  }

  private async resolveAlias(
    em: EntityManager,
    identityId: string,
  ): Promise<string> {
    const identity = await em.getRepository(CitizenIdentity).findOne({
      where: { id: identityId },
    });
    return identity?.displayAlias ?? '';
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
}
