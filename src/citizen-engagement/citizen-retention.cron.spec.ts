import { CitizenRetentionCron } from './citizen-retention.cron';

/**
 * Unit spec for CitizenRetentionCron — the PDPA on-disk blob sweeper.
 *
 * Mocks the story + media repos (`find` / `update`) and the swappable storage
 * seam (`remove`). Drives the public `runDailyRetention` and asserts the
 * file-delete + column-clear behavior, idempotency (ENOENT), the path-scope
 * guard, the env kill-switch, and the never-throw failure discipline.
 */

type Repo = {
  find: jest.Mock;
  update: jest.Mock;
};

function makeRepo(): Repo {
  return {
    find: jest.fn(async () => []),
    update: jest.fn(async () => ({ affected: 1 })),
  };
}

const STORY_KEY = 'uploads/citizen-stories/26-06-2026/a.jpg';
const MEDIA_KEY = 'uploads/citizen-media/26-06-2026/b.png';

describe('CitizenRetentionCron', () => {
  let cron: CitizenRetentionCron;
  let storyRepo: Repo;
  let mediaRepo: Repo;
  let storage: { remove: jest.Mock };
  const envBackup = { ...process.env };

  beforeEach(() => {
    jest.restoreAllMocks();
    // Clear our knobs so each test starts from defaults.
    delete process.env.CITIZEN_RETENTION_ENABLED;
    delete process.env.CITIZEN_RETENTION_GRACE_HOURS;
    delete process.env.CITIZEN_RETENTION_BATCH_SIZE;

    storyRepo = makeRepo();
    mediaRepo = makeRepo();
    storage = { remove: jest.fn(async () => undefined) };

    cron = new CitizenRetentionCron(
      storyRepo as never,
      mediaRepo as never,
      storage as never,
    );
    // Silence the logger so the suite output stays clean.
    jest.spyOn((cron as never as { logger: { log: jest.Mock } }).logger, 'log').mockImplementation(() => undefined);
    jest.spyOn((cron as never as { logger: { warn: jest.Mock } }).logger, 'warn').mockImplementation(() => undefined);
    jest.spyOn((cron as never as { logger: { error: jest.Mock } }).logger, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = { ...envBackup };
  });

  it('deletes the blob and clears the pointer column for an expired story', async () => {
    storyRepo.find = jest.fn(async () => [{ id: 's1', imagePath: STORY_KEY }]);

    await cron.runDailyRetention();

    expect(storage.remove).toHaveBeenCalledWith(STORY_KEY);
    expect(storyRepo.update).toHaveBeenCalledWith({ id: 's1' }, { imagePath: '' });
  });

  it('deletes the blob and clears storage_key for a soft-deleted media row', async () => {
    mediaRepo.find = jest.fn(async () => [{ id: 'm1', storageKey: MEDIA_KEY }]);

    await cron.runDailyRetention();

    expect(storage.remove).toHaveBeenCalledWith(MEDIA_KEY);
    expect(mediaRepo.update).toHaveBeenCalledWith(
      { id: 'm1' },
      { storageKey: '' },
    );
  });

  it('queries soft-deleted rows (withDeleted) with the right OR / grace filter and batch cap', async () => {
    process.env.CITIZEN_RETENTION_BATCH_SIZE = '50';

    await cron.runDailyRetention();

    const storyArgs = storyRepo.find.mock.calls[0][0];
    expect(storyArgs.withDeleted).toBe(true);
    expect(storyArgs.take).toBe(50);
    // OR-array: expired branch + soft-deleted branch, both gated on a non-empty path.
    expect(Array.isArray(storyArgs.where)).toBe(true);
    expect(storyArgs.where[0]).toHaveProperty('imagePath');
    expect(storyArgs.where[0]).toHaveProperty('expiresAt');
    expect(storyArgs.where[1]).toHaveProperty('deletedAt');

    const mediaArgs = mediaRepo.find.mock.calls[0][0];
    expect(mediaArgs.withDeleted).toBe(true);
    expect(mediaArgs.take).toBe(50);
    expect(mediaArgs.where).toHaveProperty('storageKey');
    expect(mediaArgs.where).toHaveProperty('deletedAt');
  });

  it('treats an already-absent file (ENOENT) as success and still clears the column (idempotent)', async () => {
    storyRepo.find = jest.fn(async () => [{ id: 's1', imagePath: STORY_KEY }]);
    storage.remove = jest.fn(async () => {
      const e: NodeJS.ErrnoException = new Error('missing');
      e.code = 'ENOENT';
      throw e;
    });

    await cron.runDailyRetention();

    expect(storyRepo.update).toHaveBeenCalledWith({ id: 's1' }, { imagePath: '' });
  });

  it('NEVER unlinks a file outside the citizen upload roots and leaves the column set', async () => {
    storyRepo.find = jest.fn(async () => [
      { id: 'evil', imagePath: '../../etc/passwd' },
      { id: 'wrong', imagePath: 'uploads/attachment-foo/x.pdf' },
    ]);

    await cron.runDailyRetention();

    expect(storage.remove).not.toHaveBeenCalled();
    expect(storyRepo.update).not.toHaveBeenCalled();
  });

  it('keeps the column set (retry next tick) when a delete fails for a non-ENOENT reason', async () => {
    storyRepo.find = jest.fn(async () => [{ id: 's1', imagePath: STORY_KEY }]);
    storage.remove = jest.fn(async () => {
      const e: NodeJS.ErrnoException = new Error('EACCES');
      e.code = 'EACCES';
      throw e;
    });

    await expect(cron.runDailyRetention()).resolves.toBeUndefined();

    expect(storyRepo.update).not.toHaveBeenCalled();
  });

  it('one bad row does not abort the batch', async () => {
    storyRepo.find = jest.fn(async () => [
      { id: 'bad', imagePath: STORY_KEY },
      { id: 'good', imagePath: 'uploads/citizen-stories/26-06-2026/c.jpg' },
    ]);
    storage.remove = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('EACCES'), { code: 'EACCES' }))
      .mockResolvedValueOnce(undefined);

    await cron.runDailyRetention();

    // First row failed (no clear), second row purged + cleared.
    expect(storyRepo.update).toHaveBeenCalledTimes(1);
    expect(storyRepo.update).toHaveBeenCalledWith({ id: 'good' }, { imagePath: '' });
  });

  it('does nothing when disabled via env', async () => {
    process.env.CITIZEN_RETENTION_ENABLED = 'false';

    await cron.runDailyRetention();

    expect(storyRepo.find).not.toHaveBeenCalled();
    expect(mediaRepo.find).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('never rethrows when a repository read fails (failure discipline)', async () => {
    storyRepo.find = jest.fn(async () => {
      throw new Error('db down');
    });

    await expect(cron.runDailyRetention()).resolves.toBeUndefined();
  });
});
