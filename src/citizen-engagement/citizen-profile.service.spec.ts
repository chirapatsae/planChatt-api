import { NotFoundException } from '@nestjs/common';

import { CitizenProfileService } from './citizen-profile.service';

/**
 * Unit spec for CitizenProfileService.
 *
 * The service does NOT hash anything (no encryption.util import), so there is
 * NO jest.mock('src/util/encryption.util'). We mock the two constructor repos +
 * a dataSource whose `.transaction(cb)` invokes the callback with a mock
 * EntityManager that hands back per-entity sub-repos.
 */

type Repo = {
  create: jest.Mock;
  save: jest.Mock;
  findOne: jest.Mock;
  find: jest.Mock;
  count: jest.Mock;
  createQueryBuilder: jest.Mock;
};

function makeRepo(): Repo {
  return {
    create: jest.fn((x) => x),
    save: jest.fn(async (x) => ({ id: x.id ?? 'generated-id', ...x })),
    findOne: jest.fn(),
    find: jest.fn(async () => []),
    count: jest.fn(async () => 0),
    createQueryBuilder: jest.fn(),
  };
}

/**
 * Chainable select builder stub for the getMyPosts keyset query
 * (`.where().andWhere().orderBy().addOrderBy().take().getMany()`) and the
 * heartsReceived sum query (`.select().where().andWhere().getRawOne()`).
 */
function makeSelectBuilder(opts: {
  many?: unknown[];
  raw?: { sum: string };
}) {
  const b: Record<string, jest.Mock> = {};
  b.select = jest.fn(() => b);
  b.where = jest.fn(() => b);
  b.andWhere = jest.fn(() => b);
  b.orderBy = jest.fn(() => b);
  b.addOrderBy = jest.fn(() => b);
  b.take = jest.fn(() => b);
  b.getMany = jest.fn(async () => opts.many ?? []);
  b.getRawOne = jest.fn(async () => opts.raw ?? { sum: '0' });
  return b;
}

const JOINED = new Date('2026-01-01T00:00:00.000Z');

