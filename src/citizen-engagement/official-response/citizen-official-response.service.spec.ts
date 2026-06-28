import { BadRequestException, NotFoundException } from '@nestjs/common';

import { CitizenOfficialResponseService } from './citizen-official-response.service';

/**
 * Unit spec for CitizenOfficialResponseService (C4 / D12). Mocks the response +
 * post repos, the notification service, and a dataSource whose `.transaction(cb)`
 * runs cb with a mock EntityManager. No encryption.util usage → no jest.mock.
 */
type Repo = {
  create: jest.Mock;
  save: jest.Mock;
  findOne: jest.Mock;
  find: jest.Mock;
  update: jest.Mock;
};

function makeRepo(): Repo {
  return {
    create: jest.fn((x) => x),
    save: jest.fn(async (x) => ({ id: x.id ?? 'resp-new', ...x })),
    findOne: jest.fn(async () => null),
    find: jest.fn(async () => []),
    update: jest.fn(async () => ({ affected: 1 })),
  };
}

const RESPONDER = {
  userId: 'u-staff',
  workHistoryId: 'wh-staff',
  displayName: 'เจ้าหน้าที่ ก.',
  agencyName: 'สำนักการช่าง',
};

describe('CitizenOfficialResponseService', () => {
  let service: CitizenOfficialResponseService;
  let responseRepo: Repo;
  let postRepo: Repo;
  let notificationService: {
    notifyOnOfficialResponse: jest.Mock;
    notifyOnOfficialResponseStatus: jest.Mock;
  };
  let emPostRepo: Repo;
  let emResponseRepo: Repo;
  let emAuditRepo: Repo;
  let auditSaves: Array<{ actorKind: string; action: string; targetKind: string }>;

  beforeEach(() => {
    responseRepo = makeRepo();
    postRepo = makeRepo();
    notificationService = {
      notifyOnOfficialResponse: jest.fn(async () => undefined),
      notifyOnOfficialResponseStatus: jest.fn(async () => undefined),
    };

    emPostRepo = makeRepo();
    emResponseRepo = makeRepo();
    emAuditRepo = makeRepo();
    auditSaves = [];
    emAuditRepo.save = jest.fn(async (x) => {
      auditSaves.push(x);
      return { id: 'audit-1', ...x };
    });

    const emRepoByName: Record<string, Repo> = {
      CitizenPost: emPostRepo,
      CitizenOfficialResponse: emResponseRepo,
      CitizenAuditLog: emAuditRepo,
    };
    const em = { getRepository: (e: { name: string }) => emRepoByName[e.name] };
    const dataSource = {
      transaction: async (cb: (em: unknown) => Promise<unknown>) => cb(em),
    };

    service = new CitizenOfficialResponseService(
      responseRepo as never,
      postRepo as never,
      notificationService as never,
      dataSource as never,
    );
  });

  describe('respond', () => {
    it('inserts the response, notifies the author, and writes an internal audit', async () => {
      emPostRepo.findOne = jest.fn(async () => ({
        id: 'post-1',
        authorIdentityId: 'identity-author',
        moderationState: 'visible',
      }));
      emResponseRepo.save = jest.fn(async (x) => ({ ...x, id: 'resp-1' }));

      const result = await service.respond(RESPONDER, 'post-1', 'เราจะดำเนินการครับ');

      const saved = emResponseRepo.create.mock.calls[0][0];
      expect(saved).toMatchObject({
        postId: 'post-1',
        responderWorkHistoryId: 'wh-staff',
        responderUserId: 'u-staff',
        responderDisplayName: 'เจ้าหน้าที่ ก.',
        responderAgencyName: 'สำนักการช่าง',
        body: 'เราจะดำเนินการครับ',
        // W-G2: a new response always starts in `received`.
        status: 'received',
      });
      expect(saved.statusUpdatedAt).toBeInstanceOf(Date);
      // DTO surfaces the lifecycle fields.
      expect(result).toMatchObject({ status: 'received' });
      expect(result.statusUpdatedAt).not.toBeNull();
      // notifies the post author in the same tx (actor null, kind official_response)
      expect(notificationService.notifyOnOfficialResponse).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ id: 'post-1', authorIdentityId: 'identity-author' }),
        'resp-1',
      );
      expect(auditSaves[0]).toMatchObject({
        actorKind: 'internal',
        action: 'official-response.create',
        targetKind: 'official_response',
      });
      // DTO exposes only the snapshot — never the plain uuids
      expect(result).toMatchObject({
        id: 'resp-1',
        responderDisplayName: 'เจ้าหน้าที่ ก.',
        responderAgencyName: 'สำนักการช่าง',
      });
      expect(result).not.toHaveProperty('responderUserId');
    });

    it('404s when the post is missing / removed', async () => {
      emPostRepo.findOne = jest.fn(async () => null);
      await expect(service.respond(RESPONDER, 'missing', 'x')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(notificationService.notifyOnOfficialResponse).not.toHaveBeenCalled();
    });
  });

  describe('listForPost', () => {
    it('returns the visible post responses oldest-first', async () => {
      postRepo.findOne = jest.fn(async () => ({ id: 'post-1', moderationState: 'visible' }));
      responseRepo.find = jest.fn(async () => [
        { id: 'r1', body: 'a', responderDisplayName: 'ก.', responderAgencyName: null },
      ]);
      const result = await service.listForPost('post-1');
      expect(result).toHaveLength(1);
      expect(result[0].responderDisplayName).toBe('ก.');
    });

    it('returns [] when the post is missing / removed', async () => {
      postRepo.findOne = jest.fn(async () => null);
      expect(await service.listForPost('missing')).toEqual([]);
    });
  });

  describe('updateStatus', () => {
    it('advances forward, persists status + timestamp, and notifies the owner', async () => {
      emResponseRepo.findOne = jest.fn(async () => ({
        id: 'resp-1',
        postId: 'post-1',
        status: 'received',
        statusUpdatedAt: new Date('2026-06-26T00:00:00Z'),
      }));
      emResponseRepo.update = jest.fn(async () => ({ affected: 1 }));
      emPostRepo.findOne = jest.fn(async () => ({
        id: 'post-1',
        authorIdentityId: 'identity-author',
        moderationState: 'visible',
      }));

      const result = await service.updateStatus(RESPONDER, 'resp-1', 'in_progress');

      // persisted the forward move + timestamp
      const [where, patch] = emResponseRepo.update.mock.calls[0];
      expect(where).toEqual({ id: 'resp-1' });
      expect(patch.status).toBe('in_progress');
      expect(patch.statusUpdatedAt).toBeInstanceOf(Date);
      // notified the post owner (reuses official_response kind, null actor)
      expect(notificationService.notifyOnOfficialResponseStatus).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ id: 'post-1', authorIdentityId: 'identity-author' }),
        'resp-1',
      );
      // audited
      expect(auditSaves[0]).toMatchObject({
        actorKind: 'internal',
        action: 'official-response.status',
        targetKind: 'official_response',
      });
      // DTO reflects the new status
      expect(result).toMatchObject({ status: 'in_progress' });
    });

    it('rejects a backward transition with 400 OFFICIAL_RESPONSE_STATUS_INVALID', async () => {
      emResponseRepo.findOne = jest.fn(async () => ({
        id: 'resp-1',
        postId: 'post-1',
        status: 'resolved',
        statusUpdatedAt: new Date(),
      }));
      emResponseRepo.update = jest.fn(async () => ({ affected: 1 }));

      await expect(
        service.updateStatus(RESPONDER, 'resp-1', 'in_progress'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(emResponseRepo.update).not.toHaveBeenCalled();
      expect(notificationService.notifyOnOfficialResponseStatus).not.toHaveBeenCalled();
    });

    it('is a NO-OP on same-status (no write, no dup notify, no audit)', async () => {
      emResponseRepo.findOne = jest.fn(async () => ({
        id: 'resp-1',
        postId: 'post-1',
        status: 'in_progress',
        statusUpdatedAt: new Date(),
      }));
      emResponseRepo.update = jest.fn(async () => ({ affected: 1 }));

      const result = await service.updateStatus(RESPONDER, 'resp-1', 'in_progress');

      expect(emResponseRepo.update).not.toHaveBeenCalled();
      expect(notificationService.notifyOnOfficialResponseStatus).not.toHaveBeenCalled();
      expect(auditSaves).toHaveLength(0);
      expect(result).toMatchObject({ status: 'in_progress' });
    });

    it('404s when the response is missing / deleted', async () => {
      emResponseRepo.findOne = jest.fn(async () => null);
      await expect(
        service.updateStatus(RESPONDER, 'missing', 'resolved'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
