import { CitizenAchievementsService, CitizenStats } from './citizen-achievements.service';
import { CITIZEN_BADGES } from '../constants/citizen-badges';

/**
 * Unit spec for CitizenAchievementsService (W-P4 civic gamification).
 *
 * The service does NOT hash anything (no encryption.util import), so — like the
 * insights / poll specs — there is NO jest.mock('src/util/encryption.util').
 *
 * Every stat is a single COUNT / SUM. We stub each repo's `createQueryBuilder`
 * to return a chainable builder whose terminal `getCount()` / `getRawOne()`
 * yields a scripted value, then drive the public methods and assert the
 * thresholds, the earned-only public projection, and that NOTHING writes.
 */

/** Chainable read-only query builder. `count` backs getCount; `raw` backs getRawOne. */
function makeCountBuilder(count: number, raw?: Record<string, unknown>) {
  const b: Record<string, jest.Mock> = {};
  b.select = jest.fn(() => b);
  b.addSelect = jest.fn(() => b);
  b.innerJoin = jest.fn(() => b);
  b.where = jest.fn(() => b);
  b.andWhere = jest.fn(() => b);
  b.getCount = jest.fn(async () => count);
  b.getRawOne = jest.fn(async () => raw ?? {});
  return b;
}

/**
 * Build the service against a fully-scripted stat set. Each repo's
 * `createQueryBuilder` returns the right scalar for its single query.
 *
 * `mutationProbe` is wired onto every write-ish method name so a spec can assert
 * the aggregator never calls one.
 */
function buildService(stats: CitizenStats) {
  const mutationProbe = jest.fn();
  const writeMethods = {
    save: mutationProbe,
    insert: mutationProbe,
    update: mutationProbe,
    delete: mutationProbe,
    softDelete: mutationProbe,
    remove: mutationProbe,
    softRemove: mutationProbe,
  };

  const postRepo = {
    ...writeMethods,
    // posts (getCount), ideaPosts (getCount), reactionsReceived (getRawOne sum).
    createQueryBuilder: jest
      .fn()
      .mockReturnValueOnce(makeCountBuilder(stats.posts))
      .mockReturnValueOnce(makeCountBuilder(stats.ideaPosts))
      .mockReturnValueOnce(
        makeCountBuilder(0, { sum: String(stats.reactionsReceived) }),
      ),
  };
  const commentRepo = {
    ...writeMethods,
    createQueryBuilder: jest.fn(() => makeCountBuilder(stats.comments)),
  };
  const pollVoteRepo = {
    ...writeMethods,
    createQueryBuilder: jest.fn(() => makeCountBuilder(stats.pollVotes)),
  };
  const storyRepo = {
    ...writeMethods,
    createQueryBuilder: jest.fn(() => makeCountBuilder(stats.stories)),
  };
  const followRepo = {
    ...writeMethods,
    createQueryBuilder: jest.fn(() => makeCountBuilder(stats.followers)),
  };
  const officialResponseRepo = {
    ...writeMethods,
    createQueryBuilder: jest.fn(() =>
      makeCountBuilder(0, { cnt: String(stats.officialResponsesReceived) }),
    ),
  };

  const service = new CitizenAchievementsService(
    postRepo as never,
    commentRepo as never,
    pollVoteRepo as never,
    storyRepo as never,
    followRepo as never,
    officialResponseRepo as never,
  );

  return {
    service,
    mutationProbe,
    repos: {
      postRepo,
      commentRepo,
      pollVoteRepo,
      storyRepo,
      followRepo,
      officialResponseRepo,
    },
  };
}

const ZERO: CitizenStats = {
  posts: 0,
  ideaPosts: 0,
  comments: 0,
  reactionsReceived: 0,
  pollVotes: 0,
  stories: 0,
  followers: 0,
  officialResponsesReceived: 0,
};

