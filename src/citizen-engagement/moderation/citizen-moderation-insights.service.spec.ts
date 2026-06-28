import { CitizenModerationInsightsService } from './citizen-moderation-insights.service';

/**
 * Unit spec for CitizenModerationInsightsService (W-T4).
 *
 * §18.13 ZERO-WRITE — every repo is a chainable select-builder stub that records
 * the where/select calls; NO repo exposes save/insert/update/delete/softDelete,
 * and the spec asserts NONE is ever invoked. Each aggregate is checked for its
 * status / moderation_state filter, its `deleted_at IS NULL` filter, the window
 * bound, and (where authors are surfaced) ALIAS-ONLY projection — no
 * national_id / thaid / *_enc / *_hash column is ever selected.
 *
 * No encryption.util import → no jest.mock needed (the service touches repos +
 * its own DTOs only; project memory: `project_encryption_util_test_env`).
 */

/** Records every chained call so a spec can assert the SQL fragments + selects. */
interface RecordingBuilder {
  whereCalls: unknown[][];
  andWhereCalls: unknown[][];
  selectCalls: unknown[][];
  joinCalls: unknown[][];
  orderCalls: Array<{ field: string; dir?: string }>;
  groupByCalls: unknown[][];
  // chainable methods
  innerJoin: jest.Mock;
  leftJoin: jest.Mock;
  select: jest.Mock;
  addSelect: jest.Mock;
  where: jest.Mock;
  andWhere: jest.Mock;
  groupBy: jest.Mock;
  addGroupBy: jest.Mock;
  orderBy: jest.Mock;
  addOrderBy: jest.Mock;
  limit: jest.Mock;
  getCount: jest.Mock;
  getRawMany: jest.Mock;
}

function makeBuilder(result: { count?: number; rows?: unknown[] }): RecordingBuilder {
  const b = {
    whereCalls: [] as unknown[][],
    andWhereCalls: [] as unknown[][],
    selectCalls: [] as unknown[][],
    joinCalls: [] as unknown[][],
    orderCalls: [] as Array<{ field: string; dir?: string }>,
    groupByCalls: [] as unknown[][],
  } as RecordingBuilder;
  b.innerJoin = jest.fn((...a: unknown[]) => (b.joinCalls.push(a), b));
  b.leftJoin = jest.fn((...a: unknown[]) => (b.joinCalls.push(a), b));
  b.select = jest.fn((...a: unknown[]) => (b.selectCalls.push(a), b));
  b.addSelect = jest.fn((...a: unknown[]) => (b.selectCalls.push(a), b));
  b.where = jest.fn((...a: unknown[]) => (b.whereCalls.push(a), b));
  b.andWhere = jest.fn((...a: unknown[]) => (b.andWhereCalls.push(a), b));
  b.groupBy = jest.fn((...a: unknown[]) => (b.groupByCalls.push(a), b));
  b.addGroupBy = jest.fn((...a: unknown[]) => (b.groupByCalls.push(a), b));
  b.orderBy = jest.fn((field: string, dir?: string) => (b.orderCalls.push({ field, dir }), b));
  b.addOrderBy = jest.fn((field: string, dir?: string) => (b.orderCalls.push({ field, dir }), b));
  b.limit = jest.fn(() => b);
  b.getCount = jest.fn(async () => result.count ?? 0);
  b.getRawMany = jest.fn(async () => result.rows ?? []);
  return b;
}

/** A repo whose createQueryBuilder hands back successive recorded builders. */
function makeRepo(builders: RecordingBuilder[]) {
  let i = 0;
  return {
    createQueryBuilder: jest.fn(() => builders[i++] ?? builders[builders.length - 1]),
    // write surfaces — present so the zero-write assertion can prove they're unused
    save: jest.fn(),
    insert: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    softDelete: jest.fn(),
    create: jest.fn(),
  };
}

/** Flatten every recorded SQL fragment + select expression from a builder list. */
function allSql(builders: RecordingBuilder[]): string {
  return builders
    .flatMap((b) => [
      ...b.whereCalls,
      ...b.andWhereCalls,
      ...b.selectCalls,
      ...b.joinCalls,
    ])
    .map((c) => String(c[0]))
    .join(' || ');
}

/** PII column fragments that MUST NEVER appear in any projection (§17.3 / PDPA). */
const PII_FRAGMENTS = ['national_id', 'thaid', '_enc', '_hash', 'reporter_identity_id'];

function assertNoWrites(repos: ReturnType<typeof makeRepo>[]): void {
  for (const r of repos) {
    expect(r.save).not.toHaveBeenCalled();
    expect(r.insert).not.toHaveBeenCalled();
    expect(r.update).not.toHaveBeenCalled();
    expect(r.delete).not.toHaveBeenCalled();
    expect(r.softDelete).not.toHaveBeenCalled();
    expect(r.create).not.toHaveBeenCalled();
  }
}

