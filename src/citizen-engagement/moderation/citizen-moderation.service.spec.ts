import { NotFoundException } from '@nestjs/common';

import {
  AUTO_HIDE_THRESHOLD,
  CitizenModerationService,
  OFFENDER_REMOVAL_THRESHOLD,
} from './citizen-moderation.service';

/**
 * Unit spec for CitizenModerationService (C5 / D13). Mocks the report/post/
 * identity repos + a dataSource whose `.transaction(cb)` runs cb with a mock
 * EntityManager handing back per-entity sub-repos.
 */
type Repo = {
  create: jest.Mock;
  save: jest.Mock;
  findOne: jest.Mock;
  find: jest.Mock;
  count: jest.Mock;
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
    count: jest.fn(async () => 0),
    update: jest.fn(async () => ({ affected: 1 })),
    softDelete: jest.fn(async () => ({ affected: 1 })),
    createQueryBuilder: jest.fn(),
  };
}

/** Insert builder: `raw` non-empty ⇒ a NEW report row was created (vs orIgnore no-op). */
function makeInsertBuilder(created = true) {
  const b: Record<string, jest.Mock> = {};
  b.insert = jest.fn(() => b);
  b.values = jest.fn(() => b);
  b.orIgnore = jest.fn(() => b);
  b.execute = jest.fn(async () =>
    created
      ? { raw: [{ id: 'rep-1' }], identifiers: [{ id: 'rep-1' }] }
      : { raw: [], identifiers: [] },
  );
  return b;
}

/** Conditional update builder: `affected` ⇒ the `WHERE state='visible'` flip applied. */
function makeUpdateBuilder(affected = 1) {
  const b: Record<string, jest.Mock> = {};
  b.update = jest.fn(() => b);
  b.set = jest.fn(() => b);
  b.where = jest.fn(() => b);
  b.execute = jest.fn(async () => ({ affected }));
  return b;
}

