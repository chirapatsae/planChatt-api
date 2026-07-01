import { BadRequestException } from '@nestjs/common';

import { computeRankScore } from './common/citizen-feed-ranking';
import { CitizenPostService } from './citizen-post.service';
import { CreateCitizenPostDto } from './dto/create-citizen-post.dto';

/**
 * Unit spec for CitizenPostService.
 *
 * The service does NOT hash anything (no encryption.util import), so unlike the
 * citizen-auth spec there is NO jest.mock('src/util/encryption.util'). We mock
 * the constructor repos + media service + a dataSource whose `.transaction(cb)`
 * invokes the callback with a mock EntityManager that hands back per-entity
 * sub-repos. `CitizenMediaService.attachMediaToPost` is mocked as a no-op.
 */

type Repo = {
  create: jest.Mock;
  save: jest.Mock;
  findOne: jest.Mock;
  find: jest.Mock;
  count: jest.Mock;
  softDelete: jest.Mock;
  update: jest.Mock;
  createQueryBuilder: jest.Mock;
};

function makeRepo(): Repo {
  return {
    create: jest.fn((x) => x),
    save: jest.fn(async (x) => ({ id: x.id ?? 'generated-id', ...x })),
    findOne: jest.fn(),
    find: jest.fn(async () => []),
    count: jest.fn(async () => 0),
    softDelete: jest.fn(async () => undefined),
    update: jest.fn(async () => undefined),
    createQueryBuilder: jest.fn(),
  };
}

/**
 * Chainable INSERT builder stub for `.insert().values().orIgnore().execute()`.
 * Captures the inserted values so a spec can assert the persisted reactionType.
 */
function makeInsertBuilder() {
  const b: Record<string, jest.Mock> & { _values: unknown[] } = {
    _values: [],
  } as never;
  b.insert = jest.fn(() => b);
  b.values = jest.fn((v: unknown) => {
    b._values.push(v);
    return b;
  });
  b.orIgnore = jest.fn(() => b);
  b.execute = jest.fn(async () => ({ identifiers: [] }));
  return b;
}

/**
 * Chainable grouped-SELECT builder stub for the reaction-breakdown query
 * `.select().addSelect().where().andWhere().groupBy().addGroupBy().getRawMany()`.
 * `rawRows` are the `{ reactionType, count }` rows the query "returns".
 */
function makeBreakdownBuilder(
  rawRows: Array<{ reactionType: string; count: string }>,
) {
  const b: Record<string, jest.Mock> = {};
  b.select = jest.fn(() => b);
  b.addSelect = jest.fn(() => b);
  b.where = jest.fn(() => b);
  b.andWhere = jest.fn(() => b);
  b.groupBy = jest.fn(() => b);
  b.addGroupBy = jest.fn(() => b);
  b.getRawMany = jest.fn(async () => rawRows);
  return b;
}

/**
 * Build a `createQueryBuilder` mock that dispatches by call order: the
 * toggleReaction ADD path calls it ONCE for the insert, then the breakdown read
 * calls it AGAIN (grouped select). A pure-read toggle (remove/switch) only hits
 * the breakdown builder. `breakdownRaw` feeds the breakdown's getRawMany.
 */
function makeReactionQbMock(
  breakdownRaw: Array<{ reactionType: string; count: string }>,
) {
  const insertBuilder = makeInsertBuilder();
  const breakdownBuilder = makeBreakdownBuilder(breakdownRaw);
  const mock = jest.fn((alias?: string) =>
    // The service passes the 'r' alias ONLY for the grouped breakdown read;
    // the insert builder is created with no alias.
    alias === 'r' ? breakdownBuilder : insertBuilder,
  );
  return { mock, insertBuilder, breakdownBuilder };
}

/**
 * Chainable SELECT builder stub for the ranked `list()` query. Captures the
 * orderBy/addOrderBy calls so the spec can assert the (rankScore, id) DESC sort,
 * and returns the provided rows from `.getMany()`.
 */
function makeSelectBuilder(rows: unknown[]) {
  const orderCalls: Array<{ field: string; dir: string }> = [];
  const b: Record<string, jest.Mock> & {
    _orderCalls: Array<{ field: string; dir: string }>;
  } = {
    leftJoin: jest.fn(() => b),
    addSelect: jest.fn(() => b),
    where: jest.fn(() => b),
    andWhere: jest.fn(() => b),
    orderBy: jest.fn((field: string, dir: string) => {
      orderCalls.push({ field, dir });
      return b;
    }),
    addOrderBy: jest.fn((field: string, dir: string) => {
      orderCalls.push({ field, dir });
      return b;
    }),
    take: jest.fn(() => b),
    getMany: jest.fn(async () => rows),
    _orderCalls: orderCalls,
  } as never;
  return b;
}

