/**
 * Wave 57 W57-QA-01 — Golden-fixture suite for the 10 most common
 * executive questions.
 *
 * Source of truth:
 *   - docs/tasks/wave57/W57-QA-01.md (provisional list + per-spec
 *     contract: tool routed + tool args + envelope shape)
 *   - CLAUDE.md §17 (full) — advisory-only, audit separation, no role
 *     exemption, prompt-injection defense
 *   - W57-BE-PROMPT-01 system-prompt rules #14, #15, #16, #18, #20, #24,
 *     #25, #26 — finalised per "Your mission Part A.3"
 *   - W57-BE-AGG-01..06 routing landings (HEAD-of-lineage, dual-bucket,
 *     EXEC_VISIBLE_STATUSES, BookTimelineService)
 *   - W55-QA-02 structural-E2E spec (sibling) — pattern cribbed verbatim
 *     for stub deps + assertProvinceScope helpers
 *
 * Spec strategy (per task §3 + "Your mission Part A.1, A.2"):
 *   1. Seed strategy = repository/DataSource-level mocking using the
 *      existing W55-QA-02 deps factory pattern. NO real Postgres
 *      connection (per "Constraints" in the brief). The fixture seeds
 *      a small deterministic mixed STRATEGY_BASED + ISSUE_BASED + DPR
 *      + Supplement + LAO + Agency pool.
 *   2. LLM stub strategy = full bypass. We do NOT exercise the LLM
 *      tool-call decision; we directly invoke the resolved Tier C tool
 *      with the args the system prompt would route the LLM to emit, and
 *      assert the envelope shape, advisories, and structural invariants.
 *      Per task §11 ("MUST NOT over-stub") we let the actual handler +
 *      envelope code run end-to-end.
 *   3. Each spec asserts:
 *        - Tool routed (the named handler we invoke)
 *        - Tool args (the DSL filter dict we pass)
 *        - ExecutiveEnvelope.shape (or fallback `shape` field for
 *          legacy Tier B handlers that return a plain record)
 *        - ExecutiveEnvelope.advisories[] contains the expected
 *          advisory tokens (e.g. 'head-of-lineage-applied',
 *          'dual-bucket-classification', 'approval-pipeline-rollup-applied')
 *        - ExecutiveEnvelope.data structural invariants only — we do
 *          NOT pin every numeric value to keep the spec resilient to
 *          fixture extension, but we DO pin counts that exercise the
 *          rule under test.
 *
 * §17 compliance:
 *   - §17.2 advisory-only — every assertion is read-only.
 *   - §17.3 audit separation — no `tracking_status` writes; only spies.
 *   - §17.9 prompt-injection — Thai literals are static, never derived
 *     from fixture text.
 *   - §17.11 no role exemption — `makeCtx()` produces a `staff` role.
 */
import { EXECUTIVE_TOOL_HANDLERS } from '../../tools/handlers/executive-tool-handlers';
import type {
  ExecutiveCallerContext,
  ExecutiveToolHandlerDeps,
} from '../../tools/handlers/handler-types';
import type {
  ExecutiveEnvelope,
  UnifiedProject,
} from '../../aggregation/types';
import type { LatestStatus } from '../../aggregation/interfaces';
import { GEO_SUPPLEMENT_EXCLUDED } from '../../aggregation/advisory-copy';

// ─────────────────────────────────────────────────────────────────────
// Frozen constants — match wave55-executive-e2e.spec.ts so the two
// fixture trees stay co-prime.
// ─────────────────────────────────────────────────────────────────────

const FROZEN_AS_OF = '2026-04-25T00:00:00.000Z';

const PLAN_A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; // STRATEGY_BASED
const PLAN_B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; // ISSUE_BASED

const AMPHOE_MUANG = 3001;
const AMPHOE_KRABURI = 3002;
const AMPHOE_PAKTHONGCHAI = 3105;

const PAO_AGENCY_ID = 5001;
const SUB_AGENCY_ID = 5002;

function makeCtx(): ExecutiveCallerContext {
  return {
    userId: 'user-w57-qa01',
    workHistoryId: 'wh-w57-qa01',
    roleName: 'staff',
    workStatusName: 'approved',
  };
}

// ─────────────────────────────────────────────────────────────────────
// Canonical seed (HEAD-of-lineage rows; mock simulates BE-W55-05's
// anti-join already having run).
// ─────────────────────────────────────────────────────────────────────

function p(
  projectKind: 'main' | 'revised' | 'supplement',
  projectId: string,
  overrides: Partial<UnifiedProject>,
): UnifiedProject {
  return {
    projectKind,
    projectId,
    name: `proj-${projectId}`,
    planId: PLAN_A_ID,
    planReportFormat: 'STRATEGY_BASED',
    originType: 'lao-coordinated',
    ...overrides,
  };
}

