/**
 * Wave 103 PR1 — unit tests for AgencyProjectsCanonicalAggregatorService.
 *
 * These tests mock the TypeORM `DataSource` chain and verify the
 * aggregator's policy logic (status defaults, planId scoping, lineage
 * folding, byBook merging, empty-input handling) WITHOUT a live DB.
 *
 * The QueryBuilder mock returns canned `getRawMany` rows keyed by the
 * primary alias seen in `.createQueryBuilder('alias')`. Each test
 * arranges the canned rows for `pg`, `rpg`, `spg` and asserts the
 * envelope shape.
 *
 * §17.2 advisory only — these tests verify counts, not workflow gates.
 * §17.3 — no `tracking_status` mutations are exercised.
 */
import { AgencyProjectsCanonicalAggregatorService } from './agency-projects-canonical-aggregator.service';

type RawRow = {
  bookid: string;
  bookname: string;
  islatest: boolean;
  cnt: number | string;
  budgetsum: number | string;
};

/**
 * Build a minimal QueryBuilder mock that returns canned raw rows. Every
 * chainable method is a no-op returning `this`; `getRawMany` resolves
 * with the provided rows.
 */
function makeQbMock(rows: RawRow[]): Record<string, unknown> {
  const qb: Record<string, unknown> = {};
  const passthrough = (): Record<string, unknown> => qb;
  for (const m of [
    'innerJoin',
    'leftJoin',
    'select',
    'addSelect',
    'where',
    'andWhere',
    'orWhere',
    'groupBy',
    'addGroupBy',
    'orderBy',
    'addOrderBy',
    'limit',
    'offset',
    'setParameters',
  ]) {
    qb[m] = passthrough;
  }
  qb.getRawMany = (): Promise<RawRow[]> => Promise.resolve(rows);
  qb.getRawOne = (): Promise<RawRow | undefined> => Promise.resolve(rows[0]);
  return qb;
}

/**
 * Build a DataSource mock whose `getRepository(Entity).createQueryBuilder(alias)`
 * dispatches to canned rows by `alias`. The aggregator uses aliases
 * 'pg' (main), 'rpg' (revised), 'spg' (supplement).
 */
function makeDataSourceMock(canned: {
  pg?: RawRow[];
  rpg?: RawRow[];
  spg?: RawRow[];
}): unknown {
  return {
    getRepository: () => ({
      createQueryBuilder: (alias: string) => {
        if (alias === 'pg') return makeQbMock(canned.pg ?? []);
        if (alias === 'rpg') return makeQbMock(canned.rpg ?? []);
        if (alias === 'spg') return makeQbMock(canned.spg ?? []);
        return makeQbMock([]);
      },
    }),
  };
}

function makeService(canned: {
  pg?: RawRow[];
  rpg?: RawRow[];
  spg?: RawRow[];
}): AgencyProjectsCanonicalAggregatorService {
  // The constructor uses `@InjectDataSource()` — when called outside
  // Nest DI we just feed the mock directly via the private property.
  const ds = makeDataSourceMock(canned);
  const svc = new AgencyProjectsCanonicalAggregatorService(ds as never);
  return svc;
}

