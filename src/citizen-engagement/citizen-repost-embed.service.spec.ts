import { CitizenRepostEmbedService } from './citizen-repost-embed.service';

/**
 * Unit spec for CitizenRepostEmbedService (W-S2).
 *
 * No encryption.util import on this path (the service touches only the post +
 * media repos), so — like the bookmark/profile specs — there is NO
 * jest.mock('src/util/encryption.util'). We mock the post repo's query builder
 * (one call for the originals) and the media repo's `find` (one call for the
 * visible originals' media).
 */

/** Chainable SELECT builder stub for the originals query. */
function makeOriginalsBuilder(rows: unknown[]) {
  const b: Record<string, jest.Mock> = {};
  b.leftJoin = jest.fn(() => b);
  b.addSelect = jest.fn(() => b);
  b.where = jest.fn(() => b);
  b.andWhere = jest.fn(() => b);
  b.getMany = jest.fn(async () => rows);
  return b;
}

describe('CitizenRepostEmbedService', () => {
  let service: CitizenRepostEmbedService;
  let postRepo: { createQueryBuilder: jest.Mock };
  let mediaRepo: { find: jest.Mock };

  function build(originals: unknown[], media: unknown[] = []) {
    postRepo = {
      createQueryBuilder: jest.fn(() => makeOriginalsBuilder(originals)),
    };
    mediaRepo = { find: jest.fn(async () => media) };
    service = new CitizenRepostEmbedService(
      postRepo as never,
      mediaRepo as never,
    );
  }

  it('returns an empty map for empty / all-null input (no query)', async () => {
    build([]);
    const out = await service.batchLoadEmbeds([null, undefined]);
    expect(out.size).toBe(0);
    expect(postRepo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('de-duplicates root ids and resolves a VISIBLE original to an embed', async () => {
    const original = {
      id: 'root-1',
      postKind: 'idea',
      lat: '14.9',
      lng: '102.1',
      amphoeId: 'amphoe-1',
      category: 'road',
      title: 'ถนนพัง',
      detail: 'หลุมเยอะ',
      heartCount: 5,
      commentCount: 2,
      repostCount: 3,
      moderationState: 'visible',
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
      author: { displayAlias: 'Alias A' },
    };
    build([original], [{ id: 'm-1', postId: 'root-1' }]);

    // two reposts of the same root → one de-duped query
    const out = await service.batchLoadEmbeds(['root-1', 'root-1']);

    expect(postRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
    const embed = out.get('root-1');
    expect(embed).toMatchObject({
      id: 'root-1',
      postKind: 'idea',
      lat: 14.9,
      lng: 102.1,
      title: 'ถนนพัง',
      heartCount: 5,
      reactionCount: 5,
      repostCount: 3,
      author: { displayAlias: 'Alias A' },
    });
    // media attached
    expect((embed as { media: unknown[] }).media).toHaveLength(1);
    // NO leak of hidden content shape
    expect(embed).not.toHaveProperty('unavailable');
  });

  it('TOMBSTONES a hidden original (never leaks its content)', async () => {
    const hidden = {
      id: 'root-1',
      moderationState: 'hidden',
      title: 'secret',
      detail: 'leaked?',
      author: { displayAlias: 'Alias A' },
    };
    build([hidden]);

    const out = await service.batchLoadEmbeds(['root-1']);

    expect(out.get('root-1')).toEqual({ unavailable: true });
    // the hidden original's media is NEVER queried
    expect(mediaRepo.find).not.toHaveBeenCalled();
  });

  it('TOMBSTONES a missing / hard-deleted original (absent from the result set)', async () => {
    build([]); // query returns nothing for the requested id
    const out = await service.batchLoadEmbeds(['gone-1']);
    expect(out.get('gone-1')).toEqual({ unavailable: true });
  });
});
