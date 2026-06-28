import { NotFoundException } from '@nestjs/common';

import { CitizenBookmarkService } from './citizen-bookmark.service';

/**
 * Unit spec for CitizenBookmarkService.
 *
 * The service does NOT hash anything (no encryption.util import), so — like the
 * C3 follow spec — there is NO jest.mock('src/util/encryption.util'). We mock
 * the constructor repos + a dataSource whose `.transaction(cb)` invokes the
 * callback with a mock EntityManager that hands back per-entity sub-repos. The
 * post repo (existence/visibility gate), bookmark repo (toggle), and audit repo
 * are the only ones touched on the write path.
 */

type Repo = {
  create: jest.Mock;
  save: jest.Mock;
  find: jest.Mock;
  findOne: jest.Mock;
  softDelete: jest.Mock;
  createQueryBuilder: jest.Mock;
};

function makeRepo(): Repo {
  return {
    create: jest.fn((x) => x),
    save: jest.fn(async (x) => ({ id: x.id ?? 'generated-id', ...x })),
    find: jest.fn(async () => []),
    findOne: jest.fn(),
    softDelete: jest.fn(async () => undefined),
    createQueryBuilder: jest.fn(),
  };
}

/** Chainable insert builder stub for `.insert().values().orIgnore().execute()`. */
function makeInsertBuilder() {
  const b: Record<string, jest.Mock> = {};
  b.insert = jest.fn(() => b);
  b.values = jest.fn(() => b);
  b.orIgnore = jest.fn(() => b);
  b.execute = jest.fn(async () => ({ identifiers: [] }));
  return b;
}

const POST_ID = '22222222-2222-2222-2222-222222222222';
const VISIBLE_POST = {
  id: POST_ID,
  moderationState: 'visible',
  deletedAt: null,
};

