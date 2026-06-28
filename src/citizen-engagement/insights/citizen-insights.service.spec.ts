import { CitizenInsightsService } from './citizen-insights.service';

/**
 * Unit spec for CitizenInsightsService (W-G3 executive insights).
 *
 * The service is a §18.13 ZERO-WRITE read aggregator — every method builds a
 * grouped/counted SELECT via a chainable QueryBuilder. The spec mocks the
 * constructor repos + a recording QueryBuilder stub (mirrors
 * `citizen-hashtag.service.spec.ts`). No encryption.util import → no jest.mock
 * needed (project memory: `project_encryption_util_test_env`).
 *
 * Asserted invariants:
 *   - every aggregate filters VISIBLE-only (`moderation_state = 'visible'`) +
 *     not-deleted (`deleted_at IS NULL`) within a `created_at >= :since` window
 *   - `windowDays` is clamped to [1, 365] (default 30)
 *   - topPosts exposes ALIAS-ONLY author fields (no national_id / thaid / _enc)
 *   - the service issues ZERO writes (no insert / save / update / delete call)
 */

interface RecordingBuilder {
  _select: string[][];
  _where: unknown[][];
  _orderBy: unknown[][];
  innerJoin: jest.Mock;
  select: jest.Mock;
  addSelect: jest.Mock;
  where: jest.Mock;
  andWhere: jest.Mock;
  groupBy: jest.Mock;
  orderBy: jest.Mock;
  addOrderBy: jest.Mock;
  limit: jest.Mock;
  getCount: jest.Mock;
  getRawOne: jest.Mock;
  getRawMany: jest.Mock;
  // forbidden write methods — present so we can assert they are NEVER called
  insert: jest.Mock;
  update: jest.Mock;
  delete: jest.Mock;
  softDelete: jest.Mock;
}

function makeBuilder(opts: {
  count?: number;
  rawOne?: Record<string, unknown>;
  rawMany?: Array<Record<string, unknown>>;
}): RecordingBuilder {
  const b = {
    _select: [],
    _where: [],
    _orderBy: [],
  } as unknown as RecordingBuilder;
  b.innerJoin = jest.fn(() => b);
  b.select = jest.fn((...a: string[]) => {
    b._select.push(a);
    return b;
  });
  b.addSelect = jest.fn((...a: string[]) => {
    b._select.push(a);
    return b;
  });
  b.where = jest.fn((...a: unknown[]) => {
    b._where.push(a);
    return b;
  });
  b.andWhere = jest.fn((...a: unknown[]) => {
    b._where.push(a);
    return b;
  });
  b.groupBy = jest.fn(() => b);
  b.orderBy = jest.fn((...a: unknown[]) => {
    b._orderBy.push(a);
    return b;
  });
  b.addOrderBy = jest.fn((...a: unknown[]) => {
    b._orderBy.push(a);
    return b;
  });
  b.limit = jest.fn(() => b);
  b.getCount = jest.fn(async () => opts.count ?? 0);
  b.getRawOne = jest.fn(async () => opts.rawOne ?? undefined);
  b.getRawMany = jest.fn(async () => opts.rawMany ?? []);
  // writes must never be reached
  b.insert = jest.fn(() => b);
  b.update = jest.fn(() => b);
  b.delete = jest.fn(() => b);
  b.softDelete = jest.fn(() => b);
  return b;
}

interface Repo {
  createQueryBuilder: jest.Mock;
  save: jest.Mock;
  insert: jest.Mock;
  update: jest.Mock;
  delete: jest.Mock;
  softDelete: jest.Mock;
}

function makeRepo(builder: RecordingBuilder): Repo {
  return {
    createQueryBuilder: jest.fn(() => builder),
    save: jest.fn(),
    insert: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    softDelete: jest.fn(),
  };
}

/** Assert a builder applied the canonical visible-only + not-deleted + window. */
function expectVisibleWindowFilters(b: RecordingBuilder, postAlias = 'p') {
  const flat = b._where.map((w) => String(w[0]));
  expect(flat.some((s) => s.includes(`${postAlias}.moderation_state`))).toBe(
    true,
  );
  expect(flat.some((s) => s.includes(`${postAlias}.deleted_at IS NULL`))).toBe(
    true,
  );
  // a created_at >= :since window predicate is applied somewhere in the chain
  expect(flat.some((s) => /created_at >= :since/.test(s))).toBe(true);
  // the :since param resolves to a real Date
  const sinceArg = b._where.find((w) => /created_at >= :since/.test(String(w[0])));
  expect((sinceArg?.[1] as { since: Date }).since).toBeInstanceOf(Date);
}

