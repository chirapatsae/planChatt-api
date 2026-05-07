/**
 * W67-FIX-02 — Executive status breakdown MUST NOT be truncated by the
 * `listUnifiedProjects` limit / split-budget.
 *
 * BUG REGRESSION
 * --------------
 * Pre-FIX-02 the `getExecutiveDashboardSnapshot` handler derived the
 * 4-group `executiveStatusBreakdown` by iterating the limit-capped
 * `statusMap` returned by `runDimensions`. With `scope=['all']` and
 * `limit=20`, `splitBudget` clamps main to 8 / revised to 7 /
 * supplement to 5. A user with 11 main projects therefore had THREE
 * rows truncated from the breakdown, producing the user-reported
 * symptom "11 visible projects, projectCount: 8 (after head-of-lineage
 * hides 2 — wait, it's actually 11 head + extras), executiveStatusBreakdown
 * sums to 8 instead of the correct 11".
 *
 * THE FIX
 * -------
 * `getExecutiveDashboardSnapshot` now calls a dedicated direct-DB count
 * helper, `IUnifiedProjectAggregator.countExecutiveStatusBreakdown`,
 * AFTER the resilience envelope returns. The new helper:
 *   - has NO `limit` / NO `splitBudget` — counts ALL matching rows;
 *   - reuses the SAME `applyFilters` predicate the list path uses;
 *   - applies the SAME §14.2 head-of-lineage anti-join when
 *     `includeHistoricalVersions=false`;
 *   - groups raw status counts via `mapToExecutiveStatusGroup` (the
 *     W67 4-group canonical mapping);
 *   - excludes `Ready` (per `EXEC_VISIBLE_STATUSES` / §17.2 Q8 default).
 *
 * SHAPE OF THIS SPEC
 * ------------------
 * Two layers:
 *   (A) Service-level — `UnifiedProjectAggregator.countExecutiveStatusBreakdown`
 *       is exercised against the same QB-stub harness as `unified-project-
 *       aggregator.spec.ts`. We assert the QB chain (no `.limit`, the
 *       head-of-lineage anti-join, the EXEC_VISIBLE_STATUSES IN-clause,
 *       per-kind FK column, planId / filter passthrough) and the bucket
 *       fold math.
 *   (B) Handler-level — `getExecutiveDashboardSnapshot` is invoked with
 *       a Tier B mock for `unifiedProject` whose `listUnifiedProjects`
 *       returns 8 rows (the limit-truncated list) but whose
 *       `countExecutiveStatusBreakdown` returns 11 (the true total).
 *       We assert `data.projectCount === 8` AND
 *       `data.executiveStatusBreakdown` sums to 11 — the contract that
 *       FIX-02 establishes.
 *
 * §17.2 — advisory only; no workflow gating tested here.
 * §17.3 — read-only; no `tracking_status` writes.
 * §17.9 — no raw SQL table literals (the service uses entity metadata).
 */

import { UnifiedProjectAggregator } from '../../aggregation/services/unified-project-aggregator.service';
import { EXECUTIVE_TOOL_HANDLERS } from '../handlers/executive-tool-handlers';
import {
  ExecutiveCallerContext,
  ExecutiveToolHandlerDeps,
} from '../handlers/handler-types';
import type { ExecutiveEnvelope } from '../../aggregation/types';

// ─────────────────────────────────────────────────────────────────────
// (A) Service-level harness — captures QB calls and returns canned
// per-repository raw COUNT(*) GROUP BY status.name rows.
// ─────────────────────────────────────────────────────────────────────

interface CountStubCall {
  repositoryName: string;
  /**
   * `.limit(...)` invocations on this QB. The W67-FIX-02 contract
   * REQUIRES this array to remain empty — the count path MUST NOT
   * apply the list-path limit.
   */
  limitCalls: number[];
  /** Captured WHERE / andWhere clauses (string predicates). */
  whereChain: string[];
  /** Captured bind-param map across the whole chain. */
  params: Record<string, unknown>;
  /** LEFT JOIN entity-class targets (records the lineage anti-join). */
  leftJoinTargets: string[];
  /** INNER JOIN entity-class targets (records ts/status count joins). */
  innerJoinTargets: string[];
  /** Captured GROUP BY clause. */
  groupByClause: string | null;
}

type CountRow = { statusname: string; cnt: string };