describe('AgencyProjectsCanonicalAggregatorService', () => {
  describe('aggregate()', () => {
    it('returns all-zero envelope for empty agencyIds', async () => {
      const svc = makeService({});
      const out = await svc.aggregate({ agencyIds: [] });
      expect(out.count).toBe(0);
      expect(out.budgetTotal).toBe(0);
      expect(out.byBook).toEqual([]);
      expect(out.byLineage).toEqual({ pg: 0, rpg: 0, spg: 0 });
      expect(out.rawRowCount).toEqual({ pg: 0, rpg: 0, spg: 0 });
      expect(out.scopeApplied.bookScope).toBe('all-books');
      expect(out.scopeApplied.headFilterActive).toBe(true);
    });

    it('sums HEAD-only counts across PG/RPG/SPG (single book)', async () => {
      const svc = makeService({
        pg: [
          {
            bookid: 'plan-A',
            bookname: 'แผนพัฒนา 2566-2570',
            islatest: true,
            cnt: 3,
            budgetsum: 100,
          },
        ],
        rpg: [
          {
            bookid: 'plan-A',
            bookname: 'แผนพัฒนา 2566-2570',
            islatest: true,
            cnt: 1,
            budgetsum: 50,
          },
        ],
        spg: [
          {
            bookid: 'plan-A',
            bookname: 'แผนพัฒนา 2566-2570',
            islatest: true,
            cnt: 1,
            budgetsum: 25,
          },
        ],
      });
      const out = await svc.aggregate({ agencyIds: [42] });
      expect(out.count).toBe(5);
      expect(out.budgetTotal).toBe(175);
      expect(out.byBook).toHaveLength(1);
      expect(out.byBook[0]).toMatchObject({
        bookId: 'plan-A',
        count: 5,
        budget: 175,
        isLatest: true,
      });
      expect(out.byLineage).toEqual({ pg: 3, rpg: 1, spg: 1 });
    });

    it('merges per-book counts across all books when planId omitted', async () => {
      const svc = makeService({
        pg: [
          {
            bookid: 'plan-LATEST',
            bookname: 'แผน 2571-2575',
            islatest: true,
            cnt: 2,
            budgetsum: 4_700_000,
          },
          {
            bookid: 'plan-OLDER',
            bookname: 'แผน 2566-2570',
            islatest: false,
            cnt: 5,
            budgetsum: 10_170_300,
          },
        ],
      });
      const out = await svc.aggregate({ agencyIds: [42] });
      expect(out.count).toBe(7);
      expect(out.budgetTotal).toBe(14_870_300);
      expect(out.byBook).toHaveLength(2);
      // latest book sorted first
      expect(out.byBook[0].isLatest).toBe(true);
      expect(out.byBook[1].isLatest).toBe(false);
    });

    it('records scopeApplied.bookScope=single-plan when planId provided', async () => {
      const svc = makeService({});
      const out = await svc.aggregate({
        agencyIds: [42],
        planId: 'plan-XYZ',
      });
      expect(out.scopeApplied.bookScope).toBe('single-plan:plan-XYZ');
    });

    it('uses default §15-aware status sets', async () => {
      const svc = makeService({});
      const out = await svc.aggregate({ agencyIds: [42] });
      expect(out.scopeApplied.statusesActive).toEqual([
        'Approved',
        'Pending',
        'Verified',
        'Pending_Approval',
      ]);
      expect(out.scopeApplied.statusesFrozen).toEqual(['Approved']);
    });

    it('honors includeStatuses override (uniform set across books)', async () => {
      const svc = makeService({});
      const out = await svc.aggregate({
        agencyIds: [42],
        scope: { includeStatuses: new Set(['Approved']) },
      });
      expect(out.scopeApplied.statusesActive).toEqual(['Approved']);
      expect(out.scopeApplied.statusesFrozen).toEqual(['Approved']);
    });

    it('coerces null/string raw values to finite numbers', async () => {
      const svc = makeService({
        pg: [
          {
            bookid: 'plan-A',
            bookname: 'X',
            islatest: 'true' as unknown as boolean,
            cnt: '7',
            budgetsum: '999.5',
          },
        ],
      });
      const out = await svc.aggregate({ agencyIds: [42] });
      expect(out.count).toBe(7);
      expect(out.budgetTotal).toBe(999.5);
      expect(out.byBook[0].isLatest).toBe(true);
    });

    it('emits scopeApplied.headFilterActive=true regardless of inputs', async () => {
      const svc = makeService({});
      const out = await svc.aggregate({
        agencyIds: [42],
        planId: 'plan-XYZ',
        scope: { includeBookFrozen: false },
      });
      expect(out.scopeApplied.headFilterActive).toBe(true);
    });
  });

  describe('computeWithLegacyComparison()', () => {
    it('logs a side-by-side warn line and returns canonical envelope', async () => {
      const svc = makeService({
        pg: [
          {
            bookid: 'plan-A',
            bookname: 'X',
            islatest: true,
            cnt: 5,
            budgetsum: 10_170_300,
          },
        ],
      });
      // Capture the Logger output via a spy on the prototype.
      const warnSpy = jest
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        .spyOn((svc as any).logger, 'warn')
        .mockImplementation(() => undefined);

      const env = await svc.computeWithLegacyComparison(
        { agencyIds: [42] },
        {
          dashboard: { count: 5, budget: 10_170_300 },
          crossPlan: { count: 8, budget: 14_870_300 },
        },
      );
      expect(env.count).toBe(5);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const arg = warnSpy.mock.calls[0][0] as string;
      expect(arg).toContain('canonical=5');
      expect(arg).toContain('legacy_dashboard=5');
      expect(arg).toContain('legacy_crossplan=8');
      warnSpy.mockRestore();
    });

    it('handles missing legacy values with n/a placeholder', async () => {
      const svc = makeService({});
      const warnSpy = jest
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        .spyOn((svc as any).logger, 'warn')
        .mockImplementation(() => undefined);
      await svc.computeWithLegacyComparison({ agencyIds: [42] }, {});
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const arg = warnSpy.mock.calls[0][0] as string;
      expect(arg).toContain('legacy_dashboard=n/a');
      expect(arg).toContain('legacy_crossplan=n/a');
      warnSpy.mockRestore();
    });
  });
});
