import {
  BASE_EPOCH_SEC,
  RECENCY_DECAY,
  computeRankScore,
} from './citizen-feed-ranking';

/**
 * Pure-function spec for the advisory feed rank score (W-F2).
 *
 * `citizen-feed-ranking.ts` imports nothing from `src/util/encryption.util`, so
 * there is NO jest.mock here (project memory: `project_encryption_util_test_env`
 * only applies to specs that transitively import encryption.util).
 */
describe('computeRankScore', () => {
  // A fixed createdAt so the recency term is constant across engagement cases.
  const fixedDate = new Date('2026-03-01T00:00:00.000Z');

  it('exports the documented constants', () => {
    expect(BASE_EPOCH_SEC).toBe(1735689600);
    expect(RECENCY_DECAY).toBe(45000);
  });

  it('is monotonic in engagement at equal recency (more hearts → higher score)', () => {
    const low = computeRankScore({ heartCount: 0, commentCount: 0, createdAt: fixedDate });
    const mid = computeRankScore({ heartCount: 5, commentCount: 0, createdAt: fixedDate });
    const high = computeRankScore({ heartCount: 50, commentCount: 0, createdAt: fixedDate });
    expect(mid).toBeGreaterThan(low);
    expect(high).toBeGreaterThan(mid);
  });

  it('weighs a comment 2× a heart at equal recency', () => {
    const oneComment = computeRankScore({ heartCount: 0, commentCount: 1, createdAt: fixedDate });
    const twoHearts = computeRankScore({ heartCount: 2, commentCount: 0, createdAt: fixedDate });
    // heartCount + 2*commentCount → both reduce to log10(2): equal engagement term.
    expect(oneComment).toBeCloseTo(twoHearts, 10);
  });

  it('is monotonic in recency at equal engagement (newer → higher score)', () => {
    const older = new Date('2026-02-01T00:00:00.000Z');
    const newer = new Date('2026-04-01T00:00:00.000Z');
    const olderScore = computeRankScore({ heartCount: 3, commentCount: 1, createdAt: older });
    const newerScore = computeRankScore({ heartCount: 3, commentCount: 1, createdAt: newer });
    expect(newerScore).toBeGreaterThan(olderScore);
  });

  it('floors engagement at log10(1)=0 for a zero-engagement post', () => {
    const createdAtSec = fixedDate.getTime() / 1000;
    const expectedRecency = (createdAtSec - BASE_EPOCH_SEC) / RECENCY_DECAY;
    const score = computeRankScore({ heartCount: 0, commentCount: 0, createdAt: fixedDate });
    expect(score).toBeCloseTo(expectedRecency, 10);
  });

  it('matches the exact documented formula for a mixed case', () => {
    const heartCount = 7;
    const commentCount = 4;
    const createdAtSec = fixedDate.getTime() / 1000;
    const expected =
      Math.log10(1 + heartCount + 2 * commentCount) +
      (createdAtSec - BASE_EPOCH_SEC) / RECENCY_DECAY;
    expect(
      computeRankScore({ heartCount, commentCount, createdAt: fixedDate }),
    ).toBeCloseTo(expected, 10);
  });
});
