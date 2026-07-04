import { BadRequestException, NotFoundException } from '@nestjs/common';

import { CitizenFollowService } from './citizen-follow.service';

/**
 * Unit spec for CitizenFollowService.
 *
 * No encryption.util import → no jest.mock needed. The constructor repos
 * (follow + identity) + a dataSource whose `.transaction(cb)` invokes the
 * callback with a mock EntityManager handing back per-entity sub-repos (same
 * shape as the C2 post spec). The follow repo + identity repo + audit repo are
 * the only ones touched.
 */

type Repo = {
  create: jest.Mock;
  save: jest.Mock;
  find: jest.Mock;
  findOne: jest.Mock;
  count: jest.Mock;
  softDelete: jest.Mock;
  createQueryBuilder: jest.Mock;
};

function makeRepo(): Repo {
  return {
    create: jest.fn((x) => x),
    save: jest.fn(async (x) => ({ id: x.id ?? 'generated-id', ...x })),
    find: jest.fn(async () => []),
    findOne: jest.fn(),
    count: jest.fn(async () => 0),
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

// Amphoe ids are short string codes (e.g. "3001"), NOT uuids.
const VALID_AMPHOE = '3001';
const SELF_ID = '22222222-2222-2222-2222-222222222222';
const OTHER_PERSON = '33333333-3333-3333-3333-333333333333';

describe('CitizenFollowService', () => {
  let service: CitizenFollowService;
  let followRepo: Repo;
  let identityRepo: Repo;
  let blockService: { isBlockedEitherWay: jest.Mock };

  // EntityManager-scoped repos
  let emFollowRepo: Repo;
  let emAuditRepo: Repo;
  let em: { getRepository: (entity: { name: string }) => Repo };
  let auditSaves: Array<{ action: string; targetKind: string; detail: unknown }>;

  beforeEach(() => {
    followRepo = makeRepo();
    identityRepo = makeRepo();
    emFollowRepo = makeRepo();
    emAuditRepo = makeRepo();

    auditSaves = [];
    emAuditRepo.save = jest.fn(async (x) => {
      auditSaves.push(x);
      return { id: 'audit-1', ...x };
    });

    const emRepoByName: Record<string, Repo> = {
      CitizenFollow: emFollowRepo,
      CitizenAuditLog: emAuditRepo,
    };
    em = { getRepository: (entity: { name: string }) => emRepoByName[entity.name] };

    const dataSource = {
      transaction: async (cb: (em: unknown) => Promise<unknown>) => cb(em),
    };

    // W-T1: block service mock — default never-blocked so the person-follow
    // interaction guard is a no-op for the existing follow specs.
    blockService = {
      isBlockedEitherWay: jest.fn(async () => false),
    };

    service = new CitizenFollowService(
      followRepo as never,
      identityRepo as never,
      blockService as never,
      dataSource as never,
    );
  });

  describe('toggleFollow validation', () => {
    it('rejects an invalid targetKind with CITIZEN_FOLLOW_INVALID', async () => {
      await expect(
        service.toggleFollow('identity-1', 'bogus', 'someone'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(emFollowRepo.findOne).not.toHaveBeenCalled();
    });

    it('rejects a category target that is not one of the 5 categories', async () => {
      await expect(
        service.toggleFollow('identity-1', 'category', 'sports'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an empty or over-long amphoe target with CITIZEN_FOLLOW_INVALID', async () => {
      // Amphoe ids are short codes (e.g. "3001") — reject only genuinely-invalid
      // values: empty/whitespace or longer than the 16-char cap.
      await expect(
        service.toggleFollow('identity-1', 'amphoe', ''),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.toggleFollow('identity-1', 'amphoe', '   '),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.toggleFollow('identity-1', 'amphoe', 'x'.repeat(17)),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(emFollowRepo.findOne).not.toHaveBeenCalled();
    });

    it('accepts a real amphoe code like "3001" → following=true', async () => {
      emFollowRepo.findOne = jest.fn(async () => null);
      const insertBuilder = makeInsertBuilder();
      emFollowRepo.createQueryBuilder = jest.fn(() => insertBuilder);

      const result = await service.toggleFollow('identity-1', 'amphoe', VALID_AMPHOE);

      expect(insertBuilder.orIgnore).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ following: true });
    });
  });

  describe('toggleFollow person (W-GATE-1)', () => {
    it('rejects a person target that is not a uuid (CITIZEN_FOLLOW_INVALID)', async () => {
      await expect(
        service.toggleFollow(SELF_ID, 'person', 'not-a-uuid'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(identityRepo.findOne).not.toHaveBeenCalled();
    });

    it('rejects following YOURSELF with CITIZEN_FOLLOW_SELF (400, no existence read)', async () => {
      await expect(
        service.toggleFollow(SELF_ID, 'person', SELF_ID),
      ).rejects.toMatchObject({ message: 'CITIZEN_FOLLOW_SELF' });
      // self-check short-circuits BEFORE any identity existence read
      expect(identityRepo.findOne).not.toHaveBeenCalled();
      expect(emFollowRepo.findOne).not.toHaveBeenCalled();
    });

    it('404s following a NON-EXISTENT / blocked person (CITIZEN_IDENTITY_NOT_FOUND)', async () => {
      identityRepo.findOne = jest.fn(async () => null);
      await expect(
        service.toggleFollow(SELF_ID, 'person', OTHER_PERSON),
      ).rejects.toBeInstanceOf(NotFoundException);
      // existence checked with status='active' + not soft-deleted
      expect(identityRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: OTHER_PERSON, status: 'active' }),
        }),
      );
      // never reached the toggle transaction
      expect(emFollowRepo.findOne).not.toHaveBeenCalled();
    });

    it('W-T1: refuses to follow a person blocked either-way with 403 CITIZEN_BLOCKED', async () => {
      identityRepo.findOne = jest.fn(async () => ({ id: OTHER_PERSON, status: 'active' }));
      blockService.isBlockedEitherWay = jest.fn(async () => true);

      await expect(
        service.toggleFollow(SELF_ID, 'person', OTHER_PERSON),
      ).rejects.toMatchObject({ message: 'CITIZEN_BLOCKED' });
      expect(blockService.isBlockedEitherWay).toHaveBeenCalledWith(SELF_ID, OTHER_PERSON);
      // never reached the toggle transaction
      expect(emFollowRepo.findOne).not.toHaveBeenCalled();
    });

    it('follows an existing person → following=true (race-safe orIgnore) + audit', async () => {
      identityRepo.findOne = jest.fn(async () => ({ id: OTHER_PERSON, status: 'active' }));
      emFollowRepo.findOne = jest.fn(async () => null);
      const insertBuilder = makeInsertBuilder();
      emFollowRepo.createQueryBuilder = jest.fn(() => insertBuilder);

      const result = await service.toggleFollow(SELF_ID, 'person', OTHER_PERSON);

      // race-safe insert (ON CONFLICT DO NOTHING), not a soft-delete
      expect(insertBuilder.orIgnore).toHaveBeenCalledTimes(1);
      expect(insertBuilder.execute).toHaveBeenCalledTimes(1);
      expect(emFollowRepo.softDelete).not.toHaveBeenCalled();
      expect(result).toEqual({ following: true });
      expect(auditSaves[0]).toMatchObject({
        action: 'follow.toggle',
        targetKind: 'follow',
        detail: { targetKind: 'person', targetKey: OTHER_PERSON, following: true },
      });
    });

    it('unfollows a live person follow → following=false (soft-delete, no insert)', async () => {
      identityRepo.findOne = jest.fn(async () => ({ id: OTHER_PERSON, status: 'active' }));
      emFollowRepo.findOne = jest.fn(async () => ({ id: 'follow-9' }));
      emFollowRepo.createQueryBuilder = jest.fn(() => makeInsertBuilder());

      const result = await service.toggleFollow(SELF_ID, 'person', OTHER_PERSON);

      expect(emFollowRepo.softDelete).toHaveBeenCalledWith('follow-9');
      expect(emFollowRepo.createQueryBuilder).not.toHaveBeenCalled();
      expect(result).toEqual({ following: false });
    });
  });

  describe('listFollowedPeople + getFollowerCount (W-GATE-1, D16)', () => {
    it('listFollowedPeople returns the caller OWN followed identity ids', async () => {
      followRepo.find = jest.fn(async () => [
        { targetKind: 'person', targetKey: OTHER_PERSON },
        { targetKind: 'person', targetKey: VALID_AMPHOE },
      ]);
      const result = await service.listFollowedPeople(SELF_ID);
      expect(followRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            followerIdentityId: SELF_ID,
            targetKind: 'person',
          }),
        }),
      );
      expect(result).toEqual([OTHER_PERSON, VALID_AMPHOE]);
    });

    it('getFollowerCount returns the public COUNT (never a roster)', async () => {
      followRepo.count = jest.fn(async () => 7);
      const count = await service.getFollowerCount(OTHER_PERSON);
      expect(followRepo.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            targetKind: 'person',
            targetKey: OTHER_PERSON,
          }),
        }),
      );
      expect(count).toBe(7);
    });
  });

  describe('toggleFollow', () => {
    it('inserts (orIgnore) a new follow → following=true + audit row', async () => {
      emFollowRepo.findOne = jest.fn(async () => null);
      const insertBuilder = makeInsertBuilder();
      emFollowRepo.createQueryBuilder = jest.fn(() => insertBuilder);

      const result = await service.toggleFollow('identity-1', 'category', 'road');

      expect(insertBuilder.orIgnore).toHaveBeenCalledTimes(1);
      expect(insertBuilder.execute).toHaveBeenCalledTimes(1);
      expect(emFollowRepo.softDelete).not.toHaveBeenCalled();
      expect(result).toEqual({ following: true });
      expect(auditSaves[0]).toMatchObject({
        actorKind: 'citizen',
        actorId: 'identity-1',
        action: 'follow.toggle',
        targetKind: 'follow',
        detail: { targetKind: 'category', targetKey: 'road', following: true },
      });
    });

    it('soft-deletes a live follow → following=false', async () => {
      emFollowRepo.findOne = jest.fn(async () => ({ id: 'follow-1' }));
      emFollowRepo.createQueryBuilder = jest.fn(() => makeInsertBuilder());

      const result = await service.toggleFollow('identity-1', 'amphoe', VALID_AMPHOE);

      expect(emFollowRepo.softDelete).toHaveBeenCalledWith('follow-1');
      expect(emFollowRepo.createQueryBuilder).not.toHaveBeenCalled();
      expect(result).toEqual({ following: false });
      expect(auditSaves[0]).toMatchObject({
        detail: { targetKind: 'amphoe', targetKey: VALID_AMPHOE, following: false },
      });
    });
  });

  describe('listFollowSets', () => {
    it('splits live follows into amphoes + categories + people (W-GATE-1)', async () => {
      followRepo.find = jest.fn(async () => [
        { targetKind: 'amphoe', targetKey: VALID_AMPHOE },
        { targetKind: 'category', targetKey: 'road' },
        { targetKind: 'category', targetKey: 'water' },
        { targetKind: 'person', targetKey: OTHER_PERSON },
      ]);

      const result = await service.listFollowSets('identity-1');

      expect(result).toEqual({
        amphoes: [VALID_AMPHOE],
        categories: ['road', 'water'],
        people: [OTHER_PERSON],
      });
    });

    it('returns empty sets when the citizen follows nothing', async () => {
      followRepo.find = jest.fn(async () => []);
      const result = await service.listFollowSets('identity-1');
      expect(result).toEqual({ amphoes: [], categories: [], people: [] });
    });
  });

  describe('softDeleteMutualPersonFollows (W-T1 block side-effect)', () => {
    it('soft-deletes the live person-follow edges in BOTH directions', async () => {
      // Two live edges: A→B and B→A.
      emFollowRepo.find = jest.fn(async () => [{ id: 'edge-ab' }, { id: 'edge-ba' }]);

      await service.softDeleteMutualPersonFollows(em as never, SELF_ID, OTHER_PERSON);

      // queried with an OR of both directions, person kind, live only
      const whereArg = (emFollowRepo.find as jest.Mock).mock.calls[0][0].where;
      expect(Array.isArray(whereArg)).toBe(true);
      expect(emFollowRepo.softDelete).toHaveBeenCalledWith('edge-ab');
      expect(emFollowRepo.softDelete).toHaveBeenCalledWith('edge-ba');
      expect(emFollowRepo.softDelete).toHaveBeenCalledTimes(2);
    });

    it('is a no-op when there are no live edges (idempotent)', async () => {
      emFollowRepo.find = jest.fn(async () => []);
      await service.softDeleteMutualPersonFollows(em as never, SELF_ID, OTHER_PERSON);
      expect(emFollowRepo.softDelete).not.toHaveBeenCalled();
    });
  });
});