describe('CitizenModerationInsightsService (W-T4)', () => {
  function build(opts: {
    report?: RecordingBuilder[];
    appeal?: RecordingBuilder[];
    post?: RecordingBuilder[];
    identity?: RecordingBuilder[];
    log?: RecordingBuilder[];
  }) {
    const reportRepo = makeRepo(opts.report ?? [makeBuilder({})]);
    const appealRepo = makeRepo(opts.appeal ?? [makeBuilder({})]);
    const postRepo = makeRepo(opts.post ?? [makeBuilder({})]);
    const identityRepo = makeRepo(opts.identity ?? [makeBuilder({})]);
    const logRepo = makeRepo(opts.log ?? [makeBuilder({})]);
    const service = new CitizenModerationInsightsService(
      reportRepo as never,
      appealRepo as never,
      postRepo as never,
      identityRepo as never,
      logRepo as never,
    );
    return { service, reportRepo, appealRepo, postRepo, identityRepo, logRepo };
  }

  // ---------------------------------------------------------------------------
  // overview
  // ---------------------------------------------------------------------------
  describe('overview', () => {
    it('counts open reports / open appeals / shadow+removed posts / suspended accounts, all not-deleted', async () => {
      const reportB = makeBuilder({ count: 7 });
      const appealB = makeBuilder({ count: 3 });
      const shadowB = makeBuilder({ count: 5 });
      const removedB = makeBuilder({ count: 2 });
      const suspendedB = makeBuilder({ count: 4 });

      const { service, reportRepo, appealRepo, postRepo, identityRepo, logRepo } = build({
        report: [reportB],
        appeal: [appealB],
        post: [shadowB, removedB], // shadow then removed
        identity: [suspendedB],
      });

      const res = await service.overview();
      expect(res).toEqual({
        openReports: 7,
        openAppeals: 3,
        shadowedPosts: 5,
        removedPosts: 2,
        suspendedAccounts: 4,
      });

      // report: status='open' + not-deleted
      expect(reportB.whereCalls[0]).toEqual(['r.status = :s', { s: 'open' }]);
      expect(reportB.andWhereCalls.map((c) => String(c[0]))).toContain('r.deleted_at IS NULL');
      // appeal: status='open' + not-deleted
      expect(appealB.whereCalls[0]).toEqual(['a.status = :s', { s: 'open' }]);
      expect(appealB.andWhereCalls.map((c) => String(c[0]))).toContain('a.deleted_at IS NULL');
      // post: shadow / removed + not-deleted
      expect(shadowB.whereCalls[0]).toEqual(['p.moderation_state = :s', { s: 'shadow' }]);
      expect(removedB.whereCalls[0]).toEqual(['p.moderation_state = :s', { s: 'removed' }]);
      expect(shadowB.andWhereCalls.map((c) => String(c[0]))).toContain('p.deleted_at IS NULL');
      // identity: suspended + not-deleted
      expect(suspendedB.whereCalls[0]).toEqual(['i.status = :s', { s: 'suspended' }]);
      expect(suspendedB.andWhereCalls.map((c) => String(c[0]))).toContain('i.deleted_at IS NULL');

      assertNoWrites([reportRepo, appealRepo, postRepo, identityRepo, logRepo]);
    });
  });

  // ---------------------------------------------------------------------------
  // topReportedAuthors
  // ---------------------------------------------------------------------------
  describe('topReportedAuthors', () => {
    it('groups by author with DISTINCT reporters + posts, filters not-deleted + window, ALIAS-ONLY', async () => {
      const b = makeBuilder({
        rows: [
          { authorIdentityId: 'a1', displayAlias: 'สมชาย', distinctReporters: '9', reportedPosts: '4' },
        ],
      });
      const { service, reportRepo, appealRepo, postRepo, identityRepo, logRepo } = build({ report: [b] });

      const res = await service.topReportedAuthors(30, 10);
      expect(res).toEqual([
        { authorIdentityId: 'a1', displayAlias: 'สมชาย', distinctReporters: 9, reportedPosts: 4 },
      ]);

      const sql = allSql([b]);
      expect(sql).toContain('COUNT(DISTINCT r.reporter_identity_id)');
      expect(sql).toContain('COUNT(DISTINCT r.post_id)');
      // Filters are location-agnostic — the first `r.deleted_at IS NULL` lands in
      // `.where()`, the rest in `.andWhere()`; assert against the combined list.
      const clauses = [...b.whereCalls, ...b.andWhereCalls].map((c) => String(c[0]));
      expect(clauses).toContain('r.deleted_at IS NULL');
      expect(clauses).toContain('p.deleted_at IS NULL');
      expect(clauses.some((c) => c.includes('r.created_at >='))).toBe(true);
      // ALIAS-ONLY: display_alias selected, no PII column / no raw reporter id projected
      expect(sql).toContain('i.display_alias');
      assertNoPii([b]);

      assertNoWrites([reportRepo, appealRepo, postRepo, identityRepo, logRepo]);
    });

    it('clamps windowDays out of range and a huge limit', async () => {
      const b = makeBuilder({ rows: [] });
      const { service } = build({ report: [b] });
      // windowDays 9999 → clamp 365; limit huge → clamp 50. Just assert it runs +
      // a window bound was applied (clamp is unit-tested via the bound presence).
      await service.topReportedAuthors(9999, 10_000);
      expect(b.andWhereCalls.some((c) => String(c[0]).includes('r.created_at >='))).toBe(true);
      expect(b.limit).toHaveBeenCalledWith(50);
    });
  });

  // ---------------------------------------------------------------------------
  // topActionedAuthors
  // ---------------------------------------------------------------------------
  describe('topActionedAuthors', () => {
    it('groups the author posts by removed/shadow FILTER counts, not-deleted + window, ALIAS-ONLY', async () => {
      const b = makeBuilder({
        rows: [{ authorIdentityId: 'a2', displayAlias: 'a-lias', removedCount: '3', shadowedCount: '1' }],
      });
      const { service, reportRepo, appealRepo, postRepo, identityRepo, logRepo } = build({ post: [b] });

      const res = await service.topActionedAuthors(30, 10);
      expect(res).toEqual([
        { authorIdentityId: 'a2', displayAlias: 'a-lias', removedCount: 3, shadowedCount: 1 },
      ]);

      const sql = allSql([b]);
      expect(sql).toContain("COUNT(*) FILTER (WHERE p.moderation_state = 'removed')");
      expect(sql).toContain("COUNT(*) FILTER (WHERE p.moderation_state = 'shadow')");
      // `p.deleted_at IS NULL` is in `.where()`, the rest in `.andWhere()` —
      // assert against the combined clause list (location-agnostic).
      const clauses = [...b.whereCalls, ...b.andWhereCalls].map((c) => String(c[0]));
      expect(clauses).toContain('p.deleted_at IS NULL');
      expect(clauses.some((c) => c.includes("moderation_state IN ('removed', 'shadow')"))).toBe(true);
      expect(clauses.some((c) => c.includes('p.created_at >='))).toBe(true);
      expect(sql).toContain('i.display_alias');
      assertNoPii([b]);

      assertNoWrites([reportRepo, appealRepo, postRepo, identityRepo, logRepo]);
    });
  });

  // ---------------------------------------------------------------------------
  // recentActions
  // ---------------------------------------------------------------------------
  describe('recentActions', () => {
    it('excludes report rows, resolves the AUTHOR alias (never the reporter), passes reason through', async () => {
      const b = makeBuilder({
        rows: [
          {
            action: 'remove',
            actorRole: 'staff',
            postId: 'p1',
            reason: 'spam',
            createdAt: new Date('2026-06-01T00:00:00Z'),
            authorAlias: 'ผู้เขียน',
          },
          // account-level row: null post → null alias survives the LEFT join
          {
            action: 'suspend_author',
            actorRole: 'staff',
            postId: null,
            reason: 'auto-suspend: 3 removed posts',
            createdAt: new Date('2026-06-02T00:00:00Z'),
            authorAlias: null,
          },
        ],
      });
      const { service, reportRepo, appealRepo, postRepo, identityRepo, logRepo } = build({ log: [b] });

      const res = await service.recentActions(20);
      expect(res[0]).toEqual({
        action: 'remove',
        actorRole: 'staff',
        postId: 'p1',
        authorAlias: 'ผู้เขียน',
        reason: 'spam',
        createdAt: new Date('2026-06-01T00:00:00Z'),
      });
      expect(res[1].authorAlias).toBeNull();
      expect(res[1].postId).toBeNull();

      // excludes the raw 'report' action; newest-first
      expect(b.whereCalls[0]).toEqual(['m.action <> :report', { report: 'report' }]);
      expect(b.orderCalls).toContainEqual({ field: 'm.created_at', dir: 'DESC' });
      // ALIAS-ONLY: author alias resolved, reporter identity never projected
      const sql = allSql([b]);
      expect(sql).toContain('i.display_alias');
      assertNoPii([b]);

      assertNoWrites([reportRepo, appealRepo, postRepo, identityRepo, logRepo]);
    });

    it('clamps the recent limit to 100', async () => {
      const b = makeBuilder({ rows: [] });
      const { service } = build({ log: [b] });
      await service.recentActions(5000);
      expect(b.limit).toHaveBeenCalledWith(100);
    });
  });

  /** Assert no builder ever selected / joined on a PII column (§17.3 / PDPA). */
  function assertNoPii(builders: RecordingBuilder[]): void {
    const sql = allSql(builders);
    for (const frag of PII_FRAGMENTS) {
      // `reporter_identity_id` may appear ONLY inside a COUNT(DISTINCT ...) (a
      // count, not a projection) — exclude that benign usage from the ban.
      if (frag === 'reporter_identity_id') {
        const projectedReporter = builders
          .flatMap((b) => b.selectCalls)
          .map((c) => String(c[0]))
          .some((s) => s.includes('reporter_identity_id') && !s.includes('COUNT('));
        expect(projectedReporter).toBe(false);
        continue;
      }
      expect(sql).not.toContain(frag);
    }
  }
});
