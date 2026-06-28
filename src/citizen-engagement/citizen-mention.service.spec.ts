import { CitizenMentionService } from './citizen-mention.service';

/**
 * Unit spec for CitizenMentionService (W-S6 @mention).
 *
 * The service does NOT hash anything (no encryption.util import), so there is no
 * jest.mock('src/util/encryption.util'). We mock:
 *   - the identity repo's `createQueryBuilder` (search) — a chainable stub that
 *     captures where/order calls and returns the provided rows from getMany;
 *   - the block service (`isBlockedEitherWay`);
 *   - the notification service (`notifyOnMention`);
 *   - an EntityManager whose `getRepository` hands back per-entity sub-repos.
 */

/** Chainable select-builder stub for the alias search; records bound params. */
function makeSearchBuilder(rows: Array<{ id: string; displayAlias: string }>) {
  const params: Record<string, unknown> = {};
  const b: Record<string, jest.Mock> & { _params: Record<string, unknown> } = {
    select: jest.fn(() => b),
    where: jest.fn((_sql: string, p?: Record<string, unknown>) => {
      Object.assign(params, p ?? {});
      return b;
    }),
    andWhere: jest.fn((_sql: string, p?: Record<string, unknown>) => {
      Object.assign(params, p ?? {});
      return b;
    }),
    orderBy: jest.fn(() => b),
    addOrderBy: jest.fn(() => b),
    take: jest.fn(() => b),
    getMany: jest.fn(async () => rows),
    _params: params,
  } as never;
  return b;
}

type EmRepo = { create: jest.Mock; save: jest.Mock; find: jest.Mock };

function makeEmRepo(): EmRepo {
  return {
    create: jest.fn((x) => x),
    save: jest.fn(async (x) => ({ id: 'mention-1', ...x })),
    find: jest.fn(async () => []),
  };
}

