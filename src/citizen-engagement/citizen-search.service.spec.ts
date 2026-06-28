import { BadRequestException } from '@nestjs/common';

import { CitizenSearchService, escapeLike } from './citizen-search.service';

/**
 * Unit spec for CitizenSearchService (W-S5).
 *
 * Mirrors the citizen-post.service.spec mock style: a chainable select-builder
 * stub captures the `where` / `andWhere` / `orderBy` calls so each spec asserts
 * the bound ILIKE `like`, the geo bbox params, the visible-only filter, and the
 * (rankScore, id) DESC keyset shape. `hydratePostPage` is a mocked pass-through.
 */

/** Chainable select-builder stub that records every where/order call. */
function makeSelectBuilder(rows: unknown[]) {
  const andWhereCalls: unknown[][] = [];
  const whereCalls: unknown[][] = [];
  const orderCalls: Array<{ field: string; dir: string }> = [];
  const b: Record<string, jest.Mock> & {
    _andWhere: unknown[][];
    _where: unknown[][];
    _order: Array<{ field: string; dir: string }>;
  } = {
    leftJoin: jest.fn(() => b),
    addSelect: jest.fn(() => b),
    where: jest.fn((...a: unknown[]) => {
      whereCalls.push(a);
      return b;
    }),
    andWhere: jest.fn((...a: unknown[]) => {
      andWhereCalls.push(a);
      return b;
    }),
    orderBy: jest.fn((field: string, dir: string) => {
      orderCalls.push({ field, dir });
      return b;
    }),
    addOrderBy: jest.fn((field: string, dir: string) => {
      orderCalls.push({ field, dir });
      return b;
    }),
    take: jest.fn(() => b),
    getMany: jest.fn(async () => rows),
    _andWhere: andWhereCalls,
    _where: whereCalls,
    _order: orderCalls,
  } as never;
  return b;
}

/** Find the andWhere call whose SQL string contains `needle`. */
function findAndWhere(
  builder: { _andWhere: unknown[][] },
  needle: string,
): unknown[] | undefined {
  return builder._andWhere.find((c) => String(c[0]).includes(needle));
}

describe('escapeLike', () => {
  it('escapes %, _, and backslash (backslash first)', () => {
    expect(escapeLike('a%b_c')).toBe('a\\%b\\_c');
    expect(escapeLike('a\\b')).toBe('a\\\\b');
    // combined: backslash is doubled BEFORE the % / _ escapes are added
    expect(escapeLike('50%_\\')).toBe('50\\%\\_\\\\');
  });

  it('passes Thai text through unchanged', () => {
    expect(escapeLike('ถนนพัง')).toBe('ถนนพัง');
  });
});

