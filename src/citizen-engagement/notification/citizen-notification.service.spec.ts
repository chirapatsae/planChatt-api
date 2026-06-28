import { NotFoundException } from '@nestjs/common';

import { CitizenNotificationService } from './citizen-notification.service';

/**
 * Unit spec for CitizenNotificationService.
 *
 * Mocks the three constructor repos + a dataSource (unused by the read/write
 * paths under test — the write helpers take the caller's EntityManager). The
 * `listNotifications` path drives a queryBuilder stub; the write helpers drive
 * a mock EntityManager handing back the notification sub-repo.
 */

type Repo = {
  create: jest.Mock;
  save: jest.Mock;
  find: jest.Mock;
  count: jest.Mock;
  update: jest.Mock;
  createQueryBuilder: jest.Mock;
};

function makeRepo(): Repo {
  return {
    create: jest.fn((x) => x),
    save: jest.fn(async (x) => ({ id: x.id ?? 'generated-id', ...x })),
    find: jest.fn(async () => []),
    count: jest.fn(async () => 0),
    update: jest.fn(async () => ({ affected: 1 })),
    createQueryBuilder: jest.fn(),
  };
}

/** Chainable select builder stub returning `rows` from getMany(). */
function makeSelectBuilder(rows: unknown[]) {
  const b: Record<string, jest.Mock> = {};
  b.where = jest.fn(() => b);
  b.andWhere = jest.fn(() => b);
  b.orderBy = jest.fn(() => b);
  b.addOrderBy = jest.fn(() => b);
  b.take = jest.fn(() => b);
  b.getMany = jest.fn(async () => rows);
  return b;
}