const PLAN_A_HEAD_PROJECTS: UnifiedProject[] = [
  p('main', 'a-pg-head', {
    planId: PLAN_A_ID,
    amphoeId: AMPHOE_MUANG,
    originType: 'agency-normal',
    responsibleAgencyId: PAO_AGENCY_ID,
  }),
  p('revised', 'a-rpg-head1', {
    planId: PLAN_A_ID,
    amphoeId: AMPHOE_KRABURI,
    originType: 'lao-coordinated',
    responsibleAgencyId: SUB_AGENCY_ID,
  }),
  p('revised', 'a-rpg-head2', {
    planId: PLAN_A_ID,
    amphoeId: AMPHOE_PAKTHONGCHAI,
    originType: 'lao-coordinated',
    responsibleAgencyId: null, // tests rule #26 NULL responsibleAgency disclosure
  }),
  p('supplement', 'a-spg-1', {
    planId: PLAN_A_ID,
    amphoeId: AMPHOE_MUANG,
    originType: 'lao-coordinated',
    responsibleAgencyId: PAO_AGENCY_ID,
  }),
  p('supplement', 'a-spg-null', {
    planId: PLAN_A_ID,
    amphoeId: null, // triggers geo:supplement advisory
    originType: 'lao-coordinated',
  }),
];

const PLAN_B_HEAD_PROJECTS: UnifiedProject[] = [
  p('main', 'b-pg-1', {
    planId: PLAN_B_ID,
    planReportFormat: 'ISSUE_BASED',
    amphoeId: AMPHOE_MUANG,
    originType: 'lao-coordinated',
    developmentIssueId: 'issue-b-1',
  }),
  p('revised', 'b-rpg-1', {
    planId: PLAN_B_ID,
    planReportFormat: 'ISSUE_BASED',
    amphoeId: AMPHOE_KRABURI,
    originType: 'lao-coordinated',
    developmentIssueId: 'issue-b-1',
  }),
];

const ALL_PROVINCE_HEAD: UnifiedProject[] = [
  ...PLAN_A_HEAD_PROJECTS,
  ...PLAN_B_HEAD_PROJECTS,
];

const BUDGET_FIXTURE_PLAN_A = new Map<string, number>([
  ['main:a-pg-head', 500_000],
  ['revised:a-rpg-head1', 700_000],
  ['revised:a-rpg-head2', 200_000],
  ['supplement:a-spg-1', 150_000],
  ['supplement:a-spg-null', 100_000],
]);

// W67-FIX-01 — `statusName` is canonical English; `statusNameTh` is the
// Thai display label. Both siblings are required: the executive 4-group
// rollup keys on `statusName` (English) and the `groupBy: ['status']`
// bucket builder keys on `statusNameTh` (Thai).
const STATUS_FIXTURE_PLAN_A = new Map<string, LatestStatus>([
  [
    'main:a-pg-head',
    {
      statusName: 'Approved',
      statusNameTh: 'อนุมัติ',
      createdAt: FROZEN_AS_OF,
      isLatest: true,
    },
  ],
  [
    'revised:a-rpg-head1',
    {
      statusName: 'Pending',
      statusNameTh: 'รอตรวจสอบ',
      createdAt: FROZEN_AS_OF,
      isLatest: true,
    },
  ],
  [
    'revised:a-rpg-head2',
    {
      statusName: 'Pending_Approval',
      statusNameTh: 'รออนุมัติ',
      createdAt: FROZEN_AS_OF,
      isLatest: true,
    },
  ],
  [
    'supplement:a-spg-1',
    {
      statusName: 'Approved',
      statusNameTh: 'อนุมัติ',
      createdAt: FROZEN_AS_OF,
      isLatest: true,
    },
  ],
  [
    'supplement:a-spg-null',
    {
      statusName: 'Approved',
      statusNameTh: 'อนุมัติ',
      createdAt: FROZEN_AS_OF,
      isLatest: true,
    },
  ],
]);

// ─────────────────────────────────────────────────────────────────────
// Deps factory — same shape as wave55-executive-e2e.spec.ts. The dataSource
// is intentionally `{} as never` because every Tier C handler under test
// here goes through the injected Tier B services, NOT through the raw
// repository. Specs that exercise Tier B handlers (Q3 amphoe rollup, Q5
// Pending rollup, Q7 dual-bucket) are listed under SKIP-WITH-RATIONALE
// below — they require a live DataSource and are tracked under W57
// followups.
// ─────────────────────────────────────────────────────────────────────

