/**
 * Wave 57 W57-BE-AGG-06 — Book global-timeline + project-partition spec.
 *
 * Validates:
 *   1. `getLatestBookForPlan` honors §15.2 GLOBAL TIMELINE — UNION DPR
 *      + DPS, ORDER BY createdAt DESC. Soft-deleted rows excluded.
 *   2. `getLatestProjectsByBookPartition` matches the bucketing of
 *      `findLatestProjects`:
 *        - HEAD in PG → mainBook
 *        - HEAD in RPG with DPR.type='edit' → editBook
 *        - HEAD in RPG with DPR.type='change' → changeBook
 *      against the canonical Q3 fixture {PG[A,B,C], RPG-edit(A),
 *      RPG-change(B)} → {mainBook:[C], editBook:[A], changeBook:[B]}.
 *   3. Plan with DPR(edit, t=1) + Supplement(t=2) + DPR(change, t=3)
 *      yields `{kind: 'change', createdAt: t=3}`.
 *   4. Soft-deleted DPR not counted.
 *
 * The tests use a stubbed DataSource that captures the queries the
 * service issues against each entity repository and returns canned
 * rows. This mirrors the established pattern in
 * `unified-project-aggregator.spec.ts`.
 */
import { BookTimelineService } from '../services/book-timeline.service';

type RawRow = Record<string, unknown>;

interface StubCall {
  repositoryName: string;
  whereChain: string[];
  orderByChain: string[];
  params: Record<string, unknown>;
}

