import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

import { CitizenAppealService } from './citizen-appeal.service';

/**
 * Unit spec for CitizenAppealService (W-T3). Mocks the appeal/post repos + a
 * dataSource whose `.transaction(cb)` runs cb with a mock EntityManager handing
 * back per-entity sub-repos (mirrors citizen-moderation.service.spec.ts).
 */
type Repo = {
  create: jest.Mock;
  save: jest.Mock;
  findOne: jest.Mock;
  find: jest.Mock;
  update: jest.Mock;
  softDelete: jest.Mock;
  createQueryBuilder: jest.Mock;
};

function makeRepo(): Repo {
  return {
    create: jest.fn((x) => x),
    save: jest.fn(async (x) => ({ id: x.id ?? 'gen', ...x })),
    findOne: jest.fn(async () => null),
    find: jest.fn(async () => []),
    update: jest.fn(async () => ({ affected: 1 })),
    softDelete: jest.fn(async () => ({ affected: 1 })),
    createQueryBuilder: jest.fn(),
  };
}

const RESOLVER = { workHistoryId: 'wh-staff', role: 'staff', displayName: 'เจ้าหน้าที่ ก' };

describe('CitizenAppealService', () => {
  let service: CitizenAppealService;
  let appealRepo: Repo;
  let postRepo: Repo;
  let emAppealRepo: Repo;
  let emPostRepo: Repo;
  let emReportRepo: Repo;
  let emLogRepo: Repo;
  let emAuditRepo: Repo;
  let auditSaves: Array<{ actorKind: string; action: string }>;
  let logSaves: Array<{ action: string; actorRole: string | null }>;

  beforeEach(() => {
    appealRepo = makeRepo();
    postRepo = makeRepo();
    emAppealRepo = makeRepo();
    emPostRepo = makeRepo();
    emReportRepo = makeRepo();
    emLogRepo = makeRepo();
    emAuditRepo = makeRepo();
    auditSaves = [];
    logSaves = [];
    emAuditRepo.save = jest.fn(async (x) => {
      auditSaves.push(x);
      return { id: 'a', ...x };
    });
    emLogRepo.save = jest.fn(async (x) => {
      logSaves.push(x);
      return { id: 'l', ...x };
    });

    const emByName: Record<string, Repo> = {
      CitizenAppeal: emAppealRepo,
      CitizenPost: emPostRepo,
      CitizenReport: emReportRepo,
      CitizenModerationLog: emLogRepo,
      CitizenAuditLog: emAuditRepo,
    };
    const em = { getRepository: (e: { name: string }) => emByName[e.name] };
    const dataSource = {
      transaction: async (cb: (em: unknown) => Promise<unknown>) => cb(em),
    };

    service = new CitizenAppealService(
      appealRepo as never,
      postRepo as never,
      dataSource as never,
    );
  });

  describe('appeal (owner submit)', () => {
    it('files an appeal on the OWNER\'s removed post + audits', async () => {
      emPostRepo.findOne = jest.fn(async () => ({
        id: 'post-1',
        authorIdentityId: 'me',
        moderationState: 'removed',
      }));
      emAppealRepo.findOne = jest.fn(async () => null); // no existing open appeal

      const result = await service.appeal('me', 'post-1', 'ผมไม่ได้ทำผิด');

      expect(result.status).toBe('open');
      expect(emAppealRepo.save).toHaveBeenCalled();
      expect(auditSaves[0]).toMatchObject({ actorKind: 'citizen', action: 'appeal.create' });
    });

    it('403 when the caller is NOT the post author (owner-only)', async () => {
      emPostRepo.findOne = jest.fn(async () => ({
        id: 'post-1',
        authorIdentityId: 'someone-else',
        moderationState: 'removed',
      }));
      await expect(service.appeal('me', 'post-1', 'reason')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(emAppealRepo.save).not.toHaveBeenCalled();
    });

    it('400 when the post is still VISIBLE (not appealable)', async () => {
      emPostRepo.findOne = jest.fn(async () => ({
        id: 'post-1',
        authorIdentityId: 'me',
        moderationState: 'visible',
      }));
      await expect(service.appeal('me', 'post-1', 'reason')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('409 when an OPEN appeal already exists (one-open)', async () => {
      emPostRepo.findOne = jest.fn(async () => ({
        id: 'post-1',
        authorIdentityId: 'me',
        moderationState: 'hidden',
      }));
      emAppealRepo.findOne = jest.fn(async () => ({ id: 'ap-existing', status: 'open' }));
      await expect(service.appeal('me', 'post-1', 'reason')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(emAppealRepo.save).not.toHaveBeenCalled();
    });

    it('404 when the post is missing / soft-deleted', async () => {
      emPostRepo.findOne = jest.fn(async () => null);
      await expect(service.appeal('me', 'post-1', 'reason')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('resolve (staff)', () => {
    it('REVERSE restores the post to visible + soft-deletes its reports + snapshots resolver', async () => {
      emAppealRepo.findOne = jest.fn(async () => ({
        id: 'ap-1',
        postId: 'post-1',
        status: 'open',
      }));

      const result = await service.resolve(RESOLVER, 'ap-1', 'reversed');

      expect(result.status).toBe('reversed');
      expect(emPostRepo.update).toHaveBeenCalledWith(
        { id: 'post-1' },
        { moderationState: 'visible' },
      );
      expect(emReportRepo.softDelete).toHaveBeenCalledWith({ postId: 'post-1' });
      expect(emAppealRepo.update).toHaveBeenCalledWith(
        { id: 'ap-1' },
        expect.objectContaining({
          status: 'reversed',
          resolverName: 'เจ้าหน้าที่ ก',
          resolverWorkHistoryId: 'wh-staff',
        }),
      );
      expect(logSaves.some((l) => l.action === 'restore')).toBe(true);
      expect(auditSaves[0]).toMatchObject({ actorKind: 'internal', action: 'appeal.reversed' });
    });

    it('UPHOLD keeps the post removed (no post update) + marks the appeal upheld', async () => {
      emAppealRepo.findOne = jest.fn(async () => ({
        id: 'ap-1',
        postId: 'post-1',
        status: 'open',
      }));

      const result = await service.resolve(RESOLVER, 'ap-1', 'upheld');

      expect(result.status).toBe('upheld');
      expect(emPostRepo.update).not.toHaveBeenCalled();
      expect(emReportRepo.softDelete).not.toHaveBeenCalled();
      expect(emAppealRepo.update).toHaveBeenCalledWith(
        { id: 'ap-1' },
        expect.objectContaining({ status: 'upheld' }),
      );
      expect(logSaves.some((l) => l.action === 'appeal_uphold')).toBe(true);
      expect(auditSaves[0]).toMatchObject({ action: 'appeal.upheld' });
    });

    it('404 when the appeal is missing / not open', async () => {
      emAppealRepo.findOne = jest.fn(async () => null);
      await expect(service.resolve(RESOLVER, 'ap-1', 'reversed')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