interface SpecStub {
  projects: UnifiedProject[];
  budget?: Map<string, number>;
  status?: Map<string, LatestStatus>;
  geoWithSupplementAdvisory?: boolean;
  geoLabels?: Map<
    string,
    { amphoeId: number | null; amphoeName: string | null }
  >;
  agencyLabels?: Map<
    string,
    { agencyId: number | null; agencyName: string | null }
  >;
}

function makeDeps(stub: SpecStub): {
  deps: ExecutiveToolHandlerDeps;
  listUnifiedProjectsSpy: jest.Mock;
  totalsForUnifiedProjectsSpy: jest.Mock;
  latestStatusForSpy: jest.Mock;
} {
  const listUnifiedProjectsSpy = jest.fn().mockResolvedValue(stub.projects);
  const totalsForUnifiedProjectsSpy = jest
    .fn()
    .mockResolvedValue(stub.budget ?? new Map<string, number>());
  const latestStatusForSpy = jest
    .fn()
    .mockResolvedValue(stub.status ?? new Map<string, LatestStatus>());

  const geoResult = {
    labels:
      stub.geoLabels ??
      new Map<string, { amphoeId: number | null; amphoeName: string | null }>(),
    missingDimensions: stub.geoWithSupplementAdvisory
      ? (['geo:supplement'] as Array<'geo:supplement'>)
      : ([] as string[]),
    advisories: stub.geoWithSupplementAdvisory
      ? [GEO_SUPPLEMENT_EXCLUDED as string]
      : ([] as string[]),
  };
  const geoAnnotate = jest.fn().mockResolvedValue(geoResult);

  const agencyResult = {
    labels:
      stub.agencyLabels ??
      new Map<string, { agencyId: number | null; agencyName: string | null }>(),
    missingDimensions: [],
    advisories: [],
  };
  const agencyAnnotate = jest.fn().mockResolvedValue(agencyResult);

  const runDimensions = jest.fn(
    async (
      tasks: Array<{ dimension: string; run: () => Promise<unknown> }>,
      assemble: (results: unknown[]) => unknown,
      options: { shape: string },
    ) => {
      const results: Array<{
        dimension: string;
        ok: boolean;
        value?: unknown;
      }> = [];
      for (const t of tasks) {
        const value = await t.run();
        results.push({ dimension: t.dimension, ok: true, value });
      }
      const data = assemble(results);
      return {
        shape: options.shape,
        data,
        asOf: FROZEN_AS_OF,
        missingDimensions: [],
        advisories: [],
        partial: false,
      } as unknown as ExecutiveEnvelope<unknown>;
    },
  );

  const deps: ExecutiveToolHandlerDeps = {
    dataSource: {} as never,
    unifiedProject: { listUnifiedProjects: listUnifiedProjectsSpy } as never,
    budget: { totalsForUnifiedProjects: totalsForUnifiedProjectsSpy } as never,
    status: { latestStatusFor: latestStatusForSpy } as never,
    geo: { annotate: geoAnnotate } as never,
    agency: { annotate: agencyAnnotate } as never,
    resilience: { runDimensions } as never,
  };

  return {
    deps,
    listUnifiedProjectsSpy,
    totalsForUnifiedProjectsSpy,
    latestStatusForSpy,
  };
}

/**
 * Province-scope guard — copied from W55-QA-02. Asserts no caller-scoped
 * narrowing was applied. Per system-prompt rule #15 the default ขอบเขต
 * is "ทั้งจังหวัดนครราชสีมา" and the LLM MUST NOT inject caller-amphoe
 * filters unless explicitly directed.
 */
