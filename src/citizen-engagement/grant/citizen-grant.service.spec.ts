import { CitizenGrantService } from './citizen-grant.service';

/**
 * Unit spec for CitizenGrantService (C4 / D6). Mocks the grant repo + a
 * dataSource whose `.transaction(cb)` runs cb with a mock EntityManager handing
 * back per-entity sub-repos. No encryption.util usage → no jest.mock.
 */
type Repo = {
  create: jest.Mock;
  save: jest.Mock;
  findOne: jest.Mock;
  find: jest.Mock;
  count: jest.Mock;
};

function makeRepo(): Repo {
  return {
    create: jest.fn((x) => x),
    save: jest.fn(async (x) => ({ id: x.id ?? 'grant-new', ...x })),
    findOne: jest.fn(async () => null),
    find: jest.fn(async () => []),
    count: jest.fn(async () => 0),
  };
}

describe('CitizenGrantService', () => {
  let service: CitizenGrantService;
  let grantRepo: Repo;
  let emGrantRepo: Repo;
  let emAuditRepo: Repo;
  let auditSaves: Array<{ actorKind: string; action: string }>;

  beforeEach(() => {
    grantRepo = makeRepo();
    emGrantRepo = makeRepo();
    emAuditRepo = makeRepo();
    auditSaves = [];
    emAuditRepo.save = jest.fn(async (x) => {
      auditSaves.push(x);
      return { id: 'audit-1', ...x };
    });

    const emRepoByName: Record<string, Repo> = {
      CitizenBackendAccessGrant: emGrantRepo,
      CitizenAuditLog: emAuditRepo,
    };
    const em = { getRepository: (e: { name: string }) => emRepoByName[e.name] };
    const dataSource = {
      transaction: async (cb: (em: unknown) => Promise<unknown>) => cb(em),
    };

    service = new CitizenGrantService(grantRepo as never, dataSource as never);
  });

  describe('grant', () => {
    it('is idempotent when a live granted row already exists (no audit)', async () => {
      emGrantRepo.findOne = jest.fn(async () => ({
        id: 'grant-1',
        userId: 'u1',
        capability: 'respond',
        state: 'granted',
      }));

      const result = await service.grant('wh-admin', 'u1', 'respond');

      expect(result.state).toBe('granted');
      expect(emGrantRepo.save).not.toHaveBeenCalled();
      expect(auditSaves).toHaveLength(0);
    });

    it('inserts a fresh granted row + writes an internal audit', async () => {
      emGrantRepo.findOne = jest
        .fn()
        .mockResolvedValueOnce(null) // no granted
        .mockResolvedValueOnce(null); // no reusable pending/revoked

      const result = await service.grant('wh-admin', 'u2', 'respond');

      expect(emGrantRepo.save).toHaveBeenCalledTimes(1);
      const saved = emGrantRepo.create.mock.calls[0][0];
      expect(saved).toMatchObject({
        userId: 'u2',
        capability: 'respond',
        state: 'granted',
        decidedByWorkHistoryId: 'wh-admin',
      });
      expect(auditSaves[0]).toMatchObject({ actorKind: 'internal', action: 'grant.grant' });
      expect(result.capability).toBe('respond');
    });
  });

  describe('revoke', () => {
    it('flips a granted row to revoked + audits', async () => {
      emGrantRepo.findOne = jest.fn(async () => ({
        id: 'grant-9',
        userId: 'u1',
        capability: 'respond',
        state: 'granted',
      }));

      const result = await service.revoke('wh-admin', 'u1', 'respond');

      expect(result?.state).toBe('revoked');
      expect(auditSaves[0]).toMatchObject({ actorKind: 'internal', action: 'grant.revoke' });
    });

    it('is a no-op (null) when nothing is granted', async () => {
      emGrantRepo.findOne = jest.fn(async () => null);
      const result = await service.revoke('wh-admin', 'u1', 'respond');
      expect(result).toBeNull();
      expect(auditSaves).toHaveLength(0);
    });
  });

  describe('hasGrant', () => {
    it('true when a granted row exists, false otherwise', async () => {
      grantRepo.count = jest.fn(async () => 1);
      expect(await service.hasGrant('u1', 'respond')).toBe(true);
      grantRepo.count = jest.fn(async () => 0);
      expect(await service.hasGrant('u1', 'respond')).toBe(false);
    });
  });
});
