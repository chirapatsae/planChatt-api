import { BadRequestException, HttpException, HttpStatus } from '@nestjs/common';

import { CitizenMediaService } from './citizen-media.service';
import * as imageMeta from './image-metadata.util';

/**
 * Unit spec for CitizenMediaService.
 *
 * Mocks the media repo, the storage seam, and a dataSource whose
 * `.transaction(cb)` runs the callback with a mock EntityManager handing back
 * per-entity sub-repos. The privacy strip (`stripImageMetadata`) is spied so we
 * can prove it is ALWAYS called before persistence.
 */

type Repo = {
  create: jest.Mock;
  save: jest.Mock;
  findOne: jest.Mock;
};

function makeRepo(): Repo {
  return {
    create: jest.fn((x) => x),
    save: jest.fn(async (x) => ({ id: x.id ?? 'media-1', ...x })),
    findOne: jest.fn(),
  };
}

/**
 * A buffer that parses as a minimal valid JPEG for BOTH the real strip and the
 * W-M1 dimension reader: SOI + SOF0 (declaring 1x1) + SOS + EOI.
 * SOF0 layout: FFC0 len(0x0011) precision(8) height(2)@+5 width(2)@+7.
 */
function minimalJpeg(): Buffer {
  return Buffer.from([
    0xff, 0xd8, // SOI
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01, // SOF0 1x1
    0xff, 0xda, 0x00, 0x02, // SOS
    0xff, 0xd9, // EOI
  ]);
}