function makeCountDataSource(opts: {
  rowsByRepo?: Record<string, CountRow[]>;
}) {
  const calls: CountStubCall[] = [];
  const rowsByRepo = opts.rowsByRepo ?? {};

  function qbFactory(repositoryName: string) {
    const call: CountStubCall = {
      repositoryName,
      limitCalls: [],
      whereChain: [],
      params: {},
      leftJoinTargets: [],
      innerJoinTargets: [],
      groupByClause: null,
    };
    const qb: Record<string, unknown> = {};
    const self = () => qb;
    Object.assign(qb, {
      innerJoin: (target: unknown, _alias?: string, _cond?: string) => {
        if (typeof target === 'function') {
          const name = (target as { name?: string }).name ?? 'UnknownEntity';
          call.innerJoinTargets.push(name);
        }
        return qb;
      },
      leftJoin: (target: unknown, _alias?: string, _cond?: string) => {
        if (typeof target === 'function') {
          const name = (target as { name?: string }).name ?? 'UnknownEntity';
          call.leftJoinTargets.push(name);
        }
        return qb;
      },
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
      orderBy: self,
      groupBy: (clause: string) => {
        call.groupByClause = clause;
        return qb;
      },
      limit: (n: number) => {
        call.limitCalls.push(n);
        return qb;
      },
      getRawMany: async () => {
        calls.push(call);
        return rowsByRepo[repositoryName] ?? [];
      },
    });
    return qb;
  }

  const dataSource = {
    getRepository: (target: unknown) => {
      const repoName =
        typeof target === 'function'
          ? ((target as { name?: string }).name ?? 'Unknown')
          : 'Unknown';
      return {
        createQueryBuilder: (_alias: string) => qbFactory(repoName),
      };
    },
    // `applyFilters.budgetRange` reads `getMetadata(Budget).tableName`.
    // Provide a benign stub so any future test exercising budgetRange
    // doesn't crash. The current tests don't pass `budgetRange`.
    getMetadata: (_entity: unknown) => ({ tableName: 'budget_test' }),
  };

  return { dataSource, calls };
}

function svc(ds: unknown): UnifiedProjectAggregator {
  return new UnifiedProjectAggregator(ds as never);
}

