import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { BadRequestException } from '@nestjs/common';
import { StoragePathService } from './storage-path.service';

/**
 * Unit tests for `StoragePathService` (Wave 2 BE-PATH-SERVICE).
 *
 * Coverage:
 *   - Path-key formulas for all four families (main / edit / change /
 *     supplement).
 *   - `assertSafeKey` rejects `..`, leading `/`, absolute paths,
 *     backslashes, NUL bytes, oversized keys, empty / non-string input.
 *   - `resolve` + `toAbsolute` join under STORAGE_ROOT.
 *   - `resolveStored` legacy-vs-relative branching.
 *   - `bootstrapPlan` creates 4 directories and is idempotent.
 *   - `writeFile` / `readFile` round-trip.
 *   - `exists` true / false branches.
 *   - Input guards on planId / versionNumber / fileName.
 */

describe('StoragePathService', () => {
  const FAKE_PLAN_ID = '11111111-1111-1111-1111-111111111111';
  const FAKE_REVISION_ID = '22222222-2222-2222-2222-222222222222';
  const FAKE_SUPPLEMENT_ID = '33333333-3333-3333-3333-333333333333';

  let tmpRoot: string;
  let service: StoragePathService;

  beforeEach(async () => {
    tmpRoot = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'storage-path-service-test-'),
    );
    process.env.STORAGE_ROOT = tmpRoot;
    service = new StoragePathService();
  });

  afterEach(async () => {
    delete process.env.STORAGE_ROOT;
    try {
      await fsp.rm(tmpRoot, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  // ---------------------------------------------------------------------------
  // Path formulas
  // ---------------------------------------------------------------------------

  describe('mainPlanVersionKey', () => {
    it('produces the expected POSIX relative key', () => {
      expect(service.mainPlanVersionKey(FAKE_PLAN_ID, 3, 'book.pdf')).toBe(
        `main-plan-${FAKE_PLAN_ID}/v3/book.pdf`,
      );
    });

    it('mainPlanVersionDir omits the filename', () => {
      expect(service.mainPlanVersionDir(FAKE_PLAN_ID, 1)).toBe(
        `main-plan-${FAKE_PLAN_ID}/v1`,
      );
    });

    it('rejects non-positive version numbers', () => {
      expect(() =>
        service.mainPlanVersionKey(FAKE_PLAN_ID, 0, 'book.pdf'),
      ).toThrow(BadRequestException);
      expect(() =>
        service.mainPlanVersionKey(FAKE_PLAN_ID, -1, 'book.pdf'),
      ).toThrow(BadRequestException);
      expect(() =>
        service.mainPlanVersionKey(FAKE_PLAN_ID, 1.5, 'book.pdf'),
      ).toThrow(BadRequestException);
    });

    it('rejects empty planId / fileName', () => {
      expect(() => service.mainPlanVersionKey('', 1, 'book.pdf')).toThrow(
        BadRequestException,
      );
      expect(() =>
        service.mainPlanVersionKey(FAKE_PLAN_ID, 1, ''),
      ).toThrow(BadRequestException);
    });
  });

  describe('revisionVersionKey', () => {
    it('builds edit revision key', () => {
      const key = service.revisionVersionKey({
        planId: FAKE_PLAN_ID,
        revisionType: 'edit',
        revisionNumber: 2,
        revisionId: FAKE_REVISION_ID,
        versionNumber: 4,
        fileName: 'book.pdf',
      });
      expect(key).toBe(
        `main-plan-${FAKE_PLAN_ID}/edit/edit-2-${FAKE_REVISION_ID}/v4/book.pdf`,
      );
    });

    it('builds change revision key', () => {
      const key = service.revisionVersionKey({
        planId: FAKE_PLAN_ID,
        revisionType: 'change',
        revisionNumber: 7,
        revisionId: FAKE_REVISION_ID,
        versionNumber: 1,
        fileName: 'official-book-v1.pdf',
      });
      expect(key).toBe(
        `main-plan-${FAKE_PLAN_ID}/change/change-7-${FAKE_REVISION_ID}/v1/official-book-v1.pdf`,
      );
    });

    it('rejects invalid revisionType', () => {
      expect(() =>
        service.revisionVersionKey({
          planId: FAKE_PLAN_ID,
          // @ts-expect-error — test runtime rejection
          revisionType: 'supplement',
          revisionNumber: 1,
          revisionId: FAKE_REVISION_ID,
          versionNumber: 1,
          fileName: 'x.pdf',
        }),
      ).toThrow(BadRequestException);
    });
  });

  describe('supplementVersionKey', () => {
    it('builds the supplement key under main-plan/supplement', () => {
      const key = service.supplementVersionKey({
        planId: FAKE_PLAN_ID,
        supplementNumber: 5,
        supplementId: FAKE_SUPPLEMENT_ID,
        versionNumber: 2,
        fileName: 'official-supplement-book-v2.pdf',
      });
      expect(key).toBe(
        `main-plan-${FAKE_PLAN_ID}/supplement/supplement-5-${FAKE_SUPPLEMENT_ID}/v2/official-supplement-book-v2.pdf`,
      );
    });
  });

  describe('root helpers', () => {
    it('returns root keys for each sub-namespace', () => {
      expect(service.mainPlanRoot(FAKE_PLAN_ID)).toBe(
        `main-plan-${FAKE_PLAN_ID}`,
      );
      expect(service.editRoot(FAKE_PLAN_ID)).toBe(
        `main-plan-${FAKE_PLAN_ID}/edit`,
      );
      expect(service.changeRoot(FAKE_PLAN_ID)).toBe(
        `main-plan-${FAKE_PLAN_ID}/change`,
      );
      expect(service.supplementRoot(FAKE_PLAN_ID)).toBe(
        `main-plan-${FAKE_PLAN_ID}/supplement`,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // assertSafeKey
  // ---------------------------------------------------------------------------

  describe('assertSafeKey', () => {
    it('accepts a normal relative key', () => {
      expect(() =>
        service.assertSafeKey(`main-plan-${FAKE_PLAN_ID}/v1/book.pdf`),
      ).not.toThrow();
    });

    it('rejects absolute paths', () => {
      expect(() => service.assertSafeKey('/etc/passwd')).toThrow(
        BadRequestException,
      );
      expect(() => service.assertSafeKey('/storage/foo')).toThrow(
        BadRequestException,
      );
    });

    it('rejects leading slash', () => {
      expect(() => service.assertSafeKey('/relative-but-slash')).toThrow(
        BadRequestException,
      );
    });

    it('rejects `..` segments', () => {
      expect(() => service.assertSafeKey('main-plan-x/../../etc/passwd')).toThrow(
        BadRequestException,
      );
      expect(() => service.assertSafeKey('..')).toThrow(BadRequestException);
      expect(() => service.assertSafeKey('a/../b')).toThrow(
        BadRequestException,
      );
    });

    it('rejects backslashes', () => {
      expect(() => service.assertSafeKey('main-plan\\foo')).toThrow(
        BadRequestException,
      );
    });

    it('rejects NUL bytes', () => {
      expect(() => service.assertSafeKey('main-plan\0foo')).toThrow(
        BadRequestException,
      );
    });

    it('rejects oversized keys', () => {
      const huge = 'a/'.repeat(1024) + 'b.pdf';
      expect(() => service.assertSafeKey(huge)).toThrow(BadRequestException);
    });

    it('rejects empty / non-string', () => {
      expect(() => service.assertSafeKey('')).toThrow(BadRequestException);
      // @ts-expect-error — test runtime rejection
      expect(() => service.assertSafeKey(null)).toThrow(BadRequestException);
      // @ts-expect-error — test runtime rejection
      expect(() => service.assertSafeKey(undefined)).toThrow(
        BadRequestException,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // resolve / toAbsolute / resolveStored
  // ---------------------------------------------------------------------------

  describe('resolve / toAbsolute', () => {
    it('returns an absolute path under STORAGE_ROOT', () => {
      const abs = service.resolve(`main-plan-${FAKE_PLAN_ID}/v1/book.pdf`);
      expect(path.isAbsolute(abs)).toBe(true);
      expect(abs).toBe(
        path.resolve(tmpRoot, `main-plan-${FAKE_PLAN_ID}/v1/book.pdf`),
      );
    });

    it('toAbsolute is an alias for resolve', () => {
      const key = service.mainPlanVersionKey(FAKE_PLAN_ID, 1, 'book.pdf');
      expect(service.toAbsolute(key)).toBe(service.resolve(key));
    });

    it('rejects unsafe input via assertSafeKey', () => {
      expect(() => service.resolve('../escape')).toThrow(BadRequestException);
    });
  });

  describe('resolveStored', () => {
    it('returns absolute paths unchanged (legacy branch)', () => {
      const legacy = '/Users/test/backend/uploads/pdf/legacy.pdf';
      expect(service.resolveStored(legacy)).toBe(legacy);
    });

    it('resolves relative keys under STORAGE_ROOT', () => {
      const key = `main-plan-${FAKE_PLAN_ID}/v1/book.pdf`;
      expect(service.resolveStored(key)).toBe(
        path.resolve(tmpRoot, key),
      );
    });

    it('rejects empty input', () => {
      expect(() => service.resolveStored('')).toThrow(BadRequestException);
    });
  });

  // ---------------------------------------------------------------------------
  // bootstrapPlan
  // ---------------------------------------------------------------------------

  describe('bootstrapPlan', () => {
    it('creates the plan root + 3 subfolders', async () => {
      await service.bootstrapPlan(FAKE_PLAN_ID);
      const planRoot = path.join(tmpRoot, `main-plan-${FAKE_PLAN_ID}`);
      expect(fs.existsSync(planRoot)).toBe(true);
      expect(fs.existsSync(path.join(planRoot, 'edit'))).toBe(true);
      expect(fs.existsSync(path.join(planRoot, 'change'))).toBe(true);
      expect(fs.existsSync(path.join(planRoot, 'supplement'))).toBe(true);
    });

    it('is idempotent on re-call', async () => {
      await service.bootstrapPlan(FAKE_PLAN_ID);
      await service.bootstrapPlan(FAKE_PLAN_ID);
      const editDir = path.join(
        tmpRoot,
        `main-plan-${FAKE_PLAN_ID}`,
        'edit',
      );
      expect(fs.existsSync(editDir)).toBe(true);
    });

    it('rejects invalid planId', async () => {
      await expect(service.bootstrapPlan('')).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.bootstrapPlan('../foo')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // writeFile / readFile / exists / stat
  // ---------------------------------------------------------------------------

  describe('writeFile / readFile round-trip', () => {
    it('writes a Buffer and reads it back unchanged', async () => {
      const key = service.mainPlanVersionKey(FAKE_PLAN_ID, 1, 'sample.pdf');
      const payload = Buffer.from('hello-storage-path-service', 'utf-8');
      await service.writeFile(key, payload);
      const readBack = await service.readFile(key);
      expect(readBack.equals(payload)).toBe(true);
    });

    it('creates intermediate directories on writeFile', async () => {
      const key = service.revisionVersionKey({
        planId: FAKE_PLAN_ID,
        revisionType: 'edit',
        revisionNumber: 1,
        revisionId: FAKE_REVISION_ID,
        versionNumber: 1,
        fileName: 'book.pdf',
      });
      await service.writeFile(key, Buffer.from('x'));
      expect(fs.existsSync(service.resolve(key))).toBe(true);
    });
  });

  describe('exists', () => {
    it('returns true for a written file', async () => {
      const key = service.mainPlanVersionKey(FAKE_PLAN_ID, 1, 'sample.pdf');
      await service.writeFile(key, Buffer.from('x'));
      await expect(service.exists(key)).resolves.toBe(true);
    });

    it('returns false for a missing file', async () => {
      const key = service.mainPlanVersionKey(FAKE_PLAN_ID, 99, 'nope.pdf');
      await expect(service.exists(key)).resolves.toBe(false);
    });
  });

  describe('getStorageRoot', () => {
    it('returns the absolute root configured at construction time', () => {
      expect(service.getStorageRoot()).toBe(tmpRoot);
    });
  });

  // ---------------------------------------------------------------------------
  // Default-root fallback
  // ---------------------------------------------------------------------------

  describe('default storage root', () => {
    it('falls back to {cwd}/storage when STORAGE_ROOT is unset', () => {
      delete process.env.STORAGE_ROOT;
      const fallback = new StoragePathService();
      expect(fallback.getStorageRoot()).toBe(
        path.resolve(process.cwd(), 'storage'),
      );
    });
  });
});
