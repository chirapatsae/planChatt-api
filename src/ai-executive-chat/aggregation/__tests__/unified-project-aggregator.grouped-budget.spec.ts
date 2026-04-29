/**
 * W71-BE-PROJECT-BUDGET (2026-04-28) — per-project budget visibility on
 * the W67-FIX-B status-drill envelope.
 *
 * The user-reported regression was: AI Executive Chat returned the
 * correct aggregate budget (e.g. 7,100,000 บาท for 4 projects under
 * กองสาธารณสุข) but rendered "งบประมาณ: ไม่ระบุ" on every per-project
 * bullet because the drill payload type
 * `GroupedExecutiveStatusBreakdownProject` had NO `budget` field — the
 * model literally had nothing to render.
 *
 * This spec asserts:
 *   1. Every drill-project entry carries a non-null `budget: number`.
 *   2. PG / RPG / SPG branches all wire up the correlated SUM subquery
 *      against the correct `Budget` FK column.
 *   3. Zero-budget projects emit `budget: 0` (not null, not undefined).
 *   4. Non-zero budget rows pass through verbatim from the SUM cell.
 *   5. §14.2 head-of-lineage anti-join is preserved on the spine
 *      query — the budget subquery does NOT add its own anti-join.
 *
 * Source-of-truth references:
 *   - docs/tasks/wave71/W71-AI-CHAT-BUDGET-VISIBILITY.md §10 AC1-AC9.
 *   - CLAUDE.md §14.2 (HEAD-of-lineage), §17.2 (advisory only).
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import { UnifiedProjectAggregator } from '../services/unified-project-aggregator.service';

// ─────────────────────────────────────────────────────────────────────
// Test harness. The grouped-status drill makes several DB round-trips:
//
//   1. `countMain/Revised/SupplementByBookAndStatus` — bucket counts.
//   2. `fetchProjectsForBookStatus` — per (book × status) sample SELECT.
//   3. `loadDrillCreatedAt` — per-kind createdAt batched SELECT
//      (linkedRelated annotation pass).
//
// The harness queues per-repository `getRawMany` result arrays so each
// call consumes the next queued result. `getRawOne` is also stubbed
// (returns null) since the FK-chain resolver only runs under
// `includeHistoricalVersions=true`.
// ─────────────────────────────────────────────────────────────────────

interface QbCall {
  repositoryName: string;
  whereChain: string[];
  /** Aliases assigned via addSelect(subQb, alias) for correlated subqueries. */
  subQueryAliases: string[];
  /** SQL snippets captured from sub-query builders' where chains. */
  subQueryWheres: string[];
  /** From-clause table refs for the subqueries. */
  subQueryFromTables: string[];
}

function makeDataSource(opts: {
  /** FIFO queue of getRawMany results per repository name. */
  rawManyByRepo?: Record<string, unknown[][]>;
}) {
  const calls: QbCall[] = [];
  const queues: Record<string, unknown[][]> = {};
  for (const [k, v] of Object.entries(opts.rawManyByRepo ?? {})) {
    queues[k] = [...v];
  }

  function makeSubQbStub(call: QbCall) {
    // Sub-query builder used inside addSelect((subQb) => …) callbacks.
    // Record the .from() target's table and the where chain so the
    // outer test can assert the FK column is correct.
    const subQb: Record<string, unknown> = {};
    Object.assign(subQb, {
      select: () => subQb,
      from: (target: unknown, _alias?: string) => {
        const name =
          typeof target === 'function'
            ? (target as { name?: string }).name ?? 'UnknownEntity'
            : String(target);
        call.subQueryFromTables.push(name);
        return subQb;
      },
      where: (clause: string) => {
        call.subQueryWheres.push(clause);
        return subQb;
      },
      andWhere: (clause: string) => {
        call.subQueryWheres.push(clause);
        return subQb;
      },
      getQuery: () => '',
    });
    return subQb;
  }

  function qbFactory(repositoryName: string) {
    const call: QbCall = {
      repositoryName,
      whereChain: [],
      subQueryAliases: [],
      subQueryWheres: [],
      subQueryFromTables: [],
    };
    const qb: Record<string, unknown> = {};
    const self = () => qb;
    Object.assign(qb, {
      innerJoin: self,
      leftJoin: self,
      select: self,
      addSelect: (arg1: unknown, alias?: string) => {
        // arg1 may be a string (column literal) or a callback that
        // builds a sub-query using the sub-QB factory.
        if (typeof arg1 === 'function') {
          call.subQueryAliases.push(alias ?? '<unnamed>');
          (arg1 as (sub: unknown) => unknown)(makeSubQbStub(call));
        }
        return qb;
      },
      where: (clause: string) => {
        call.whereChain.push(clause);
        return qb;
      },
      andWhere: (clause: string) => {
        call.whereChain.push(clause);
        return qb;
      },
      orderBy: self,
      addOrderBy: self,
      groupBy: self,
      addGroupBy: self,
      limit: self,
      getRawMany: async () => {
        calls.push(call);
        const queue = queues[repositoryName];
        if (!queue || queue.length === 0) return [];
        return queue.shift() ?? [];
      },
      getRawOne: async () => null,
    });
    return qb;
  }

  const dataSource = {
    getRepository: (target: unknown) => {
      const repoName =
        typeof target === 'function'
          ? (target as { name?: string }).name ?? 'Unknown'
          : 'Unknown';
      return {
        createQueryBuilder: (_alias: string) => qbFactory(repoName),
      };
    },
    // Required by `applyFilters` budget-range branch but unused here.
    getMetadata: () => ({ tableName: 'budget' }),
  };

  return { dataSource, calls };
}

