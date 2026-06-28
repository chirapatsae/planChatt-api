import {
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

import { CitizenStoryService } from './citizen-story.service';
import * as imageMeta from '../media/image-metadata.util';

/**
 * Unit spec for CitizenStoryService (W-GATE-3).
 *
 * Mocks the story repo, the identity repo (alias-only load), the storage seam,
 * and a dataSource whose `.transaction(cb)` runs the callback with a mock
 * EntityManager handing back per-entity sub-repos. The privacy strip
 * (`stripImageMetadata`) is spied so we PROVE it is called before persistence.
 */

type Repo = {
  create: jest.Mock;
  save: jest.Mock;
  find: jest.Mock;
  findOne: jest.Mock;
  softDelete: jest.Mock;
};

function makeRepo(): Repo {
  return {
    create: jest.fn((x) => x),
    save: jest.fn(async (x) => ({ id: x.id ?? 'story-1', ...x })),
    find: jest.fn(async () => []),
    findOne: jest.fn(),
    softDelete: jest.fn(async () => undefined),
  };
}

/**
 * A buffer that parses for BOTH the real strip AND the W-M1 dimension reader:
 * SOI + SOF0 (declaring 1x1) + SOS + EOI. (Without the SOF0 marker the W-M1
 * dimension guard rejects it with CITIZEN_MEDIA_NO_SOF.)
 */
function minimalJpeg(): Buffer {
  return Buffer.from([
    0xff, 0xd8, // SOI
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01, // SOF0 1x1
    0xff, 0xda, 0x00, 0x02, // SOS
    0xff, 0xd9, // EOI
  ]);
}

describe('CitizenStoryService', () => {
  let service: CitizenStoryService;
  let storyRepo: Repo;
  let identityRepo: Repo;
  let emStoryRepo: Repo;
  let emAuditRepo: Repo;
  let storage: { save: jest.Mock; read: jest.Mock; remove: jest.Mock };
  let auditSaves: Array<Record<string, unknown>>;

  beforeEach(() => {
    jest.restoreAllMocks();

    storyRepo = makeRepo();
    identityRepo = makeRepo();
    emStoryRepo = makeRepo();
    emAuditRepo = makeRepo();

    auditSaves = [];
    emAuditRepo.save = jest.fn(async (x) => {
      auditSaves.push(x);
      return { id: 'audit-1', ...x };
    });

    storage = {
      save: jest.fn(async () => undefined),
      read: jest.fn(async () => Buffer.from([1, 2, 3])),
      remove: jest.fn(async () => undefined),
    };

    const emRepoByName: Record<string, Repo> = {
      CitizenStory: emStoryRepo,
      CitizenAuditLog: emAuditRepo,
    };
    const em = {
      getRepository: (entity: { name: string }) => emRepoByName[entity.name],
    };

    const dataSource = {
      transaction: async (cb: (em: unknown) => Promise<unknown>) => cb(em),
    };

    service = new CitizenStoryService(
      storyRepo as never,
      identityRepo as never,
      storage as never,
      dataSource as never,
      // W-M1 moderation seam — default allow (unconfigured); tests that need a
      // deny verdict override this mock.
      { assertAllowed: jest.fn(async () => 'unconfigured') } as never,
    );
  });

  describe('create', () => {
    it('strips metadata BEFORE store, sets expires_at = now + 24h, writes audit', async () => {
      const stripped = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
      const stripSpy = jest
        .spyOn(imageMeta, 'stripImageMetadata')
        .mockReturnValue(stripped);

      const before = Date.now();
      emStoryRepo.save = jest.fn(async (x) => ({
        ...x,
        id: 'story-9',
        createdAt: new Date(),
      }));

      const result = await service.create(
        'identity-1',
        minimalJpeg(),
        'image/jpeg',
        '  hello  ',
      );
      const after = Date.now();

      // strip ran with the ORIGINAL buffer + mimetype, BEFORE storage.save.
      expect(stripSpy).toHaveBeenCalledWith(minimalJpeg(), 'image/jpeg');
      expect(storage.save).toHaveBeenCalledTimes(1);
      // saved the stripped buffer (2nd arg), never the raw upload.
      expect(storage.save.mock.calls[0][1]).toBe(stripped);

      // row persisted with +24h expiry + trimmed caption + the storage key.
      const row = emStoryRepo.create.mock.calls[0][0];
      expect(row.authorIdentityId).toBe('identity-1');
      expect(row.caption).toBe('hello');
      expect(typeof row.imagePath).toBe('string');
      const ttl = row.expiresAt.getTime();
      expect(ttl).toBeGreaterThanOrEqual(before + 24 * 60 * 60 * 1000 - 50);
      expect(ttl).toBeLessThanOrEqual(after + 24 * 60 * 60 * 1000 + 50);

      // audit row written (§17.3 — citizen_audit_logs only).
      expect(auditSaves).toHaveLength(1);
      expect(auditSaves[0]).toMatchObject({
        actorKind: 'citizen',
        actorId: 'identity-1',
        action: 'story.create',
        targetKind: 'story',
      });

      expect(result.id).toBe('story-9');
      expect(result.imageUrl).toBe(
        '/api/v1/citizen-engagement/stories/story-9/image',
      );
    });

    it('rejects a non-image mimetype without stripping/storing', async () => {
      const stripSpy = jest.spyOn(imageMeta, 'stripImageMetadata');
      await expect(
        service.create('identity-1', Buffer.from([0]), 'application/pdf'),
      ).rejects.toBeDefined();
      expect(stripSpy).not.toHaveBeenCalled();
      expect(storage.save).not.toHaveBeenCalled();
    });

    it('cleans up the stored blob when the row insert fails', async () => {
      jest
        .spyOn(imageMeta, 'stripImageMetadata')
        .mockReturnValue(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      emStoryRepo.save = jest.fn(async () => {
        throw new Error('db down');
      });

      await expect(
        service.create('identity-1', minimalJpeg(), 'image/jpeg'),
      ).rejects.toThrow('db down');
      expect(storage.remove).toHaveBeenCalledTimes(1);
    });
  });

  describe('listActive', () => {
    it('returns non-expired stories grouped by author with alias-only authors', async () => {
      storyRepo.find = jest.fn(async () => [
        {
          id: 's1',
          authorIdentityId: 'a1',
          caption: null,
          imagePath: 'p1.jpg',
          createdAt: new Date('2026-06-26T00:00:00Z'),
          expiresAt: new Date('2099-01-01T00:00:00Z'),
        },
        {
          id: 's2',
          authorIdentityId: 'a1',
          caption: 'two',
          imagePath: 'p2.jpg',
          createdAt: new Date('2026-06-26T01:00:00Z'),
          expiresAt: new Date('2099-01-01T00:00:00Z'),
        },
        {
          id: 's3',
          authorIdentityId: 'a2',
          caption: null,
          imagePath: 'p3.jpg',
          createdAt: new Date('2026-06-26T02:00:00Z'),
          expiresAt: new Date('2099-01-01T00:00:00Z'),
        },
      ]);
      identityRepo.find = jest.fn(async () => [
        { id: 'a1', displayAlias: 'Alice' },
        { id: 'a2', displayAlias: 'Bob' },
      ]);

      const groups = await service.listActive();

      // alias load asked for id + displayAlias ONLY (no PII columns).
      const findArg = identityRepo.find.mock.calls[0][0];
      expect(findArg.select).toEqual({ id: true, displayAlias: true });

      expect(groups).toHaveLength(2);
      expect(groups[0].author).toEqual({ id: 'a1', displayAlias: 'Alice' });
      expect(groups[0].stories.map((s) => s.id)).toEqual(['s1', 's2']);
      expect(groups[1].author).toEqual({ id: 'a2', displayAlias: 'Bob' });
      expect(groups[1].stories.map((s) => s.id)).toEqual(['s3']);
    });

    it('queries with an expires_at > now (active-window) filter', async () => {
      storyRepo.find = jest.fn(async () => []);
      const groups = await service.listActive();
      expect(groups).toEqual([]);
      const whereArg = storyRepo.find.mock.calls[0][0].where;
      // MoreThan(now) is opaque here, but the filter object MUST carry expiresAt + deletedAt.
      expect(whereArg).toHaveProperty('expiresAt');
      expect(whereArg).toHaveProperty('deletedAt');
    });
  });

  describe('getImage', () => {
    it('serves bytes for a non-expired, non-deleted story', async () => {
      storyRepo.findOne = jest.fn(async () => ({
        id: 's1',
        imagePath: 'uploads/citizen-stories/26-06-2026/x.png',
        expiresAt: new Date('2099-01-01T00:00:00Z'),
      }));
      const out = await service.getImage('s1');
      expect(out.contentType).toBe('image/png');
      expect(storage.read).toHaveBeenCalledWith(
        'uploads/citizen-stories/26-06-2026/x.png',
      );
    });

    it('404s an expired or deleted story (findOne returns null under the filter)', async () => {
      storyRepo.findOne = jest.fn(async () => null);
      await expect(service.getImage('gone')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(storage.read).not.toHaveBeenCalled();
    });
  });

  describe('removeOwn', () => {
    it('soft-deletes the owner’s own story', async () => {
      storyRepo.findOne = jest.fn(async () => ({
        id: 's1',
        authorIdentityId: 'identity-1',
      }));
      await service.removeOwn('identity-1', 's1');
      expect(emStoryRepo.softDelete).toHaveBeenCalledWith('s1');
      expect(auditSaves).toHaveLength(1);
      expect(auditSaves[0]).toMatchObject({ action: 'story.delete' });
    });

    it('403s when the story belongs to another identity', async () => {
      storyRepo.findOne = jest.fn(async () => ({
        id: 's1',
        authorIdentityId: 'someone-else',
      }));
      await expect(
        service.removeOwn('identity-1', 's1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(emStoryRepo.softDelete).not.toHaveBeenCalled();
    });

    it('404s a missing story', async () => {
      storyRepo.findOne = jest.fn(async () => null);
      await expect(
        service.removeOwn('identity-1', 'nope'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