describe('CitizenMediaService', () => {
  let service: CitizenMediaService;
  let mediaRepo: Repo;
  let emMediaRepo: Repo;
  let emAuditRepo: Repo;
  let storage: { keyFor: jest.Mock; save: jest.Mock; read: jest.Mock; remove: jest.Mock };
  let moderation: { assertAllowed: jest.Mock };
  let auditSaves: Array<Record<string, unknown>>;
  let em: { getRepository: (entity: { name: string }) => Repo };

  beforeEach(() => {
    jest.restoreAllMocks();

    mediaRepo = makeRepo();
    emMediaRepo = makeRepo();
    emAuditRepo = makeRepo();

    auditSaves = [];
    emAuditRepo.save = jest.fn(async (x) => {
      auditSaves.push(x);
      return { id: 'audit-1', ...x };
    });

    storage = {
      keyFor: jest.fn(() => 'uploads/citizen-media/01-01-2026/abc.jpg'),
      save: jest.fn(async () => undefined),
      read: jest.fn(async () => Buffer.from([1, 2, 3])),
      remove: jest.fn(async () => undefined),
    };

    // Default: moderation allows (unconfigured path). Individual tests override.
    moderation = {
      assertAllowed: jest.fn(async () => 'unconfigured'),
    };

    const emRepoByName: Record<string, Repo> = {
      CitizenPostMedia: emMediaRepo,
      CitizenAuditLog: emAuditRepo,
    };
    em = {
      getRepository: (entity: { name: string }) => emRepoByName[entity.name],
    };

    const dataSource = {
      transaction: async (cb: (em: unknown) => Promise<unknown>) => cb(em),
    };

    service = new CitizenMediaService(
      mediaRepo as never,
      storage as never,
      dataSource as never,
      moderation as never,
    );
  });

  describe('upload', () => {
    it('rejects a non-image mimetype with CITIZEN_MEDIA_INVALID', async () => {
      await expect(
        service.upload('identity-1', {
          buffer: Buffer.from([0]),
          mimetype: 'application/pdf',
          size: 10,
          originalname: 'x.pdf',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(storage.save).not.toHaveBeenCalled();
    });

    it('rejects an oversized file with CITIZEN_MEDIA_INVALID', async () => {
      await expect(
        service.upload('identity-1', {
          buffer: Buffer.from([0]),
          mimetype: 'image/jpeg',
          size: 5 * 1024 * 1024 + 1,
          originalname: 'big.jpg',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(storage.save).not.toHaveBeenCalled();
    });

    it('strips metadata, stores the clean buffer, inserts a row + audit', async () => {
      const stripped = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
      const stripSpy = jest
        .spyOn(imageMeta, 'stripImageMetadata')
        .mockReturnValue(stripped);
      emMediaRepo.save = jest.fn(async (x) => ({ ...x, id: 'media-9' }));

      const result = await service.upload('identity-1', {
        buffer: minimalJpeg(),
        mimetype: 'image/jpeg',
        size: 8,
        originalname: 'photo.jpg',
      });

      // strip ran BEFORE storage.save, with the original buffer + mimetype.
      expect(stripSpy).toHaveBeenCalledWith(minimalJpeg(), 'image/jpeg');
      expect(storage.save).toHaveBeenCalledWith(
        'uploads/citizen-media/01-01-2026/abc.jpg',
        stripped,
      );

      // moderation ran on the CLEANED bytes (post-strip), before storage.save.
      expect(moderation.assertAllowed).toHaveBeenCalledWith(stripped, 'image/jpeg');

      // row persisted with the stripped byte size + ready status + null postId.
      const row = emMediaRepo.create.mock.calls[0][0];
      expect(row).toMatchObject({
        ownerIdentityId: 'identity-1',
        storageKey: 'uploads/citizen-media/01-01-2026/abc.jpg',
        contentType: 'image/jpeg',
        byteSize: stripped.length,
        status: 'ready',
        postId: null,
      });

      // audit row written (§17.3) incl. the W-M1 moderation outcome.
      expect(auditSaves).toHaveLength(1);
      expect(auditSaves[0]).toMatchObject({
        actorKind: 'citizen',
        actorId: 'identity-1',
        action: 'media.upload',
        targetKind: 'media',
        detail: expect.objectContaining({ moderated: 'unconfigured' }),
      });

      expect(result).toEqual({
        id: 'media-9',
        url: '/api/v1/citizen-engagement/media/media-9',
      });
    });

    it('rejects a malformed image (strip throws) with CITIZEN_MEDIA_INVALID', async () => {
      await expect(
        service.upload('identity-1', {
          buffer: Buffer.from([0x00, 0x01]),
          mimetype: 'image/png',
          size: 2,
          originalname: 'bad.png',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(storage.save).not.toHaveBeenCalled();
    });

    it('rejects a video/* type with CITIZEN_MEDIA_INVALID (video fail-closed)', async () => {
      await expect(
        service.upload('identity-1', {
          buffer: Buffer.from([0x00, 0x00, 0x00, 0x18]),
          mimetype: 'video/mp4',
          size: 1024,
          originalname: 'clip.mp4',
        }),
      ).rejects.toMatchObject({ message: 'CITIZEN_MEDIA_INVALID' });
      expect(storage.save).not.toHaveBeenCalled();
      expect(moderation.assertAllowed).not.toHaveBeenCalled();
    });

    it('rejects an oversized-IHDR PNG with CITIZEN_MEDIA_DIMENSIONS', async () => {
      // PNG signature + IHDR declaring 20000 x 20000 (> MAX_DIM 10000).
      const signature = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);
      const ihdr = Buffer.alloc(25); // len(4)+'IHDR'(4)+13 data minimum
      ihdr.writeUInt32BE(13, 0); // chunk data length
      ihdr.write('IHDR', 4, 'latin1');
      ihdr.writeUInt32BE(20000, 8); // width  @ offset 16 of full buffer
      ihdr.writeUInt32BE(20000, 12); // height @ offset 20 of full buffer
      const crafted = Buffer.concat([signature, ihdr]);

      await expect(
        service.upload('identity-1', {
          buffer: crafted,
          mimetype: 'image/png',
          size: crafted.length,
          originalname: 'bomb.png',
        }),
      ).rejects.toMatchObject({ message: 'CITIZEN_MEDIA_DIMENSIONS' });
      expect(storage.save).not.toHaveBeenCalled();
      expect(moderation.assertAllowed).not.toHaveBeenCalled();
    });

    it('rejects a PNG that exceeds the pixel-product cap with CITIZEN_MEDIA_DIMENSIONS', async () => {
      // 8000 x 8000 = 64,000,000 px > MAX_PIXELS (40,000,000) while each
      // dimension is <= MAX_DIM (10000) — proves the product cap fires.
      const signature = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);
      const ihdr = Buffer.alloc(25);
      ihdr.writeUInt32BE(13, 0);
      ihdr.write('IHDR', 4, 'latin1');
      ihdr.writeUInt32BE(8000, 8);
      ihdr.writeUInt32BE(8000, 12);
      const crafted = Buffer.concat([signature, ihdr]);

      await expect(
        service.upload('identity-1', {
          buffer: crafted,
          mimetype: 'image/png',
          size: crafted.length,
          originalname: 'wide.png',
        }),
      ).rejects.toMatchObject({ message: 'CITIZEN_MEDIA_DIMENSIONS' });
      expect(storage.save).not.toHaveBeenCalled();
    });

    it('propagates a moderation deny (422) without storing or persisting', async () => {
      jest
        .spyOn(imageMeta, 'stripImageMetadata')
        .mockReturnValue(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      moderation.assertAllowed = jest.fn(async () => {
        throw new HttpException('CITIZEN_MEDIA_REJECTED', HttpStatus.UNPROCESSABLE_ENTITY);
      });

      await expect(
        service.upload('identity-1', {
          buffer: minimalJpeg(),
          mimetype: 'image/jpeg',
          size: minimalJpeg().length,
          originalname: 'nsfw.jpg',
        }),
      ).rejects.toMatchObject({ status: HttpStatus.UNPROCESSABLE_ENTITY });
      // moderation runs AFTER strip but BEFORE storage.save + persist.
      expect(storage.save).not.toHaveBeenCalled();
      expect(emMediaRepo.save).not.toHaveBeenCalled();
    });

    it('records moderated="provider" in the audit when a provider allowed', async () => {
      jest
        .spyOn(imageMeta, 'stripImageMetadata')
        .mockReturnValue(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      moderation.assertAllowed = jest.fn(async () => 'provider');
      emMediaRepo.save = jest.fn(async (x) => ({ ...x, id: 'media-7' }));

      await service.upload('identity-1', {
        buffer: minimalJpeg(),
        mimetype: 'image/jpeg',
        size: minimalJpeg().length,
        originalname: 'ok.jpg',
      });

      expect(auditSaves[0]).toMatchObject({
        detail: expect.objectContaining({ moderated: 'provider' }),
      });
    });
  });

  describe('attachMediaToPost', () => {
    it('attaches owned, unattached media in order (sets postId + sortOrder)', async () => {
      const rows: Record<string, { id: string; ownerIdentityId: string; postId: string | null; sortOrder: number }> =
        {
          'm-1': { id: 'm-1', ownerIdentityId: 'identity-1', postId: null, sortOrder: 0 },
          'm-2': { id: 'm-2', ownerIdentityId: 'identity-1', postId: null, sortOrder: 0 },
        };
      emMediaRepo.findOne = jest.fn(async ({ where }: { where: { id: string } }) => rows[where.id]);

      await service.attachMediaToPost(em as never, 'identity-1', 'post-1', [
        'm-1',
        'm-2',
      ]);

      expect(rows['m-1']).toMatchObject({ postId: 'post-1', sortOrder: 0 });
      expect(rows['m-2']).toMatchObject({ postId: 'post-1', sortOrder: 1 });
      expect(emMediaRepo.save).toHaveBeenCalledTimes(2);
    });

    it('rejects media owned by another identity', async () => {
      emMediaRepo.findOne = jest.fn(async () => ({
        id: 'm-1',
        ownerIdentityId: 'someone-else',
        postId: null,
      }));
      await expect(
        service.attachMediaToPost(em as never, 'identity-1', 'post-1', ['m-1']),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects media already attached to a post (single-attach)', async () => {
      emMediaRepo.findOne = jest.fn(async () => ({
        id: 'm-1',
        ownerIdentityId: 'identity-1',
        postId: 'other-post',
      }));
      await expect(
        service.attachMediaToPost(em as never, 'identity-1', 'post-1', ['m-1']),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a missing media id', async () => {
      emMediaRepo.findOne = jest.fn(async () => null);
      await expect(
        service.attachMediaToPost(em as never, 'identity-1', 'post-1', ['nope']),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('no-ops for an empty media list', async () => {
      await service.attachMediaToPost(em as never, 'identity-1', 'post-1', []);
      expect(emMediaRepo.findOne).not.toHaveBeenCalled();
      expect(emMediaRepo.save).not.toHaveBeenCalled();
    });
  });
});