describe('CitizenModerationService', () => {
  let service: CitizenModerationService;
  let reportRepo: Repo;
  let postRepo: Repo;
  let emPostRepo: Repo;
  let emReportRepo: Repo;
  let emLogRepo: Repo;
  let emAuditRepo: Repo;
  let emIdentityRepo: Repo;
  let auditSaves: Array<{ actorKind: string; action: string }>;
  let logSaves: Array<{ action: string; actorRole: string | null }>;

  beforeEach(() => {
    reportRepo = makeRepo();
    postRepo = makeRepo();
    emPostRepo = makeRepo();
    emReportRepo = makeRepo();
    emLogRepo = makeRepo();
    emAuditRepo = makeRepo();
    emIdentityRepo = makeRepo();
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
    // report insert (created by default) + post conditional-shadow update
    emReportRepo.createQueryBuilder = jest.fn(() => makeInsertBuilder(true));
    emPostRepo.createQueryBuilder = jest.fn(() => makeUpdateBuilder(1));
    // W-T3 offender ladder: by default the author is below the removal threshold
    // (count 0) so suspend never fires unless a test raises it.
    emPostRepo.count = jest.fn(async () => 0);
    emIdentityRepo.createQueryBuilder = jest.fn(() => makeUpdateBuilder(1));

    const emByName: Record<string, Repo> = {
      CitizenPost: emPostRepo,
      CitizenReport: emReportRepo,
      CitizenModerationLog: emLogRepo,
      CitizenAuditLog: emAuditRepo,
      CitizenIdentity: emIdentityRepo,
    };
    const em = { getRepository: (e: { name: string }) => emByName[e.name] };
    const dataSource = {
      transaction: async (cb: (em: unknown) => Promise<unknown>) => cb(em),
    };

    service = new CitizenModerationService(
      reportRepo as never,
      postRepo as never,
      makeRepo() as never, // identityRepo (unused in these paths)
      dataSource as never,
    );
  });

  describe('reportPost', () => {
    it('records a report below threshold without auto-hiding', async () => {
      emPostRepo.findOne = jest.fn(async () => ({ id: 'post-1', moderationState: 'visible' }));
      emReportRepo.count = jest.fn(async () => 1);

      const result = await service.reportPost('identity-1', 'post-1', 'สแปม');

      expect(result).toEqual({ reported: true, autoHidden: false });
      expect(emPostRepo.createQueryBuilder).not.toHaveBeenCalled(); // no shadow flip
      expect(logSaves[0]).toMatchObject({ action: 'report' });
      expect(auditSaves[0]).toMatchObject({ actorKind: 'citizen', action: 'report.create' });
    });

    it('is an idempotent no-op on a duplicate report (no log/audit spam)', async () => {
      emPostRepo.findOne = jest.fn(async () => ({ id: 'post-1', moderationState: 'visible' }));
      emReportRepo.createQueryBuilder = jest.fn(() => makeInsertBuilder(false)); // orIgnore no-op

      const result = await service.reportPost('identity-1', 'post-1', null);

      expect(result).toEqual({ reported: true, autoHidden: false });
      expect(logSaves).toHaveLength(0);
      expect(auditSaves).toHaveLength(0);
      expect(emReportRepo.count).not.toHaveBeenCalled();
    });

    it('auto-shadows a visible post via a race-safe conditional update at threshold', async () => {
      emPostRepo.findOne = jest.fn(async () => ({ id: 'post-1', moderationState: 'visible' }));
      emReportRepo.count = jest.fn(async () => AUTO_HIDE_THRESHOLD);

      const result = await service.reportPost('identity-9', 'post-1', null);

      expect(result.autoHidden).toBe(true);
      expect(emPostRepo.createQueryBuilder).toHaveBeenCalled(); // conditional flip ran
      expect(logSaves.some((l) => l.action === 'hide' && l.actorRole === 'system')).toBe(true);
      expect(auditSaves.some((a) => a.action === 'post.auto_shadow')).toBe(true);
    });

    it('does NOT auto-shadow when the conditional flip affects 0 rows (already moderated)', async () => {
      emPostRepo.findOne = jest.fn(async () => ({ id: 'post-1', moderationState: 'visible' }));
      emReportRepo.count = jest.fn(async () => AUTO_HIDE_THRESHOLD);
      emPostRepo.createQueryBuilder = jest.fn(() => makeUpdateBuilder(0)); // concurrently removed

      const result = await service.reportPost('identity-9', 'post-1', null);

      expect(result.autoHidden).toBe(false);
      expect(auditSaves.some((a) => a.action === 'post.auto_shadow')).toBe(false);
    });

    it('404s when the post is missing / already removed', async () => {
      emPostRepo.findOne = jest.fn(async () => ({ id: 'post-1', moderationState: 'removed' }));
      await expect(service.reportPost('i', 'post-1', null)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('moderate', () => {
    it('hides a post (targeted update), actions its open reports, audits internal', async () => {
      emPostRepo.findOne = jest.fn(async () => ({ id: 'post-1', moderationState: 'shadow' }));

      const result = await service.moderate('wh-staff', 'staff', 'post-1', 'hide');

      expect(result.moderationState).toBe('hidden');
      expect(emPostRepo.update).toHaveBeenCalledWith(
        { id: 'post-1' },
        { moderationState: 'hidden' },
      );
      expect(emReportRepo.update).toHaveBeenCalledWith(
        expect.objectContaining({ postId: 'post-1', status: 'open' }),
        { status: 'actioned' },
      );
      expect(emReportRepo.softDelete).not.toHaveBeenCalled();
      expect(auditSaves[0]).toMatchObject({ actorKind: 'internal', action: 'moderate.hide' });
    });

    it('restores a post and SOFT-DELETES its reports (clean slate for re-report)', async () => {
      emPostRepo.findOne = jest.fn(async () => ({ id: 'post-1', moderationState: 'shadow' }));

      const result = await service.moderate('wh-staff', 'admin', 'post-1', 'restore');

      expect(result.moderationState).toBe('visible');
      expect(emReportRepo.softDelete).toHaveBeenCalledWith({ postId: 'post-1' });
      expect(emReportRepo.update).not.toHaveBeenCalled();
    });
  });

  describe('offender ladder (remove → auto-suspend)', () => {
    it('does NOT suspend the author below the removal threshold', async () => {
      emPostRepo.findOne = jest.fn(async () => ({
        id: 'post-1',
        moderationState: 'shadow',
        authorIdentityId: 'author-1',
      }));
      emPostRepo.count = jest.fn(async () => OFFENDER_REMOVAL_THRESHOLD - 1);

      await service.moderate('wh-staff', 'staff', 'post-1', 'remove');

      expect(emIdentityRepo.createQueryBuilder).not.toHaveBeenCalled(); // no suspend flip
      expect(logSaves.some((l) => l.action === 'suspend_author')).toBe(false);
      expect(auditSaves.some((a) => a.action === 'identity.suspend')).toBe(false);
    });

    it('SUSPENDS the author at the removal threshold (conditional flip + log + audit)', async () => {
      emPostRepo.findOne = jest.fn(async () => ({
        id: 'post-1',
        moderationState: 'shadow',
        authorIdentityId: 'author-1',
      }));
      emPostRepo.count = jest.fn(async () => OFFENDER_REMOVAL_THRESHOLD);

      await service.moderate('wh-staff', 'staff', 'post-1', 'remove');

      expect(emIdentityRepo.createQueryBuilder).toHaveBeenCalled(); // active→suspended flip
      expect(logSaves.some((l) => l.action === 'suspend_author')).toBe(true);
      expect(auditSaves.some((a) => a.action === 'identity.suspend')).toBe(true);
    });

    it('is a NO-OP when the conditional flip affects 0 rows (already suspended/terminal)', async () => {
      emPostRepo.findOne = jest.fn(async () => ({
        id: 'post-1',
        moderationState: 'shadow',
        authorIdentityId: 'author-1',
      }));
      emPostRepo.count = jest.fn(async () => OFFENDER_REMOVAL_THRESHOLD);
      emIdentityRepo.createQueryBuilder = jest.fn(() => makeUpdateBuilder(0));

      await service.moderate('wh-staff', 'staff', 'post-1', 'remove');

      expect(logSaves.some((l) => l.action === 'suspend_author')).toBe(false);
      expect(auditSaves.some((a) => a.action === 'identity.suspend')).toBe(false);
    });

    it('does NOT run the ladder for non-remove actions (hide)', async () => {
      emPostRepo.findOne = jest.fn(async () => ({
        id: 'post-1',
        moderationState: 'shadow',
        authorIdentityId: 'author-1',
      }));

      await service.moderate('wh-staff', 'staff', 'post-1', 'hide');

      expect(emPostRepo.count).not.toHaveBeenCalled();
      expect(emIdentityRepo.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe('reinstate (staff lift)', () => {
    it('flips a suspended author back to active + audits', async () => {
      emIdentityRepo.findOne = jest.fn(async () => ({ id: 'author-1', status: 'suspended' }));

      const result = await service.reinstate('wh-staff', 'staff', 'author-1');

      expect(result.status).toBe('active');
      expect(emIdentityRepo.update).toHaveBeenCalledWith(
        { id: 'author-1' },
        { status: 'active' },
      );
      expect(logSaves.some((l) => l.action === 'reinstate_author')).toBe(true);
      expect(auditSaves.some((a) => a.action === 'identity.reinstate')).toBe(true);
    });

    it('is an idempotent no-op when the identity is not suspended (no audit)', async () => {
      emIdentityRepo.findOne = jest.fn(async () => ({ id: 'author-1', status: 'active' }));

      const result = await service.reinstate('wh-staff', 'staff', 'author-1');

      expect(result.status).toBe('active');
      expect(emIdentityRepo.update).not.toHaveBeenCalled();
      expect(auditSaves.some((a) => a.action === 'identity.reinstate')).toBe(false);
    });

    it('404 when the identity is missing', async () => {
      emIdentityRepo.findOne = jest.fn(async () => null);
      await expect(service.reinstate('wh-staff', 'staff', 'nope')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