describe('CitizenBookmarkService', () => {
  let service: CitizenBookmarkService;
  let bookmarkRepo: Repo;

  // EntityManager-scoped repos
  let emPostRepo: Repo;
  let emBookmarkRepo: Repo;
  let emAuditRepo: Repo;
  let em: { getRepository: (entity: { name: string }) => Repo };
  let auditSaves: Array<{ action: string; targetKind: string; detail: unknown }>;

  beforeEach(() => {
    bookmarkRepo = makeRepo();
    emPostRepo = makeRepo();
    emBookmarkRepo = makeRepo();
    emAuditRepo = makeRepo();

    // The post exists + is visible by default — toggle gate passes.
    emPostRepo.findOne = jest.fn(async () => VISIBLE_POST);

    auditSaves = [];
    emAuditRepo.save = jest.fn(async (x) => {
      auditSaves.push(x);
      return { id: 'audit-1', ...x };
    });

    const emRepoByName: Record<string, Repo> = {
      CitizenPost: emPostRepo,
      CitizenBookmark: emBookmarkRepo,
      CitizenAuditLog: emAuditRepo,
    };
    em = { getRepository: (entity: { name: string }) => emRepoByName[entity.name] };

    // W-S1: `listMine` batch-loads the reaction breakdown via
    // `dataSource.getRepository(CitizenPostReaction).createQueryBuilder('r')`.
    const reactionRepo = makeRepo();
    reactionRepo.createQueryBuilder = jest.fn(() => {
      const b: Record<string, jest.Mock> = {};
      b.select = jest.fn(() => b);
      b.addSelect = jest.fn(() => b);
      b.where = jest.fn(() => b);
      b.andWhere = jest.fn(() => b);
      b.groupBy = jest.fn(() => b);
      b.addGroupBy = jest.fn(() => b);
      b.getRawMany = jest.fn(async () => []);
      return b;
    });

    const dataSource = {
      transaction: async (cb: (em: unknown) => Promise<unknown>) => cb(em),
      manager: {},
      getRepository: () => reactionRepo,
    };

    // W-S2: the repost embed batch-loader. Default → no embeds (empty map).
    const repostEmbedService = { batchLoadEmbeds: jest.fn(async () => new Map()) };
    // W-S7: the poll batch-loader. Default → no polls (empty map).
    const pollService = { batchLoadPolls: jest.fn(async () => new Map()) };

    service = new CitizenBookmarkService(
      bookmarkRepo as never,
      makeRepo() as never, // mediaRepo
      pollService as never,
      repostEmbedService as never,
      dataSource as never,
    );
  });

  describe('toggle', () => {
    it('rejects when the post is missing / not visible (404)', async () => {
      emPostRepo.findOne = jest.fn(async () => null);
      await expect(service.toggle('identity-1', POST_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(emBookmarkRepo.findOne).not.toHaveBeenCalled();
    });

    it('inserts (orIgnore) a fresh bookmark → bookmarked=true + audit row', async () => {
      emBookmarkRepo.findOne = jest.fn(async () => null);
      const insertBuilder = makeInsertBuilder();
      emBookmarkRepo.createQueryBuilder = jest.fn(() => insertBuilder);

      const result = await service.toggle('identity-1', POST_ID);

      expect(insertBuilder.orIgnore).toHaveBeenCalledTimes(1);
      expect(insertBuilder.execute).toHaveBeenCalledTimes(1);
      expect(emBookmarkRepo.softDelete).not.toHaveBeenCalled();
      expect(result).toEqual({ bookmarked: true });
      expect(auditSaves[0]).toMatchObject({
        actorKind: 'citizen',
        actorId: 'identity-1',
        action: 'bookmark.toggle',
        targetKind: 'post',
        targetId: POST_ID,
        detail: { postId: POST_ID, bookmarked: true },
      });
    });

    it('soft-deletes a live bookmark → bookmarked=false + audit row', async () => {
      emBookmarkRepo.findOne = jest.fn(async () => ({ id: 'bm-1' }));
      emBookmarkRepo.createQueryBuilder = jest.fn(() => makeInsertBuilder());

      const result = await service.toggle('identity-1', POST_ID);

      expect(emBookmarkRepo.softDelete).toHaveBeenCalledWith('bm-1');
      expect(emBookmarkRepo.createQueryBuilder).not.toHaveBeenCalled();
      expect(result).toEqual({ bookmarked: false });
      expect(auditSaves[0]).toMatchObject({
        detail: { postId: POST_ID, bookmarked: false },
      });
    });

    it('is idempotent/race-safe on→off→on (insert, then delete, then insert)', async () => {
      // on: no live row → insert
      emBookmarkRepo.findOne = jest.fn(async () => null);
      const ib1 = makeInsertBuilder();
      emBookmarkRepo.createQueryBuilder = jest.fn(() => ib1);
      expect(await service.toggle('identity-1', POST_ID)).toEqual({
        bookmarked: true,
      });

      // off: live row → soft-delete
      emBookmarkRepo.findOne = jest.fn(async () => ({ id: 'bm-1' }));
      expect(await service.toggle('identity-1', POST_ID)).toEqual({
        bookmarked: false,
      });

      // on again: live row gone → insert (orIgnore re-save under partial-unique)
      emBookmarkRepo.findOne = jest.fn(async () => null);
      const ib2 = makeInsertBuilder();
      emBookmarkRepo.createQueryBuilder = jest.fn(() => ib2);
      expect(await service.toggle('identity-1', POST_ID)).toEqual({
        bookmarked: true,
      });

      expect(auditSaves).toHaveLength(3);
      expect(auditSaves.map((a) => (a.detail as { bookmarked: boolean }).bookmarked)).toEqual([
        true,
        false,
        true,
      ]);
    });
  });

  describe('listMine', () => {
    it('returns visible saved posts only, mapped to the PostDto shape', async () => {
      const now = new Date('2026-06-25T00:00:00.000Z');
      const rows = [
        {
          id: 'bm-1',
          createdAt: now,
          post: {
            id: POST_ID,
            postKind: 'idea',
            lat: '14.9',
            lng: '102.1',
            amphoeId: 'amphoe-1',
            category: 'road',
            title: 'Fix the road',
            detail: 'pothole',
            heartCount: 3,
            commentCount: 1,
            createdAt: now,
            author: { displayAlias: 'Alias A' },
          },
        },
      ];

      const qb: Record<string, jest.Mock> = {};
      qb.innerJoinAndSelect = jest.fn(() => qb);
      qb.leftJoin = jest.fn(() => qb);
      qb.addSelect = jest.fn(() => qb);
      qb.where = jest.fn(() => qb);
      qb.andWhere = jest.fn(() => qb);
      qb.orderBy = jest.fn(() => qb);
      qb.addOrderBy = jest.fn(() => qb);
      qb.take = jest.fn(() => qb);
      qb.getMany = jest.fn(async () => rows);
      bookmarkRepo.createQueryBuilder = jest.fn(() => qb);

      const result = await service.listMine('identity-1', {});

      // visibility + ownership constraints applied on the QB
      const andWhereArgs = qb.andWhere.mock.calls.map((c) => c[0]);
      expect(andWhereArgs).toContain('p.moderationState = :state');
      expect(andWhereArgs).toContain('p.deletedAt IS NULL');
      expect(andWhereArgs).toContain('b.deletedAt IS NULL');

      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({
        id: POST_ID,
        postKind: 'idea',
        lat: 14.9,
        lng: 102.1,
        title: 'Fix the road',
        author: { displayAlias: 'Alias A' },
        media: [],
      });
      // single page below the default limit → no further cursor
      expect(result.nextCursor).toBeNull();
    });
  });

  describe('listMyIds', () => {
    it('returns the live-bookmarked post id set', async () => {
      bookmarkRepo.find = jest.fn(async () => [
        { postId: 'post-a' },
        { postId: 'post-b' },
      ]);
      const ids = await service.listMyIds('identity-1');
      expect(ids).toEqual(['post-a', 'post-b']);
    });
  });
});
