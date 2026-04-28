/**
 * W67-COORDINATOR-LAO (2026-04-27) — coordinator-LAO annotation spec.
 *
 * Locks the row-to-project projection logic inside the drill-down
 * sample fetcher (`fetchProjectsForBookStatus`):
 *
 *   - PG / RPG with project.lao_id = some non-อบจ. id (e.g. '3001001')
 *     → coordinatorLaoName = that lao's name (verbatim from JOIN)
 *   - PG / RPG with project.lao_id = '3001027' (อบจ.นม itself)
 *     → coordinatorLaoName = null (no coordination annotation)
 *   - PG / RPG with project.lao_id = NULL (no FK)
 *     → coordinatorLaoName = null
 *   - SPG (no LAO FK column) → coordinatorLaoName = null
 *   - LEFT JOIN preserves the project row even when the LAO row is
 *     missing / soft-deleted (proj_lao_name = null) → coordinatorLaoName
 *     = null
 *
 * The spec drives the aggregator through its public surface
 * `groupedExecutiveStatusBreakdown` with a fake DataSource that
 * intercepts the per-bucket QueryBuilder chain and returns canned raw
 * rows. This exercises the real projection code (no monkey-patching of
 * private methods).
 *
 * §14.2 head-of-lineage anti-join is preserved (the fake QB is a
 * pass-through; the production code path stays untouched).
 * §17.2 advisory only — no workflow gating.
 * §17.9 — pure projection assertion; zero raw SQL string assertions.
 *
 * CLAUDE.md references:
 *   - §1 / §5 — origin classification (อบจ.นม PAO_LAO_ID = '3001027')
 *   - §11 Versioning — three project shapes, one drill projection
 *   - §17.2 advisory only
 */
import type { DataSource } from 'typeorm';
import { UnifiedProjectAggregator } from '../unified-project-aggregator.service';
import type {
  GroupedExecutiveStatusBreakdownBook,
  GroupedExecutiveStatusBreakdownStatusGroup,
} from '../../interfaces/unified-project-aggregator.interface';

const PAO_LAO_ID = '3001027';

type RawRow = {
  id: string;
  title: string | null;
  pagenumber: number | null;
  proj_lao_id?: string | null;
  proj_lao_name?: string | null;
};

/**
 * Build a chainable fake QueryBuilder that captures `select` /
 * `addSelect` / `where` / `andWhere` / `leftJoin` / `innerJoin` /
 * `orderBy` / `groupBy` / `addGroupBy` / `limit` calls and returns
 * `cannedRows` from `getRawMany`.
 */
function makeFakeQb(cannedRows: RawRow[]) {
  const qb: Record<string, unknown> = {};
  const passThrough = () => qb;
  qb.select = passThrough;
  qb.addSelect = passThrough;
  qb.where = passThrough;
  qb.andWhere = passThrough;
  qb.leftJoin = passThrough;
  qb.innerJoin = passThrough;
  qb.orderBy = passThrough;
  qb.groupBy = passThrough;
  qb.addGroupBy = passThrough;
  qb.limit = passThrough;
  qb.getRawMany = jest.fn().mockResolvedValue(cannedRows);
  qb.getRawOne = jest.fn().mockResolvedValue(undefined);
  return qb;
}

/**
 * Build a fake DataSource whose `getRepository(...).createQueryBuilder`
 * returns a per-call fake QB. The two-phase drill flow first runs the
 * COUNT-by-book-and-status helpers, then the per-bucket sample fetch
 * helpers. We supply different rows per call via the provider closure.
 */
function makeFakeDataSource(opts: {
  countRows: Record<'main' | 'revised' | 'supplement', RawRow[]>;
  sampleRows: Record<'main' | 'revised' | 'supplement', RawRow[]>;
}): DataSource {
  // Track per-alias call counts so each createQueryBuilder invocation
  // gets the right canned response.
  const callIndex = { main: 0, revised: 0, supplement: 0 };

  const repo = (alias: 'pg' | 'rpg' | 'spg') => {
    const kind: 'main' | 'revised' | 'supplement' =
      alias === 'pg' ? 'main' : alias === 'rpg' ? 'revised' : 'supplement';
    return {
      createQueryBuilder: () => {
        const idx = callIndex[kind]++;
        // Call sequence per kind (per drill invocation):
        //   idx 0 → COUNT-by-book-and-status (count rows)
        //   idx 1 → per-bucket sample fetch (sample rows)
        //   idx ≥ 2 → loadDrillCreatedAt / FK-chain probe (empty)
        const rows =
          idx === 0
            ? opts.countRows[kind]
            : idx === 1
              ? opts.sampleRows[kind]
              : [];
        return makeFakeQb(rows);
      },
    };
  };

  return {
    getRepository: (entity: { name?: string }) => {
      const name = (entity?.name ?? '').toLowerCase();
      if (name.includes('supplement')) return repo('spg');
      if (name.includes('revised')) return repo('rpg');
      return repo('pg');
    },
  } as unknown as DataSource;
}

