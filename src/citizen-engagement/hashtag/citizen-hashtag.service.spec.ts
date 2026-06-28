import { CitizenHashtagService } from './citizen-hashtag.service';

/**
 * Unit spec for CitizenHashtagService (W-S4).
 *
 * `extractTags` / `normalizeTag` are pure static helpers — tested directly with
 * no harness. `extractAndLink` + `listTrending` mock the constructor repos + a
 * mock EntityManager (the host transaction supplies it). No encryption.util
 * import → no jest.mock needed (project memory: `project_encryption_util_test_env`).
 */

type Repo = {
  findOne: jest.Mock;
  createQueryBuilder: jest.Mock;
};

function makeRepo(): Repo {
  return {
    findOne: jest.fn(),
    createQueryBuilder: jest.fn(),
  };
}

/** Chainable insert builder stub for `.insert().values().orIgnore().execute()`. */
function makeInsertBuilder() {
  const b: Record<string, jest.Mock> & { _values: unknown[] } = {
    _values: [],
  } as never;
  b.insert = jest.fn(() => b);
  b.values = jest.fn((v: unknown) => {
    b._values.push(v);
    return b;
  });
  b.orIgnore = jest.fn(() => b);
  b.execute = jest.fn(async () => ({ identifiers: [] }));
  return b;
}

/** Chainable grouped-SELECT builder for the trending query. */
function makeTrendingBuilder(rawRows: Array<{ tag: string; postCount: string }>) {
  const b: Record<string, jest.Mock> & { _where: unknown[] } = {
    _where: [],
  } as never;
  b.innerJoin = jest.fn(() => b);
  b.select = jest.fn(() => b);
  b.addSelect = jest.fn(() => b);
  b.where = jest.fn((...args: unknown[]) => {
    b._where.push(args);
    return b;
  });
  b.andWhere = jest.fn((...args: unknown[]) => {
    b._where.push(args);
    return b;
  });
  b.groupBy = jest.fn(() => b);
  b.orderBy = jest.fn(() => b);
  b.addOrderBy = jest.fn(() => b);
  b.limit = jest.fn(() => b);
  b.getRawMany = jest.fn(async () => rawRows);
  return b;
}