describe('CitizenInsightsService (W-G3)', () => {
  describe('overview', () => {
    it('counts visible + windowed posts/comments/reactions/active/polls/stories and clamps windowDays', async () => {
      // A fresh builder per repo so we can inspect each independently.
      const postCount = makeBuilder({ count: 12 });
      const commentCount = makeBuilder({ count: 30 });
      const reactionCount = makeBuilder({ count: 40 });
      const activeRaw = makeBuilder({ rawOne: { cnt: '5' } });
      const pollCount = makeBuilder({ count: 2 });
      const storyCount = makeBuilder({ count: 3 });
      const kindRaw = makeBuilder({
        rawMany: [
          { kind: 'idea', cnt: '8' },
          { kind: 'discussion', cnt: '3' },
          { kind: 'poll', cnt: '1' },
        ],
      });
      const dayRaw = makeBuilder({
        rawMany: [{ day: '2026-06-25', cnt: '4' }],
      });

      // postRepo.createQueryBuilder is called 5x in overview (posts, active,
      // polls, byKind, byDay) — return a fresh builder each time, in order.
      const postRepo = {
        createQueryBuilder: jest
          .fn()
          .mockReturnValueOnce(postCount)
          .mockReturnValueOnce(activeRaw)
          .mockReturnValueOnce(pollCount)
          .mockReturnValueOnce(kindRaw)
          .mockReturnValueOnce(dayRaw),
        save: jest.fn(),
      } as unknown as Repo;

      const service = new CitizenInsightsService(
        postRepo as never,
        makeRepo(commentCount) as never,
        makeRepo(reactionCount) as never,
        makeRepo(makeBuilder({})) as never, // postHashtagRepo (unused here)
        makeRepo(storyCount) as never,
      );

      const out = await service.overview(30);

      expect(out.windowDays).toBe(30);
      expect(out.totals).toEqual({
        posts: 12,
        comments: 30,
        reactions: 40,
        activeCitizens: 5,
        polls: 2,
        stories: 3,
      });
      expect(out.byKind).toEqual({ idea: 8, discussion: 3, poll: 1 });
      expect(out.newPostsByDay).toEqual([{ day: '2026-06-25', count: 4 }]);

      // visible-only + window on the primary post count
      expectVisibleWindowFilters(postCount);
      // comments are visible-only + windowed too
      expectVisibleWindowFilters(commentCount, 'c');
    });

    it('clamps an out-of-range windowDays to [1, 365] and defaults to 30', async () => {
      const mk = () =>
        new CitizenInsightsService(
          { createQueryBuilder: jest.fn(() => makeBuilder({ rawOne: { cnt: '0' } })) } as never,
          makeRepo(makeBuilder({})) as never,
          makeRepo(makeBuilder({})) as never,
          makeRepo(makeBuilder({})) as never,
          makeRepo(makeBuilder({})) as never,
        );

      expect((await mk().overview(undefined)).windowDays).toBe(30);
      expect((await mk().overview(0)).windowDays).toBe(1);
      expect((await mk().overview(99999)).windowDays).toBe(365);
      expect((await mk().overview(NaN)).windowDays).toBe(30);
    });
  });

  describe('topCategories', () => {
    it('groups idea categories with post + reaction counts, visible-only + windowed', async () => {
      const b = makeBuilder({
        rawMany: [
          { category: 'road', postCount: '9', reactionCount: '40' },
          { category: 'water', postCount: '4', reactionCount: '12' },
        ],
      });
      const service = new CitizenInsightsService(
        makeRepo(b) as never,
        makeRepo(makeBuilder({})) as never,
        makeRepo(makeBuilder({})) as never,
        makeRepo(makeBuilder({})) as never,
        makeRepo(makeBuilder({})) as never,
      );

      const rows = await service.topCategories(7);
      expect(rows).toEqual([
        { category: 'road', postCount: 9, reactionCount: 40 },
        { category: 'water', postCount: 4, reactionCount: 12 },
      ]);
      expectVisibleWindowFilters(b);
      // category NOT NULL filter present (idea-only)
      expect(b._where.map((w) => String(w[0])).some((s) => /category IS NOT NULL/.test(s))).toBe(true);
    });
  });

  describe('topHashtags', () => {
    it('wraps the W-S4 trending shape (distinct visible posts per tag) with a day window + clamped limit', async () => {
      const b = makeBuilder({
        rawMany: [
          { tag: 'road', postCount: '7' },
          { tag: 'water', postCount: '3' },
        ],
      });
      const service = new CitizenInsightsService(
        makeRepo(makeBuilder({})) as never,
        makeRepo(makeBuilder({})) as never,
        makeRepo(makeBuilder({})) as never,
        makeRepo(b) as never, // postHashtagRepo
        makeRepo(makeBuilder({})) as never,
      );

      const rows = await service.topHashtags(30, 999);
      expect(rows).toEqual([
        { tag: 'road', postCount: 7 },
        { tag: 'water', postCount: 3 },
      ]);
      // visible-only + not-deleted on the joined post; window on the link time
      const flat = b._where.map((w) => String(w[0]));
      expect(flat.some((s) => s.includes('p.moderation_state'))).toBe(true);
      expect(flat.some((s) => s.includes('p.deleted_at IS NULL'))).toBe(true);
      expect(flat.some((s) => /ph.created_at >= :since/.test(s))).toBe(true);
      // limit clamped to MAX 50
      expect(b.limit).toHaveBeenCalledWith(50);
    });
  });

  describe('topPosts (ALIAS-ONLY author — no PII)', () => {
    let b: RecordingBuilder;
    let service: CitizenInsightsService;

    beforeEach(() => {
      b = makeBuilder({
        rawMany: [
          {
            id: 'post-1',
            title: 'ถนนชำรุด',
            detail: 'รายละเอียด',
            postKind: 'idea',
            category: 'road',
            heartCount: 10,
            commentCount: 4,
            engagement: 18,
            displayAlias: 'พลเมืองดี',
            createdAt: new Date('2026-06-20T00:00:00Z'),
          },
        ],
      });
      service = new CitizenInsightsService(
        makeRepo(b) as never,
        makeRepo(makeBuilder({})) as never,
        makeRepo(makeBuilder({})) as never,
        makeRepo(makeBuilder({})) as never,
        makeRepo(makeBuilder({})) as never,
      );
    });

    it('returns most-engaged visible posts with alias-only author', async () => {
      const rows = await service.topPosts(30, 10);
      expect(rows[0]).toMatchObject({
        id: 'post-1',
        displayAlias: 'พลเมืองดี',
        engagement: 18,
        heartCount: 10,
        commentCount: 4,
      });
      // the returned row carries ONLY the alias — never any PII field
      const keys = Object.keys(rows[0]);
      expect(keys).toContain('displayAlias');
      for (const forbidden of [
        'nationalId',
        'national_id',
        'nationalIdEnc',
        'national_id_enc',
        'nationalIdHash',
        'thaidSubHash',
        'thaid_sub_hash',
        'fullNameEnc',
        'full_name_enc',
      ]) {
        expect(keys).not.toContain(forbidden);
      }
    });

    it('NEVER selects a PII column in the SQL (only display_alias from the identity join)', async () => {
      await service.topPosts(30, 10);
      const selected = b._select.flat().join(' | ');
      expect(selected).toContain('i.display_alias');
      expect(selected).not.toMatch(/national_id|_enc|_hash|thaid_sub/);
    });

    it('filters visible-only + windowed and orders by engagement', async () => {
      await service.topPosts(30, 10);
      expectVisibleWindowFilters(b);
      expect(b._orderBy.flat().join(' ')).toContain('engagement');
    });
  });

  describe('byAmphoe', () => {
    it('groups post counts by amphoe_id (idea pins), visible-only + windowed', async () => {
      const b = makeBuilder({
        rawMany: [
          { amphoeId: 'amphoe-a', postCount: '11' },
          { amphoeId: 'amphoe-b', postCount: '6' },
        ],
      });
      const service = new CitizenInsightsService(
        makeRepo(b) as never,
        makeRepo(makeBuilder({})) as never,
        makeRepo(makeBuilder({})) as never,
        makeRepo(makeBuilder({})) as never,
        makeRepo(makeBuilder({})) as never,
      );

      const rows = await service.byAmphoe(90);
      expect(rows).toEqual([
        { amphoeId: 'amphoe-a', postCount: 11 },
        { amphoeId: 'amphoe-b', postCount: 6 },
      ]);
      expectVisibleWindowFilters(b);
      expect(b._where.map((w) => String(w[0])).some((s) => /amphoe_id IS NOT NULL/.test(s))).toBe(true);
    });
  });

  describe('§18.13 zero-write — issues NO write call on any read path', () => {
    it('never calls save/insert/update/delete/softDelete on any repo', async () => {
      const builders = Array.from({ length: 9 }, () =>
        makeBuilder({ rawOne: { cnt: '0' }, rawMany: [] }),
      );
      let i = 0;
      const next = () => builders[Math.min(i++, builders.length - 1)];
      const repos = Array.from({ length: 5 }, () => ({
        createQueryBuilder: jest.fn(() => next()),
        save: jest.fn(),
        insert: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        softDelete: jest.fn(),
      }));
      const [postRepo, commentRepo, reactionRepo, hashtagRepo, storyRepo] =
        repos;

      const service = new CitizenInsightsService(
        postRepo as never,
        commentRepo as never,
        reactionRepo as never,
        hashtagRepo as never,
        storyRepo as never,
      );

      await service.overview(30);
      i = 0;
      await service.topCategories(30);
      i = 0;
      await service.topHashtags(30, 10);
      i = 0;
      await service.topPosts(30, 10);
      i = 0;
      await service.byAmphoe(30);

      for (const r of repos) {
        expect(r.save).not.toHaveBeenCalled();
        expect(r.insert).not.toHaveBeenCalled();
        expect(r.update).not.toHaveBeenCalled();
        expect(r.delete).not.toHaveBeenCalled();
        expect(r.softDelete).not.toHaveBeenCalled();
      }
      // and no builder ever invoked a write method
      for (const b of builders) {
        expect(b.insert).not.toHaveBeenCalled();
        expect(b.update).not.toHaveBeenCalled();
        expect(b.delete).not.toHaveBeenCalled();
        expect(b.softDelete).not.toHaveBeenCalled();
      }
    });
  });
});