describe('CitizenSearchService', () => {
  let service: CitizenSearchService;
  let postRepo: { createQueryBuilder: jest.Mock };
  let postService: { hydratePostPage: jest.Mock };

  beforeEach(() => {
    postRepo = { createQueryBuilder: jest.fn() };
    // pass-through hydrator: return a deterministic envelope so we can assert
    // the rows + limit it was called with.
    postService = {
      hydratePostPage: jest.fn(async (rows: unknown[]) => ({
        items: rows,
        nextCursor: null,
      })),
    };
    // W-T1: block service mock — default no exclusions so the search WHERE
    // clause is unchanged for the existing specs.
    const blockService = {
      excludedAuthorIdsForViewer: jest.fn(async () => new Set<string>()),
    };
    service = new CitizenSearchService(
      postRepo as never,
      postService as never,
      blockService as never,
    );
  });

  describe('validation', () => {
    it('400s CITIZEN_SEARCH_EMPTY when neither q nor geo is supplied', async () => {
      await expect(service.search({} as never)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(postRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('400s CITIZEN_SEARCH_EMPTY when q is blank/whitespace-only and no geo', async () => {
      await expect(
        service.search({ q: '   ' } as never),
      ).rejects.toMatchObject({ message: 'CITIZEN_SEARCH_EMPTY' });
      expect(postRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('400s on a PARTIAL geo triple (lat+lng but no radiusKm)', async () => {
      await expect(
        service.search({ lat: 14.97, lng: 102.1 } as never),
      ).rejects.toMatchObject({ message: 'CITIZEN_SEARCH_EMPTY' });
      expect(postRepo.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe('text search', () => {
    it('binds an escaped, %-wrapped ILIKE over title OR detail (Thai substring)', async () => {
      const builder = makeSelectBuilder([]);
      postRepo.createQueryBuilder = jest.fn(() => builder);

      await service.search({ q: '  ถนนพัง  ' } as never);

      const likeCall = findAndWhere(builder, 'p.title ILIKE :like');
      expect(likeCall).toBeDefined();
      expect(String(likeCall?.[0])).toContain('p.detail ILIKE :like');
      // trimmed + %-wrapped; Thai passes through escapeLike unchanged
      expect(likeCall?.[1]).toEqual({ like: '%ถนนพัง%' });
    });

    it('escapes a literal % in the query so it matches literally', async () => {
      const builder = makeSelectBuilder([]);
      postRepo.createQueryBuilder = jest.fn(() => builder);

      await service.search({ q: '50%' } as never);

      const likeCall = findAndWhere(builder, 'ILIKE :like');
      // the inner % is escaped; the wrapping %…% stay as wildcards
      expect(likeCall?.[1]).toEqual({ like: '%50\\%%' });
    });

    it('filters visible-only and not-deleted', async () => {
      const builder = makeSelectBuilder([]);
      postRepo.createQueryBuilder = jest.fn(() => builder);

      await service.search({ q: 'x' } as never);

      expect(builder.where).toHaveBeenCalledWith('p.moderationState = :state', {
        state: 'visible',
      });
      expect(findAndWhere(builder, 'p.deletedAt IS NULL')).toBeDefined();
    });
  });

  describe('geo search', () => {
    it('restricts to idea posts and binds the lat/lng bounding box (d = radiusKm/111)', async () => {
      const builder = makeSelectBuilder([]);
      postRepo.createQueryBuilder = jest.fn(() => builder);

      await service.search({ lat: 14.97, lng: 102.1, radiusKm: 11.1 } as never);

      // idea-only restriction
      const ideaCall = findAndWhere(builder, 'p.postKind = :ideaKind');
      expect(ideaCall?.[1]).toEqual({ ideaKind: 'idea' });

      const d = 11.1 / 111.0; // 0.1 deg (latitude delta)
      const latCall = findAndWhere(builder, 'p.lat BETWEEN');
      expect(latCall?.[1]).toEqual({ latMin: 14.97 - d, latMax: 14.97 + d });
      // longitude degrees shrink by cos(lat), so the lng delta is widened.
      const lngD = d / Math.max(0.01, Math.cos((14.97 * Math.PI) / 180));
      const lngCall = findAndWhere(builder, 'p.lng BETWEEN');
      expect(lngCall?.[1]).toEqual({ lngMin: 102.1 - lngD, lngMax: 102.1 + lngD });
    });

    it('combines text AND geo (both predicates present)', async () => {
      const builder = makeSelectBuilder([]);
      postRepo.createQueryBuilder = jest.fn(() => builder);

      await service.search({
        q: 'น้ำท่วม',
        lat: 14.97,
        lng: 102.1,
        radiusKm: 5,
      } as never);

      expect(findAndWhere(builder, 'ILIKE :like')).toBeDefined();
      expect(findAndWhere(builder, 'p.lat BETWEEN')).toBeDefined();
    });
  });

  describe('keyset + hydration', () => {
    it('orders by (rankScore, id) DESC and delegates hydration', async () => {
      const rows = [{ id: 'post-hi' }, { id: 'post-lo' }];
      const builder = makeSelectBuilder(rows);
      postRepo.createQueryBuilder = jest.fn(() => builder);

      const result = await service.search({ q: 'x', limit: 2 } as never);

      expect(builder._order).toEqual([
        { field: 'p.rankScore', dir: 'DESC' },
        { field: 'p.id', dir: 'DESC' },
      ]);
      expect(postService.hydratePostPage).toHaveBeenCalledWith(rows, 2, undefined);
      expect(result.items).toEqual(rows);
    });

    it('applies the (rankScore, id) keyset predicate when a cursor is supplied', async () => {
      const builder = makeSelectBuilder([]);
      postRepo.createQueryBuilder = jest.fn(() => builder);

      await service.search({
        q: 'x',
        beforeRankScore: 4.0,
        beforeId: 'cursor-id',
      } as never);

      const keysetCall = findAndWhere(builder, 'p.rankScore <');
      expect(keysetCall).toBeDefined();
      expect(keysetCall?.[1]).toEqual({
        beforeRankScore: 4.0,
        beforeId: 'cursor-id',
      });
    });

    it('applies the optional kind filter', async () => {
      const builder = makeSelectBuilder([]);
      postRepo.createQueryBuilder = jest.fn(() => builder);

      await service.search({ q: 'x', kind: 'poll' } as never);

      const kindCall = findAndWhere(builder, 'p.postKind = :kind');
      expect(kindCall?.[1]).toEqual({ kind: 'poll' });
    });
  });
});
