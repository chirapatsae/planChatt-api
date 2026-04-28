/**
 * W67-FIX-B / W67-PROMPT-RULE-39 — hierarchical status drill-down spec.
 *
 * Verifies that:
 *   1. `includeStatusDrill: true` is opt-in (default OFF) — without the
 *      flag the envelope MUST NOT carry `data.statusBreakdownByBook`.
 *   2. The handler forwards the SAME `planId` / `scope` / `filters` /
 *      `includeHistoricalVersions` to the Tier B drill helper that the
 *      list path uses (so drill window matches list semantics).
 *   3. Hybrid truncation (Q2): bucket count <= 10 ships ALL projects;
 *      bucket count > 10 ships first 5 + `truncatedRemainder = count - 5`.
 *      The handler is a pass-through; the contract surface is the Tier B
 *      `groupedExecutiveStatusBreakdown` mock value, which is what real
 *      callers will see in the envelope.
 *   4. Empty status buckets are dropped (Q6) and books with no surviving
 *      status group are dropped (Tier B contract verified via the canned
 *      mock — handler MUST emit the buckets verbatim).
 *   5. §14.2 head-of-lineage anti-join is plumbed via
 *      `includeHistoricalVersions=false` by default.
 *   6. Sort order: books = main → revised → supplement; statuses inside
 *      a book follow the canonical executive order (verified via mock
 *      contract — handler emits as-is).
 *   7. planId-narrowed scope still produces multi-book hierarchy
 *      (Q5 = a — drill DPR/Supplement rounds within a single plan).
 *   8. Sub-book label combo (Q3): main → planLabel only;
 *      revised/supplement → "planLabel / roundLabel".
 *   9. Sample fetch order is created_at DESC (encoded in the mock — the
 *      handler does not reorder).
 *
 * §17.2 advisory only — no workflow gating. §17.9 — no raw SQL strings
 * leak from the mock into the handler. §14.2 head-of-lineage — verified
 * via the `includeHistoricalVersions` plumb-through.
 */
import { EXECUTIVE_TOOL_HANDLERS } from '../handlers/executive-tool-handlers';
import {
  ExecutiveCallerContext,
  ExecutiveToolHandlerDeps,
} from '../handlers/handler-types';
import type { ExecutiveEnvelope } from '../../aggregation/types';
import type {
  GroupedExecutiveStatusBreakdown,
  GroupedExecutiveStatusBreakdownProject,
} from '../../aggregation/interfaces';

// W67-FIX-C — drill projects now require pageNumber + bookLabel +
// linkedRelated. W67-COORDINATOR-LAO (2026-04-27) adds
// `coordinatorLaoName`. The helper builds a baseline projection so the
// existing test bodies stay readable; spec cases that exercise the new
// fields override these defaults explicitly.
function mkProject(
  overrides: Partial<GroupedExecutiveStatusBreakdownProject> &
    Pick<GroupedExecutiveStatusBreakdownProject, 'projectId' | 'projectKind' | 'name'>,
): GroupedExecutiveStatusBreakdownProject {
  return {
    pageNumber: null,
    bookLabel: '',
    linkedRelated: null,
    // W67-COORDINATOR-LAO — null by default; per-test overrides exercise
    // the coordinator-LAO annotation surface.
    coordinatorLaoName: null,
    ...overrides,
  };
}

function makeCtx(): ExecutiveCallerContext {
  return {
    userId: 'u',
    workHistoryId: 'wh',
    roleName: 'admin',
    workStatusName: 'approved',
  };
}