describe('CitizenHashtagService', () => {
  // ---------------------------------------------------------------------------
  // extractTags / normalizeTag (pure)
  // ---------------------------------------------------------------------------

  describe('extractTags — normalize / dedupe / cap', () => {
    it('returns [] for null / empty / no-tag text', () => {
      expect(CitizenHashtagService.extractTags(null)).toEqual([]);
      expect(CitizenHashtagService.extractTags('')).toEqual([]);
      expect(CitizenHashtagService.extractTags('no tags here')).toEqual([]);
    });

    it('parses Thai + latin tags and strips the leading #', () => {
      expect(
        CitizenHashtagService.extractTags('สร้าง #สวนสาธารณะ ที่ #Korat วันนี้'),
      ).toEqual(['สวนสาธารณะ', 'korat']);
    });

    it('lowercases latin tags (case-fold to one canonical key)', () => {
      expect(CitizenHashtagService.extractTags('#Road #ROAD #road')).toEqual([
        'road',
      ]);
    });

    it('dedupes after normalization, preserving first-seen order', () => {
      expect(
        CitizenHashtagService.extractTags('#น้ำ #ไฟ #น้ำ #road #Road'),
      ).toEqual(['น้ำ', 'ไฟ', 'road']);
    });

    it('allows underscore + digits, terminates at punctuation/space', () => {
      expect(
        CitizenHashtagService.extractTags('#โครงการ_2026, #road2! #ok.'),
      ).toEqual(['โครงการ_2026', 'road2', 'ok']);
    });

    it('caps at 10 distinct tags (first-seen wins)', () => {
      const body = Array.from({ length: 15 }, (_, i) => `#t${i}`).join(' ');
      const tags = CitizenHashtagService.extractTags(body);
      expect(tags).toHaveLength(10);
      expect(tags[0]).toBe('t0');
      expect(tags[9]).toBe('t9');
    });

    it('skips a token longer than the column width (never truncates)', () => {
      const long = 'a'.repeat(200);
      expect(CitizenHashtagService.extractTags(`#${long} #ok`)).toEqual(['ok']);
    });

    it('normalizeTag strips a leading # and NFC/lowercases', () => {
      expect(CitizenHashtagService.normalizeTag('#Park')).toBe('park');
      expect(CitizenHashtagService.normalizeTag('  สวน  ')).toBe('สวน');
      expect(CitizenHashtagService.normalizeTag('')).toBe('');
    });
  });

  // ---------------------------------------------------------------------------
  // extractAndLink (in-tx)
  // ---------------------------------------------------------------------------

  describe('extractAndLink (in-tx upsert + link)', () => {
    let emHashtagRepo: Repo;
    let emLinkRepo: Repo;
    let em: { getRepository: (e: { name: string }) => Repo };
    let service: CitizenHashtagService;
    let hashtagInsert: ReturnType<typeof makeInsertBuilder>;
    let linkInsert: ReturnType<typeof makeInsertBuilder>;

    beforeEach(() => {
      emHashtagRepo = makeRepo();
      emLinkRepo = makeRepo();
      hashtagInsert = makeInsertBuilder();
      linkInsert = makeInsertBuilder();
      emHashtagRepo.createQueryBuilder = jest.fn(() => hashtagInsert);
      emLinkRepo.createQueryBuilder = jest.fn(() => linkInsert);
      // After the orIgnore upsert, the dictionary read returns a row with an id
      // derived from the tag so we can assert the link uses it.
      emHashtagRepo.findOne = jest.fn(async (opts: { where: { tag: string } }) => ({
        id: `hid-${opts.where.tag}`,
        tag: opts.where.tag,
      }));

      const byName: Record<string, Repo> = {
        CitizenHashtag: emHashtagRepo,
        CitizenPostHashtag: emLinkRepo,
      };
      em = { getRepository: (e: { name: string }) => byName[e.name] };

      // The constructor repos / dataSource are unused on this path.
      service = new CitizenHashtagService(
        makeRepo() as never,
        makeRepo() as never,
        {} as never,
      );
    });

    it('no-ops when the text carries no tags', async () => {
      await service.extractAndLink(em as never, 'post-1', 'no tags');
      expect(emHashtagRepo.createQueryBuilder).not.toHaveBeenCalled();
      expect(emLinkRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('upserts each distinct tag and links it to the post (deduped)', async () => {
      await service.extractAndLink(
        em as never,
        'post-1',
        'ช่วย #road และ #Road อีกครั้ง #น้ำ',
      );

      // 'road' (deduped from #road/#Road) + 'น้ำ' = 2 distinct tags
      expect(hashtagInsert.orIgnore).toHaveBeenCalledTimes(2);
      expect(linkInsert.orIgnore).toHaveBeenCalledTimes(2);
      expect(hashtagInsert._values).toEqual([{ tag: 'road' }, { tag: 'น้ำ' }]);
      // links carry the resolved dictionary ids + the post id
      expect(linkInsert._values).toEqual([
        { postId: 'post-1', hashtagId: 'hid-road' },
        { postId: 'post-1', hashtagId: 'hid-น้ำ' },
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  // listTrending (window + visible-only)
  // ---------------------------------------------------------------------------

  describe('listTrending (recent window, advisory)', () => {
    let postHashtagRepo: Repo;
    let service: CitizenHashtagService;
    let builder: ReturnType<typeof makeTrendingBuilder>;

    beforeEach(() => {
      postHashtagRepo = makeRepo();
      builder = makeTrendingBuilder([
        { tag: 'road', postCount: '7' },
        { tag: 'water', postCount: '3' },
      ]);
      postHashtagRepo.createQueryBuilder = jest.fn(() => builder);
      service = new CitizenHashtagService(
        makeRepo() as never,
        postHashtagRepo as never,
        {} as never,
      );
    });

    it('returns tags ordered by postCount with the window echoed back', async () => {
      const result = await service.listTrending(24, 20);
      expect(result.windowHours).toBe(24);
      expect(result.items).toEqual([
        { tag: 'road', postCount: 7 },
        { tag: 'water', postCount: 3 },
      ]);
    });

    it('filters by a recent created_at window AND visible-only posts', async () => {
      await service.listTrending(6);
      // a created_at >= :since predicate is applied
      const sinceCall = builder._where.find((w) =>
        String((w as unknown[])[0]).includes('ph.created_at >='),
      );
      expect(sinceCall).toBeDefined();
      const sinceParam = (sinceCall as unknown[])[1] as { since: Date };
      const expected = Date.now() - 6 * 60 * 60 * 1000;
      // within a 5s tolerance of "now − 6h"
      expect(Math.abs(sinceParam.since.getTime() - expected)).toBeLessThan(5000);

      // a visible-only filter is applied
      const visibleCall = builder._where.find((w) =>
        String((w as unknown[])[0]).includes('moderation_state'),
      );
      expect(visibleCall).toBeDefined();
    });

    it('defaults the window to 24h and clamps an out-of-range window', async () => {
      const def = await service.listTrending();
      expect(def.windowHours).toBe(24);
      const clamped = await service.listTrending(99999);
      expect(clamped.windowHours).toBe(24 * 14); // MAX two weeks
    });
  });
});