describe('CitizenProfileService', () => {
  let service: CitizenProfileService;

  let identityRepo: Repo;
  let postRepo: Repo;
  let mediaRepo: Repo;

  // EntityManager-scoped repos (returned inside the PATCH transaction)
  let emIdentityRepo: Repo;
  let emPostRepo: Repo;
  let emAuditRepo: Repo;

  let auditSaves: Array<{ action: string; targetKind: string; detail: unknown }>;

  beforeEach(() => {
    identityRepo = makeRepo();
    postRepo = makeRepo();
    mediaRepo = makeRepo();

    emIdentityRepo = makeRepo();
    emPostRepo = makeRepo();
    emAuditRepo = makeRepo();

    auditSaves = [];
    emAuditRepo.save = jest.fn(async (x) => {
      auditSaves.push(x);
      return { id: 'audit-1', ...x };
    });

    const emRepoByName: Record<string, Repo> = {
      CitizenIdentity: emIdentityRepo,
      CitizenPost: emPostRepo,
      CitizenAuditLog: emAuditRepo,
    };

    const em = {
      getRepository: (entity: { name: string }) => emRepoByName[entity.name],
    };

    // W-S1: `getMyPosts` batch-loads the reaction breakdown via
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
      getRepository: () => reactionRepo,
    };

    // W-S2: the repost embed batch-loader. Default → no embeds (empty map).
    const repostEmbedService = { batchLoadEmbeds: jest.fn(async () => new Map()) };

    // Presence wave added an EventEmitter2 dependency (visibility-change event).
    const events = { emit: jest.fn() };

    service = new CitizenProfileService(
      identityRepo as never,
      postRepo as never,
      mediaRepo as never,
      repostEmbedService as never,
      dataSource as never,
      events as never,
    );
  });

  describe('getProfile', () => {
    it('returns displayAlias + postCount + heartsReceived + joinedAt', async () => {
      identityRepo.findOne = jest.fn(async () => ({
        id: 'identity-1',
        displayAlias: 'สมชาย ม.',
        createdAt: JOINED,
      }));
      postRepo.count = jest.fn(async () => 4);
      postRepo.createQueryBuilder = jest.fn(() =>
        makeSelectBuilder({ raw: { sum: '12' } }),
      );

      const result = await service.getProfile('identity-1');

      expect(result).toEqual({
        id: 'identity-1',
        displayAlias: 'สมชาย ม.',
        bio: null,
        joinedAt: JOINED.toISOString(),
        postCount: 4,
        heartsReceived: 12,
      });
      // PII guard — no hash / enc fields leak into the response
      expect(result).not.toHaveProperty('nationalIdHash');
      expect(result).not.toHaveProperty('thaidSubHash');
    });

    it('throws 404 CITIZEN_IDENTITY_NOT_FOUND when the identity is missing', async () => {
      identityRepo.findOne = jest.fn(async () => null);
      await expect(service.getProfile('ghost')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('getMyPosts', () => {
    it('filters authorIdentityId = me, includes a hidden post, nextCursor null when < limit', async () => {
      identityRepo.findOne = jest.fn(async () => ({
        id: 'identity-1',
        displayAlias: 'สมชาย ม.',
        createdAt: JOINED,
      }));

      const rows = [
        {
          id: 'post-1',
          postKind: 'idea',
          lat: '14.97',
          lng: '102.1',
          amphoeId: null,
          category: 'road',
          title: 'ถนนพัง',
          detail: 'หลุมเยอะ',
          heartCount: 3,
          commentCount: 1,
          createdAt: new Date('2026-02-02T00:00:00.000Z'),
          moderationState: 'visible',
        },
        {
          id: 'post-2',
          postKind: 'discussion',
          lat: null,
          lng: null,
          amphoeId: null,
          category: null,
          title: 'คุยกัน',
          detail: null,
          heartCount: 0,
          commentCount: 0,
          createdAt: new Date('2026-02-01T00:00:00.000Z'),
          moderationState: 'hidden',
        },
      ];
      const builder = makeSelectBuilder({ many: rows });
      postRepo.createQueryBuilder = jest.fn(() => builder);

      const result = await service.getMyPosts('identity-1', 50);

      // scoped to the caller
      expect(builder.where).toHaveBeenCalledWith(
        'p.authorIdentityId = :identityId',
        { identityId: 'identity-1' },
      );
      // owner sees ALL moderation states (no visible-only filter)
      expect(result.items).toHaveLength(2);
      expect(result.items[0].moderationState).toBe('visible');
      expect(result.items[1].moderationState).toBe('hidden');
      // decimal columns parsed back to numbers in the DTO
      expect(result.items[0].lat).toBe(14.97);
      expect(result.items[0].author.displayAlias).toBe('สมชาย ม.');
      // fewer rows than the limit → no further page
      expect(result.nextCursor).toBeNull();
    });

    it('returns a cursor when the page is full', async () => {
      identityRepo.findOne = jest.fn(async () => ({
        id: 'identity-1',
        displayAlias: 'สมชาย ม.',
        createdAt: JOINED,
      }));
      const last = {
        id: 'post-2',
        postKind: 'discussion',
        lat: null,
        lng: null,
        amphoeId: null,
        category: null,
        title: 't',
        detail: null,
        heartCount: 0,
        commentCount: 0,
        createdAt: new Date('2026-02-01T00:00:00.000Z'),
        moderationState: 'visible',
      };
      postRepo.createQueryBuilder = jest.fn(() =>
        makeSelectBuilder({ many: [{ ...last, id: 'post-1' }, last] }),
      );

      const result = await service.getMyPosts('identity-1', 2);

      expect(result.nextCursor).toEqual({
        createdAt: last.createdAt.toISOString(),
        id: 'post-2',
      });
    });
  });

  describe('updateProfile', () => {
    it('trims + saves displayAlias AND writes a profile.update audit row', async () => {
      const identity = {
        id: 'identity-1',
        displayAlias: 'เก่า',
        createdAt: JOINED,
      };
      emIdentityRepo.findOne = jest.fn(async () => identity);
      emPostRepo.count = jest.fn(async () => 0);
      emPostRepo.createQueryBuilder = jest.fn(() =>
        makeSelectBuilder({ raw: { sum: '0' } }),
      );

      const result = await service.updateProfile('identity-1', {
        displayAlias: '  ชื่อใหม่  ',
      });

      // trimmed before persist
      expect(identity.displayAlias).toBe('ชื่อใหม่');
      expect(emIdentityRepo.save).toHaveBeenCalledWith(identity);

      expect(auditSaves).toHaveLength(1);
      expect(auditSaves[0]).toMatchObject({
        actorKind: 'citizen',
        actorId: 'identity-1',
        action: 'profile.update',
        targetKind: 'identity',
        targetId: 'identity-1',
        detail: { displayAlias: 'ชื่อใหม่' },
      });

      expect(result.displayAlias).toBe('ชื่อใหม่');
    });

    it('throws 404 CITIZEN_IDENTITY_NOT_FOUND when the identity is missing', async () => {
      emIdentityRepo.findOne = jest.fn(async () => null);
      await expect(
        service.updateProfile('ghost', { displayAlias: 'x' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(emIdentityRepo.save).not.toHaveBeenCalled();
      expect(auditSaves).toHaveLength(0);
    });
  });
});