/**
 * The drill helper runs (a) per-kind COUNT GROUP BY queries to learn
 * bucket sizes, then (b) per-bucket sample fetches. The COUNT row shape
 * differs per kind. Provide minimal realistic rows so the helper opens
 * exactly one main book and runs exactly one sample fetch.
 */
function mainCountRow(planId: string, planName: string, status: string, cnt: number): RawRow {
  // Cast through unknown — the fake QB is duck-typed; the COUNT row
  // shape differs from the per-bucket SELECT shape that drives
  // RawRow's strict columns. Spread comes first; explicit
  // RawRow defaults follow only for fields not in the COUNT shape.
  return {
    ...({ planid: planId, planname: planName, statusname: status, cnt: String(cnt) } as unknown as RawRow),
    id: '',
  };
}

function revisedCountRow(
  planId: string,
  planName: string,
  dprId: string,
  status: string,
  cnt: number,
): RawRow {
  return {
    ...({
      planid: planId,
      planname: planName,
      dprid: dprId,
      revisionnumber: 1,
      dprdescription: null,
      revisiontypename: 'edit',
      statusname: status,
      cnt: String(cnt),
    } as unknown as RawRow),
    id: '',
  };
}

describe('W67-COORDINATOR-LAO / drill projection', () => {
  describe('PG (main book) coordinatorLaoName projection', () => {
    it('non-อบจ. lao id ("3001001") → coordinatorLaoName = lao name (verbatim)', async () => {
      const ds = makeFakeDataSource({
        countRows: {
          main: [mainCountRow('plan-1', 'แผน A', 'Pending', 1)],
          revised: [],
          supplement: [],
        },
        sampleRows: {
          main: [
            {
              id: 'pg-1',
              title: 'โครงการ A',
              pagenumber: 42,
              proj_lao_id: '3001001',
              proj_lao_name: 'เทศบาลตำบลโคกกรวด',
            },
          ],
          revised: [],
          supplement: [],
        },
      });
      const svc = new UnifiedProjectAggregator(ds);
      const env = await svc.groupedExecutiveStatusBreakdown({ scope: ['main'] });

      const projects = env.books[0].statuses[0].projects;
      expect(projects).toHaveLength(1);
      expect(projects[0].coordinatorLaoName).toBe('เทศบาลตำบลโคกกรวด');
      expect(projects[0].projectKind).toBe('main');
    });

    it('lao id = อบจ.นม ("3001027") → coordinatorLaoName = null', async () => {
      const ds = makeFakeDataSource({
        countRows: {
          main: [mainCountRow('plan-1', 'แผน A', 'Approved', 1)],
          revised: [],
          supplement: [],
        },
        sampleRows: {
          main: [
            {
              id: 'pg-2',
              title: 'โครงการ B',
              pagenumber: 5,
              proj_lao_id: PAO_LAO_ID,
              proj_lao_name: 'องค์การบริหารส่วนจังหวัดนครราชสีมา',
            },
          ],
          revised: [],
          supplement: [],
        },
      });
      const svc = new UnifiedProjectAggregator(ds);
      const env = await svc.groupedExecutiveStatusBreakdown({ scope: ['main'] });

      const project = env.books[0].statuses[0].projects[0];
      expect(project.coordinatorLaoName).toBeNull();
    });

    it('lao id = NULL (no FK) → coordinatorLaoName = null', async () => {
      const ds = makeFakeDataSource({
        countRows: {
          main: [mainCountRow('plan-1', 'แผน A', 'Pending', 1)],
          revised: [],
          supplement: [],
        },
        sampleRows: {
          main: [
            {
              id: 'pg-3',
              title: 'โครงการ C',
              pagenumber: null,
              proj_lao_id: null,
              proj_lao_name: null,
            },
          ],
          revised: [],
          supplement: [],
        },
      });
      const svc = new UnifiedProjectAggregator(ds);
      const env = await svc.groupedExecutiveStatusBreakdown({ scope: ['main'] });

      const project = env.books[0].statuses[0].projects[0];
      expect(project.coordinatorLaoName).toBeNull();
    });

    it('LEFT JOIN: project FK present but LAO row missing/soft-deleted → coordinatorLaoName = null', async () => {
      // Simulates the soft-deleted-LAO race: project.lao_id is non-null
      // but the LAO row JOIN failed → proj_lao_id and proj_lao_name come
      // back null. The projection must not invent a name and must not
      // throw.
      const ds = makeFakeDataSource({
        countRows: {
          main: [mainCountRow('plan-1', 'แผน A', 'Pending', 1)],
          revised: [],
          supplement: [],
        },
        sampleRows: {
          main: [
            {
              id: 'pg-4',
              title: 'โครงการ D',
              pagenumber: 7,
              proj_lao_id: null,
              proj_lao_name: null,
            },
          ],
          revised: [],
          supplement: [],
        },
      });
      const svc = new UnifiedProjectAggregator(ds);
      const env = await svc.groupedExecutiveStatusBreakdown({ scope: ['main'] });

      const project = env.books[0].statuses[0].projects[0];
      expect(project.coordinatorLaoName).toBeNull();
    });
  });

  describe('RPG (revised book) coordinatorLaoName projection', () => {
    it('non-อบจ. lao id ("3001001") → coordinatorLaoName = lao name', async () => {
      const ds = makeFakeDataSource({
        countRows: {
          main: [],
          revised: [
            revisedCountRow('plan-1', 'แผน A', 'dpr-1', 'Pending', 1),
          ],
          supplement: [],
        },
        sampleRows: {
          main: [],
          revised: [
            {
              id: 'rpg-1',
              title: 'โครงการ R',
              pagenumber: 9,
              proj_lao_id: '3001001',
              proj_lao_name: 'เทศบาลตำบลโคกกรวด',
            },
          ],
          supplement: [],
        },
      });
      const svc = new UnifiedProjectAggregator(ds);
      const env = await svc.groupedExecutiveStatusBreakdown({
        scope: ['revised'],
      });

      const projects = env.books[0].statuses[0].projects;
      expect(projects).toHaveLength(1);
      expect(projects[0].projectKind).toBe('revised');
      expect(projects[0].coordinatorLaoName).toBe('เทศบาลตำบลโคกกรวด');
    });
  });

  describe('SPG (supplement book) coordinatorLaoName projection', () => {
    it('SPG always emits coordinatorLaoName = null (entity has no LAO FK column)', async () => {
      const ds = makeFakeDataSource({
        countRows: {
          main: [],
          revised: [],
          supplement: [
            {
              ...({
                planid: 'plan-1',
                planname: 'แผน A',
                dpsid: 'dps-1',
                supplementnumber: 1,
                dpsdescription: null,
                statusname: 'Pending',
                cnt: '1',
              } as unknown as RawRow),
              id: '',
            },
          ],
        },
        sampleRows: {
          main: [],
          revised: [],
          supplement: [
            {
              id: 'spg-1',
              title: 'โครงการเพิ่มเติม',
              pagenumber: 3,
              // SPG raw rows do NOT carry proj_lao_id / proj_lao_name —
              // the projection must coerce missing fields to null.
            },
          ],
        },
      });
      const svc = new UnifiedProjectAggregator(ds);
      const env = await svc.groupedExecutiveStatusBreakdown({
        scope: ['supplement'],
      });

      // Locate the supplement book and assert null coordinatorLaoName.
      const supplementBook = env.books.find(
        (b: GroupedExecutiveStatusBreakdownBook) => b.bookKind === 'supplement',
      );
      expect(supplementBook).toBeDefined();
      const status = supplementBook!.statuses.find(
        (s: GroupedExecutiveStatusBreakdownStatusGroup) =>
          s.projects.length > 0,
      );
      expect(status).toBeDefined();
      expect(status!.projects[0].coordinatorLaoName).toBeNull();
      expect(status!.projects[0].projectKind).toBe('supplement');
    });
  });
});