describe('W67-FIX-02 — UnifiedProjectAggregator.countExecutiveStatusBreakdown', () => {
  describe('limit / split-budget independence (the core regression)', () => {
    it('applies NO `.limit(...)` to any per-kind COUNT query', async () => {
      const { dataSource, calls } = makeCountDataSource({
        rowsByRepo: {
          ProjectGroup: [],
          RevisedProjectGroup: [],
          SupplementProjectGroup: [],
        },
      });
      await svc(dataSource).countExecutiveStatusBreakdown({
        scope: ['all'],
      });
      expect(calls).toHaveLength(3);
      for (const c of calls) {
        expect(c.limitCalls).toEqual([]);
      }
    });

    it('returns FULL totals across all 11 main projects even though listUnifiedProjects would cap main to 8', async () => {
      // Seed: 11 main projects spread across the four executive
      // buckets. The list path with scope=['all'] and limit=20 would
      // truncate main to 8 (40% of 20 = 8). The COUNT path MUST
      // surface all 11 because it bypasses splitBudget.
      const { dataSource } = makeCountDataSource({
        rowsByRepo: {
          ProjectGroup: [
            // 1 Pending → pending_review
            { statusname: 'Pending', cnt: '1' },
            // 4 Pending_Approval → awaiting_approval
            { statusname: 'Pending_Approval', cnt: '4' },
            // 6 Approved → approved
            { statusname: 'Approved', cnt: '6' },
          ],
          RevisedProjectGroup: [],
          SupplementProjectGroup: [],
        },
      });
      const out = await svc(dataSource).countExecutiveStatusBreakdown({
        scope: ['all'],
      });
      expect(out).toEqual({
        pendingReviewCount: 1,
        awaitingApprovalCount: 4,
        approvedCount: 6,
        rejectedCount: 0,
      });
      // Sanity: total === 11 (NOT 8 — the would-be split-budget cap).
      const total =
        out.pendingReviewCount +
        out.awaitingApprovalCount +
        out.approvedCount +
        out.rejectedCount;
      expect(total).toBe(11);
    });
  });

  describe('§14.2 head-of-lineage filter', () => {
    it('attaches the RevisedProjectGroup anti-join to PG and RPG by default', async () => {
      const { dataSource, calls } = makeCountDataSource({
        rowsByRepo: {
          ProjectGroup: [],
          RevisedProjectGroup: [],
        },
      });
      await svc(dataSource).countExecutiveStatusBreakdown({
        scope: ['main', 'revised'],
      });
      const pg = calls.find((c) => c.repositoryName === 'ProjectGroup');
      const rpg = calls.find((c) => c.repositoryName === 'RevisedProjectGroup');
      expect(pg).toBeDefined();
      expect(rpg).toBeDefined();
      // Each kind attaches RevisedProjectGroup as the anti-join target.
      expect(pg!.leftJoinTargets).toContain('RevisedProjectGroup');
      expect(rpg!.leftJoinTargets).toContain('RevisedProjectGroup');
      // The anti-join ANDs an `IS NULL` clause that pins HEAD rows.
      expect(pg!.whereChain.some((w) => /IS NULL/.test(w))).toBe(true);
      expect(rpg!.whereChain.some((w) => /IS NULL/.test(w))).toBe(true);
    });

    it('SHORT-CIRCUITS the anti-join when includeHistoricalVersions=true', async () => {
      const { dataSource, calls } = makeCountDataSource({
        rowsByRepo: { ProjectGroup: [] },
      });
      await svc(dataSource).countExecutiveStatusBreakdown({
        scope: ['main'],
        includeHistoricalVersions: true,
      });
      const pg = calls.find((c) => c.repositoryName === 'ProjectGroup');
      expect(pg).toBeDefined();
      // The anti-join MUST NOT be attached when the caller explicitly
      // asks for historical rows.
      expect(pg!.leftJoinTargets).not.toContain('RevisedProjectGroup');
    });

    it('does NOT attach the anti-join to SupplementProjectGroup (SPG is not part of the §14.1 PG/RPG chain)', async () => {
      const { dataSource, calls } = makeCountDataSource({
        rowsByRepo: { SupplementProjectGroup: [] },
      });
      await svc(dataSource).countExecutiveStatusBreakdown({
        scope: ['supplement'],
      });
      const spg = calls.find(
        (c) => c.repositoryName === 'SupplementProjectGroup',
      );
      expect(spg).toBeDefined();
      expect(spg!.leftJoinTargets).not.toContain('RevisedProjectGroup');
    });
  });

  describe('empty / defensive input', () => {
    it('returns all-zero counts when scope is missing', async () => {
      const { dataSource, calls } = makeCountDataSource({});
      const out = await svc(dataSource).countExecutiveStatusBreakdown({
        scope: undefined as never,
      });
      expect(out).toEqual({
        pendingReviewCount: 0,
        awaitingApprovalCount: 0,
        approvedCount: 0,
        rejectedCount: 0,
      });
      expect(calls).toHaveLength(0);
    });

    it('returns all-zero counts when scope is an empty array', async () => {
      const { dataSource, calls } = makeCountDataSource({});
      const out = await svc(dataSource).countExecutiveStatusBreakdown({
        scope: [],
      });
      expect(out).toEqual({
        pendingReviewCount: 0,
        awaitingApprovalCount: 0,
        approvedCount: 0,
        rejectedCount: 0,
      });
      expect(calls).toHaveLength(0);
    });

    it('returns all-zero counts when no rows match (e.g. plan with zero projects)', async () => {
      const { dataSource } = makeCountDataSource({
        rowsByRepo: {
          ProjectGroup: [],
          RevisedProjectGroup: [],
          SupplementProjectGroup: [],
        },
      });
      const out = await svc(dataSource).countExecutiveStatusBreakdown({
        scope: ['all'],
        planId: '00000000-0000-0000-0000-000000000000',
      });
      expect(out).toEqual({
        pendingReviewCount: 0,
        awaitingApprovalCount: 0,
        approvedCount: 0,
        rejectedCount: 0,
      });
    });
  });

  describe('filter consistency with listUnifiedProjects', () => {
    it('forwards planId to dp.id predicate', async () => {
      const { dataSource, calls } = makeCountDataSource({
        rowsByRepo: { ProjectGroup: [] },
      });
      await svc(dataSource).countExecutiveStatusBreakdown({
        scope: ['main'],
        planId: 'plan-abc',
      });
      const pg = calls.find((c) => c.repositoryName === 'ProjectGroup');
      expect(pg!.params.planId).toBe('plan-abc');
      expect(pg!.whereChain.some((w) => w.includes('dp.id = :planId'))).toBe(
        true,
      );
    });

    it('forwards filters.agencyIds through applyFilters', async () => {
      const { dataSource, calls } = makeCountDataSource({
        rowsByRepo: { ProjectGroup: [] },
      });
      await svc(dataSource).countExecutiveStatusBreakdown({
        scope: ['main'],
        filters: { agencyIds: ['42'] },
      });
      const pg = calls.find((c) => c.repositoryName === 'ProjectGroup');
      // applyFilters coerces agencyIds via Number(x) and feeds the
      // numeric array as `agencyIdsFilter`.
      expect(pg!.params.agencyIdsFilter).toEqual([42]);
      expect(
        pg!.whereChain.some((w) =>
          w.includes('responsible_agency_id IN (:...agencyIdsFilter)'),
        ),
      ).toBe(true);
    });
  });

  describe('Ready exclusion (EXEC_VISIBLE_STATUSES)', () => {
    it('binds the EXEC_VISIBLE_STATUSES whitelist into the COUNT query', async () => {
      const { dataSource, calls } = makeCountDataSource({
        rowsByRepo: { ProjectGroup: [] },
      });
      await svc(dataSource).countExecutiveStatusBreakdown({
        scope: ['main'],
      });
      const pg = calls.find((c) => c.repositoryName === 'ProjectGroup');
      // The whitelist bind param's exact name (one of *Main / *Revised /
      // *Supplement) is an implementation detail; assert by content.
      const visible = Object.values(pg!.params).find(
        (v) => Array.isArray(v) && v.includes('Approved'),
      );
      expect(Array.isArray(visible)).toBe(true);
      const list = visible as string[];
      expect(list).toContain('Pending');
      expect(list).toContain('Verified');
      expect(list).toContain('Pending_Approval');
      expect(list).toContain('Approved');
      // Ready is INTENTIONALLY excluded.
      expect(list).not.toContain('Ready');
    });

    it('folds raw rows into the four buckets and ignores Ready entries that somehow leak through', async () => {
      // Defense-in-depth: even if the SQL whitelist failed and a Ready
      // row reached the fold step, `mapToExecutiveStatusGroup` returns
      // null for Ready so the bucket totals stay correct.
      const { dataSource } = makeCountDataSource({
        rowsByRepo: {
          ProjectGroup: [
            { statusname: 'Ready', cnt: '5' }, // ignored
            { statusname: 'Approved', cnt: '3' },
          ],
          RevisedProjectGroup: [],
          SupplementProjectGroup: [],
        },
      });
      const out = await svc(dataSource).countExecutiveStatusBreakdown({
        scope: ['all'],
      });
      expect(out).toEqual({
        pendingReviewCount: 0,
        awaitingApprovalCount: 0,
        approvedCount: 3,
        rejectedCount: 0,
      });
    });
  });

  describe('TrackingStatus + Status inner-join wiring', () => {
    it('inner-joins TrackingStatus and Status entity classes', async () => {
      const { dataSource, calls } = makeCountDataSource({
        rowsByRepo: { ProjectGroup: [] },
      });
      await svc(dataSource).countExecutiveStatusBreakdown({
        scope: ['main'],
      });
      const pg = calls.find((c) => c.repositoryName === 'ProjectGroup');
      expect(pg!.innerJoinTargets).toContain('TrackingStatus');
      expect(pg!.innerJoinTargets).toContain('Status');
    });

    it('groups by status.name', async () => {
      const { dataSource, calls } = makeCountDataSource({
        rowsByRepo: { ProjectGroup: [] },
      });
      await svc(dataSource).countExecutiveStatusBreakdown({
        scope: ['main'],
      });
      const pg = calls.find((c) => c.repositoryName === 'ProjectGroup');
      expect(pg!.groupByClause).toBe('st_count.name');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// (B) Handler-level wiring — `getExecutiveDashboardSnapshot` MUST source
// `executiveStatusBreakdown` from the count helper, not from the limit-
// capped status map.
// ─────────────────────────────────────────────────────────────────────

function makeCtx(
  overrides: Partial<ExecutiveCallerContext> = {},
): ExecutiveCallerContext {
  return {
    userId: 'u',
    workHistoryId: 'wh',
    roleName: 'admin',
    workStatusName: 'approved',
    ...overrides,
  };
}

function makeHandlerDeps(opts: {
  listLength: number;
  countResult: {
    pendingReviewCount: number;
    awaitingApprovalCount: number;
    approvedCount: number;
    rejectedCount: number;
  };
}): {
  deps: ExecutiveToolHandlerDeps;
  listUnifiedProjects: jest.Mock;
  countExecutiveStatusBreakdown: jest.Mock;
} {
  // Simulate the limit-truncated list (8 main rows in the production
  // bug scenario). Shape-wise we only need `projectKind` + `projectId`
  // for the handler's runDimensions task plumbing; classification
  // fields are unused when groupBy is empty / status only.
  const fakeListRows = Array.from({ length: opts.listLength }, (_, i) => ({
    projectKind: 'main' as const,
    projectId: `p${i}`,
    name: `proj-${i}`,
    planId: 'plan-1',
    planReportFormat: 'STRATEGY_BASED' as const,
    amphoeId: null,
    responsibleAgencyId: null,
    strategyId: null,
    tacticId: null,
    planLevelId: null,
    indicator: null,
    developmentIssueId: null,
    originType: 'lao-coordinated' as const,
  }));
  const listUnifiedProjects = jest.fn().mockResolvedValue(fakeListRows);
  const countExecutiveStatusBreakdown = jest
    .fn()
    .mockResolvedValue(opts.countResult);

  // Resilience envelope: pass through `assemble` like the production
  // implementation; we only care that the handler then merges
  // `executiveStatusBreakdown` AFTER runDimensions returns.
  const runDimensions = jest.fn(
    async (
      _tasks: Array<{ dimension: string }>,
      assemble: (results: unknown[]) => unknown,
      options: { shape: string },
    ) => ({
      shape: options.shape,
      data: assemble([]) as Record<string, unknown>,
      asOf: new Date().toISOString(),
      missingDimensions: [],
      advisories: [],
      partial: false,
    }),
  );

  const deps: ExecutiveToolHandlerDeps = {
    dataSource: {} as never,
    unifiedProject: {
      listUnifiedProjects,
      countExecutiveStatusBreakdown,
    } as never,
    budget: {
      totalsForUnifiedProjects: jest.fn().mockResolvedValue(new Map()),
    } as never,
    status: {
      latestStatusFor: jest.fn().mockResolvedValue(new Map()),
    } as never,
    geo: {
      annotate: jest.fn().mockResolvedValue({
        labels: new Map(),
        missingDimensions: [],
        advisories: [],
      }),
    } as never,
    agency: {
      annotate: jest.fn().mockResolvedValue({
        labels: new Map(),
        missingDimensions: [],
        advisories: [],
      }),
    } as never,
    resilience: { runDimensions } as never,
  };
  return { deps, listUnifiedProjects, countExecutiveStatusBreakdown };
}

describe('W67-FIX-02 — getExecutiveDashboardSnapshot wires the count helper', () => {
  it('uses countExecutiveStatusBreakdown for `executiveStatusBreakdown` (not the limit-capped statusMap)', async () => {
    // List returns 8 rows (the 40% of 20 main cap). Count returns 11
    // (the true total before truncation). The handler MUST surface the
    // latter as `data.executiveStatusBreakdown`.
    const { deps, countExecutiveStatusBreakdown } = makeHandlerDeps({
      listLength: 8,
      countResult: {
        pendingReviewCount: 1,
        awaitingApprovalCount: 4,
        approvedCount: 6,
        rejectedCount: 0,
      },
    });

    const env = (await EXECUTIVE_TOOL_HANDLERS.getExecutiveDashboardSnapshot(
      { scope: ['all'], includeStatus: true },
      makeCtx(),
      deps,
    )) as unknown as ExecutiveEnvelope<Record<string, unknown>>;

    // The truncated list is reflected in projectCount (correct — it's a
    // list-display field).
    expect(env.data.projectCount).toBe(8);
    // The breakdown is the true total (the FIX-02 contract).
    expect(env.data.executiveStatusBreakdown).toEqual({
      pendingReviewCount: 1,
      awaitingApprovalCount: 4,
      approvedCount: 6,
      rejectedCount: 0,
    });
    // Sanity: 1 + 4 + 6 + 0 = 11, NOT the 8 the list path would have
    // produced.
    const breakdown = env.data.executiveStatusBreakdown as Record<
      string,
      number
    >;
    const total =
      breakdown.pendingReviewCount +
      breakdown.awaitingApprovalCount +
      breakdown.approvedCount +
      breakdown.rejectedCount;
    expect(total).toBe(11);

    // The count helper is invoked with the SAME planId / scope /
    // filters / includeHistoricalVersions the list path used.
    expect(countExecutiveStatusBreakdown).toHaveBeenCalledTimes(1);
    const callArg = countExecutiveStatusBreakdown.mock.calls[0][0];
    expect(callArg.scope).toEqual(['all']);
    expect(callArg.includeHistoricalVersions).toBe(false);
  });

  it('skips the count call when includeStatus is explicitly false', async () => {
    const { deps, countExecutiveStatusBreakdown } = makeHandlerDeps({
      listLength: 0,
      countResult: {
        pendingReviewCount: 0,
        awaitingApprovalCount: 0,
        approvedCount: 0,
        rejectedCount: 0,
      },
    });

    await EXECUTIVE_TOOL_HANDLERS.getExecutiveDashboardSnapshot(
      { scope: ['all'], includeStatus: false },
      makeCtx(),
      deps,
    );
    expect(countExecutiveStatusBreakdown).not.toHaveBeenCalled();
  });

  it('forwards the filters clause to the count helper unchanged', async () => {
    const { deps, countExecutiveStatusBreakdown } = makeHandlerDeps({
      listLength: 0,
      countResult: {
        pendingReviewCount: 2,
        awaitingApprovalCount: 0,
        approvedCount: 0,
        rejectedCount: 0,
      },
    });

    await EXECUTIVE_TOOL_HANDLERS.getExecutiveDashboardSnapshot(
      {
        scope: ['main'],
        includeStatus: true,
        filters: { agencyIds: ['7'] },
      },
      makeCtx(),
      deps,
    );

    expect(countExecutiveStatusBreakdown).toHaveBeenCalledTimes(1);
    const callArg = countExecutiveStatusBreakdown.mock.calls[0][0];
    expect(callArg.scope).toEqual(['main']);
    expect(callArg.filters).toEqual({ agencyIds: ['7'] });
  });

  it('returns all-zero breakdown for an empty plan (defensive)', async () => {
    const { deps } = makeHandlerDeps({
      listLength: 0,
      countResult: {
        pendingReviewCount: 0,
        awaitingApprovalCount: 0,
        approvedCount: 0,
        rejectedCount: 0,
      },
    });

    const env = (await EXECUTIVE_TOOL_HANDLERS.getExecutiveDashboardSnapshot(
      {
        scope: ['all'],
        includeStatus: true,
        planId: '00000000-0000-0000-0000-000000000000',
      },
      makeCtx(),
      deps,
    )) as unknown as ExecutiveEnvelope<Record<string, unknown>>;

    expect(env.data.projectCount).toBe(0);
    expect(env.data.executiveStatusBreakdown).toEqual({
      pendingReviewCount: 0,
      awaitingApprovalCount: 0,
      approvedCount: 0,
      rejectedCount: 0,
    });
  });

  it('§17.2 advisory-only — count helper failure does NOT throw out of the handler', async () => {
    const { deps, countExecutiveStatusBreakdown } = makeHandlerDeps({
      listLength: 0,
      countResult: {
        pendingReviewCount: 0,
        awaitingApprovalCount: 0,
        approvedCount: 0,
        rejectedCount: 0,
      },
    });
    // Override the stub to reject.
    countExecutiveStatusBreakdown.mockRejectedValueOnce(
      new Error('synthetic DB outage'),
    );

    const env = (await EXECUTIVE_TOOL_HANDLERS.getExecutiveDashboardSnapshot(
      { scope: ['all'], includeStatus: true },
      makeCtx(),
      deps,
    )) as unknown as ExecutiveEnvelope<Record<string, unknown>>;

    // The handler still returns a valid envelope; `executiveStatusBreakdown`
    // is simply omitted (undefined) so the LLM falls back to the per-row
    // limit-capped buckets rather than crashing the whole turn.
    expect(env.shape).toBe('dashboardSnapshot');
    expect(env.data.executiveStatusBreakdown).toBeUndefined();
  });
});