describe('CitizenMentionService', () => {
  let service: CitizenMentionService;
  let identityRepo: { createQueryBuilder: jest.Mock };
  let blockService: { isBlockedEitherWay: jest.Mock };
  let notificationService: { notifyOnMention: jest.Mock };

  // EntityManager-scoped repos.
  let emIdentityRepo: EmRepo;
  let emMentionRepo: EmRepo;
  let em: { getRepository: (e: { name: string }) => EmRepo };

  beforeEach(() => {
    identityRepo = { createQueryBuilder: jest.fn() };
    blockService = { isBlockedEitherWay: jest.fn(async () => false) };
    notificationService = { notifyOnMention: jest.fn(async () => undefined) };

    emIdentityRepo = makeEmRepo();
    emMentionRepo = makeEmRepo();
    const byName: Record<string, EmRepo> = {
      CitizenIdentity: emIdentityRepo,
      CitizenMention: emMentionRepo,
    };
    em = { getRepository: (e: { name: string }) => byName[e.name] };

    service = new CitizenMentionService(
      identityRepo as never,
      blockService as never,
      notificationService as never,
    );
  });

  // ---------------------------------------------------------------------------
  // searchByAlias
  // ---------------------------------------------------------------------------

  describe('searchByAlias', () => {
    it('returns ACTIVE citizens, ALIAS-ONLY (id + displayAlias, no PII)', async () => {
      const builder = makeSearchBuilder([
        { id: 'c1', displayAlias: 'สมชาย ก.' },
        { id: 'c2', displayAlias: 'สมชาย ข.' },
      ]);
      identityRepo.createQueryBuilder.mockReturnValue(builder);

      const out = await service.searchByAlias('สมชาย', 'viewer-1');

      // active-only filter bound.
      expect(builder.where).toHaveBeenCalledWith('c.status = :status', {
        status: 'active',
      });
      // prefix ILIKE bound (escaped + `%` suffix, never a leading `%`).
      expect(builder._params.like).toBe('สมชาย%');
      // EXACTLY { id, displayAlias } — never national_id / thaid / _enc.
      expect(out).toEqual([
        { id: 'c1', displayAlias: 'สมชาย ก.' },
        { id: 'c2', displayAlias: 'สมชาย ข.' },
      ]);
      for (const r of out) {
        expect(Object.keys(r).sort()).toEqual(['displayAlias', 'id']);
      }
    });

    it('excludes the caller themselves (no self-mention candidate)', async () => {
      const builder = makeSearchBuilder([]);
      identityRepo.createQueryBuilder.mockReturnValue(builder);

      await service.searchByAlias('สม', 'viewer-1');

      expect(builder.andWhere).toHaveBeenCalledWith('c.id <> :viewerId', {
        viewerId: 'viewer-1',
      });
    });

    it('drops W-T1 block pairs (either direction) from the result', async () => {
      const builder = makeSearchBuilder([
        { id: 'c1', displayAlias: 'A' },
        { id: 'blocked', displayAlias: 'B' },
        { id: 'c3', displayAlias: 'C' },
      ]);
      identityRepo.createQueryBuilder.mockReturnValue(builder);
      blockService.isBlockedEitherWay.mockImplementation(
        async (_v: string, target: string) => target === 'blocked',
      );

      const out = await service.searchByAlias('x', 'viewer-1');

      expect(out.map((r) => r.id)).toEqual(['c1', 'c3']);
    });

    it('empty query → empty result, no DB call', async () => {
      const out = await service.searchByAlias('   ', 'viewer-1');
      expect(out).toEqual([]);
      expect(identityRepo.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // processMentions
  // ---------------------------------------------------------------------------

  const post = { id: 'post-1', authorIdentityId: 'author-1' } as never;

  describe('processMentions (post source)', () => {
    it('inserts a citizen_mention row + notifies each valid mentioned id', async () => {
      emIdentityRepo.find.mockResolvedValue([
        { id: 'm1', displayAlias: 'Alpha' },
        { id: 'm2', displayAlias: 'Beta' },
      ]);

      const out = await service.processMentions(
        em as never,
        'author-1',
        ['m1', 'm2'],
        { post },
      );

      // one mention row per surviving id, post-sourced (comment_id null).
      expect(emMentionRepo.save).toHaveBeenCalledTimes(2);
      expect(emMentionRepo.create).toHaveBeenCalledWith({
        postId: 'post-1',
        commentId: null,
        mentionedIdentityId: 'm1',
      });
      // one 'mention' notification per surviving id (post-mention → no commentId).
      expect(notificationService.notifyOnMention).toHaveBeenCalledTimes(2);
      expect(notificationService.notifyOnMention).toHaveBeenCalledWith(
        em,
        'author-1',
        'm1',
        post,
        undefined,
      );
      // resolved DTOs are alias-only.
      expect(out).toEqual([
        { identityId: 'm1', displayAlias: 'Alpha' },
        { identityId: 'm2', displayAlias: 'Beta' },
      ]);
    });

    it('drops self-mention (author never notifies themselves)', async () => {
      // Even if the validate query were to echo the author back, the author was
      // already filtered out of the requested set, so it never reaches here.
      emIdentityRepo.find.mockResolvedValue([{ id: 'm1', displayAlias: 'Alpha' }]);

      const out = await service.processMentions(
        em as never,
        'author-1',
        ['author-1', 'm1'],
        { post },
      );

      // ONLY m1 survives — the self id produced no row, no notify.
      expect(out.map((m) => m.identityId)).toEqual(['m1']);
      expect(emMentionRepo.save).toHaveBeenCalledTimes(1);
      expect(notificationService.notifyOnMention).toHaveBeenCalledTimes(1);
      expect(notificationService.notifyOnMention).not.toHaveBeenCalledWith(
        em,
        'author-1',
        post,
        undefined,
      );
    });

    it('de-dups repeated ids (one row + one notify per unique id)', async () => {
      // The validate query collapses duplicates to one identity row; even if a
      // dup leaked through, the service de-dups the requested set first.
      emIdentityRepo.find.mockResolvedValue([{ id: 'm1', displayAlias: 'Alpha' }]);

      await service.processMentions(em as never, 'author-1', ['m1', 'm1', 'm1'], {
        post,
      });

      expect(emMentionRepo.save).toHaveBeenCalledTimes(1);
      expect(notificationService.notifyOnMention).toHaveBeenCalledTimes(1);
    });

    it('drops invalid / nonexistent ids (validate query returns nothing)', async () => {
      emIdentityRepo.find.mockResolvedValue([]); // none of the ids resolve

      const out = await service.processMentions(
        em as never,
        'author-1',
        ['ghost-1', 'ghost-2'],
        { post },
      );

      expect(out).toEqual([]);
      expect(emMentionRepo.save).not.toHaveBeenCalled();
      expect(notificationService.notifyOnMention).not.toHaveBeenCalled();
    });

    it('drops W-T1 blocked pairs with the author (no row, no notify)', async () => {
      emIdentityRepo.find.mockResolvedValue([
        { id: 'm1', displayAlias: 'Alpha' },
        { id: 'blocked', displayAlias: 'Beta' },
      ]);
      blockService.isBlockedEitherWay.mockImplementation(
        async (_a: string, target: string) => target === 'blocked',
      );

      const out = await service.processMentions(
        em as never,
        'author-1',
        ['m1', 'blocked'],
        { post },
      );

      expect(out.map((m) => m.identityId)).toEqual(['m1']);
      expect(emMentionRepo.save).toHaveBeenCalledTimes(1);
      expect(notificationService.notifyOnMention).toHaveBeenCalledTimes(1);
    });

    it('empty / undefined mentions → no-op (no validate, no row, no notify)', async () => {
      const out = await service.processMentions(em as never, 'author-1', undefined, {
        post,
      });
      expect(out).toEqual([]);
      expect(emIdentityRepo.find).not.toHaveBeenCalled();
      expect(emMentionRepo.save).not.toHaveBeenCalled();
      expect(notificationService.notifyOnMention).not.toHaveBeenCalled();
    });
  });

  describe('processMentions (comment source)', () => {
    it('stamps comment_id (post_id null) + passes commentId to the notify', async () => {
      emIdentityRepo.find.mockResolvedValue([{ id: 'm1', displayAlias: 'Alpha' }]);

      const out = await service.processMentions(em as never, 'author-1', ['m1'], {
        post,
        commentId: 'comment-9',
      });

      expect(emMentionRepo.create).toHaveBeenCalledWith({
        postId: null,
        commentId: 'comment-9',
        mentionedIdentityId: 'm1',
      });
      expect(notificationService.notifyOnMention).toHaveBeenCalledWith(
        em,
        'author-1',
        'm1',
        post,
        'comment-9',
      );
      expect(out).toEqual([{ identityId: 'm1', displayAlias: 'Alpha' }]);
    });
  });
});