describe('CitizenNotificationService', () => {
  let service: CitizenNotificationService;
  let notificationRepo: Repo;
  let identityRepo: Repo;
  let postRepo: Repo;
  let bus: { publish: jest.Mock };

  // EntityManager for the write helpers
  let emNotificationRepo: Repo;
  let em: { getRepository: (entity: { name: string }) => Repo };

  beforeEach(() => {
    notificationRepo = makeRepo();
    identityRepo = makeRepo();
    postRepo = makeRepo();
    emNotificationRepo = makeRepo();
    bus = { publish: jest.fn() };

    const emRepoByName: Record<string, Repo> = {
      CitizenNotification: emNotificationRepo,
    };
    em = { getRepository: (entity: { name: string }) => emRepoByName[entity.name] };

    const dataSource = {};

    service = new CitizenNotificationService(
      notificationRepo as never,
      identityRepo as never,
      postRepo as never,
      dataSource as never,
      bus as never,
    );
  });

  describe('notifyOnComment', () => {
    it('is a NO-OP when the actor is the post author (self-comment)', async () => {
      const post = { id: 'post-1', authorIdentityId: 'identity-1' } as never;
      await service.notifyOnComment(em as never, post, 'identity-1', 'comment-1');
      expect(emNotificationRepo.save).not.toHaveBeenCalled();
    });

    it('inserts a comment notification to the post author otherwise', async () => {
      const post = { id: 'post-1', authorIdentityId: 'author-1' } as never;
      await service.notifyOnComment(em as never, post, 'actor-2', 'comment-1');
      expect(emNotificationRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          recipientIdentityId: 'author-1',
          actorIdentityId: 'actor-2',
          kind: 'comment',
          postId: 'post-1',
          commentId: 'comment-1',
        }),
      );
      expect(emNotificationRepo.save).toHaveBeenCalledTimes(1);
      // W-T2: realtime ping to the recipient AFTER the row is saved (NO PII).
      expect(bus.publish).toHaveBeenCalledWith({
        recipientIdentityId: 'author-1',
        type: 'notification',
      });
    });

    it('does NOT publish a realtime ping on a self-comment NO-OP', async () => {
      const post = { id: 'post-1', authorIdentityId: 'identity-1' } as never;
      await service.notifyOnComment(em as never, post, 'identity-1', 'comment-1');
      expect(bus.publish).not.toHaveBeenCalled();
    });
  });

  describe('notifyOnHeart', () => {
    it('is a NO-OP for a self-heart', async () => {
      const post = { id: 'post-1', authorIdentityId: 'identity-1' } as never;
      await service.notifyOnHeart(em as never, post, 'identity-1');
      expect(emNotificationRepo.save).not.toHaveBeenCalled();
    });

    it('inserts a heart notification (commentId null) otherwise', async () => {
      const post = { id: 'post-1', authorIdentityId: 'author-1' } as never;
      await service.notifyOnHeart(em as never, post, 'actor-2');
      expect(emNotificationRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          recipientIdentityId: 'author-1',
          actorIdentityId: 'actor-2',
          kind: 'heart',
          postId: 'post-1',
          commentId: null,
        }),
      );
      expect(emNotificationRepo.save).toHaveBeenCalledTimes(1);
      // W-T2: realtime ping to the recipient AFTER the row is saved.
      expect(bus.publish).toHaveBeenCalledWith({
        recipientIdentityId: 'author-1',
        type: 'notification',
      });
    });
  });

  describe('W-T2 realtime fan-out', () => {
    it('notifyOnOfficialResponse publishes a ping to the post author', async () => {
      const post = { id: 'post-1', authorIdentityId: 'author-1' } as never;
      await service.notifyOnOfficialResponse(em as never, post, 'response-1');
      expect(emNotificationRepo.save).toHaveBeenCalledTimes(1);
      expect(bus.publish).toHaveBeenCalledWith({
        recipientIdentityId: 'author-1',
        type: 'notification',
      });
    });

    it('notifyOnOfficialResponseStatus publishes a ping to the post author', async () => {
      const post = { id: 'post-1', authorIdentityId: 'author-1' } as never;
      await service.notifyOnOfficialResponseStatus(em as never, post, 'response-1');
      expect(emNotificationRepo.save).toHaveBeenCalledTimes(1);
      expect(bus.publish).toHaveBeenCalledWith({
        recipientIdentityId: 'author-1',
        type: 'notification',
      });
    });

    it('a throwing bus does NOT break the notification write', async () => {
      bus.publish = jest.fn(() => {
        throw new Error('bus down');
      });
      const post = { id: 'post-1', authorIdentityId: 'author-1' } as never;
      // The write must still resolve even though the bus throws.
      await expect(
        service.notifyOnComment(em as never, post, 'actor-2', 'comment-1'),
      ).resolves.toBeUndefined();
      expect(emNotificationRepo.save).toHaveBeenCalledTimes(1);
    });

    it('is a no-op (no throw) when no bus is injected (legacy DI construction)', async () => {
      const noBusService = new CitizenNotificationService(
        notificationRepo as never,
        identityRepo as never,
        postRepo as never,
        {} as never,
      );
      const post = { id: 'post-1', authorIdentityId: 'author-1' } as never;
      await expect(
        noBusService.notifyOnHeart(em as never, post, 'actor-2'),
      ).resolves.toBeUndefined();
    });
  });

  describe('listNotifications', () => {
    it('maps rows with actor alias + post title', async () => {
      const now = new Date('2026-06-24T00:00:00.000Z');
      const rows = [
        {
          id: 'notif-1',
          kind: 'comment',
          createdAt: now,
          readAt: null,
          actorIdentityId: 'actor-1',
          postId: 'post-1',
        },
      ];
      notificationRepo.createQueryBuilder = jest.fn(() => makeSelectBuilder(rows));
      identityRepo.find = jest.fn(async () => [
        { id: 'actor-1', displayAlias: 'สมหญิง ก.' },
      ]);
      postRepo.find = jest.fn(async () => [
        { id: 'post-1', title: 'ถนนพัง' },
      ]);

      const result = await service.listNotifications('me-1');

      expect(result.items).toEqual([
        {
          id: 'notif-1',
          kind: 'comment',
          createdAt: now.toISOString(),
          read: false,
          // W-GATE-1: actor carries the opaque identity uuid handle + alias.
          actor: { id: 'actor-1', displayAlias: 'สมหญิง ก.' },
          post: { id: 'post-1', title: 'ถนนพัง' },
        },
      ]);
      expect(result.nextCursor).toBeNull();
    });

    it('marks read=true when readAt is set and tolerates a missing post', async () => {
      const now = new Date('2026-06-24T00:00:00.000Z');
      const rows = [
        {
          id: 'notif-2',
          kind: 'heart',
          createdAt: now,
          readAt: now,
          actorIdentityId: 'actor-1',
          postId: null,
        },
      ];
      notificationRepo.createQueryBuilder = jest.fn(() => makeSelectBuilder(rows));
      identityRepo.find = jest.fn(async () => [
        { id: 'actor-1', displayAlias: 'สมชาย' },
      ]);

      const result = await service.listNotifications('me-1');

      expect(result.items[0].read).toBe(true);
      expect(result.items[0].post).toBeNull();
    });
  });

  describe('unreadCount', () => {
    it('counts unread, non-deleted notifications for the caller', async () => {
      notificationRepo.count = jest.fn(async () => 3);
      const result = await service.unreadCount('me-1');
      expect(result).toEqual({ count: 3 });
      expect(notificationRepo.count).toHaveBeenCalledWith({
        where: {
          recipientIdentityId: 'me-1',
          readAt: expect.anything(),
          deletedAt: expect.anything(),
        },
      });
    });
  });

  describe('markRead', () => {
    it('returns ok when a row is updated', async () => {
      notificationRepo.update = jest.fn(async () => ({ affected: 1 }));
      const result = await service.markRead('me-1', 'notif-1');
      expect(result).toEqual({ ok: true });
    });

    it('throws 404 when nothing is updated (not yours / missing)', async () => {
      notificationRepo.update = jest.fn(async () => ({ affected: 0 }));
      await expect(service.markRead('me-1', 'notif-x')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('markAllRead', () => {
    it('updates all unread notifications for the caller and returns ok', async () => {
      const result = await service.markAllRead('me-1');
      expect(notificationRepo.update).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ ok: true });
    });
  });
});
