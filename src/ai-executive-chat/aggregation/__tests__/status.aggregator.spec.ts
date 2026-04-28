/**
 * BE-W54-04 — StatusAggregator unit coverage.
 *
 * Targets `backend/src/ai-executive-chat/aggregation/services/status-aggregator.service.ts`.
 *
 * Coverage grid (task §10):
 *   - each FK path (main / revised / supplement)
 *   - `isLatest = true` filter IS applied on every query
 *   - `deletedAt IS NULL` filter IS applied on every query
 *   - missing status row → key ABSENT from the result Map
 *   - Thai status name resolution (toThaiStatus) — known + unknown fallback
 *   - empty input → empty Map
 *   - chunking IN-clause at 5000
 *   - duplicate `isLatest=true` (defensive): keep the newer createAt
 *   - mixed-kind input: all three buckets merged into one Map
 *
 * CLAUDE.md §12 — audit separation: zero `tracking_status` writes, zero
 * `save` / `update` / `delete` / `softRemove` invocations on any
 * repository.
 */
import { DataSource } from 'typeorm';

import { StatusAggregator } from '../services/status-aggregator.service';
import type { UnifiedProject } from '../types';

// ---------------------------------------------------------------------------
// QB mock harness
// ---------------------------------------------------------------------------

interface RawLatestRow {
  projectid: string;
  statusname: string | null;
  createat: Date | string | null;
}

interface InvocationTrace {
  /** SQL fragment of the FK-IN clause last applied, e.g. `ts.project_group_id IN (:...ids)`. */
  inClause?: string;
  /** ids bound to the IN clause. */
  ids?: readonly string[];
  /** `isLatest = :latest` parameter the QB saw. */
  latest?: unknown;
  /** Whether `deletedAt IS NULL` was applied. */
  appliedDeletedAtGuard?: boolean;
  /** Whether `ts.isLatest = :latest` was applied. */
  appliedIsLatestGuard?: boolean;
  /** Whether `.innerJoin('ts.statusId', 'status')` was applied. */
  appliedStatusJoin?: boolean;
  /** FK column the caller selected as `projectid`. */
  selectedFkColumn?: string;
  /** Whether any write-like method was invoked on the QB chain. */
  writeMethodCalls: string[];
}

/**
 * Build a fake QueryBuilder that records every call, validates the
 * `isLatest` + `deletedAt` guards, and returns a caller-configurable
 * raw-row set keyed by which FK column appeared in the IN clause.
 */
function makeQbHarness(rowsByColumn: Record<string, RawLatestRow[]>) {
  const traces: InvocationTrace[] = [];
  let current: InvocationTrace = { writeMethodCalls: [] };

  const qb: Record<string, unknown> = {};
  const self = () => qb;

  Object.assign(qb, {
    select: (expr: string, alias?: string) => {
      if (alias === 'projectid' && typeof expr === 'string') {
        current.selectedFkColumn = expr;
      }
      return qb;
    },
    addSelect: self,
    innerJoin: (relation: string, _alias: string) => {
      if (relation === 'ts.statusId') {
        current.appliedStatusJoin = true;
      }
      return qb;
    },
    leftJoin: self,
    where: (clause: string, params?: Record<string, unknown>) => {
      if (/ts\.isLatest\s*=\s*:latest/.test(clause)) {
        current.appliedIsLatestGuard = true;
        current.latest = params?.latest;
      }
      return qb;
    },
    andWhere: (clause: string, params?: Record<string, unknown>) => {
      if (/ts\.isLatest\s*=\s*:latest/.test(clause)) {
        current.appliedIsLatestGuard = true;
        current.latest = params?.latest;
      }
      if (/ts\.deletedAt\s+IS\s+NULL/.test(clause)) {
        current.appliedDeletedAtGuard = true;
      }
      const inMatch = clause.match(/ts\.(\w+)\s+IN\s+\(:\.\.\.ids\)/);
      if (inMatch) {
        current.inClause = clause;
        current.ids = (params?.ids as readonly string[]) ?? [];
      }
      return qb;
    },
    groupBy: self,
    orderBy: self,
    take: self,
    limit: self,
    getRawMany: async () => {
      // Snapshot trace and reset for next query in the same test.
      const snap = current;
      traces.push(snap);
      current = { writeMethodCalls: [] };
      const col = snap.inClause?.match(/ts\.(\w+)\s+IN/)?.[1];
      if (!col) return [];
      return rowsByColumn[col] ?? [];
    },
    // Write-like methods — must NEVER be invoked by the aggregator.
    save: () => {
      current.writeMethodCalls.push('save');
      throw new Error('StatusAggregator attempted a write');
    },
    update: () => {
      current.writeMethodCalls.push('update');
      throw new Error('StatusAggregator attempted a write');
    },
    delete: () => {
      current.writeMethodCalls.push('delete');
      throw new Error('StatusAggregator attempted a write');
    },
    softDelete: () => {
      current.writeMethodCalls.push('softDelete');
      throw new Error('StatusAggregator attempted a write');
    },
    softRemove: () => {
      current.writeMethodCalls.push('softRemove');
      throw new Error('StatusAggregator attempted a write');
    },
    insert: () => {
      current.writeMethodCalls.push('insert');
      throw new Error('StatusAggregator attempted a write');
    },
    upsert: () => {
      current.writeMethodCalls.push('upsert');
      throw new Error('StatusAggregator attempted a write');
    },
  });

  const repoWriteCalls: string[] = [];
  const repo = {
    createQueryBuilder: (_alias: string) => qb,
    // Trap any direct repository write.
    save: () => {
      repoWriteCalls.push('save');
      throw new Error('StatusAggregator attempted a write');
    },
    update: () => {
      repoWriteCalls.push('update');
      throw new Error('StatusAggregator attempted a write');
    },
    delete: () => {
      repoWriteCalls.push('delete');
      throw new Error('StatusAggregator attempted a write');
    },
    softDelete: () => {
      repoWriteCalls.push('softDelete');
      throw new Error('StatusAggregator attempted a write');
    },
    softRemove: () => {
      repoWriteCalls.push('softRemove');
      throw new Error('StatusAggregator attempted a write');
    },
    remove: () => {
      repoWriteCalls.push('remove');
      throw new Error('StatusAggregator attempted a write');
    },
    insert: () => {
      repoWriteCalls.push('insert');
      throw new Error('StatusAggregator attempted a write');
    },
    upsert: () => {
      repoWriteCalls.push('upsert');
      throw new Error('StatusAggregator attempted a write');
    },
  };

  const dataSource = {
    getRepository: (_target: unknown) => repo,
  } as unknown as DataSource;

  return {
    dataSource,
    traces,
    repoWriteCalls,
  };
}

