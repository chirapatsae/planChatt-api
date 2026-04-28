/**
 * BE-W54-03 — BudgetAggregator unit spec.
 *
 * Covers:
 *   1. Empty input → empty Map, no DB call.
 *   2. Single FK column (main only / revised only / supplement only).
 *   3. All three FK columns mixed.
 *   4. Chunking boundary — 5001 ids → 2 chunk calls.
 *   5. Zero-quantity rows (SUM = 0) still present in Map.
 *   6. Missing FK rows (project has no budget) absent from Map.
 *   7. DB error propagates upstream (no swallowing).
 *   8. No raw table literals in the service source.
 *
 * CLAUDE.md §17.2 / §17.11 — read-only; no workflow gating; role check
 * lives at Tier C.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import { BudgetAggregatorService, BUDGET_AGGREGATOR_IN_CHUNK_SIZE } from '../services/budget-aggregator.service';
import type { ProjectKey, UnifiedProject } from '../types';

// ────────────────────────────────────────────────────────────────
// Test harness — mock DataSource with a QB chain instrumented so we
// can inspect call counts, captured `ids` parameters, and the FK
// column string each call referenced.
// ────────────────────────────────────────────────────────────────

interface QbCall {
  fkColumn: string;
  ids: string[];
}

type SumRow = { id: string | null; sum: string | number | null };

function makeDataSource(opts: {
  // Rows returned per (fkColumn, ids) — `undefined` means default to
  // empty array. A function lets chunking tests return per-chunk rows.
  rows?: (call: QbCall) => SumRow[];
  throwOn?: (call: QbCall) => Error | null;
}) {
  const calls: QbCall[] = [];
  const rows = opts.rows ?? (() => []);
  const throwOn = opts.throwOn ?? (() => null);

  const qbFactory = () => {
    const state: Partial<QbCall> = { fkColumn: undefined, ids: undefined };
    const qb: Record<string, unknown> = {};
    const self = () => qb;
    Object.assign(qb, {
      select: (expr: string) => {
        // `b.<fk>` — capture the FK column.
        const m = /^b\.(\w+)$/.exec(expr);
        if (m) state.fkColumn = m[1];
        return qb;
      },
      addSelect: self,
      where: (_clause: string, params: { ids: string[] }) => {
        state.ids = params?.ids ?? [];
        return qb;
      },
      groupBy: self,
      getRawMany: async () => {
        const call: QbCall = {
          fkColumn: state.fkColumn ?? '<unknown>',
          ids: state.ids ?? [],
        };
        calls.push(call);
        const err = throwOn(call);
        if (err) throw err;
        return rows(call);
      },
    });
    return qb;
  };

  const dataSource = {
    getRepository: (_target: unknown) => ({
      createQueryBuilder: (_alias: string) => qbFactory(),
    }),
  };

  return { dataSource, calls };
}

function makeProject(
  projectKind: 'main' | 'revised' | 'supplement',
  projectId: string,
): UnifiedProject {
  return {
    projectKind,
    projectId,
    name: `proj-${projectId}`,
    planId: 'plan-1',
    planReportFormat: 'STRATEGY_BASED',
    // Wave 55 W55-BE-07 — required field; BudgetAggregator does not
    // branch on it so the fixture uses the safe default.
    originType: 'lao-coordinated',
  };
}

function svc(ds: unknown): BudgetAggregatorService {
  // Reach into the service constructor directly — the service accepts a
  // DataSource, so we pass our mock.
  return new BudgetAggregatorService(ds as never);
}

// ────────────────────────────────────────────────────────────────

describe('BE-W54-03 / BudgetAggregator', () => {
  // ── 1. Empty input ──────────────────────────────────────────
  describe('empty input', () => {
    it('returns empty Map without issuing any DB call', async () => {
      const { dataSource, calls } = makeDataSource({});
      const out = await svc(dataSource).totalsForUnifiedProjects([]);
      expect(out).toBeInstanceOf(Map);
      expect(out.size).toBe(0);
      expect(calls).toHaveLength(0);
    });

    it('filters out null/undefined entries before issuing calls', async () => {
      const { dataSource, calls } = makeDataSource({});
      const projects = [
        null as unknown as UnifiedProject,
        undefined as unknown as UnifiedProject,
        { projectKind: 'main', projectId: '' } as UnifiedProject,
      ];
      const out = await svc(dataSource).totalsForUnifiedProjects(projects);
      expect(out.size).toBe(0);
      // Three FK passes are attempted BUT each with empty ids — the
      // service short-circuits before calling getRawMany.
      expect(calls).toHaveLength(0);
    });
  });

  // ── 2. Single FK column paths ──────────────────────────────
  describe('single FK column', () => {
    it('main only → queries project_group_id, Map keyed main:<id>', async () => {
      const { dataSource, calls } = makeDataSource({
        rows: (c) =>
          c.fkColumn === 'project_group_id'
            ? [
                { id: 'p1', sum: '100' },
                { id: 'p2', sum: '250.5' },
              ]
            : [],
      });
      const out = await svc(dataSource).totalsForUnifiedProjects([
        makeProject('main', 'p1'),
        makeProject('main', 'p2'),
      ]);
      expect(out.get('main:p1' as ProjectKey)).toBe(100);
      expect(out.get('main:p2' as ProjectKey)).toBe(250.5);
      expect(out.size).toBe(2);
      // Only the main-FK path hit the DB.
      const hitCols = calls.map((c) => c.fkColumn);
      expect(hitCols).toEqual(['project_group_id']);
    });

    it('revised only → queries revised_project_group_id', async () => {
      const { dataSource, calls } = makeDataSource({
        rows: (c) =>
          c.fkColumn === 'revised_project_group_id'
            ? [{ id: 'r1', sum: 42 }]
            : [],
      });
      const out = await svc(dataSource).totalsForUnifiedProjects([
        makeProject('revised', 'r1'),
      ]);
      expect(out.get('revised:r1' as ProjectKey)).toBe(42);
      expect(calls.map((c) => c.fkColumn)).toEqual([
        'revised_project_group_id',
      ]);
    });

    it('supplement only → queries supplement_project_group_id', async () => {
      const { dataSource, calls } = makeDataSource({
        rows: (c) =>
          c.fkColumn === 'supplement_project_group_id'
            ? [{ id: 's1', sum: '7' }]
            : [],
      });
      const out = await svc(dataSource).totalsForUnifiedProjects([
        makeProject('supplement', 's1'),
      ]);
      expect(out.get('supplement:s1' as ProjectKey)).toBe(7);
      expect(calls.map((c) => c.fkColumn)).toEqual([
        'supplement_project_group_id',
      ]);
    });
  });

  // ── 3. All three FK columns mixed ───────────────────────────
  describe('all three FK columns mixed', () => {
    it('issues three parallel queries and merges into one Map', async () => {
      const { dataSource, calls } = makeDataSource({
        rows: (c) => {
          if (c.fkColumn === 'project_group_id')
            return [{ id: 'p1', sum: '100' }];
          if (c.fkColumn === 'revised_project_group_id')
            return [{ id: 'r1', sum: '200' }];
          if (c.fkColumn === 'supplement_project_group_id')
            return [{ id: 's1', sum: '300' }];
          return [];
        },
      });
      const out = await svc(dataSource).totalsForUnifiedProjects([
        makeProject('main', 'p1'),
        makeProject('revised', 'r1'),
        makeProject('supplement', 's1'),
      ]);
      expect(out.size).toBe(3);
      expect(out.get('main:p1' as ProjectKey)).toBe(100);
      expect(out.get('revised:r1' as ProjectKey)).toBe(200);
      expect(out.get('supplement:s1' as ProjectKey)).toBe(300);
      const cols = calls.map((c) => c.fkColumn).sort();
      expect(cols).toEqual(
        [
          'project_group_id',
          'revised_project_group_id',
          'supplement_project_group_id',
        ].sort(),
      );
    });

    it('keys from different kinds do NOT collide even on shared ids', async () => {
      // Edge case: a PG and an RPG could theoretically share a UUID
      // across tables. ProjectKey prefixes them with the kind.
      const SHARED = 'deadbeef-0000-4000-8000-000000000000';
      const { dataSource } = makeDataSource({
        rows: (c) => {
          if (c.fkColumn === 'project_group_id')
            return [{ id: SHARED, sum: '11' }];
          if (c.fkColumn === 'revised_project_group_id')
            return [{ id: SHARED, sum: '22' }];
          return [];
        },
      });
      const out = await svc(dataSource).totalsForUnifiedProjects([
        makeProject('main', SHARED),
        makeProject('revised', SHARED),
      ]);
      expect(out.get(`main:${SHARED}` as ProjectKey)).toBe(11);
      expect(out.get(`revised:${SHARED}` as ProjectKey)).toBe(22);
      expect(out.size).toBe(2);
    });
  });

  // ── 4. Chunking boundary ───────────────────────────────────
  describe('chunking boundary', () => {
    it('exports the canonical chunk size constant = 5000', () => {
      expect(BUDGET_AGGREGATOR_IN_CHUNK_SIZE).toBe(5000);
    });

    it('5001 main ids → two sequential chunk calls', async () => {
      const perCall: QbCall[] = [];
      const { dataSource, calls } = makeDataSource({
        rows: (c) => {
          perCall.push({ ...c });
          // Return SUM=1 for every id in the chunk so the Map is fully
          // populated and we can count entries.
          return c.ids.map<SumRow>((id) => ({ id, sum: 1 }));
        },
      });
      const projects: UnifiedProject[] = [];
      for (let i = 0; i < 5001; i++) {
        projects.push(makeProject('main', `id-${i}`));
      }
      const out = await svc(dataSource).totalsForUnifiedProjects(projects);
      expect(out.size).toBe(5001);
      // Exactly two chunk calls for the `project_group_id` FK.
      const mainCalls = calls.filter(
        (c) => c.fkColumn === 'project_group_id',
      );
      expect(mainCalls).toHaveLength(2);
      expect(mainCalls[0].ids).toHaveLength(5000);
      expect(mainCalls[1].ids).toHaveLength(1);
    });

    it('exact multiple of chunk size → no extra empty chunk', async () => {
      const { calls, dataSource } = makeDataSource({
        rows: () => [],
      });
      const projects: UnifiedProject[] = [];
      for (let i = 0; i < 10000; i++) {
        projects.push(makeProject('main', `id-${i}`));
      }
      await svc(dataSource).totalsForUnifiedProjects(projects);
      const mainCalls = calls.filter(
        (c) => c.fkColumn === 'project_group_id',
      );
      expect(mainCalls).toHaveLength(2);
      expect(mainCalls[0].ids).toHaveLength(5000);
      expect(mainCalls[1].ids).toHaveLength(5000);
    });
  });

  // ── 5. Zero-quantity / missing-key semantics ────────────────
  describe('zero-quantity + missing-key semantics', () => {
    it('explicit SUM=0 row is present in Map as 0', async () => {
      const { dataSource } = makeDataSource({
        rows: (c) =>
          c.fkColumn === 'project_group_id'
            ? [{ id: 'p1', sum: '0' }]
            : [],
      });
      const out = await svc(dataSource).totalsForUnifiedProjects([
        makeProject('main', 'p1'),
      ]);
      expect(out.has('main:p1' as ProjectKey)).toBe(true);
      expect(out.get('main:p1' as ProjectKey)).toBe(0);
    });

    it('project with no matching Budget row is ABSENT from Map (caller defaults to 0)', async () => {
      const { dataSource } = makeDataSource({
        rows: (c) =>
          c.fkColumn === 'project_group_id'
            ? [{ id: 'p1', sum: '50' }]
            : [],
      });
      const out = await svc(dataSource).totalsForUnifiedProjects([
        makeProject('main', 'p1'),
        makeProject('main', 'p2-no-budget'),
      ]);
      expect(out.get('main:p1' as ProjectKey)).toBe(50);
      expect(out.has('main:p2-no-budget' as ProjectKey)).toBe(false);
      expect(out.size).toBe(1);
    });

    it('null/non-finite sum coerces to 0', async () => {
      const { dataSource } = makeDataSource({
        rows: (c) =>
          c.fkColumn === 'project_group_id'
            ? [
                { id: 'a', sum: null },
                { id: 'b', sum: 'not-a-number' },
              ]
            : [],
      });
      const out = await svc(dataSource).totalsForUnifiedProjects([
        makeProject('main', 'a'),
        makeProject('main', 'b'),
      ]);
      expect(out.get('main:a' as ProjectKey)).toBe(0);
      expect(out.get('main:b' as ProjectKey)).toBe(0);
    });

    it('rows with null id (malformed raw row) are skipped', async () => {
      const { dataSource } = makeDataSource({
        rows: (c) =>
          c.fkColumn === 'project_group_id'
            ? [
                { id: null, sum: '999' },
                { id: 'p1', sum: '5' },
              ]
            : [],
      });
      const out = await svc(dataSource).totalsForUnifiedProjects([
        makeProject('main', 'p1'),
      ]);
      expect(out.size).toBe(1);
      expect(out.get('main:p1' as ProjectKey)).toBe(5);
    });
  });

  // ── 6. Error propagation ────────────────────────────────────
  describe('error propagation (no swallowing)', () => {
    it('rethrows DB errors so ResilienceEnvelope (BE-W54-07) can catch at dimension boundary', async () => {
      const { dataSource } = makeDataSource({
        throwOn: (c) =>
          c.fkColumn === 'project_group_id'
            ? new Error('simulated pg outage')
            : null,
      });
      await expect(
        svc(dataSource).totalsForUnifiedProjects([
          makeProject('main', 'p1'),
        ]),
      ).rejects.toThrow(/simulated pg outage/);
    });
  });

  // ── 7. Grep gate — no raw table literals in the service source ──
  describe('grep gate — no raw `budgets` table literals in service source', () => {
    const SERVICE_PATH = join(
      __dirname,
      '..',
      'services',
      'budget-aggregator.service.ts',
    );
    const src = readFileSync(SERVICE_PATH, 'utf8');

    it('does not contain `FROM budgets` literal', () => {
      expect(/\bFROM\s+budgets\b/i.test(src)).toBe(false);
    });

    it('does not contain `"budgets"` double-quoted literal', () => {
      expect(/"budgets"/i.test(src)).toBe(false);
    });

    it("does not contain `'budgets'` single-quoted literal", () => {
      expect(/'budgets'/i.test(src)).toBe(false);
    });

    it('does not contain backtick-wrapped `budgets` literal', () => {
      expect(/`budgets`/i.test(src)).toBe(false);
    });

    it('uses entity-metadata resolution — references Budget class + getRepository', () => {
      expect(src).toMatch(/getRepository\(\s*Budget\s*\)/);
      expect(src).toMatch(
        /from\s*['"]src\/budget\/entities\/budget\.entity['"]/,
      );
    });

    it('contains NO write-method calls (.save / .update / .delete / .softRemove / .softDelete / .remove / .insert / .upsert)', () => {
      expect(/\.save\(/.test(src)).toBe(false);
      expect(/\.update\(/.test(src)).toBe(false);
      // `.delete(` is checked as a method call — entity metadata's
      // `deleted_at` column reference does not match `.delete(`.
      expect(/\.delete\(/.test(src)).toBe(false);
      expect(/\.softRemove\(/.test(src)).toBe(false);
      expect(/\.softDelete\(/.test(src)).toBe(false);
      expect(/\.remove\(/.test(src)).toBe(false);
      expect(/\.insert\(/.test(src)).toBe(false);
      expect(/\.upsert\(/.test(src)).toBe(false);
    });

    it('makes no tracking_status writes (§12 audit separation)', () => {
      // Strip comments to avoid false-positives on doc-comment mentions
      // of `tracking_status` in a negative/policy context.
      const stripped = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      expect(/tracking_status/i.test(stripped)).toBe(false);
      expect(/TrackingStatus/.test(stripped)).toBe(false);
    });
  });
});