function makeDataSource(
  rowsByRepo: Record<string, RawRow[]> = {},
  rowSelector?: (
    repo: string,
    params: Record<string, unknown>,
  ) => RawRow[] | undefined,
) {
  const calls: StubCall[] = [];
  function qbFactory(repositoryName: string) {
    const call: StubCall = {
      repositoryName,
      whereChain: [],
      orderByChain: [],
      params: {},
    };
    const qb: Record<string, unknown> = {};
    const self = () => qb;
    Object.assign(qb, {
      innerJoin: self,
      leftJoin: self,
      select: self,
      addSelect: self,
      where: (clause: string, params?: Record<string, unknown>) => {
        call.whereChain.push(clause);
        if (params) Object.assign(call.params, params);
        return qb;
      },
      andWhere: (clause: string, params?: Record<string, unknown>) => {
        call.whereChain.push(clause);
        if (params) Object.assign(call.params, params);
        return qb;
      },
      orderBy: (clause: string) => {
        call.orderByChain.push(clause);
        return qb;
      },
      addOrderBy: (clause: string) => {
        call.orderByChain.push(clause);
        return qb;
      },
      limit: self,
      getRawMany: async () => {
        calls.push({ ...call });
        const sel =
          rowSelector?.(repositoryName, call.params) ??
          rowsByRepo[repositoryName] ??
          [];
        return sel;
      },
      getRawOne: async () => {
        calls.push({ ...call });
        const sel =
          rowSelector?.(repositoryName, call.params) ??
          rowsByRepo[repositoryName] ??
          [];
        return sel[0];
      },
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
  };
  return { dataSource, calls };
}

function svc(ds: unknown): BookTimelineService {
  return new BookTimelineService(ds as never);
}

describe('W57-BE-AGG-06 / getLatestBookForPlan', () => {
  it('returns kind=main when no DPR / DPS exists', async () => {
    const { dataSource } = makeDataSource({
      DevelopmentPlanRevision: [],
      DevelopmentPlanSupplement: [],
      DevelopmentPlan: [{ id: 'plan-1', createdat: '2026-01-01T00:00:00Z' }],
    });
    const out = await svc(dataSource).getLatestBookForPlan('plan-1');
    expect(out).toEqual({
      kind: 'main',
      rowId: 'plan-1',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('picks the change-revision when it is the newest in the timeline', async () => {
    // §15.2 GLOBAL TIMELINE — t=1 edit, t=2 supplement, t=3 change.
    const { dataSource } = makeDataSource({
      DevelopmentPlanRevision: [
        {
          // Newest edit OR change — service queries newest by ORDER BY
          // DESC LIMIT 1, so the seed must be the change row.
          id: 'dpr-change-3',
          createdat: '2026-04-15T00:00:00Z',
          rtname: 'change',
        },
      ],
      DevelopmentPlanSupplement: [
        { id: 'dps-2', createdat: '2026-03-01T00:00:00Z' },
      ],
      DevelopmentPlan: [],
    });
    const out = await svc(dataSource).getLatestBookForPlan('plan-1');
    expect(out).not.toBeNull();
    expect(out!.kind).toBe('change');
    expect(out!.rowId).toBe('dpr-change-3');
    expect(out!.createdAt).toBe('2026-04-15T00:00:00.000Z');
  });

  it('picks the supplement when supplement is newer than the latest revision', async () => {
    const { dataSource } = makeDataSource({
      DevelopmentPlanRevision: [
        { id: 'dpr-old', createdat: '2026-02-01T00:00:00Z', rtname: 'edit' },
      ],
      DevelopmentPlanSupplement: [
        { id: 'dps-new', createdat: '2026-04-01T00:00:00Z' },
      ],
    });
    const out = await svc(dataSource).getLatestBookForPlan('plan-1');
    expect(out!.kind).toBe('supplement');
    expect(out!.rowId).toBe('dps-new');
  });

  it('treats Thai revision-type "เปลี่ยนแปลง" as change', async () => {
    const { dataSource } = makeDataSource({
      DevelopmentPlanRevision: [
        {
          id: 'dpr-th-change',
          createdat: '2026-04-01T00:00:00Z',
          rtname: 'เปลี่ยนแปลง',
        },
      ],
      DevelopmentPlanSupplement: [],
    });
    const out = await svc(dataSource).getLatestBookForPlan('plan-1');
    expect(out!.kind).toBe('change');
  });

  it('does not return soft-deleted DPR (filter via deletedAt IS NULL)', async () => {
    // The service filters `dpr.deletedAt IS NULL` in the where chain;
    // the stubs return only rows the test seeded, so a "soft-deleted"
    // row is simulated by NOT seeding it. The assertion is on the
    // where-chain content to lock the contract.
    const { dataSource, calls } = makeDataSource({
      DevelopmentPlanRevision: [],
      DevelopmentPlanSupplement: [],
      DevelopmentPlan: [{ id: 'p', createdat: '2026-01-01' }],
    });
    await svc(dataSource).getLatestBookForPlan('plan-1');
    const dprCall = calls.find(
      (c) => c.repositoryName === 'DevelopmentPlanRevision',
    );
    expect(dprCall).toBeDefined();
    expect(
      dprCall!.whereChain.some((w) => /deletedAt IS NULL/.test(w)),
    ).toBe(true);
    const dpsCall = calls.find(
      (c) => c.repositoryName === 'DevelopmentPlanSupplement',
    );
    expect(dpsCall).toBeDefined();
    expect(
      dpsCall!.whereChain.some((w) => /deletedAt IS NULL/.test(w)),
    ).toBe(true);
  });
});

describe('W57-BE-AGG-06 / getLatestProjectsByBookPartition', () => {
  it('Q3 fixture — PG{A,B,C} + RPG-edit(A) + RPG-change(B) → {mainBook:[C], editBook:[A], changeBook:[B]}', async () => {
    // The PG repo returns only HEAD rows because the service applies the
    // §14.2 anti-join. The stub does not actually evaluate the join — it
    // simulates the post-join result by seeding ONLY C in the response
    // (mirroring what the anti-join would return: A and B are excluded
    // because they have RPG descendants).
    //
    // The RPG repo returns the two HEAD revised rows: A (edit) and B
    // (change). Each carries its DPR type via the rtname column.
    const { dataSource } = makeDataSource({
      DevelopmentPlan: [{ id: 'plan-1' }],
      ProjectGroup: [{ pid: 'C', title: 'C' }],
      RevisedProjectGroup: [
        { pid: 'A', title: 'A', rtname: 'edit' },
        { pid: 'B', title: 'B', rtname: 'change' },
      ],
    });
    const out = await svc(dataSource).getLatestProjectsByBookPartition(
      'plan-1',
    );
    expect(out).not.toBeNull();
    expect(out!.planId).toBe('plan-1');
    expect(out!.mainBook).toEqual([{ projectId: 'C', name: 'C' }]);
    expect(out!.editBook).toEqual([{ projectId: 'A', name: 'A' }]);
    expect(out!.changeBook).toEqual([{ projectId: 'B', name: 'B' }]);
  });

  it('Thai revision-type "แก้ไข" routes to editBook; "เปลี่ยนแปลง" routes to changeBook', async () => {
    const { dataSource } = makeDataSource({
      DevelopmentPlan: [{ id: 'plan-1' }],
      ProjectGroup: [],
      RevisedProjectGroup: [
        { pid: 'rpg-th-edit', title: 'TH-edit', rtname: 'แก้ไข' },
        { pid: 'rpg-th-change', title: 'TH-change', rtname: 'เปลี่ยนแปลง' },
      ],
    });
    const out = await svc(dataSource).getLatestProjectsByBookPartition(
      'plan-1',
    );
    // 'แก้ไข' is not an English literal and not the change keyword, so
    // it lands in editBook.
    expect(out!.editBook.find((r) => r.projectId === 'rpg-th-edit')).toBeDefined();
    expect(
      out!.changeBook.find((r) => r.projectId === 'rpg-th-change'),
    ).toBeDefined();
  });

  it('falls back to isLatest plan when no planId supplied', async () => {
    let observedPlanId: string | undefined;
    const ds = makeDataSource(
      {
        ProjectGroup: [],
        RevisedProjectGroup: [],
      },
      (repo, params) => {
        if (repo === 'DevelopmentPlan') {
          return [{ id: 'auto-plan' }];
        }
        if (repo === 'ProjectGroup' || repo === 'RevisedProjectGroup') {
          observedPlanId = params.planId as string;
        }
        return undefined;
      },
    );
    const out = await svc(ds.dataSource).getLatestProjectsByBookPartition();
    expect(out).not.toBeNull();
    expect(out!.planId).toBe('auto-plan');
    expect(observedPlanId).toBe('auto-plan');
  });
});

describe('W57-BE-AGG-06 / parity contract with findLatestProjects', () => {
  it('bucket counts under the Q3 fixture match the canonical mainBook/editBook/changeBook split', async () => {
    // Locks the bucket arithmetic against the canonical reference
    // implementation:
    //   findLatestProjects → returns
    //     latestRevised = [RPG-A1 (edit), RPG-B1 (change)]
    //     original      = [PG-C]
    // The chat-tool partition splits latestRevised by DPR.type, so:
    //     mainBook    .length = original.length          = 1
    //     editBook    .length + changeBook.length         = latestRevised.length
    const { dataSource } = makeDataSource({
      DevelopmentPlan: [{ id: 'plan-1' }],
      ProjectGroup: [{ pid: 'C', title: 'C' }],
      RevisedProjectGroup: [
        { pid: 'A', title: 'A', rtname: 'edit' },
        { pid: 'B', title: 'B', rtname: 'change' },
      ],
    });
    const out = await svc(dataSource).getLatestProjectsByBookPartition(
      'plan-1',
    );
    expect(out!.mainBook.length).toBe(1);
    expect(out!.editBook.length + out!.changeBook.length).toBe(2);
  });
});