function mkProject(
  projectKind: 'main' | 'revised' | 'supplement',
  projectId: string,
): UnifiedProject {
  return {
    projectKind,
    projectId,
    name: `name-${projectId}`,
    planId: 'plan-1',
    planReportFormat: 'STRATEGY_BASED',
    // Wave 55 W55-BE-07 — required field; StatusAggregator does not
    // branch on it so the fixture uses the safe default.
    originType: 'lao-coordinated',
  };
}

describe('BE-W54-04 / StatusAggregator', () => {
  describe('empty input', () => {
    it('returns an empty Map without touching the repo', async () => {
      const h = makeQbHarness({});
      const svc = new StatusAggregator(h.dataSource);
      const result = await svc.latestStatusFor([]);
      expect(result.size).toBe(0);
      expect(h.traces.length).toBe(0);
      expect(h.repoWriteCalls.length).toBe(0);
    });
  });

  describe('single-kind queries (FK path coverage)', () => {
    it('main path: IN clause targets `ts.project_group_id`', async () => {
      const h = makeQbHarness({
        project_group_id: [
          {
            projectid: 'pg-1',
            statusname: 'Pending',
            createat: '2026-04-23T00:00:00.000Z',
          },
        ],
      });
      const svc = new StatusAggregator(h.dataSource);
      const result = await svc.latestStatusFor([mkProject('main', 'pg-1')]);
      expect(result.size).toBe(1);
      expect(result.get('main:pg-1')).toEqual({
        // W67-FIX-01 — `statusName` is canonical English; `statusNameTh`
        // carries the Thai display label. Pre-FIX-01 contract had Thai in
        // `statusName`, which broke executive status rollup downstream.
        statusName: 'Pending',
        statusNameTh: 'รอตรวจสอบ',
        createdAt: '2026-04-23T00:00:00.000Z',
        isLatest: true,
      });
      expect(h.traces.length).toBe(1);
      expect(h.traces[0].selectedFkColumn).toBe('ts.project_group_id');
      expect(h.traces[0].inClause).toMatch(
        /ts\.project_group_id\s+IN\s+\(:\.\.\.ids\)/,
      );
      expect(h.traces[0].appliedIsLatestGuard).toBe(true);
      expect(h.traces[0].latest).toBe(true);
      expect(h.traces[0].appliedDeletedAtGuard).toBe(true);
      expect(h.traces[0].appliedStatusJoin).toBe(true);
    });

    it('revised path: IN clause targets `ts.revised_project_group_id`', async () => {
      const h = makeQbHarness({
        revised_project_group_id: [
          {
            projectid: 'rpg-1',
            statusname: 'Approved',
            createat: '2026-04-22T12:00:00.000Z',
          },
        ],
      });
      const svc = new StatusAggregator(h.dataSource);
      const result = await svc.latestStatusFor([
        mkProject('revised', 'rpg-1'),
      ]);
      expect(result.size).toBe(1);
      expect(result.get('revised:rpg-1')).toEqual({
        statusName: 'Approved',
        statusNameTh: 'อนุมัติ',
        createdAt: '2026-04-22T12:00:00.000Z',
        isLatest: true,
      });
      expect(h.traces[0].inClause).toMatch(
        /ts\.revised_project_group_id\s+IN\s+\(:\.\.\.ids\)/,
      );
      expect(h.traces[0].appliedIsLatestGuard).toBe(true);
      expect(h.traces[0].appliedDeletedAtGuard).toBe(true);
    });

    it('supplement path: IN clause targets `ts.supplement_project_group_id`', async () => {
      const h = makeQbHarness({
        supplement_project_group_id: [
          {
            projectid: 'spg-1',
            statusname: 'Verified',
            createat: '2026-04-20T08:30:00.000Z',
          },
        ],
      });
      const svc = new StatusAggregator(h.dataSource);
      const result = await svc.latestStatusFor([
        mkProject('supplement', 'spg-1'),
      ]);
      expect(result.size).toBe(1);
      expect(result.get('supplement:spg-1')).toEqual({
        statusName: 'Verified',
        statusNameTh: 'ตรวจสอบผ่าน',
        createdAt: '2026-04-20T08:30:00.000Z',
        isLatest: true,
      });
      expect(h.traces[0].inClause).toMatch(
        /ts\.supplement_project_group_id\s+IN\s+\(:\.\.\.ids\)/,
      );
    });
  });

  describe('mixed-kind input', () => {
    it('merges three-kind rows into a single Map keyed by `${kind}:${id}`', async () => {
      const h = makeQbHarness({
        project_group_id: [
          { projectid: 'pg-1', statusname: 'Pending', createat: '2026-04-23T00:00:00.000Z' },
        ],
        revised_project_group_id: [
          { projectid: 'rpg-1', statusname: 'Approved', createat: '2026-04-23T01:00:00.000Z' },
        ],
        supplement_project_group_id: [
          { projectid: 'spg-1', statusname: 'Returned_For_Revision', createat: '2026-04-23T02:00:00.000Z' },
        ],
      });
      const svc = new StatusAggregator(h.dataSource);
      const result = await svc.latestStatusFor([
        mkProject('main', 'pg-1'),
        mkProject('revised', 'rpg-1'),
        mkProject('supplement', 'spg-1'),
      ]);
      expect(result.size).toBe(3);
      // W67-FIX-01 — `statusName` is canonical English; Thai display label
      // is on `statusNameTh`. Both are asserted here.
      expect(result.get('main:pg-1')?.statusName).toBe('Pending');
      expect(result.get('main:pg-1')?.statusNameTh).toBe('รอตรวจสอบ');
      expect(result.get('revised:rpg-1')?.statusName).toBe('Approved');
      expect(result.get('revised:rpg-1')?.statusNameTh).toBe('อนุมัติ');
      expect(result.get('supplement:spg-1')?.statusName).toBe(
        'Returned_For_Revision',
      );
      expect(result.get('supplement:spg-1')?.statusNameTh).toBe('รอแก้ไข');
      // Three parallel queries — one per non-empty bucket.
      expect(h.traces.length).toBe(3);
      for (const t of h.traces) {
        expect(t.appliedIsLatestGuard).toBe(true);
        expect(t.appliedDeletedAtGuard).toBe(true);
        expect(t.latest).toBe(true);
      }
    });
  });

  describe('isLatest guard enforcement', () => {
    it('every emitted query carries `ts.isLatest = :latest` with latest=true', async () => {
      const h = makeQbHarness({
        project_group_id: [{ projectid: 'pg-1', statusname: 'Approved', createat: new Date() }],
        revised_project_group_id: [{ projectid: 'rpg-1', statusname: 'Approved', createat: new Date() }],
        supplement_project_group_id: [{ projectid: 'spg-1', statusname: 'Approved', createat: new Date() }],
      });
      const svc = new StatusAggregator(h.dataSource);
      await svc.latestStatusFor([
        mkProject('main', 'pg-1'),
        mkProject('revised', 'rpg-1'),
        mkProject('supplement', 'spg-1'),
      ]);
      expect(h.traces).toHaveLength(3);
      for (const t of h.traces) {
        expect(t.appliedIsLatestGuard).toBe(true);
        expect(t.latest).toBe(true);
      }
    });
  });

  describe('missing status row', () => {
    it('returns a Map that omits keys for projects with no tracking row', async () => {
      const h = makeQbHarness({
        project_group_id: [
          { projectid: 'pg-present', statusname: 'Pending', createat: new Date('2026-04-23') },
        ],
        // pg-missing intentionally NOT in the result set.
      });
      const svc = new StatusAggregator(h.dataSource);
      const result = await svc.latestStatusFor([
        mkProject('main', 'pg-present'),
        mkProject('main', 'pg-missing'),
      ]);
      expect(result.has('main:pg-present')).toBe(true);
      expect(result.has('main:pg-missing')).toBe(false);
    });
  });

  describe('Thai name resolution', () => {
    it('maps known canonical status names to Thai', async () => {
      const h = makeQbHarness({
        project_group_id: [
          { projectid: 'pg-1', statusname: 'Pending_Approval', createat: new Date() },
          { projectid: 'pg-2', statusname: 'Pull_Back', createat: new Date() },
        ],
      });
      const svc = new StatusAggregator(h.dataSource);
      const result = await svc.latestStatusFor([
        mkProject('main', 'pg-1'),
        mkProject('main', 'pg-2'),
      ]);
      expect(result.get('main:pg-1')?.statusName).toBe('Pending_Approval');
      expect(result.get('main:pg-1')?.statusNameTh).toBe('รออนุมัติ');
      expect(result.get('main:pg-2')?.statusName).toBe('Pull_Back');
      expect(result.get('main:pg-2')?.statusNameTh).toBe('ดึงกลับ');
    });

    it('falls back to the raw status string when unknown (never throws)', async () => {
      const h = makeQbHarness({
        project_group_id: [
          {
            projectid: 'pg-1',
            statusname: 'BrandNewStatusXYZ',
            createat: new Date(),
          },
        ],
      });
      const svc = new StatusAggregator(h.dataSource);
      const result = await svc.latestStatusFor([mkProject('main', 'pg-1')]);
      expect(result.get('main:pg-1')?.statusName).toBe('BrandNewStatusXYZ');
    });
  });

  describe('duplicate isLatest=true rows (defensive)', () => {
    it('keeps the row with the newer createAt when two latest rows collide', async () => {
      const h = makeQbHarness({
        project_group_id: [
          { projectid: 'pg-1', statusname: 'Pending', createat: '2026-04-01T00:00:00.000Z' },
          { projectid: 'pg-1', statusname: 'Approved', createat: '2026-04-23T00:00:00.000Z' },
        ],
      });
      const svc = new StatusAggregator(h.dataSource);
      const result = await svc.latestStatusFor([mkProject('main', 'pg-1')]);
      expect(result.get('main:pg-1')).toEqual({
        statusName: 'Approved',
        statusNameTh: 'อนุมัติ',
        createdAt: '2026-04-23T00:00:00.000Z',
        isLatest: true,
      });
    });
  });

  describe('chunking IN-clause at 5000', () => {
    it('splits a 12000-id bucket into three chunks (5000 + 5000 + 2000)', async () => {
      const ids = Array.from({ length: 12000 }, (_, i) => `pg-${i}`);
      const h = makeQbHarness({
        project_group_id: [], // we only care about chunk metadata, not row results
      });
      const svc = new StatusAggregator(h.dataSource);
      await svc.latestStatusFor(ids.map((id) => mkProject('main', id)));
      expect(h.traces.length).toBe(3);
      expect(h.traces[0].ids?.length).toBe(5000);
      expect(h.traces[1].ids?.length).toBe(5000);
      expect(h.traces[2].ids?.length).toBe(2000);
    });
  });

  describe('§12 audit invariant', () => {
    it('never invokes any write method on the TrackingStatus repo or QB', async () => {
      const h = makeQbHarness({
        project_group_id: [
          { projectid: 'pg-1', statusname: 'Pending', createat: new Date() },
        ],
        revised_project_group_id: [
          { projectid: 'rpg-1', statusname: 'Pending', createat: new Date() },
        ],
        supplement_project_group_id: [
          { projectid: 'spg-1', statusname: 'Pending', createat: new Date() },
        ],
      });
      const svc = new StatusAggregator(h.dataSource);
      await svc.latestStatusFor([
        mkProject('main', 'pg-1'),
        mkProject('revised', 'rpg-1'),
        mkProject('supplement', 'spg-1'),
      ]);
      expect(h.repoWriteCalls).toEqual([]);
      for (const t of h.traces) {
        expect(t.writeMethodCalls).toEqual([]);
      }
    });
  });
});