describe('CitizenAchievementsService (W-P4)', () => {
  describe('computeStats', () => {
    it('maps each repo scalar to the right stat field', async () => {
      const stats: CitizenStats = {
        posts: 12,
        ideaPosts: 6,
        comments: 51,
        reactionsReceived: 140,
        pollVotes: 11,
        stories: 7,
        followers: 13,
        officialResponsesReceived: 2,
      };
      const { service } = buildService(stats);
      await expect(service.computeStats('id-1')).resolves.toEqual(stats);
    });
  });

  describe('getMine — full catalog + earned + progress', () => {
    it('returns every catalog badge with stats', async () => {
      const { service } = buildService(ZERO);
      const out = await service.getMine('id-1');
      expect(out.badges).toHaveLength(CITIZEN_BADGES.length);
      expect(out.stats).toEqual(ZERO);
    });

    it('threshold boundary: posts=9 → contributor NOT earned', async () => {
      const { service } = buildService({ ...ZERO, posts: 9 });
      const out = await service.getMine('id-1');
      const contributor = out.badges.find((b) => b.key === 'contributor');
      const firstPost = out.badges.find((b) => b.key === 'first_post');
      expect(contributor?.earned).toBe(false);
      expect(contributor?.progress).toEqual({ current: 9, target: 10 });
      // first_post (>=1) IS earned at posts=9.
      expect(firstPost?.earned).toBe(true);
    });

    it('threshold boundary: posts=10 → contributor earned', async () => {
      const { service } = buildService({ ...ZERO, posts: 10 });
      const out = await service.getMine('id-1');
      const contributor = out.badges.find((b) => b.key === 'contributor');
      expect(contributor?.earned).toBe(true);
      expect(contributor?.progress).toEqual({ current: 10, target: 10 });
    });

    it('clamps over-threshold progress.current at the target', async () => {
      const { service } = buildService({ ...ZERO, reactionsReceived: 250 });
      const out = await service.getMine('id-1');
      const voice = out.badges.find((b) => b.key === 'community_voice');
      expect(voice?.earned).toBe(true);
      // current clamped to target (100), not the raw 250.
      expect(voice?.progress).toEqual({ current: 100, target: 100 });
    });

    it('verified_civic earns at >=1 official response', async () => {
      const earned = buildService({ ...ZERO, officialResponsesReceived: 1 });
      const notEarned = buildService({ ...ZERO, officialResponsesReceived: 0 });
      const a = await earned.service.getMine('id-1');
      const b = await notEarned.service.getMine('id-2');
      expect(a.badges.find((x) => x.key === 'verified_civic')?.earned).toBe(true);
      expect(b.badges.find((x) => x.key === 'verified_civic')?.earned).toBe(false);
    });
  });

  describe('getPublic — earned-only, NO stats leak', () => {
    it('returns ONLY earned badges and never a stats key', async () => {
      // posts=10 → first_post + contributor earned; everything else zero.
      const { service } = buildService({ ...ZERO, posts: 10 });
      const out = await service.getPublic('id-1');
      const keys = out.map((b) => b.key).sort();
      expect(keys).toEqual(['contributor', 'first_post']);
      // Each earned entry carries badge facts only — NO `earned`, NO `progress`,
      // NO `current`/`target`, NO raw count.
      for (const badge of out) {
        expect(Object.keys(badge).sort()).toEqual(
          ['descriptionTh', 'iconKey', 'key', 'labelTh', 'tier'].sort(),
        );
        expect(badge).not.toHaveProperty('progress');
        expect(badge).not.toHaveProperty('earned');
      }
    });

    it('returns an empty array when nothing is earned', async () => {
      const { service } = buildService(ZERO);
      await expect(service.getPublic('id-1')).resolves.toEqual([]);
    });

    it('does not expose raw stats anywhere in the public payload', async () => {
      const { service } = buildService({ ...ZERO, posts: 10, followers: 13 });
      const out = await service.getPublic('id-1');
      // followers=13 (>=10 connector) is earned but the COUNT 13 must not appear.
      const serialized = JSON.stringify(out);
      expect(serialized).not.toContain('13');
    });
  });

  describe('zero-write (§18.13 / §17.3)', () => {
    it('getMine performs no save/insert/update/delete on any repo', async () => {
      const { service, mutationProbe } = buildService({
        ...ZERO,
        posts: 10,
        comments: 60,
      });
      await service.getMine('id-1');
      expect(mutationProbe).not.toHaveBeenCalled();
    });

    it('getPublic performs no save/insert/update/delete on any repo', async () => {
      const { service, mutationProbe } = buildService({ ...ZERO, posts: 10 });
      await service.getPublic('id-1');
      expect(mutationProbe).not.toHaveBeenCalled();
    });
  });
});