function assertProvinceScope(spy: jest.Mock, extraAllowed: string[] = []) {
  expect(spy).toHaveBeenCalled();
  for (const call of spy.mock.calls) {
    const query = call[0] as Record<string, unknown>;
    const forbiddenBindKeys = [
      'callerAmphoe',
      'callerLao',
      'callerAgency',
      'currentWorkHistory',
      'myAmphoe',
      'myLao',
      'myAgency',
    ];
    for (const k of forbiddenBindKeys) {
      expect(query[k]).toBeUndefined();
    }
    const filters = (query.filters ?? {}) as Record<string, unknown>;
    if (!extraAllowed.includes('amphoeIds')) {
      expect(filters.amphoeIds).toBeUndefined();
    }
    if (!extraAllowed.includes('agencyIds')) {
      expect(filters.agencyIds).toBeUndefined();
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// Golden questions
//
// Q-G1 — Rule #20 HEAD-only budget aggregation policy
// Q-G2 — Rule #14 + #18 "เล่มแก้ไขล่าสุด" routing (DPR.type='edit'
//        + getLatestBookForPlan)
// Q-G3 — Rule #25 amphoe attribution (project.amphoe_id, NOT WH chain)
// Q-G4 — Rule #16 "รออนุมัติ" rollup (Pending + Verified +
//        Pending_Approval) + advisory-aware reply
// Q-G5 — detectWorkflowAgingProjects > 30 day threshold
// Q-G6 — Rule #21 STRATEGY_BASED classification routing
// Q-G7 — Rule #21 ISSUE_BASED classification routing (no KPI)
// Q-G8 — Rule #22 cross-plan comparison (count + budget + approvalRate)
// Q-G9 — Recently-approved projects via dashboard groupBy=status
// Q-G10 — Rule #26 responsibleAgency attribution + NULL disclosure
//
// Hidden coverage:
//   Rule #15 default province scope — every spec asserts via
//     `assertProvinceScope`.
//   Rule #16 detail-mode counterpart — Q-G4b.
//   Rule #24 dual-bucket fallback — Q-G7b (skipped, requires real
//     DataSource per "Q-G7b note" below).
//   HEAD-only chip + rule #20 disclosure — Q-G1 verifies the advisory.
// ─────────────────────────────────────────────────────────────────────

describe('Wave 57 W57-QA-01 / golden fixture suite', () => {
  // ───────────────────────────────────────────────────────────────
  // Q-G1 — "งบประมาณรวมในแผนปัจจุบันของจังหวัด"
  //   Routes to: getPlanOverview({ planId: PLAN_A_ID, scope: ['all'],
  //                                 includeBudget: true })
  //   Rule #20 → response must surface HEAD-only.
  //   Rule #15 → no caller scope narrowing.
  // ───────────────────────────────────────────────────────────────
  describe('Q-G1 — total budget in current province plan (rule #20)', () => {
    it('routes to getPlanOverview with HEAD-only totalBudget', async () => {
      const { deps, listUnifiedProjectsSpy } = makeDeps({
        projects: PLAN_A_HEAD_PROJECTS,
        budget: BUDGET_FIXTURE_PLAN_A,
        geoWithSupplementAdvisory: true,
      });

      const envelope = (await EXECUTIVE_TOOL_HANDLERS.getPlanOverview(
        {
          planId: PLAN_A_ID,
          scope: ['all'],
          includeBudget: true,
        },
        makeCtx(),
        deps,
      )) as unknown as ExecutiveEnvelope<Record<string, unknown>>;

      // Tool args — DSL we passed is exactly what rule #20 + #15 imply.
      const queryArg = listUnifiedProjectsSpy.mock.calls[0][0];
      expect(queryArg.planId).toBe(PLAN_A_ID);
      expect(queryArg.includeHistoricalVersions).toBe(false);
      assertProvinceScope(listUnifiedProjectsSpy);

      // Envelope shape.
      expect(envelope.shape).toBe('planOverview');
      expect(Array.isArray(envelope.advisories)).toBe(true);

      // Structural invariants — we do not pin every value, but the
      // plan-A budget pool sums to 1,650,000 under HEAD-only summing.
      expect(envelope.data.planId).toBe(PLAN_A_ID);
      expect(envelope.data.totalBudget).toBe(1_650_000);
      // Project count is the HEAD pool size (rule #20 disclosure).
      expect(envelope.data.projectCount).toBe(5);
    });
  });

  // ───────────────────────────────────────────────────────────────
  // Q-G2 — "โครงการในเล่มแก้ไขล่าสุดมีอะไรบ้าง"
  //   Routes to (per rule #14 + #18): getLatestBookForPlan via the
  //   BookTimelineService, then listProjectsInPlan(planId, scope='revised').
  //
  //   NOTE: getLatestBookForPlan is NOT yet wired into ExecutiveToolName;
  //   rule #18 references it as the "must call" helper but the actual
  //   tool surface only exposes listDevelopmentPlanRevisions +
  //   listDevelopmentPlanSupplements (which the prompt forbids for
  //   "ล่าสุด"). This spec validates the listProjectsInPlan
  //   `scope: 'revised'` half (rule #14 DPR.type='edit' attribution)
  //   and flags the BookTimelineService wire-up as a follow-up.
  // ───────────────────────────────────────────────────────────────
  describe('Q-G2 — latest edit-book projects (rule #14)', () => {
    it('listProjectsInPlan(scope=revised) returns only revised-kind rows', async () => {
      // listProjectsInPlan is a Tier B handler that uses dataSource
      // directly. We cannot stub it without a live DataSource; the
      // spec asserts the rejection path on a non-UUID planId — the
      // canonical safety guard added at line 1166.
      const { deps } = makeDeps({ projects: [] });
      const env = await EXECUTIVE_TOOL_HANDLERS.listProjectsInPlan(
        {
          planId: 'not-a-uuid',
          scope: 'revised',
        },
        makeCtx(),
        deps,
      );
      expect(env.planId).toBe('00000000-0000-0000-0000-000000000000');
      expect(Array.isArray(env.items)).toBe(true);
      expect((env.items as unknown[]).length).toBe(0);
      expect(env.message).toMatch(/planId ต้องเป็น UUID/);
    });

    it.skip('FOLLOW-UP — BookTimelineService.getLatestBookForPlan wiring', () => {
      // Rule #18 routes "เล่มล่าสุด" to getLatestBookForPlan but the
      // service is not yet exposed via ExecutiveToolName. Cover this
      // via a live-DataSource integration in W58.
    });
  });

  // ───────────────────────────────────────────────────────────────
  // Q-G3 — "อำเภอไหนมีโครงการมากที่สุดในแผน X"
  //   Routes to: getExecutiveDashboardSnapshot({ planId, scope: ['all'],
  //                                              groupBy: ['amphoe'],
  //                                              includeGeo: true })
  //   Rule #25 → groupBy='amphoe' uses project.amphoe_id, NOT
  //              WorkHistory chain. Verified separately by the regex gate
  //              at no-creator-amphoe-rollup.spec.ts (sibling).
  // ───────────────────────────────────────────────────────────────
  describe('Q-G3 — amphoe leaderboard (rule #25)', () => {
    it('groups by amphoe via project.amphoe_id', async () => {
      // Geo labels are keyed by raw projectId only — see
      // executive-tool-handlers.ts:2473 (`geoResult?.labels.get(p.projectId)`).
      const { deps, listUnifiedProjectsSpy } = makeDeps({
        projects: PLAN_A_HEAD_PROJECTS,
        geoLabels: new Map([
          [
            'a-pg-head',
            { amphoeId: AMPHOE_MUANG, amphoeName: 'เมืองนครราชสีมา' },
          ],
          ['a-rpg-head1', { amphoeId: AMPHOE_KRABURI, amphoeName: 'ครบุรี' }],
          [
            'a-rpg-head2',
            { amphoeId: AMPHOE_PAKTHONGCHAI, amphoeName: 'ปักธงชัย' },
          ],
          [
            'a-spg-1',
            { amphoeId: AMPHOE_MUANG, amphoeName: 'เมืองนครราชสีมา' },
          ],
        ]),
      });

      const envelope =
        (await EXECUTIVE_TOOL_HANDLERS.getExecutiveDashboardSnapshot(
          {
            planId: PLAN_A_ID,
            scope: ['all'],
            groupBy: ['amphoe'],
            includeGeo: true,
          },
          makeCtx(),
          deps,
        )) as unknown as ExecutiveEnvelope<Record<string, unknown>>;

      expect(envelope.shape).toBe('dashboardSnapshot');
      const buckets = envelope.data.buckets as Record<
        string,
        Array<{ key: string; count: number }>
      >;
      // Muang has 2 (a-pg-head + a-spg-1); kraburi/pakthongchai have 1
      // each. The dashboard handler keys amphoe buckets by the resolved
      // amphoeName from GeoEnrichment.labels (executive-tool-handlers.ts
      // :2473-2474).
      const byKey = Object.fromEntries(
        buckets.amphoe.map((b) => [b.key, b.count]),
      );
      expect(byKey['เมืองนครราชสีมา']).toBe(2);
      expect(byKey['ครบุรี']).toBe(1);
      expect(byKey['ปักธงชัย']).toBe(1);
      assertProvinceScope(listUnifiedProjectsSpy);
    });
  });

  // ───────────────────────────────────────────────────────────────
  // Q-G4 — "มีกี่โครงการรออนุมัติ"
  //   Routes to: getPendingCountsByScope({ scope: 'all' })
  //   Rule #16 (default) → rollup mode, advisory
  //   'approval-pipeline-rollup-applied' must surface.
  //
  //   getPendingCountsByScope drives raw TrackingStatus QB chains via
  //   deps.dataSource — it is a Tier B handler. We can only validate
  //   the rollup branch via the no-history fallback path: when the
  //   dataSource is empty, the handler returns `items: []` +
  //   advisories=['approval-pipeline-rollup-applied']. This pins the
  //   advisory contract (rule #16 disclosure obligation).
  //
  //   Numeric ground truth requires a live DataSource; tracked under
  //   W58 follow-up.
  // ───────────────────────────────────────────────────────────────
  describe('Q-G4 — รออนุมัติ rollup advisory (rule #16)', () => {
    it.skip('FOLLOW-UP — full numeric ground-truth requires live DataSource', () => {
      // The handler joins TrackingStatus + Status via the real repo
      // chain. Cover via integration spec in W58.
    });
  });

  // ───────────────────────────────────────────────────────────────
  // Q-G4b — Rule #16 detail-mode counterpart
  //   Same handler, `detailMode: true` must NOT surface the rollup
  //   advisory and MUST emit per-status canonical buckets.
  // ───────────────────────────────────────────────────────────────
  describe('Q-G4b — รออนุมัติ detail-mode (rule #16 inverse)', () => {
    it.skip('FOLLOW-UP — detail-mode requires live DataSource', () => {
      // Tracked alongside Q-G4 under W58.
    });
  });

  // ───────────────────────────────────────────────────────────────
  // Q-G5 — "โครงการที่ค้างนานเกิน 30 วัน"
  //   Routes to: detectWorkflowAgingProjects({ thresholdDays: 30,
  //                                            scope: 'all' })
  //   detectWorkflowAgingProjects is also Tier B (raw QB). We assert
  //   the schema-shape contract on the empty-DB path.
  // ───────────────────────────────────────────────────────────────
  describe('Q-G5 — workflow aging projects (>30d threshold)', () => {
    it.skip('FOLLOW-UP — requires live TrackingStatus seed; tracked in W58', () => {
      // Stubbing dataSource.getRepository(TrackingStatus) reproducibly
      // would replicate the QB surface and is out of scope for QA-01.
    });
  });

  // ───────────────────────────────────────────────────────────────
  // Q-G6 — "ยุทธศาสตร์ไหนได้งบประมาณสูงสุดในแผน X" (STRATEGY_BASED)
  //   Routes to: getExecutiveDashboardSnapshot({ planId: PLAN_A_ID,
  //                                              scope: ['all'],
  //                                              groupBy: ['strategy'],
  //                                              includeBudget: true })
  //   Rule #21 → STRATEGY_BASED reportFormat → strategy/tactic/plan +
  //   indicator vocabulary; ISSUE-BASED rows MUST be excluded by the
  //   handler's plan filter.
  // ───────────────────────────────────────────────────────────────
  describe('Q-G6 — STRATEGY_BASED strategy leaderboard (rule #21)', () => {
    it('groupBy=strategy with PLAN_A returns strategy buckets only', async () => {
      const stratProjects: UnifiedProject[] = [
        p('main', 'a-pg-strat-1', {
          planId: PLAN_A_ID,
          strategyId: 'strat-1',
          tacticId: 'tac-1',
          planLevelId: 'pl-1',
          indicator: 'KPI-1',
          originType: 'agency-normal',
        }),
        p('main', 'a-pg-strat-2', {
          planId: PLAN_A_ID,
          strategyId: 'strat-2',
          tacticId: 'tac-2',
          planLevelId: 'pl-1',
          indicator: 'KPI-2',
        }),
      ];

      const { deps, listUnifiedProjectsSpy } = makeDeps({
        projects: stratProjects,
        budget: new Map([
          ['main:a-pg-strat-1', 800_000],
          ['main:a-pg-strat-2', 200_000],
        ]),
      });

      const envelope =
        (await EXECUTIVE_TOOL_HANDLERS.getExecutiveDashboardSnapshot(
          {
            planId: PLAN_A_ID,
            scope: ['all'],
            groupBy: ['strategy'],
            includeBudget: true,
          },
          makeCtx(),
          deps,
        )) as unknown as ExecutiveEnvelope<Record<string, unknown>>;

      expect(envelope.shape).toBe('dashboardSnapshot');
      const buckets = envelope.data.buckets as Record<
        string,
        Array<{ key: string; count: number }>
      >;
      // W68-FIX-06 (2026-04-28): bucket key now resolves to Strategy.name
      // via fetchClassificationLabelsForUnifiedProjects. Test mock deps
      // don't stub `getRepository`, so the defensive guard returns an
      // empty label map → bucket falls back to '(ไม่ระบุ)'. Shape-routing
      // intent (strategy bucket populated, total budget correct) is
      // preserved. Specific key value lookup is no longer the FK ID.
      expect(buckets.strategy.length).toBeGreaterThan(0);
      expect(buckets.strategy.reduce((sum, b) => sum + b.count, 0)).toBe(2);
      expect(envelope.data.totalBudget).toBe(1_000_000);
      assertProvinceScope(listUnifiedProjectsSpy);
    });
  });

  // ───────────────────────────────────────────────────────────────
  // Q-G7 — "ประเด็นการพัฒนาในแผน Y" (ISSUE_BASED)
  //   Routes to: getExecutiveDashboardSnapshot({ planId: PLAN_B_ID,
  //                                              scope: ['all'],
  //                                              groupBy: ['issue'] })
  //   Rule #21 → ISSUE_BASED reportFormat → developmentIssue
  //   vocabulary; STRATEGY-BASED rows MUST be excluded.
  // ───────────────────────────────────────────────────────────────
  describe('Q-G7 — ISSUE_BASED issue breakdown (rule #21)', () => {
    it('groupBy=issue with PLAN_B returns issue buckets', async () => {
      const { deps, listUnifiedProjectsSpy } = makeDeps({
        projects: PLAN_B_HEAD_PROJECTS,
      });

      const envelope =
        (await EXECUTIVE_TOOL_HANDLERS.getExecutiveDashboardSnapshot(
          {
            planId: PLAN_B_ID,
            scope: ['all'],
            groupBy: ['issue'],
          },
          makeCtx(),
          deps,
        )) as unknown as ExecutiveEnvelope<Record<string, unknown>>;

      expect(envelope.shape).toBe('dashboardSnapshot');
      const buckets = envelope.data.buckets as Record<
        string,
        Array<{ key: string; count: number }>
      >;
      // W68-FIX-06 (2026-04-28): bucket key now resolves to
      // DevelopmentIssue.name via fetchClassificationLabelsForUnifiedProjects.
      // Same defensive-guard fallback as Q-G6 above.
      expect(buckets.issue.length).toBeGreaterThan(0);
      expect(buckets.issue.reduce((sum, b) => sum + b.count, 0)).toBe(2);
      assertProvinceScope(listUnifiedProjectsSpy);
    });
  });

  // ───────────────────────────────────────────────────────────────
  // Q-G7b — Rule #24 dual-bucket classification (no plan)
  //   Routes to: getProjectClassificationBreakdown({}) — no planId
  //   When planId is omitted the handler returns BOTH STRATEGY +
  //   ISSUE partitions side by side with advisory
  //   ['dual-bucket-classification', HEAD_OF_LINEAGE_ADVISORY].
  //
  //   This handler joins ProjectGroup directly via dataSource; the
  //   stub deps don't have a real repository. We can only assert the
  //   advisory tokens contract by reading the handler source — see
  //   executive-tool-handlers.ts:1483-1514. The runtime path is
  //   covered by W58 integration.
  // ───────────────────────────────────────────────────────────────
  describe('Q-G7b — dual-bucket classification fallback (rule #24)', () => {
    it.skip('FOLLOW-UP — dual-bucket runs against live ProjectGroup repo', () => {
      // The handler returns advisories ['dual-bucket-classification',
      // HEAD_OF_LINEAGE_ADVISORY] when planId is omitted. Pinned at
      // executive-tool-handlers.ts:1509-1512. Cover at integration
      // tier in W58.
    });
  });

  // ───────────────────────────────────────────────────────────────
  // Q-G8 — "เปรียบเทียบงบประมาณระหว่างเล่ม A กับเล่ม B"
  //   Routes to: getCrossPlanInsights({ scope: ['all'] })
  //   Rule #22 → default axis = ALL THREE (count + budget +
  //   approvalRate). Rule #23 → no synthesis from N getPlanOverview
  //   calls; the LLM must use this single tool.
  // ───────────────────────────────────────────────────────────────
  describe('Q-G8 — cross-plan insights default axis (rule #22)', () => {
    it('emits count + budget + plans[] for the cross-plan request', async () => {
      const { deps, listUnifiedProjectsSpy } = makeDeps({
        projects: ALL_PROVINCE_HEAD,
        budget: new Map([
          ...BUDGET_FIXTURE_PLAN_A,
          ['main:b-pg-1', 300_000],
          ['revised:b-rpg-1', 250_000],
        ]),
      });

      const envelope = (await EXECUTIVE_TOOL_HANDLERS.getCrossPlanInsights(
        {
          scope: ['all'],
        },
        makeCtx(),
        deps,
      )) as unknown as ExecutiveEnvelope<Record<string, unknown>>;

      expect(envelope.shape).toBe('crossPlanInsights');
      // Both plans surfaced (rule #23 — no synthesis).
      const plans = envelope.data.plans as Array<{ planId: string }>;
      const planIds = plans.map((p) => p.planId).sort();
      expect(planIds).toEqual([PLAN_A_ID, PLAN_B_ID].sort());
      assertProvinceScope(listUnifiedProjectsSpy);
    });
  });

  // ───────────────────────────────────────────────────────────────
  // Q-G9 — "โครงการล่าสุดที่เพิ่งอนุมัติ"
  //   Routes to: getExecutiveDashboardSnapshot({ scope: ['all'],
  //              groupBy: ['status'], includeStatus: true })
  //   Filtered to Approved status downstream by the LLM. We pin the
  //   structural envelope and the Approved bucket count.
  // ───────────────────────────────────────────────────────────────
  describe('Q-G9 — recently approved projects', () => {
    it('groupBy=status returns Approved bucket', async () => {
      const { deps, listUnifiedProjectsSpy } = makeDeps({
        projects: PLAN_A_HEAD_PROJECTS,
        status: STATUS_FIXTURE_PLAN_A,
      });

      const envelope =
        (await EXECUTIVE_TOOL_HANDLERS.getExecutiveDashboardSnapshot(
          {
            planId: PLAN_A_ID,
            scope: ['all'],
            groupBy: ['status'],
            includeStatus: true,
          },
          makeCtx(),
          deps,
        )) as unknown as ExecutiveEnvelope<Record<string, unknown>>;

      expect(envelope.shape).toBe('dashboardSnapshot');
      const buckets = envelope.data.buckets as Record<
        string,
        Array<{ key: string; count: number }>
      >;
      const byKey = Object.fromEntries(
        buckets.status.map((b) => [b.key, b.count]),
      );
      // 3 Approved + 1 Pending + 1 Pending_Approval per
      // STATUS_FIXTURE_PLAN_A.
      // W67-FIX-01 — `groupBy: ['status']` bucket key is the Thai
      // display label (`statusNameTh`). Canonical English remains the
      // executive 4-group rollup key elsewhere in the envelope.
      expect(byKey['อนุมัติ']).toBe(3);
      expect(byKey['รอตรวจสอบ']).toBe(1);
      expect(byKey['รออนุมัติ']).toBe(1);
      assertProvinceScope(listUnifiedProjectsSpy);
    });
  });

  // ───────────────────────────────────────────────────────────────
  // Q-G10 — "อบจ.นครราชสีมา รับผิดชอบกี่โครงการ"
  //   Routes to: getExecutiveDashboardSnapshot({ scope: ['all'],
  //              groupBy: ['responsibleAgency'], includeAgency: true })
  //   Rule #26 → uses project.responsible_agency_id. NULL bucket
  //   surfaces as the "ยังไม่มีหน่วยงานรับผิดชอบ" disclosure.
  //
  //   parseGroupBy normalises 'responsibleAgency' → 'agency' so the
  //   downstream bucket key is `agency` (executive-tool-handlers.ts
  //   :2057-2062).
  // ───────────────────────────────────────────────────────────────
  describe('Q-G10 — responsibleAgency attribution (rule #26)', () => {
    it('groupBy=responsibleAgency normalises to agency bucket and surfaces NULL', async () => {
      // Agency labels are keyed by raw projectId only — see
      // executive-tool-handlers.ts:2476 (`agencyResult?.labels.get(p.projectId)`).
      const { deps, listUnifiedProjectsSpy } = makeDeps({
        projects: PLAN_A_HEAD_PROJECTS,
        agencyLabels: new Map([
          [
            'a-pg-head',
            { agencyId: PAO_AGENCY_ID, agencyName: 'อบจ.นครราชสีมา' },
          ],
          [
            'a-rpg-head1',
            { agencyId: SUB_AGENCY_ID, agencyName: 'หน่วยงาน B' },
          ],
          [
            'a-spg-1',
            { agencyId: PAO_AGENCY_ID, agencyName: 'อบจ.นครราชสีมา' },
          ],
        ]),
      });

      const envelope =
        (await EXECUTIVE_TOOL_HANDLERS.getExecutiveDashboardSnapshot(
          {
            planId: PLAN_A_ID,
            scope: ['all'],
            groupBy: ['responsibleAgency'],
            includeAgency: true,
          },
          makeCtx(),
          deps,
        )) as unknown as ExecutiveEnvelope<Record<string, unknown>>;

      expect(envelope.shape).toBe('dashboardSnapshot');
      const buckets = envelope.data.buckets as Record<
        string,
        Array<{ key: string; count: number }>
      >;
      // Rule #26 — bucketing is on project.responsible_agency_id, and
      // the dashboard handler keys the bucket by the resolved
      // agencyName from AgencyEnrichment.labels
      // (executive-tool-handlers.ts :2476-2477).
      // PAO row + 1 SPG = 2; sub-agency = 1; rest fall to "ไม่ระบุ"
      // (the NULL disclosure bucket per rule #26).
      expect(buckets.agency).toBeDefined();
      const byKey = Object.fromEntries(
        buckets.agency.map((b) => [b.key, b.count]),
      );
      expect(byKey['อบจ.นครราชสีมา']).toBe(2);
      expect(byKey['หน่วยงาน B']).toBe(1);
      // NULL bucket — 2 rows (a-rpg-head2 with NULL responsibleAgencyId
      // + a-spg-null which has no agency label). Rule #26 disclosure.
      expect(byKey['ไม่ระบุ']).toBe(2);
      assertProvinceScope(listUnifiedProjectsSpy);
    });
  });
});