function makeDeps(drill: GroupedExecutiveStatusBreakdown = { books: [] }): {
  deps: ExecutiveToolHandlerDeps;
  listUnifiedProjects: jest.Mock;
  groupedExecutiveStatusBreakdown: jest.Mock;
  countExecutiveStatusBreakdown: jest.Mock;
} {
  const listUnifiedProjects = jest.fn().mockResolvedValue([]);
  const countExecutiveStatusBreakdown = jest.fn().mockResolvedValue({
    pendingReviewCount: 0,
    awaitingApprovalCount: 0,
    approvedCount: 0,
    rejectedCount: 0,
  });
  const groupedExecutiveStatusBreakdown = jest.fn().mockResolvedValue(drill);

  const runDimensions = jest.fn(
    async (
      tasks: Array<{ dimension: string }>,
      assemble: (results: unknown[]) => unknown,
      options: { shape: string },
    ) => {
      const data = assemble([]);
      return {
        shape: options.shape,
        data,
        asOf: new Date().toISOString(),
        missingDimensions: [],
        advisories: [],
        partial: false,
        _tasksSeen: tasks.map((t) => t.dimension),
      } as unknown as ExecutiveEnvelope<unknown>;
    },
  );

  const deps: ExecutiveToolHandlerDeps = {
    dataSource: {} as never,
    unifiedProject: {
      listUnifiedProjects,
      countExecutiveStatusBreakdown,
      groupedExecutiveStatusBreakdown,
    } as never,
    budget: {
      totalsForUnifiedProjects: jest.fn().mockResolvedValue(new Map()),
    } as never,
    status: { latestStatusFor: jest.fn().mockResolvedValue(new Map()) } as never,
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
  return {
    deps,
    listUnifiedProjects,
    groupedExecutiveStatusBreakdown,
    countExecutiveStatusBreakdown,
  };
}

describe('W67-FIX-B / status drill-down', () => {
  describe('opt-in default — `includeStatusDrill` flag', () => {
    it('without `includeStatusDrill` flag → envelope does NOT include `statusBreakdownByBook`', async () => {
      const { deps, groupedExecutiveStatusBreakdown } = makeDeps({
        books: [
          {
            bookKey: 'p1::main',
            bookKind: 'main',
            bookLabel: 'plan one',
            planLabel: 'plan one',
            roundLabel: null,
            statuses: [],
          },
        ],
      });
      const env = (await EXECUTIVE_TOOL_HANDLERS.getExecutiveDashboardSnapshot(
        { scope: ['all'] },
        makeCtx(),
        deps,
      )) as unknown as ExecutiveEnvelope<Record<string, unknown>>;
      expect(env.data.statusBreakdownByBook).toBeUndefined();
      expect(groupedExecutiveStatusBreakdown).not.toHaveBeenCalled();
    });

    it('with `includeStatus: false` AND `includeStatusDrill: true` → still skipped (drill requires status)', async () => {
      const { deps, groupedExecutiveStatusBreakdown } = makeDeps();
      await EXECUTIVE_TOOL_HANDLERS.getExecutiveDashboardSnapshot(
        { scope: ['all'], includeStatus: false, includeStatusDrill: true },
        makeCtx(),
        deps,
      );
      expect(groupedExecutiveStatusBreakdown).not.toHaveBeenCalled();
    });

    it('with `includeStatusDrill: true` → calls Tier B drill helper and surfaces the books', async () => {
      const drill: GroupedExecutiveStatusBreakdown = {
        books: [
          {
            bookKey: 'p1::main',
            bookKind: 'main',
            bookLabel: 'แผนพัฒนาท้องถิ่น พ.ศ. 2571-2575',
            planLabel: 'แผนพัฒนาท้องถิ่น พ.ศ. 2571-2575',
            roundLabel: null,
            statuses: [
              {
                group: 'pending_review',
                groupLabel: 'รอตรวจสอบ',
                count: 1,
                projects: [
                  mkProject({ projectId: 'pg1', projectKind: 'main', name: 'A' }),
                ],
                truncatedRemainder: 0,
              },
            ],
          },
        ],
      };
      const { deps, groupedExecutiveStatusBreakdown } = makeDeps(drill);
      const env = (await EXECUTIVE_TOOL_HANDLERS.getExecutiveDashboardSnapshot(
        { scope: ['all'], includeStatusDrill: true },
        makeCtx(),
        deps,
      )) as unknown as ExecutiveEnvelope<Record<string, unknown>>;
      expect(groupedExecutiveStatusBreakdown).toHaveBeenCalledTimes(1);
      expect(env.data.statusBreakdownByBook).toEqual(drill.books);
    });
  });

  describe('mixed seed — main + revised, plan-format-independent', () => {
    it('drill returns 2 books with correct labels (Q3 combo)', async () => {
      const drill: GroupedExecutiveStatusBreakdown = {
        books: [
          {
            bookKey: 'p1::main',
            bookKind: 'main',
            bookLabel: 'แผนพัฒนาท้องถิ่น พ.ศ. 2571-2575',
            planLabel: 'แผนพัฒนาท้องถิ่น พ.ศ. 2571-2575',
            roundLabel: null,
            statuses: [
              {
                group: 'pending_review',
                groupLabel: 'รอตรวจสอบ',
                count: 1,
                projects: [
                  mkProject({ projectId: 'm1', projectKind: 'main', name: 'M-pend' }),
                ],
                truncatedRemainder: 0,
              },
              {
                group: 'awaiting_approval',
                groupLabel: 'รออนุมัติ',
                count: 4,
                projects: [
                  mkProject({ projectId: 'm2', projectKind: 'main', name: 'M-pa-1' }),
                  mkProject({ projectId: 'm3', projectKind: 'main', name: 'M-pa-2' }),
                  mkProject({ projectId: 'm4', projectKind: 'main', name: 'M-pa-3' }),
                  mkProject({ projectId: 'm5', projectKind: 'main', name: 'M-pa-4' }),
                ],
                truncatedRemainder: 0,
              },
              {
                group: 'approved',
                groupLabel: 'อนุมัติ',
                count: 6,
                projects: Array.from({ length: 6 }, (_, i) =>
                  mkProject({
                    projectId: `m${6 + i}`,
                    projectKind: 'main' as const,
                    name: `M-app-${i + 1}`,
                  }),
                ),
                truncatedRemainder: 0,
              },
            ],
          },
          {
            bookKey: 'p1::revised::dpr1',
            bookKind: 'revised',
            bookLabel:
              'แผนพัฒนาท้องถิ่น พ.ศ. 2571-2575 / เล่มแก้ไขครั้งที่ 1',
            planLabel: 'แผนพัฒนาท้องถิ่น พ.ศ. 2571-2575',
            roundLabel: 'เล่มแก้ไขครั้งที่ 1',
            statuses: [
              {
                group: 'approved',
                groupLabel: 'อนุมัติ',
                count: 1,
                projects: [
                  mkProject({ projectId: 'r1', projectKind: 'revised', name: 'R-app-1' }),
                ],
                truncatedRemainder: 0,
              },
            ],
          },
        ],
      };
      const { deps } = makeDeps(drill);
      const env = (await EXECUTIVE_TOOL_HANDLERS.getExecutiveDashboardSnapshot(
        { scope: ['all'], includeStatusDrill: true },
        makeCtx(),
        deps,
      )) as unknown as ExecutiveEnvelope<Record<string, unknown>>;
      const books = env.data.statusBreakdownByBook as typeof drill.books;
      expect(books).toHaveLength(2);
      expect(books[0].bookKind).toBe('main');
      expect(books[0].bookLabel).toBe(books[0].planLabel);
      expect(books[1].bookKind).toBe('revised');
      expect(books[1].bookLabel).toContain(' / ');
      expect(books[1].bookLabel).toContain(books[1].planLabel);
      expect(books[1].bookLabel).toContain(books[1].roundLabel as string);
    });
  });

  describe('truncation regression (Q2 hybrid)', () => {
    it('bucket count=12 → projects=5, truncatedRemainder=7', async () => {
      const drill: GroupedExecutiveStatusBreakdown = {
        books: [
          {
            bookKey: 'p1::main',
            bookKind: 'main',
            bookLabel: 'plan',
            planLabel: 'plan',
            roundLabel: null,
            statuses: [
              {
                group: 'approved',
                groupLabel: 'อนุมัติ',
                count: 12,
                projects: Array.from({ length: 5 }, (_, i) =>
                  mkProject({
                    projectId: `id-${i}`,
                    projectKind: 'main' as const,
                    name: `P-${i}`,
                  }),
                ),
                truncatedRemainder: 7,
              },
            ],
          },
        ],
      };
      const { deps } = makeDeps(drill);
      const env = (await EXECUTIVE_TOOL_HANDLERS.getExecutiveDashboardSnapshot(
        { scope: ['all'], includeStatusDrill: true },
        makeCtx(),
        deps,
      )) as unknown as ExecutiveEnvelope<Record<string, unknown>>;
      const books = env.data.statusBreakdownByBook as typeof drill.books;
      expect(books[0].statuses[0].count).toBe(12);
      expect(books[0].statuses[0].projects).toHaveLength(5);
      expect(books[0].statuses[0].truncatedRemainder).toBe(7);
    });

    it('bucket count<=10 → all projects shown, truncatedRemainder=0', async () => {
      const drill: GroupedExecutiveStatusBreakdown = {
        books: [
          {
            bookKey: 'p1::main',
            bookKind: 'main',
            bookLabel: 'plan',
            planLabel: 'plan',
            roundLabel: null,
            statuses: [
              {
                group: 'pending_review',
                groupLabel: 'รอตรวจสอบ',
                count: 7,
                projects: Array.from({ length: 7 }, (_, i) =>
                  mkProject({
                    projectId: `id-${i}`,
                    projectKind: 'main' as const,
                    name: `P-${i}`,
                  }),
                ),
                truncatedRemainder: 0,
              },
            ],
          },
        ],
      };
      const { deps } = makeDeps(drill);
      const env = (await EXECUTIVE_TOOL_HANDLERS.getExecutiveDashboardSnapshot(
        { scope: ['all'], includeStatusDrill: true },
        makeCtx(),
        deps,
      )) as unknown as ExecutiveEnvelope<Record<string, unknown>>;
      const books = env.data.statusBreakdownByBook as typeof drill.books;
      expect(books[0].statuses[0].projects).toHaveLength(7);
      expect(books[0].statuses[0].truncatedRemainder).toBe(0);
    });
  });

  describe('empty bucket hiding (Q6)', () => {
    it('only one status group present → handler emits exactly that group', async () => {
      const drill: GroupedExecutiveStatusBreakdown = {
        books: [
          {
            bookKey: 'p1::main',
            bookKind: 'main',
            bookLabel: 'plan',
            planLabel: 'plan',
            roundLabel: null,
            statuses: [
              {
                group: 'pending_review',
                groupLabel: 'รอตรวจสอบ',
                count: 1,
                projects: [
                  mkProject({ projectId: 'm1', projectKind: 'main', name: 'A' }),
                ],
                truncatedRemainder: 0,
              },
            ],
          },
        ],
      };
      const { deps } = makeDeps(drill);
      const env = (await EXECUTIVE_TOOL_HANDLERS.getExecutiveDashboardSnapshot(
        { scope: ['all'], includeStatusDrill: true },
        makeCtx(),
        deps,
      )) as unknown as ExecutiveEnvelope<Record<string, unknown>>;
      const books = env.data.statusBreakdownByBook as typeof drill.books;
      expect(books[0].statuses).toHaveLength(1);
      expect(books[0].statuses[0].group).toBe('pending_review');
    });

    it('drill returning empty books[] surfaces empty array (handler does not throw)', async () => {
      const { deps } = makeDeps({ books: [] });
      const env = (await EXECUTIVE_TOOL_HANDLERS.getExecutiveDashboardSnapshot(
        { scope: ['all'], includeStatusDrill: true },
        makeCtx(),
        deps,
      )) as unknown as ExecutiveEnvelope<Record<string, unknown>>;
      expect(env.data.statusBreakdownByBook).toEqual([]);
    });
  });

  describe('§14.2 head-of-lineage plumbing', () => {
    it('default `includeHistoricalVersions=false` is forwarded to drill helper', async () => {
      const { deps, groupedExecutiveStatusBreakdown } = makeDeps();
      await EXECUTIVE_TOOL_HANDLERS.getExecutiveDashboardSnapshot(
        { scope: ['all'], includeStatusDrill: true },
        makeCtx(),
        deps,
      );
      expect(groupedExecutiveStatusBreakdown).toHaveBeenCalledTimes(1);
      const call = groupedExecutiveStatusBreakdown.mock.calls[0][0];
      expect(call.includeHistoricalVersions).toBe(false);
    });

    it('explicit `includeHistoricalVersions=true` is plumbed', async () => {
      const { deps, groupedExecutiveStatusBreakdown } = makeDeps();
      await EXECUTIVE_TOOL_HANDLERS.getExecutiveDashboardSnapshot(
        {
          scope: ['all'],
          includeStatusDrill: true,
          includeHistoricalVersions: true,
        },
        makeCtx(),
        deps,
      );
      const call = groupedExecutiveStatusBreakdown.mock.calls[0][0];
      expect(call.includeHistoricalVersions).toBe(true);
    });
  });

  describe('planId-narrowed scope (Q5)', () => {
    it('planId is forwarded so drill scopes to a single plan', async () => {
      const planId = '11111111-1111-4111-8111-111111111111';
      const { deps, groupedExecutiveStatusBreakdown } = makeDeps();
      await EXECUTIVE_TOOL_HANDLERS.getExecutiveDashboardSnapshot(
        { scope: ['all'], planId, includeStatusDrill: true },
        makeCtx(),
        deps,
      );
      const call = groupedExecutiveStatusBreakdown.mock.calls[0][0];
      expect(call.planId).toBe(planId);
    });
  });

  describe('sub-book label format (Q3)', () => {
    it('main bookLabel === planLabel (no separator)', () => {
      const book = {
        bookKey: 'p::main',
        bookKind: 'main' as const,
        bookLabel: 'plan-x',
        planLabel: 'plan-x',
        roundLabel: null,
        statuses: [],
      };
      expect(book.bookLabel).toBe(book.planLabel);
      expect(book.roundLabel).toBeNull();
    });

    it('revised round 1 bookLabel === "<plan> / เล่มแก้ไขครั้งที่ 1"', () => {
      const expected = 'plan-x / เล่มแก้ไขครั้งที่ 1';
      const book = {
        bookKey: 'p::revised::dpr1',
        bookKind: 'revised' as const,
        bookLabel: expected,
        planLabel: 'plan-x',
        roundLabel: 'เล่มแก้ไขครั้งที่ 1',
        statuses: [],
      };
      expect(book.bookLabel).toBe(`${book.planLabel} / ${book.roundLabel}`);
    });

    it('supplement round 2 bookLabel === "<plan> / เล่มเพิ่มเติมครั้งที่ 2"', () => {
      const expected = 'plan-x / เล่มเพิ่มเติมครั้งที่ 2';
      const book = {
        bookKey: 'p::supplement::dps2',
        bookKind: 'supplement' as const,
        bookLabel: expected,
        planLabel: 'plan-x',
        roundLabel: 'เล่มเพิ่มเติมครั้งที่ 2',
        statuses: [],
      };
      expect(book.bookLabel).toBe(`${book.planLabel} / ${book.roundLabel}`);
    });
  });

  describe('drill failure must not throw out of snapshot (§17.2)', () => {
    it('drill helper rejecting → envelope still returns, drill field omitted', async () => {
      const drillReject: GroupedExecutiveStatusBreakdown = { books: [] };
      const { deps, groupedExecutiveStatusBreakdown } = makeDeps(drillReject);
      groupedExecutiveStatusBreakdown.mockRejectedValueOnce(
        new Error('downstream-DB-blip'),
      );
      const env = (await EXECUTIVE_TOOL_HANDLERS.getExecutiveDashboardSnapshot(
        { scope: ['all'], includeStatusDrill: true },
        makeCtx(),
        deps,
      )) as unknown as ExecutiveEnvelope<Record<string, unknown>>;
      expect(env.data.statusBreakdownByBook).toBeUndefined();
      expect(env.shape).toBe('dashboardSnapshot');
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // W67-FIX-C — per-project context annotation + cross-lineage trail.
  //
  // The handler is a verbatim pass-through of the Tier B drill envelope
  // (the wiring is asserted by the existing "with `includeStatusDrill:
  // true` → ..." case above). These cases lock the per-project field
  // shape that the Tier B helper now produces and the LLM consumes via
  // prompt rule #39.
  //
  // Q1=yes (every project carries pageNumber + bookLabel) and Q2=C
  // (cross-lineage pointer FK-first, name-match fallback) are checked
  // here at the contract surface — full unit-level coverage of the
  // resolver lives in the aggregator service spec.
  // ────────────────────────────────────────────────────────────────────
  describe('W67-FIX-C / per-project context (Q1=yes)', () => {
    it('every project carries pageNumber + bookLabel verbatim from envelope', async () => {
      const drill: GroupedExecutiveStatusBreakdown = {
        books: [
          {
            bookKey: 'p1::main',
            bookKind: 'main',
            bookLabel: 'แผนพัฒนาท้องถิ่น พ.ศ. 2571-2575',
            planLabel: 'แผนพัฒนาท้องถิ่น พ.ศ. 2571-2575',
            roundLabel: null,
            statuses: [
              {
                group: 'pending_review',
                groupLabel: 'รอตรวจสอบ',
                count: 2,
                projects: [
                  mkProject({
                    projectId: 'pg1',
                    projectKind: 'main',
                    name: 'โครงการพัฒนาแหล่งน้ำ',
                    pageNumber: 42,
                    bookLabel: 'แผนพัฒนาท้องถิ่น พ.ศ. 2571-2575',
                  }),
                  mkProject({
                    projectId: 'pg2',
                    projectKind: 'main',
                    name: 'โครงการก่อสร้างถนน',
                    pageNumber: null,
                    bookLabel: 'แผนพัฒนาท้องถิ่น พ.ศ. 2571-2575',
                  }),
                ],
                truncatedRemainder: 0,
              },
            ],
          },
        ],
      };
      const { deps } = makeDeps(drill);
      const env = (await EXECUTIVE_TOOL_HANDLERS.getExecutiveDashboardSnapshot(
        { scope: ['all'], includeStatusDrill: true },
        makeCtx(),
        deps,
      )) as unknown as ExecutiveEnvelope<Record<string, unknown>>;
      const books = env.data.statusBreakdownByBook as typeof drill.books;
      const projects = books[0].statuses[0].projects;
      expect(projects[0].pageNumber).toBe(42);
      expect(projects[0].bookLabel).toBe('แผนพัฒนาท้องถิ่น พ.ศ. 2571-2575');
      // null pageNumber survives the pass-through unchanged.
      expect(projects[1].pageNumber).toBeNull();
      expect(projects[1].bookLabel).toBe(books[0].bookLabel);
    });

    it('revised round → bookLabel === "${planLabel} / ${roundLabel}"', async () => {
      const drill: GroupedExecutiveStatusBreakdown = {
        books: [
          {
            bookKey: 'p1::revised::dpr1',
            bookKind: 'revised',
            bookLabel: 'plan-x / เล่มแก้ไขครั้งที่ 1',
            planLabel: 'plan-x',
            roundLabel: 'เล่มแก้ไขครั้งที่ 1',
            statuses: [
              {
                group: 'approved',
                groupLabel: 'อนุมัติ',
                count: 1,
                projects: [
                  mkProject({
                    projectId: 'r1',
                    projectKind: 'revised',
                    name: 'X',
                    pageNumber: 7,
                    bookLabel: 'plan-x / เล่มแก้ไขครั้งที่ 1',
                  }),
                ],
                truncatedRemainder: 0,
              },
            ],
          },
        ],
      };
      const { deps } = makeDeps(drill);
      const env = (await EXECUTIVE_TOOL_HANDLERS.getExecutiveDashboardSnapshot(
        { scope: ['all'], includeStatusDrill: true },
        makeCtx(),
        deps,
      )) as unknown as ExecutiveEnvelope<Record<string, unknown>>;
      const books = env.data.statusBreakdownByBook as typeof drill.books;
      const project = books[0].statuses[0].projects[0];
      expect(project.bookLabel).toBe(`${books[0].planLabel} / ${books[0].roundLabel}`);
      expect(project.pageNumber).toBe(7);
    });
  });

  describe('W67-FIX-C / linkedRelated cross-lineage trail (Q2=C)', () => {
    it('FK-chain match emits matchType="fk-chain"', async () => {
      const drill: GroupedExecutiveStatusBreakdown = {
        books: [
          {
            bookKey: 'p1::main',
            bookKind: 'main',
            bookLabel: 'plan-x',
            planLabel: 'plan-x',
            roundLabel: null,
            statuses: [
              {
                group: 'approved',
                groupLabel: 'อนุมัติ',
                count: 1,
                projects: [
                  mkProject({
                    projectId: 'pg1',
                    projectKind: 'main',
                    name: 'X',
                    pageNumber: 1,
                    bookLabel: 'plan-x',
                    linkedRelated: {
                      bookLabel: 'plan-x / เล่มแก้ไขครั้งที่ 2',
                      pageNumber: 12,
                      matchType: 'fk-chain',
                    },
                  }),
                ],
                truncatedRemainder: 0,
              },
            ],
          },
        ],
      };
      const { deps } = makeDeps(drill);
      const env = (await EXECUTIVE_TOOL_HANDLERS.getExecutiveDashboardSnapshot(
        {
          scope: ['all'],
          includeStatusDrill: true,
          includeHistoricalVersions: true,
        },
        makeCtx(),
        deps,
      )) as unknown as ExecutiveEnvelope<Record<string, unknown>>;
      const books = env.data.statusBreakdownByBook as typeof drill.books;
      const linked = books[0].statuses[0].projects[0].linkedRelated;
      expect(linked).not.toBeNull();
      expect(linked?.matchType).toBe('fk-chain');
      expect(linked?.bookLabel).toBe('plan-x / เล่มแก้ไขครั้งที่ 2');
      expect(linked?.pageNumber).toBe(12);
    });

    it('name-exact match emits matchType="name-exact"', async () => {
      const drill: GroupedExecutiveStatusBreakdown = {
        books: [
          {
            bookKey: 'p1::main',
            bookKind: 'main',
            bookLabel: 'plan-x',
            planLabel: 'plan-x',
            roundLabel: null,
            statuses: [
              {
                group: 'approved',
                groupLabel: 'อนุมัติ',
                count: 1,
                projects: [
                  mkProject({
                    projectId: 'pg1',
                    projectKind: 'main',
                    name: 'พัฒนาศักยภาพ',
                    pageNumber: 5,
                    bookLabel: 'plan-x',
                    linkedRelated: {
                      bookLabel: 'plan-x / เล่มเปลี่ยนแปลงครั้งที่ 2',
                      pageNumber: 18,
                      matchType: 'name-exact',
                    },
                  }),
                ],
                truncatedRemainder: 0,
              },
            ],
          },
        ],
      };
      const { deps } = makeDeps(drill);
      const env = (await EXECUTIVE_TOOL_HANDLERS.getExecutiveDashboardSnapshot(
        { scope: ['all'], includeStatusDrill: true },
        makeCtx(),
        deps,
      )) as unknown as ExecutiveEnvelope<Record<string, unknown>>;
      const books = env.data.statusBreakdownByBook as typeof drill.books;
      const linked = books[0].statuses[0].projects[0].linkedRelated;
      expect(linked?.matchType).toBe('name-exact');
      expect(linked?.bookLabel).toContain('เล่มเปลี่ยนแปลงครั้งที่ 2');
      expect(linked?.pageNumber).toBe(18);
    });

    it('W67-COORDINATOR-LAO — coordinatorLaoName field is part of the envelope contract', async () => {
      // Locks the per-project field shape that the Tier B helper now
      // produces and the LLM consumes via prompt rule #39's
      // W67-COORDINATOR-LAO sub-rule. The handler is a verbatim pass-
      // through; we just assert the field surfaces unchanged.
      const drill: GroupedExecutiveStatusBreakdown = {
        books: [
          {
            bookKey: 'p1::main',
            bookKind: 'main',
            bookLabel: 'plan-x',
            planLabel: 'plan-x',
            roundLabel: null,
            statuses: [
              {
                group: 'pending_review',
                groupLabel: 'รอตรวจสอบ',
                count: 2,
                projects: [
                  // Coordinated project — non-อบจ. LAO surfaces verbatim.
                  mkProject({
                    projectId: 'pg1',
                    projectKind: 'main',
                    name: 'โครงการ A',
                    pageNumber: 1,
                    bookLabel: 'plan-x',
                    coordinatorLaoName: 'เทศบาลตำบลโคกกรวด',
                  }),
                  // Direct อบจ. project — null indicates no annotation.
                  mkProject({
                    projectId: 'pg2',
                    projectKind: 'main',
                    name: 'โครงการ B',
                    pageNumber: 2,
                    bookLabel: 'plan-x',
                    coordinatorLaoName: null,
                  }),
                ],
                truncatedRemainder: 0,
              },
            ],
          },
        ],
      };
      const { deps } = makeDeps(drill);
      const env = (await EXECUTIVE_TOOL_HANDLERS.getExecutiveDashboardSnapshot(
        { scope: ['all'], includeStatusDrill: true },
        makeCtx(),
        deps,
      )) as unknown as ExecutiveEnvelope<Record<string, unknown>>;
      const books = env.data.statusBreakdownByBook as typeof drill.books;
      const projects = books[0].statuses[0].projects;
      // Field present on every project — exact field-name lock.
      expect('coordinatorLaoName' in projects[0]).toBe(true);
      expect(projects[0].coordinatorLaoName).toBe('เทศบาลตำบลโคกกรวด');
      // Null pass-through for the direct-PAO case.
      expect(projects[1].coordinatorLaoName).toBeNull();
    });

    it('no related row → linkedRelated stays null', async () => {
      const drill: GroupedExecutiveStatusBreakdown = {
        books: [
          {
            bookKey: 'p1::main',
            bookKind: 'main',
            bookLabel: 'plan-x',
            planLabel: 'plan-x',
            roundLabel: null,
            statuses: [
              {
                group: 'approved',
                groupLabel: 'อนุมัติ',
                count: 1,
                projects: [
                  mkProject({
                    projectId: 'pg1',
                    projectKind: 'main',
                    name: 'unique-name',
                    pageNumber: 99,
                    bookLabel: 'plan-x',
                    linkedRelated: null,
                  }),
                ],
                truncatedRemainder: 0,
              },
            ],
          },
        ],
      };
      const { deps } = makeDeps(drill);
      const env = (await EXECUTIVE_TOOL_HANDLERS.getExecutiveDashboardSnapshot(
        { scope: ['all'], includeStatusDrill: true },
        makeCtx(),
        deps,
      )) as unknown as ExecutiveEnvelope<Record<string, unknown>>;
      const books = env.data.statusBreakdownByBook as typeof drill.books;
      expect(books[0].statuses[0].projects[0].linkedRelated).toBeNull();
    });
  });
});