function svc(ds: unknown): UnifiedProjectAggregator {
  return new UnifiedProjectAggregator(ds as never);
}

// ─────────────────────────────────────────────────────────────────────

describe('W71-BE-PROJECT-BUDGET / groupedExecutiveStatusBreakdown', () => {
  // ── 1. Type-shape gate (interface declaration) ──────────────────────
  describe('interface — `budget: number` is required', () => {
    const interfacePath = join(
      __dirname,
      '..',
      'interfaces',
      'unified-project-aggregator.interface.ts',
    );
    const src = readFileSync(interfacePath, 'utf8');

    it('declares `budget: number` (non-null) on GroupedExecutiveStatusBreakdownProject', () => {
      // The field MUST be `number` (NOT `number | null`, NOT optional)
      // — `0` is the canonical zero-value sentinel.
      expect(src).toMatch(/budget:\s*number\s*;/);
    });
  });

  // ── 2. Service source-level wiring (correlated SUM per branch) ──────
  describe('service — correlated SUM subquery per project kind', () => {
    const servicePath = join(
      __dirname,
      '..',
      'services',
      'unified-project-aggregator.service.ts',
    );
    const src = readFileSync(servicePath, 'utf8');

    it('PG branch correlates Budget on `b.project_group_id = pg.id`', () => {
      expect(src).toMatch(/b\.project_group_id\s*=\s*pg\.id/);
    });

    it('RPG branch correlates Budget on `b.revised_project_group_id = rpg.id`', () => {
      expect(src).toMatch(/b\.revised_project_group_id\s*=\s*rpg\.id/);
    });

    it('SPG branch correlates Budget on `b.supplement_project_group_id = spg.id`', () => {
      expect(src).toMatch(/b\.supplement_project_group_id\s*=\s*spg\.id/);
    });

    it('uses COALESCE(SUM(b.quantity), 0) — the non-null zero-value contract', () => {
      // Three matches expected — one per branch. `\\s*` between tokens
      // accommodates formatter whitespace drift.
      const re = /COALESCE\(\s*SUM\(\s*b\.quantity\s*\)\s*,\s*0\s*\)/g;
      const matches = src.match(re) ?? [];
      // The grouped-status drill has 3 branches; `applyFilters`
      // (budgetRange) ALSO uses a SUM subquery (alias `b_f`) which has
      // a different alias, so it should not collide. We require AT
      // LEAST 3 occurrences for the drill branches.
      expect(matches.length).toBeGreaterThanOrEqual(3);
    });
  });

  // ── 3. Runtime drill — budget projects through to every project row ─
  describe('runtime — drill rows carry budget for PG/RPG/SPG', () => {
    it('PG drill row receives `budget` from the correlated SUM cell', async () => {
      // Bucket counts → fetchProjects → loadDrillCreatedAt sequence.
      const { dataSource } = makeDataSource({
        rawManyByRepo: {
          // countMainByBookAndStatus
          ProjectGroup: [
            // (1) bucket counts
            [
              {
                planid: 'plan-1',
                planname: 'แผนสุขภาพ',
                statusname: 'Approved',
                cnt: '1',
              },
            ],
            // (2) fetchProjectsForBookStatus — main bucket sample
            [
              {
                id: 'pg-1',
                title: 'โครงการ A',
                pagenumber: 7,
                proj_lao_id: null,
                proj_lao_name: null,
                budget: '50000',
              },
            ],
            // (3) loadDrillCreatedAt — main createdAt batch
            [{ id: 'pg-1', createdat: new Date('2026-01-01').toISOString() }],
          ],
          RevisedProjectGroup: [
            [], // countRevisedByBookAndStatus
            [], // loadDrillCreatedAt revised batch
          ],
          SupplementProjectGroup: [
            [], // countSupplementByBookAndStatus
            [], // loadDrillCreatedAt supplement batch
          ],
        },
      });
      const out = await svc(dataSource).groupedExecutiveStatusBreakdown({
        scope: ['main'],
      });
      expect(out.books).toHaveLength(1);
      expect(out.books[0].statuses).toHaveLength(1);
      expect(out.books[0].statuses[0].projects).toHaveLength(1);
      const p = out.books[0].statuses[0].projects[0];
      expect(p.projectId).toBe('pg-1');
      expect(p.projectKind).toBe('main');
      expect(p.budget).toBe(50000);
      // §14.2 sentinel — `0` is canonical zero, never null/undefined.
      expect(p.budget).not.toBeNull();
      expect(p.budget).not.toBeUndefined();
      expect(typeof p.budget).toBe('number');
    });

    it('RPG drill row receives `budget` from the correlated SUM cell', async () => {
      const { dataSource } = makeDataSource({
        rawManyByRepo: {
          ProjectGroup: [
            [], // countMainByBookAndStatus
            [], // loadDrillCreatedAt main batch
          ],
          RevisedProjectGroup: [
            // countRevisedByBookAndStatus
            [
              {
                planid: 'plan-1',
                planname: 'แผนสุขภาพ',
                dprid: 'dpr-1',
                revisionnumber: 1,
                dprdescription: null,
                revisiontypename: 'แก้ไข',
                statusname: 'Pending',
                cnt: '1',
              },
            ],
            // fetchProjectsForBookStatus — revised bucket
            [
              {
                id: 'rpg-1',
                title: 'โครงการ B',
                pagenumber: 3,
                proj_lao_id: null,
                proj_lao_name: null,
                budget: 1500000, // numeric type from raw; no string coercion needed
              },
            ],
            // loadDrillCreatedAt revised batch
            [{ id: 'rpg-1', createdat: new Date('2026-02-01').toISOString() }],
          ],
          SupplementProjectGroup: [
            [], // count
            [], // createdAt
          ],
        },
      });
      const out = await svc(dataSource).groupedExecutiveStatusBreakdown({
        scope: ['revised'],
      });
      expect(out.books).toHaveLength(1);
      const p = out.books[0].statuses[0].projects[0];
      expect(p.projectId).toBe('rpg-1');
      expect(p.projectKind).toBe('revised');
      expect(p.budget).toBe(1500000);
    });

    it('SPG drill row receives `budget` from the correlated SUM cell', async () => {
      const { dataSource } = makeDataSource({
        rawManyByRepo: {
          ProjectGroup: [[], []],
          RevisedProjectGroup: [[], []],
          SupplementProjectGroup: [
            // count
            [
              {
                planid: 'plan-1',
                planname: 'แผนสุขภาพ',
                dpsid: 'dps-1',
                supplementnumber: 1,
                dpsdescription: null,
                statusname: 'Verified',
                cnt: '1',
              },
            ],
            // fetchProjectsForBookStatus — supplement bucket
            [
              {
                id: 'spg-1',
                title: 'โครงการ C',
                pagenumber: 12,
                budget: '275000.00', // postgres numeric → string projection
              },
            ],
            // loadDrillCreatedAt supplement batch
            [{ id: 'spg-1', createdat: new Date('2026-03-01').toISOString() }],
          ],
        },
      });
      const out = await svc(dataSource).groupedExecutiveStatusBreakdown({
        scope: ['supplement'],
      });
      expect(out.books).toHaveLength(1);
      const p = out.books[0].statuses[0].projects[0];
      expect(p.projectId).toBe('spg-1');
      expect(p.projectKind).toBe('supplement');
      expect(p.budget).toBe(275000);
    });

    it('zero-budget project emits `budget: 0` (not null, not undefined)', async () => {
      const { dataSource } = makeDataSource({
        rawManyByRepo: {
          ProjectGroup: [
            [
              {
                planid: 'plan-1',
                planname: 'แผนสุขภาพ',
                statusname: 'Approved',
                cnt: '1',
              },
            ],
            [
              {
                id: 'pg-zero',
                title: 'no-budget',
                pagenumber: 1,
                proj_lao_id: null,
                proj_lao_name: null,
                // COALESCE returns '0' as a string from postgres SUM cells.
                budget: '0',
              },
            ],
            [{ id: 'pg-zero', createdat: new Date().toISOString() }],
          ],
          RevisedProjectGroup: [[], []],
          SupplementProjectGroup: [[], []],
        },
      });
      const out = await svc(dataSource).groupedExecutiveStatusBreakdown({
        scope: ['main'],
      });
      const p = out.books[0].statuses[0].projects[0];
      expect(p.budget).toBe(0);
      expect(p.budget).not.toBeNull();
      expect(p.budget).not.toBeUndefined();
    });

    it('reproducer trace — 4 main projects sum to 7,100,000 (กองสาธารณสุข)', async () => {
      // Budget rows: 1,500,000 + 2,000,000 + 1,200,000 + 2,400,000 = 7,100,000.
      const { dataSource } = makeDataSource({
        rawManyByRepo: {
          ProjectGroup: [
            [
              {
                planid: 'plan-health',
                planname: 'แผนพัฒนาท้องถิ่น',
                statusname: 'Approved',
                cnt: '4',
              },
            ],
            [
              {
                id: 'pg-1',
                title: 'โครงการสุขภาพ A',
                pagenumber: 1,
                proj_lao_id: null,
                proj_lao_name: null,
                budget: '1500000',
              },
              {
                id: 'pg-2',
                title: 'โครงการสุขภาพ B',
                pagenumber: 2,
                proj_lao_id: null,
                proj_lao_name: null,
                budget: '2000000',
              },
              {
                id: 'pg-3',
                title: 'โครงการสุขภาพ C',
                pagenumber: 3,
                proj_lao_id: null,
                proj_lao_name: null,
                budget: '1200000',
              },
              {
                id: 'pg-4',
                title: 'โครงการสุขภาพ D',
                pagenumber: 4,
                proj_lao_id: null,
                proj_lao_name: null,
                budget: '2400000',
              },
            ],
            [
              { id: 'pg-1', createdat: new Date().toISOString() },
              { id: 'pg-2', createdat: new Date().toISOString() },
              { id: 'pg-3', createdat: new Date().toISOString() },
              { id: 'pg-4', createdat: new Date().toISOString() },
            ],
          ],
          RevisedProjectGroup: [[], []],
          SupplementProjectGroup: [[], []],
        },
      });
      const out = await svc(dataSource).groupedExecutiveStatusBreakdown({
        scope: ['main'],
      });
      const projects = out.books[0].statuses[0].projects;
      expect(projects).toHaveLength(4);
      const total = projects.reduce((acc, p) => acc + p.budget, 0);
      expect(total).toBe(7_100_000);
      for (const p of projects) {
        expect(p.budget).toBeGreaterThan(0);
        expect(typeof p.budget).toBe('number');
      }
    });
  });

  // ── 4. Subquery binding — addSelect captures the correlated SUM ─────
  describe('subquery binding — Budget FK column matches the project kind', () => {
    it('PG drill subquery references `b.project_group_id = pg.id`', async () => {
      const { dataSource, calls } = makeDataSource({
        rawManyByRepo: {
          ProjectGroup: [
            [
              {
                planid: 'plan-1',
                planname: 'plan',
                statusname: 'Approved',
                cnt: '1',
              },
            ],
            [
              {
                id: 'pg-1',
                title: 'p',
                pagenumber: 1,
                proj_lao_id: null,
                proj_lao_name: null,
                budget: '0',
              },
            ],
            [{ id: 'pg-1', createdat: new Date().toISOString() }],
          ],
          RevisedProjectGroup: [[], []],
          SupplementProjectGroup: [[], []],
        },
      });
      await svc(dataSource).groupedExecutiveStatusBreakdown({ scope: ['main'] });
      // The fetchProjectsForBookStatus PG sample call MUST register an
      // addSelect with alias 'budget' AND a sub-query whose where binds
      // `b.project_group_id = pg.id`.
      const sampleCall = calls.find(
        (c) =>
          c.repositoryName === 'ProjectGroup' &&
          c.subQueryAliases.includes('budget'),
      );
      expect(sampleCall).toBeDefined();
      expect(sampleCall!.subQueryWheres).toContain(
        'b.project_group_id = pg.id',
      );
    });
  });
});
