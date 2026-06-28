import { BadRequestException, NotFoundException } from '@nestjs/common';

import { CitizenBlockService } from './citizen-block.service';

/**
 * Unit spec for CitizenBlockService (W-T1 block / mute).
 *
 * No encryption.util import → no jest.mock needed. The constructor takes a block
 * repo + identity repo + a follow-service stub + a dataSource whose
 * `.transaction(cb)` invokes the callback with a mock EntityManager handing back
 * per-entity sub-repos (same shape as the follow / post specs).
 */

type Repo = {
  create: jest.Mock;
  save: jest.Mock;
  find: jest.Mock;
  findOne: jest.Mock;
  count: jest.Mock;
  update: jest.Mock;
  softDelete: jest.Mock;
  createQueryBuilder: jest.Mock;
};

function makeRepo(): Repo {
  return {
    create: jest.fn((x) => x),
    save: jest.fn(async (x) => ({ id: x.id ?? 'generated-id', ...x })),
    find: jest.fn(async () => []),
    findOne: jest.fn(async () => null),
    count: jest.fn(async () => 0),
    update: jest.fn(async () => undefined),
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

/** Chainable update builder stub for `.update().set().where()…execute()`. */
function makeUpdateBuilder() {
  const b: Record<string, jest.Mock> = {};
  b.update = jest.fn(() => b);
  b.set = jest.fn(() => b);
  b.where = jest.fn(() => b);
  b.andWhere = jest.fn(() => b);
  b.execute = jest.fn(async () => ({ affected: 1 }));
  return b;
}

const BLOCKER = '11111111-1111-1111-1111-111111111111';
const TARGET = '22222222-2222-2222-2222-222222222222';

describe('CitizenBlockService', () => {
  let service: CitizenBlockService;
  let blockRepo: Repo;
  let identityRepo: Repo;
  let emBlockRepo: Repo;
  let emAuditRepo: Repo;
  let followService: { softDeleteMutualPersonFollows: jest.Mock };
  let em: { getRepository: (e: { name: string }) => Repo };
  let auditSaves: Array<{ action: string; targetKind: string; targetId: string }>;

  beforeEach(() => {
    blockRepo = makeRepo();
    identityRepo = makeRepo();
    emBlockRepo = makeRepo();
    emAuditRepo = makeRepo();

    auditSaves = [];
    emAuditRepo.save = jest.fn(async (x) => {
      auditSaves.push(x);
      return { id: 'audit-1', ...x };
    });

    // Default: the target identity exists + is active.
    identityRepo.findOne = jest.fn(async () => ({
      id: TARGET,
      status: 'active',
      displayAlias: 'อีกคน',
    }));

    followService = { softDeleteMutualPersonFollows: jest.fn(async () => undefined) };

    const emRepoByName: Record<string, Repo> = {
      CitizenBlock: emBlockRepo,
      CitizenAuditLog: emAuditRepo,
    };
    em = { getRepository: (e: { name: string }) => emRepoByName[e.name] };

    const dataSource = {
      transaction: async (cb: (em: unknown) => Promise<unknown>) => cb(em),
    };

    service = new CitizenBlockService(
      blockRepo as never,
      identityRepo as never,
      followService as never,
      dataSource as never,
    );
  });

  describe('set', () => {
    it('rejects blocking yourself with CITIZEN_BLOCK_SELF', async () => {
      await expect(service.set(BLOCKER, BLOCKER, 'block')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(identityRepo.findOne).not.toHaveBeenCalled();
    });

    it('404s when the target identity does not exist', async () => {
      identityRepo.findOne = jest.fn(async () => null);
      await expect(service.set(BLOCKER, TARGET, 'mute')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('inserts a fresh mute edge (no follow side-effect) and audits', async () => {
      emBlockRepo.findOne = jest.fn(async () => null);
      emBlockRepo.createQueryBuilder = jest
        .fn()
        .mockReturnValueOnce(makeInsertBuilder())
        .mockReturnValueOnce(makeUpdateBuilder());

      const res = await service.set(BLOCKER, TARGET, 'mute');

      expect(res).toEqual({ targetId: TARGET, kind: 'mute' });
      // mute does NOT touch follows.
      expect(followService.softDeleteMutualPersonFollows).not.toHaveBeenCalled();
      expect(auditSaves[0]).toMatchObject({ action: 'block.set', targetKind: 'block', targetId: TARGET });
    });

    it('on block, soft-deletes the follow edges in BOTH directions', async () => {
      emBlockRepo.findOne = jest.fn(async () => null);
      emBlockRepo.createQueryBuilder = jest
        .fn()
        .mockReturnValueOnce(makeInsertBuilder())
        .mockReturnValueOnce(makeUpdateBuilder());

      await service.set(BLOCKER, TARGET, 'block');

      expect(followService.softDeleteMutualPersonFollows).toHaveBeenCalledWith(
        em,
        BLOCKER,
        TARGET,
      );
    });

    it('switches kind in place when a live edge already exists (upsert)', async () => {
      emBlockRepo.findOne = jest.fn(async () => ({ id: 'edge-1', kind: 'mute' }));

      const res = await service.set(BLOCKER, TARGET, 'block');

      expect(emBlockRepo.update).toHaveBeenCalledWith('edge-1', { kind: 'block' });
      expect(res).toEqual({ targetId: TARGET, kind: 'block' });
      // mute → block still soft-deletes the mutual follows.
      expect(followService.softDeleteMutualPersonFollows).toHaveBeenCalled();
    });
  });

  describe('unset', () => {
    it('soft-deletes the live edge and audits', async () => {
      emBlockRepo.findOne = jest.fn(async () => ({ id: 'edge-1', kind: 'block' }));

      const res = await service.unset(BLOCKER, TARGET);

      expect(emBlockRepo.softDelete).toHaveBeenCalledWith('edge-1');
      expect(res).toEqual({ removed: true });
      expect(auditSaves[0]).toMatchObject({ action: 'block.unset' });
    });

    it('is a no-op when no live edge exists', async () => {
      emBlockRepo.findOne = jest.fn(async () => null);
      const res = await service.unset(BLOCKER, TARGET);
      expect(emBlockRepo.softDelete).not.toHaveBeenCalled();
      expect(res).toEqual({ removed: false });
    });
  });

  describe('listMyBlocks (owner-scoped)', () => {
    it('maps the caller OWN live edges to [{ targetId, kind }]', async () => {
      blockRepo.find = jest.fn(async () => [
        { blockedIdentityId: 'a', kind: 'mute' },
        { blockedIdentityId: 'b', kind: 'block' },
      ]);
      const res = await service.listMyBlocks(BLOCKER);
      expect(res).toEqual([
        { targetId: 'a', kind: 'mute' },
        { targetId: 'b', kind: 'block' },
      ]);
      // owner-scoped: queried by the caller's id.
      expect(blockRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ blockerIdentityId: BLOCKER }) }),
      );
    });
  });

  describe('hiddenAuthorIdsFor', () => {
    it('returns the muted-or-blocked author ids for a viewer', async () => {
      blockRepo.find = jest.fn(async () => [
        { blockedIdentityId: 'x' },
        { blockedIdentityId: 'y' },
      ]);
      expect(await service.hiddenAuthorIdsFor(BLOCKER)).toEqual(['x', 'y']);
    });

    it('returns [] for an anonymous viewer (no id)', async () => {
      expect(await service.hiddenAuthorIdsFor(undefined)).toEqual([]);
      expect(blockRepo.find).not.toHaveBeenCalled();
    });
  });

  describe('blockedBySet', () => {
    it('returns ids of citizens who BLOCKED the target (block kind only)', async () => {
      blockRepo.find = jest.fn(async () => [{ blockerIdentityId: 'p' }]);
      expect(await service.blockedBySet(TARGET)).toEqual(['p']);
      // kind = 'block' is part of the filter.
      expect(blockRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ kind: 'block' }) }),
      );
    });

    it('returns [] for an anonymous viewer (no id)', async () => {
      expect(await service.blockedBySet(undefined)).toEqual([]);
    });
  });

  describe('isBlockedEitherWay (interaction guard, block only)', () => {
    it('false for self', async () => {
      expect(await service.isBlockedEitherWay(BLOCKER, BLOCKER)).toBe(false);
      expect(blockRepo.count).not.toHaveBeenCalled();
    });

    it('true when a block edge exists either way', async () => {
      blockRepo.count = jest.fn(async () => 1);
      expect(await service.isBlockedEitherWay(BLOCKER, TARGET)).toBe(true);
    });

    it('false when no block edge exists (mute does not count — kind filter)', async () => {
      blockRepo.count = jest.fn(async () => 0);
      expect(await service.isBlockedEitherWay(BLOCKER, TARGET)).toBe(false);
    });
  });

  describe('excludedAuthorIdsForViewer', () => {
    it('unions hidden + blocked-by ids', async () => {
      blockRepo.find = jest
        .fn()
        // hiddenAuthorIdsFor
        .mockResolvedValueOnce([{ blockedIdentityId: 'a' }])
        // blockedBySet
        .mockResolvedValueOnce([{ blockerIdentityId: 'b' }]);
      const set = await service.excludedAuthorIdsForViewer(BLOCKER);
      expect([...set].sort()).toEqual(['a', 'b']);
    });

    it('empty set for anonymous viewer', async () => {
      const set = await service.excludedAuthorIdsForViewer(undefined);
      expect(set.size).toBe(0);
    });
  });
});