describe('CitizenPostService', () => {
  let service: CitizenPostService;

  // Constructor repos
  let postRepo: Repo;
  let commentRepo: Repo;
  let mediaRepo: Repo;
  let identityRepo: Repo;
  let mediaService: { attachMediaToPost: jest.Mock };
  let mentionService: {
    processMentions: jest.Mock;
    loadMentionsForPosts: jest.Mock;
    loadMentionsForComments: jest.Mock;
  };
  let notificationService: {
    notifyOnComment: jest.Mock;
    notifyOnHeart: jest.Mock;
  };
  let officialResponseService: { listForPost: jest.Mock };
  let pollService: { batchLoadPolls: jest.Mock };
  let repostEmbedService: { batchLoadEmbeds: jest.Mock };
  let hashtagService: { extractAndLink: jest.Mock };
  let followService: { getFollowerCount: jest.Mock };
  let blockService: {
    excludedAuthorIdsForViewer: jest.Mock;
    isBlockedEitherWay: jest.Mock;
  };

  // EntityManager-scoped repos (returned inside the transaction)
  let emPostRepo: Repo;
  let emCommentRepo: Repo;
  let emReactionRepo: Repo;
  let emIdentityRepo: Repo;
  let emAuditRepo: Repo;
  let emModerationRepo: Repo;
  let emMediaRepo: Repo;
  // Reaction repo returned by `dataSource.getRepository` (outside-tx reads).
  let dsReactionRepo: Repo;
  let em: { getRepository: (entity: { name: string }) => Repo };

  let auditSaves: Array<{ action: string; targetKind: string; detail: unknown }>;

  beforeEach(() => {
    postRepo = makeRepo();
    commentRepo = makeRepo();
    mediaRepo = makeRepo();
    mediaService = { attachMediaToPost: jest.fn(async () => undefined) };
    // W-S6: the mention processor. Default → no mentions (an empty array); the
    // create/comment specs are mention-agnostic. Mention-specific behavior is
    // covered in citizen-mention.service.spec.ts.
    mentionService = {
      processMentions: jest.fn(async () => []),
      loadMentionsForPosts: jest.fn(async () => new Map()),
      loadMentionsForComments: jest.fn(async () => new Map()),
    };
    notificationService = {
      notifyOnComment: jest.fn(async () => undefined),
      notifyOnHeart: jest.fn(async () => undefined),
    };
    officialResponseService = { listForPost: jest.fn(async () => []) };
    // W-S7: the poll batch-loader. Default → no polls (an empty map); the feed
    // is poll-agnostic in these specs.
    pollService = {
      batchLoadPolls: jest.fn(async () => new Map()),
    };
    // W-S2: the embed batch-loader. Default → no embeds (an empty map); specs
    // that need an embed/tombstone override `batchLoadEmbeds` per-case.
    repostEmbedService = {
      batchLoadEmbeds: jest.fn(async () => new Map()),
    };
    // W-S4: the hashtag extractor/linker. Default → a no-op (extractAndLink is
    // invoked in-tx by create(); these specs are hashtag-agnostic).
    hashtagService = {
      extractAndLink: jest.fn(async () => undefined),
    };
    // W-GATE-1: the follow service (public-profile follower count + the feed
    // person-set is passed in by the controller, not read here). Default → 0.
    followService = {
      getFollowerCount: jest.fn(async () => 0),
    };
    // W-T1: the block service. Default → no exclusions / never blocked, so the
    // existing read + write specs behave exactly as pre-W-T1. Block-specific
    // specs override these per-case.
    blockService = {
      excludedAuthorIdsForViewer: jest.fn(async () => new Set<string>()),
      isBlockedEitherWay: jest.fn(async () => false),
    };
    // W-GATE-1: the identity repo (public-profile existence + alias). Default →
    // an active identity; specs that need a 404 override `findOne` per-case.
    identityRepo = makeRepo();
    identityRepo.findOne = jest.fn(async () => ({
      id: 'identity-1',
      displayAlias: 'สมชาย ม.',
      status: 'active',
    }));

    emPostRepo = makeRepo();
    emCommentRepo = makeRepo();
    emReactionRepo = makeRepo();
    emIdentityRepo = makeRepo();
    emAuditRepo = makeRepo();
    emModerationRepo = makeRepo();
    emMediaRepo = makeRepo();

    auditSaves = [];
    emAuditRepo.save = jest.fn(async (x) => {
      auditSaves.push(x);
      return { id: 'audit-1', ...x };
    });

    emIdentityRepo.findOne = jest.fn(async () => ({
      id: 'identity-1',
      displayAlias: 'สมชาย ม.',
    }));

    const emRepoByName: Record<string, Repo> = {
      CitizenPost: emPostRepo,
      CitizenPostComment: emCommentRepo,
      CitizenPostReaction: emReactionRepo,
      CitizenIdentity: emIdentityRepo,
      CitizenAuditLog: emAuditRepo,
      CitizenModerationLog: emModerationRepo,
      CitizenPostMedia: emMediaRepo,
    };

    em = {
      getRepository: (entity: { name: string }) => emRepoByName[entity.name],
    };

    // `list()` / `listMyReactions()` read reactions via
    // `this.dataSource.getRepository(CitizenPostReaction)` (outside the tx).
    dsReactionRepo = makeRepo();
    dsReactionRepo.createQueryBuilder = jest.fn(() => makeBreakdownBuilder([]));

    // Comment-like repo — `detail()` groups counts via createQueryBuilder.
    const commentReactionRepo = makeRepo();
    commentReactionRepo.createQueryBuilder = jest.fn(() => makeBreakdownBuilder([]));

    const dataSource = {
      transaction: async (cb: (em: unknown) => Promise<unknown>) => cb(em),
      // `detail()` loads media via `this.dataSource.manager.getRepository(...)`.
      manager: em,
      getRepository: (entity: { name: string }) =>
        entity.name === 'CitizenPostReaction' ? dsReactionRepo : postRepo,
    };

    service = new CitizenPostService(
      postRepo as never,
      commentRepo as never,
      commentReactionRepo as never,
      mediaRepo as never,
      identityRepo as never,
      mediaService as never,
      mentionService as never,
      notificationService as never,
      officialResponseService as never,
      pollService as never,
      repostEmbedService as never,
      hashtagService as never,
      followService as never,
      blockService as never,
      dataSource as never,
    );
  });

  describe('create', () => {
    it('rejects an idea missing category with CITIZEN_POST_SHAPE_INVALID', async () => {
      const dto: CreateCitizenPostDto = {
        postKind: 'idea',
        lat: 14.97,
        lng: 102.1,
        title: 'ถนนพัง',
        detail: 'หลุมเยอะ',
        // category missing
      };
      await expect(service.create('identity-1', dto)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(emPostRepo.save).not.toHaveBeenCalled();
    });

    it('accepts an idea with no detail — the composer collapsed to a single idea-text field (→ title)', async () => {
      emPostRepo.save = jest.fn(async (x) => ({ ...x, id: 'post-2' }));
      const dto: CreateCitizenPostDto = {
        postKind: 'idea',
        lat: 14.97,
        lng: 102.1,
        category: 'road',
        title: 'เพิ่มไฟส่องสว่างตรงทางโค้ง',
        // detail omitted — the citizen composer no longer collects it
        amphoeId: '11111111-1111-1111-1111-111111111111',
      };
      await expect(service.create('identity-1', dto)).resolves.toBeDefined();
      expect(emPostRepo.save).toHaveBeenCalled();
      const savedPost = emPostRepo.create.mock.calls[0][0];
      expect(savedPost.detail).toBeNull();
    });

    it('inserts a valid idea and writes an audit row', async () => {
      emPostRepo.save = jest.fn(async (x) => ({ ...x, id: 'post-1' }));
      const dto: CreateCitizenPostDto = {
        postKind: 'idea',
        lat: 14.97,
        lng: 102.1,
        category: 'road',
        title: 'ถนนพัง',
        detail: 'หลุมเยอะ',
        amphoeId: '11111111-1111-1111-1111-111111111111',
      };

      const result = await service.create('identity-1', dto);

      // Saved twice in-tx: (1) persist the row, (2) persist the seeded rankScore.
      expect(emPostRepo.save).toHaveBeenCalledTimes(2);
      // The second save carries a finite, non-negative seeded rank score.
      const rankSavedPost = emPostRepo.save.mock.calls[1][0];
      expect(typeof rankSavedPost.rankScore).toBe('number');
      expect(Number.isFinite(rankSavedPost.rankScore)).toBe(true);
      // media attach is invoked inside the create tx (empty list here)
      expect(mediaService.attachMediaToPost).toHaveBeenCalledWith(
        em,
        'identity-1',
        'post-1',
        [],
      );
      expect(result.media).toEqual([]);
      const savedPost = emPostRepo.create.mock.calls[0][0];
      expect(savedPost).toMatchObject({
        authorIdentityId: 'identity-1',
        postKind: 'idea',
        category: 'road',
        moderationState: 'visible',
        heartCount: 0,
        commentCount: 0,
      });
      // decimal columns are stringified for the entity
      expect(savedPost.lat).toBe('14.97');
      expect(savedPost.lng).toBe('102.1');

      expect(auditSaves).toHaveLength(1);
      expect(auditSaves[0]).toMatchObject({
        actorKind: 'citizen',
        actorId: 'identity-1',
        action: 'post.create',
        targetKind: 'post',
      });

      expect(result.lat).toBe(14.97);
      expect(result.author.displayAlias).toBe('สมชาย ม.');
    });

    it('forces lat/lng/category to null for a discussion', async () => {
      emPostRepo.save = jest.fn(async (x) => ({ ...x, id: 'post-2' }));
      const dto: CreateCitizenPostDto = {
        postKind: 'discussion',
        lat: 14.97,
        lng: 102.1,
        category: 'road',
        title: 'คุยกันเรื่องน้ำ',
      };

      const result = await service.create('identity-1', dto);

      const savedPost = emPostRepo.create.mock.calls[0][0];
      expect(savedPost.lat).toBeNull();
      expect(savedPost.lng).toBeNull();
      expect(savedPost.category).toBeNull();
      expect(result.lat).toBeNull();
      expect(result.lng).toBeNull();
      expect(result.category).toBeNull();
    });
  });

  describe('repost (W-S2)', () => {
    it('reposts a ROOT: increments its repost_count, stores the quote, audits', async () => {
      const root = {
        id: 'root-1',
        moderationState: 'visible',
        repostOfId: null,
        repostCount: 4,
        heartCount: 0,
        commentCount: 0,
        createdAt: new Date('2026-03-01T00:00:00.000Z'),
        rankScore: 0,
      };
      // findOne is called once for the target (== root here).
      emPostRepo.findOne = jest.fn(async () => root);
      emPostRepo.save = jest.fn(async (x) => ({ id: x.id ?? 'repost-1', ...x }));

      const result = await service.repost('identity-1', 'root-1', 'เห็นด้วยมาก');

      // the inserted repost row: discussion, geo/category null, quote in detail,
      // repostOfId = root, own repostCount 0
      const created = emPostRepo.create.mock.calls[0][0];
      expect(created).toMatchObject({
        authorIdentityId: 'identity-1',
        postKind: 'discussion',
        lat: null,
        lng: null,
        category: null,
        title: null,
        detail: 'เห็นด้วยมาก',
        repostOfId: 'root-1',
        repostCount: 0,
        moderationState: 'visible',
      });
      // root.repostCount bumped 4 → 5 and saved
      expect(root.repostCount).toBe(5);
      // audit row written
      expect(auditSaves[0]).toMatchObject({
        action: 'post.repost',
        targetKind: 'post',
        detail: { repostOfId: 'root-1', hasQuote: true },
      });
      // the returned dto carries the embed resolved for the root
      expect(repostEmbedService.batchLoadEmbeds).toHaveBeenCalledWith(['root-1']);
      expect(result.detail).toBe('เห็นด้วยมาก');
      expect(result.repostCount).toBe(0);
    });

    it('FLATTEN-TO-ROOT: reposting a repost references the ROOT original', async () => {
      const repostTarget = {
        id: 'repost-X',
        moderationState: 'visible',
        repostOfId: 'root-1',
        repostCount: 0,
        heartCount: 0,
        commentCount: 0,
        createdAt: new Date('2026-03-01T00:00:00.000Z'),
        rankScore: 0,
      };
      const root = {
        id: 'root-1',
        moderationState: 'visible',
        repostOfId: null,
        repostCount: 1,
        heartCount: 0,
        commentCount: 0,
        createdAt: new Date('2026-02-01T00:00:00.000Z'),
        rankScore: 0,
      };
      // 1st findOne → the target repost, 2nd findOne → the re-loaded root.
      emPostRepo.findOne = jest
        .fn()
        .mockResolvedValueOnce(repostTarget)
        .mockResolvedValueOnce(root);
      emPostRepo.save = jest.fn(async (x) => ({ id: x.id ?? 'repost-2', ...x }));

      await service.repost('identity-1', 'repost-X');

      // the new repost references the ROOT, not the intermediate repost
      const created = emPostRepo.create.mock.calls[0][0];
      expect(created.repostOfId).toBe('root-1');
      // pure share (no quote) → detail null, hasQuote false in audit
      expect(created.detail).toBeNull();
      expect(auditSaves[0].detail).toMatchObject({
        repostOfId: 'root-1',
        hasQuote: false,
      });
      // the ROOT's count was incremented (1 → 2), not the intermediate repost's
      expect(root.repostCount).toBe(2);
      expect(repostEmbedService.batchLoadEmbeds).toHaveBeenCalledWith(['root-1']);
    });

    it('404s when the target post is not visible / not found', async () => {
      emPostRepo.findOne = jest.fn(async () => null);
      await expect(
        service.repost('identity-1', 'missing-1'),
      ).rejects.toMatchObject({ message: 'CITIZEN_POST_NOT_FOUND' });
      expect(emPostRepo.create).not.toHaveBeenCalled();
    });
  });

  describe('toggleReaction (W-S1 multi-reaction set)', () => {
    beforeEach(() => {
      emPostRepo.findOne = jest.fn(async () => ({
        id: 'post-1',
        moderationState: 'visible',
        heartCount: 3,
        commentCount: 0,
        createdAt: new Date('2026-03-01T00:00:00.000Z'),
        rankScore: 0,
      }));
    });

    it('ADD: inserts with the chosen type (orIgnore), recounts ALL types, notifies once', async () => {
      emReactionRepo.findOne = jest.fn(async () => null);
      const { mock, insertBuilder } = makeReactionQbMock([
        { reactionType: 'love', count: '1' },
        { reactionType: 'like', count: '3' },
      ]);
      emReactionRepo.createQueryBuilder = mock;
      // authoritative recount of ALL live reactions (any type) after the insert
      emReactionRepo.count = jest.fn(async () => 4);

      const result = await service.toggleReaction('identity-1', 'post-1', 'love');

      expect(insertBuilder.orIgnore).toHaveBeenCalledTimes(1);
      expect(insertBuilder.execute).toHaveBeenCalledTimes(1);
      // the persisted insert carries reaction='heart' (legacy) + the chosen type
      expect(insertBuilder._values[0]).toMatchObject({
        postId: 'post-1',
        identityId: 'identity-1',
        reaction: 'heart',
        reactionType: 'love',
      });
      expect(emReactionRepo.softDelete).not.toHaveBeenCalled();
      expect(emReactionRepo.update).not.toHaveBeenCalled();
      // reaction ADDED → notify the post author once
      expect(notificationService.notifyOnHeart).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        reacted: true,
        reactionType: 'love',
        reactionCount: 4,
        breakdown: { like: 3, love: 1, support: 0, insightful: 0 },
      });
      expect(auditSaves[0]).toMatchObject({
        action: 'reaction.toggle',
        detail: { postId: 'post-1', reacted: true, reactionType: 'love' },
      });
    });

    it('SWITCH: a live reaction of a DIFFERENT type is UPDATEd in place (no insert, no notify)', async () => {
      emReactionRepo.findOne = jest.fn(async () => ({
        id: 'reaction-1',
        reactionType: 'like',
      }));
      const { mock, insertBuilder } = makeReactionQbMock([
        { reactionType: 'support', count: '3' },
      ]);
      emReactionRepo.createQueryBuilder = mock;
      emReactionRepo.count = jest.fn(async () => 3);

      const result = await service.toggleReaction(
        'identity-1',
        'post-1',
        'support',
      );

      // switch = UPDATE the type in place
      expect(emReactionRepo.update).toHaveBeenCalledWith('reaction-1', {
        reactionType: 'support',
      });
      expect(emReactionRepo.softDelete).not.toHaveBeenCalled();
      // no insert builder used on switch
      expect(insertBuilder.execute).not.toHaveBeenCalled();
      // SWITCH is not a first-add → no notification
      expect(notificationService.notifyOnHeart).not.toHaveBeenCalled();
      expect(result).toEqual({
        reacted: true,
        reactionType: 'support',
        reactionCount: 3,
        breakdown: { like: 0, love: 0, support: 3, insightful: 0 },
      });
    });

    it('REMOVE: a live reaction of the SAME type is soft-deleted (un-react)', async () => {
      emReactionRepo.findOne = jest.fn(async () => ({
        id: 'reaction-1',
        reactionType: 'like',
      }));
      const { mock } = makeReactionQbMock([]);
      emReactionRepo.createQueryBuilder = mock;
      emReactionRepo.count = jest.fn(async () => 2);

      const result = await service.toggleReaction('identity-1', 'post-1', 'like');

      expect(emReactionRepo.softDelete).toHaveBeenCalledWith('reaction-1');
      expect(emReactionRepo.update).not.toHaveBeenCalled();
      // REMOVE → no notification
      expect(notificationService.notifyOnHeart).not.toHaveBeenCalled();
      expect(result).toEqual({
        reacted: false,
        reactionType: null,
        reactionCount: 2,
        breakdown: { like: 0, love: 0, support: 0, insightful: 0 },
      });
    });

    it('defaults to "like" when no reactionType is supplied (back-compat)', async () => {
      emReactionRepo.findOne = jest.fn(async () => null);
      const { mock, insertBuilder } = makeReactionQbMock([
        { reactionType: 'like', count: '1' },
      ]);
      emReactionRepo.createQueryBuilder = mock;
      emReactionRepo.count = jest.fn(async () => 1);

      const result = await service.toggleReaction('identity-1', 'post-1');

      expect(insertBuilder._values[0]).toMatchObject({ reactionType: 'like' });
      expect(result.reacted).toBe(true);
      expect(result.reactionType).toBe('like');
    });
  });

  describe('addComment', () => {
    it('increments commentCount and writes an audit row', async () => {
      const createdAt = new Date('2026-03-01T00:00:00.000Z');
      const before = computeRankScore({ heartCount: 0, commentCount: 5, createdAt });
      const post = {
        id: 'post-1',
        moderationState: 'visible',
        heartCount: 0,
        commentCount: 5,
        createdAt,
        rankScore: before,
      };
      emPostRepo.findOne = jest.fn(async () => post);
      emCommentRepo.save = jest.fn(async (x) => ({ ...x, id: 'comment-1' }));

      const result = await service.addComment('identity-1', 'post-1', 'เห็นด้วย');

      expect(emCommentRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          postId: 'post-1',
          authorIdentityId: 'identity-1',
          text: 'เห็นด้วย',
          moderationState: 'visible',
        }),
      );
      // post.commentCount mutated to 6 and saved
      expect(post.commentCount).toBe(6);
      expect(emPostRepo.save).toHaveBeenCalledWith(post);
      // W-F2: rank score recomputed in-tx after the comment landed — strictly rose
      expect(post.rankScore).toBeGreaterThan(before);
      expect(post.rankScore).toBeCloseTo(
        computeRankScore({ heartCount: 0, commentCount: 6, createdAt }),
        10,
      );

      // comment ALWAYS notifies the post author (self-skip handled in service)
      expect(notificationService.notifyOnComment).toHaveBeenCalledTimes(1);
      expect(notificationService.notifyOnComment).toHaveBeenCalledWith(
        em,
        post,
        'identity-1',
        'comment-1',
      );

      expect(auditSaves[0]).toMatchObject({
        action: 'comment.create',
        targetKind: 'comment',
        detail: { postId: 'post-1' },
      });
      expect(result.text).toBe('เห็นด้วย');
      expect(result.author.displayAlias).toBe('สมชาย ม.');
    });
  });

  describe('W-T1 block/mute read-filter + interaction guard', () => {
    it('feed excludes posts from muted+blocked authors (applies NOT IN with the excluded set)', async () => {
      // The viewer mutes 'muted-a' and is blocked-by 'blocker-b' → both excluded.
      blockService.excludedAuthorIdsForViewer = jest.fn(
        async () => new Set(['muted-a', 'blocker-b']),
      );
      const selectBuilder = makeSelectBuilder([]);
      postRepo.createQueryBuilder = jest.fn(() => selectBuilder);

      await service.list({ limit: 50 } as never, 'viewer-1');

      expect(blockService.excludedAuthorIdsForViewer).toHaveBeenCalledWith('viewer-1');
      const filterCall = selectBuilder.andWhere.mock.calls.find((c: unknown[]) =>
        String(c[0]).includes('p.authorIdentityId NOT IN'),
      );
      expect(filterCall).toBeDefined();
      expect(filterCall?.[1]).toEqual({
        excludedAuthorIds: ['muted-a', 'blocker-b'],
      });
    });

    it('feed is unfiltered for an anonymous viewer (no NOT IN clause)', async () => {
      // anonymous → empty set → no filter clause.
      blockService.excludedAuthorIdsForViewer = jest.fn(async () => new Set<string>());
      const selectBuilder = makeSelectBuilder([]);
      postRepo.createQueryBuilder = jest.fn(() => selectBuilder);

      await service.list({ limit: 50 } as never, undefined);

      const filterCall = selectBuilder.andWhere.mock.calls.find((c: unknown[]) =>
        String(c[0]).includes('p.authorIdentityId NOT IN'),
      );
      expect(filterCall).toBeUndefined();
    });

    it('detail hides a post whose author the viewer blocked (mutual invisibility → 404)', async () => {
      const selectBuilder = makeSelectBuilder([]);
      (selectBuilder as { getOne?: jest.Mock }).getOne = jest.fn(async () => ({
        id: 'post-1',
        authorIdentityId: 'author-x',
        moderationState: 'visible',
      }));
      postRepo.createQueryBuilder = jest.fn(() => selectBuilder);
      blockService.excludedAuthorIdsForViewer = jest.fn(
        async () => new Set(['author-x']),
      );

      await expect(service.detail('post-1', 'viewer-1')).rejects.toMatchObject({
        message: 'CITIZEN_POST_NOT_FOUND',
      });
    });

    it('addComment is refused with 403 CITIZEN_BLOCKED when block edge exists', async () => {
      emPostRepo.findOne = jest.fn(async () => ({
        id: 'post-1',
        authorIdentityId: 'author-x',
        moderationState: 'visible',
      }));
      blockService.isBlockedEitherWay = jest.fn(async () => true);

      await expect(
        service.addComment('actor-1', 'post-1', 'hi'),
      ).rejects.toMatchObject({ message: 'CITIZEN_BLOCKED' });
      expect(blockService.isBlockedEitherWay).toHaveBeenCalledWith('actor-1', 'author-x');
      // no comment written
      expect(emCommentRepo.save).not.toHaveBeenCalled();
    });

    it('mute does NOT restrict interaction (isBlockedEitherWay false → comment proceeds)', async () => {
      const createdAt = new Date('2026-03-01T00:00:00.000Z');
      emPostRepo.findOne = jest.fn(async () => ({
        id: 'post-1',
        authorIdentityId: 'author-x',
        moderationState: 'visible',
        heartCount: 0,
        commentCount: 0,
        createdAt,
      }));
      emCommentRepo.save = jest.fn(async (x) => ({ ...x, id: 'comment-1' }));
      // 'mute' edges are ignored by isBlockedEitherWay (kind='block' filter) → false.
      blockService.isBlockedEitherWay = jest.fn(async () => false);

      const res = await service.addComment('muter-1', 'post-1', 'still allowed');
      expect(res.text).toBe('still allowed');
      expect(emCommentRepo.save).toHaveBeenCalled();
    });
  });

  describe('list (W-F2 ranked feed)', () => {
    it('orders by (rankScore, id) DESC and emits a rankScore-based cursor', async () => {
      const rows = [
        { id: 'post-hi', rankScore: 9.5, author: { displayAlias: 'ก' } },
        { id: 'post-lo', rankScore: 3.2, author: { displayAlias: 'ข' } },
      ];
      const selectBuilder = makeSelectBuilder(rows);
      postRepo.createQueryBuilder = jest.fn(() => selectBuilder);
      // media batch-load reads from the constructor mediaRepo.find → [] (default)

      const result = await service.list({ limit: 2 } as never);

      // sort order assertion: rankScore DESC then id DESC
      expect(selectBuilder._orderCalls).toEqual([
        { field: 'p.rankScore', dir: 'DESC' },
        { field: 'p.id', dir: 'DESC' },
      ]);
      // returned items preserve the builder's (already-ranked) order
      expect(result.items.map((p) => p.id)).toEqual(['post-hi', 'post-lo']);
      // full page → cursor carries the LAST row's rankScore + id (W-F2 shape)
      expect(result.nextCursor).toEqual({ rankScore: 3.2, id: 'post-lo' });
    });

    it('returns a null cursor when the page is not full', async () => {
      const rows = [{ id: 'only', rankScore: 1.0, author: { displayAlias: 'ก' } }];
      postRepo.createQueryBuilder = jest.fn(() => makeSelectBuilder(rows));

      const result = await service.list({ limit: 50 } as never);

      expect(result.nextCursor).toBeNull();
    });

    it('applies the (rankScore, id) keyset predicate when a cursor is supplied', async () => {
      const selectBuilder = makeSelectBuilder([]);
      postRepo.createQueryBuilder = jest.fn(() => selectBuilder);

      await service.list({ beforeRankScore: 4.0, beforeId: 'cursor-id' } as never);

      const keysetCall = selectBuilder.andWhere.mock.calls.find((c: unknown[]) =>
        String(c[0]).includes('p.rankScore <'),
      );
      expect(keysetCall).toBeDefined();
      expect(keysetCall?.[1]).toEqual({ beforeRankScore: 4.0, beforeId: 'cursor-id' });
    });
  });

  describe('toggleReaction raises rank_score (W-F2) and uses the TOTAL count (W-S1)', () => {
    it('recomputes a higher rank_score from the authoritative TOTAL reaction count', async () => {
      const createdAt = new Date('2026-03-01T00:00:00.000Z');
      const post = {
        id: 'post-1',
        moderationState: 'visible',
        heartCount: 0,
        commentCount: 0,
        createdAt,
        rankScore: computeRankScore({ heartCount: 0, commentCount: 0, createdAt }),
      };
      const before = post.rankScore;

      emPostRepo.findOne = jest.fn(async () => post);
      emReactionRepo.findOne = jest.fn(async () => null);
      const { mock } = makeReactionQbMock([{ reactionType: 'love', count: '1' }]);
      emReactionRepo.createQueryBuilder = mock;
      // authoritative recount of ALL live reactions (any type) → 1
      emReactionRepo.count = jest.fn(async () => 1);

      const result = await service.toggleReaction('identity-1', 'post-1', 'love');

      expect(result.reacted).toBe(true);
      expect(result.reactionCount).toBe(1);
      // the post object was mutated in-tx with the recomputed, higher score —
      // ranking uses the TOTAL count (heartCount), unchanged in spirit by W-S1.
      expect(post.heartCount).toBe(1);
      expect(post.rankScore).toBeGreaterThan(before);
      expect(post.rankScore).toBeCloseTo(
        computeRankScore({ heartCount: 1, commentCount: 0, createdAt }),
        10,
      );
    });
  });

  describe('listMyReactions (W-S1 owner-scoped marking)', () => {
    it('maps the caller live reactions to { [postId]: reactionType }', async () => {
      dsReactionRepo.find = jest.fn(async () => [
        { postId: 'post-a', reactionType: 'love' },
        { postId: 'post-b', reactionType: 'support' },
        // an unexpected/legacy value is skipped (defensive narrowing)
        { postId: 'post-c', reactionType: 'bogus' },
      ]);

      const result = await service.listMyReactions('identity-1');

      expect(dsReactionRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ identityId: 'identity-1' }),
        }),
      );
      expect(result).toEqual({ 'post-a': 'love', 'post-b': 'support' });
    });
  });

  describe('author.id (W-GATE-1 opaque handle)', () => {
    it('create() returns author.id = the authorIdentityId', async () => {
      emPostRepo.save = jest.fn(async (x) => ({
        ...x,
        id: 'post-1',
        authorIdentityId: 'identity-1',
      }));
      const dto: CreateCitizenPostDto = {
        postKind: 'discussion',
        title: 'คุย',
      } as never;

      const result = await service.create('identity-1', dto);

      expect(result.author).toEqual({
        id: 'identity-1',
        displayAlias: 'สมชาย ม.',
      });
    });
  });

  describe('listFollowedFeed (W-GATE-1 person UNION)', () => {
    it('includes posts authored by a FOLLOWED PERSON (does NOT short-circuit on empty area/topic sets)', async () => {
      const rows = [
        {
          id: 'post-by-followed',
          rankScore: 5.0,
          authorIdentityId: 'followed-1',
          author: { id: 'followed-1', displayAlias: 'ผู้ถูกติดตาม' },
        },
      ];
      const selectBuilder = makeSelectBuilder(rows);
      postRepo.createQueryBuilder = jest.fn(() => selectBuilder);

      // Only a person follow — no amphoe / category. Pre-W-GATE-1 this would
      // have short-circuited to an empty page; now it must query + return.
      const result = await service.listFollowedFeed(
        'me-1',
        { amphoes: [], categories: [], people: ['followed-1'] },
        { limit: 50 } as never,
      );

      expect(postRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
      expect(result.items.map((p) => p.id)).toEqual(['post-by-followed']);
      expect(result.items[0].author).toEqual({
        id: 'followed-1',
        displayAlias: 'ผู้ถูกติดตาม',
      });
    });

    it('returns an empty page when ALL follow sets are empty (no global feed leak)', async () => {
      const result = await service.listFollowedFeed(
        'me-1',
        { amphoes: [], categories: [], people: [] },
        { limit: 50 } as never,
      );
      expect(result).toEqual({ items: [], nextCursor: null });
      expect(postRepo.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe('getPublicProfile (W-GATE-1, D16)', () => {
    it('returns { id, displayAlias, postCount, followerCount } — count public, roster private', async () => {
      identityRepo.findOne = jest.fn(async () => ({
        id: 'pub-1',
        displayAlias: 'ประชาชน ก',
        status: 'active',
      }));
      postRepo.count = jest.fn(async () => 3);
      followService.getFollowerCount = jest.fn(async () => 12);

      const result = await service.getPublicProfile('pub-1');

      // postCount counts VISIBLE, not-deleted posts only
      expect(postRepo.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            authorIdentityId: 'pub-1',
            moderationState: 'visible',
          }),
        }),
      );
      expect(followService.getFollowerCount).toHaveBeenCalledWith('pub-1');
      expect(result).toEqual({
        id: 'pub-1',
        displayAlias: 'ประชาชน ก',
        postCount: 3,
        followerCount: 12,
      });
    });

    it('404s a missing / blocked identity (CITIZEN_IDENTITY_NOT_FOUND)', async () => {
      identityRepo.findOne = jest.fn(async () => null);
      await expect(service.getPublicProfile('gone-1')).rejects.toMatchObject({
        message: 'CITIZEN_IDENTITY_NOT_FOUND',
      });
      expect(postRepo.count).not.toHaveBeenCalled();
    });
  });

  describe('getPublicPosts (W-GATE-1)', () => {
    it('lists the citizen VISIBLE-only posts (visible filter applied) with author.id', async () => {
      identityRepo.findOne = jest.fn(async () => ({
        id: 'pub-1',
        displayAlias: 'ประชาชน ก',
        status: 'active',
      }));
      const rows = [
        {
          id: 'p1',
          rankScore: 2.0,
          authorIdentityId: 'pub-1',
          author: { id: 'pub-1', displayAlias: 'ประชาชน ก' },
        },
      ];
      const selectBuilder = makeSelectBuilder(rows);
      postRepo.createQueryBuilder = jest.fn(() => selectBuilder);

      const result = await service.getPublicPosts('pub-1', { limit: 50 } as never);

      // the visible-only filter is applied on the builder
      const visibleCall = selectBuilder.andWhere.mock.calls.find((c: unknown[]) =>
        String(c[0]).includes('p.moderationState'),
      );
      expect(visibleCall).toBeDefined();
      expect(result.items.map((p) => p.id)).toEqual(['p1']);
      expect(result.items[0].author.id).toBe('pub-1');
    });

    it('404s a missing / blocked identity before querying posts', async () => {
      identityRepo.findOne = jest.fn(async () => null);
      postRepo.createQueryBuilder = jest.fn(() => makeSelectBuilder([]));
      await expect(
        service.getPublicPosts('gone-1', { limit: 50 } as never),
      ).rejects.toMatchObject({ message: 'CITIZEN_IDENTITY_NOT_FOUND' });
      expect(postRepo.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe('listByHashtag (W-S4 visible-only tag search)', () => {
    /** A select builder that also captures innerJoin calls (tag filter). */
    function makeTagSelectBuilder(rows: unknown[]) {
      const b: Record<string, jest.Mock> & {
        _joins: unknown[][];
      } = {
        innerJoin: jest.fn((...a: unknown[]) => {
          b._joins.push(a);
          return b;
        }),
        leftJoin: jest.fn(() => b),
        addSelect: jest.fn(() => b),
        where: jest.fn(() => b),
        andWhere: jest.fn(() => b),
        orderBy: jest.fn(() => b),
        addOrderBy: jest.fn(() => b),
        take: jest.fn(() => b),
        getMany: jest.fn(async () => rows),
        _joins: [],
      } as never;
      return b;
    }

    it('normalizes the tag, joins the link table, filters visible-only', async () => {
      const rows = [
        {
          id: 'p1',
          rankScore: 4.0,
          repostOfId: null,
          authorIdentityId: 'a1',
          author: { id: 'a1', displayAlias: 'ก' },
        },
      ];
      const builder = makeTagSelectBuilder(rows);
      postRepo.createQueryBuilder = jest.fn(() => builder);

      // raw param carries a leading # + mixed case → normalized to 'road'
      const result = await service.listByHashtag('#Road', { limit: 50 } as never);

      // join filter binds the NORMALIZED tag. innerJoin args are
      // (entity, alias, condition, params) → condition is [2], params [3].
      const tagJoin = builder._joins.find((j) =>
        String(j[2]).includes('h.tag'),
      );
      expect(tagJoin).toBeDefined();
      expect(tagJoin?.[3]).toEqual({ tag: 'road' });
      // visible-only filter present (via .where on moderationState)
      expect(builder.where).toHaveBeenCalledWith('p.moderationState = :state', {
        state: 'visible',
      });
      expect(result.items.map((p) => p.id)).toEqual(['p1']);
    });

    it('returns an empty page for an empty/blank tag (never queries)', async () => {
      postRepo.createQueryBuilder = jest.fn(() => makeTagSelectBuilder([]));
      const result = await service.listByHashtag('   ', { limit: 50 } as never);
      expect(result).toEqual({ items: [], nextCursor: null });
      expect(postRepo.createQueryBuilder).not.toHaveBeenCalled();
    });
  });
});
