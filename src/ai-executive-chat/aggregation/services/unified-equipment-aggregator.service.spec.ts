/**
 * Wave AI-Exec-Chat-Equipment-ผ.03 — unit spec for
 * `UnifiedEquipmentAggregatorService`
 * (docs/tasks/AI_EXEC_CHAT_EQUIPMENT_P03_COVERAGE.md §3.6).
 *
 * Coverage matrix (task §12 QA checklist):
 *   - single spine call per public method (no N+1)
 *   - HEAD semantics inherited from the stubbed executive-list
 *   - scope filter (main / revision / supplement / all)
 *   - budget rollup math (total / average / byYear / byBook)
 *   - W67 4-group rollup mapping from `executiveStatusGroup`
 *   - §16.5 dual-shape rows (ISSUE_BASED rows lack strategy fields —
 *     must not be dropped)
 *   - pagination clamp + nextOffset contract
 *   - revision/supplement book filter + sentinel meta on zero rows
 *   - PII discipline: no creator fields on any projected item
 */
import {
  UnifiedEquipmentAggregatorService,
} from './unified-equipment-aggregator.service';
import type { UnifiedEquipmentRow } from 'src/unified-equipment/types/unified-equipment-row';
import type { UnifiedEquipmentService } from 'src/unified-equipment/unified-equipment.service';

const PLAN_A = '11111111-1111-4111-8111-111111111111';
const DPR_1 = '22222222-2222-4222-8222-222222222222';
const DPS_1 = '33333333-3333-4333-8333-333333333333';

function makeRow(
  overrides: Partial<UnifiedEquipmentRow> & { id: string },
): UnifiedEquipmentRow {
  return {
    kind: 'equipment',
    equipmentName: 'เครื่องคอมพิวเตอร์',
    targetOutput: null,
    expectedResults: null,
    indicator: null,
    equipmentCategory: {
      id: 'cat-1',
      code: 1,
      name: 'ครุภัณฑ์คอมพิวเตอร์',
    },
    strategy: { id: 'st-1', name: 'ยุทธศาสตร์ 1' },
    tactic: null,
    plan: null,
    developmentIssue: null,
    developmentPlan: {
      id: PLAN_A,
      name: 'แผนพัฒนาท้องถิ่น พ.ศ. 2566-2570',
      startYear: 2566,
      endYear: 2570,
      isLatest: true,
      isBooked: true,
      reportFormat: 'STRATEGY_BASED',
    },
    developmentPlanRevision: undefined,
    developmentPlanSupplement: undefined,
    status: { name: 'Approved', thName: 'อนุมัติ', statusAt: null },
    hasDescendant: false,
    isBooked: true,
    bookedAt: null,
    pageNumber: 5,
    budgets: [{ year: 2566, quantity: 50000 }],
    createdBy: {
      workHistoryId: 'wh-1',
      firstName: 'สมชาย',
      lastName: 'ทดสอบ',
      profileImageUrl: null,
      email: null,
      joinDate: null,
    },
    createdByWorkHistoryId: 'wh-1',
    responsibleAgency: { id: '1', name: 'สำนักปลัด' },
    amphoe: null,
    localAdministrativeOrganization: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    executiveStatusGroup: 'approved',
    ...overrides,
  };
}

function buildFixture(): UnifiedEquipmentRow[] {
  return [
    // เล่มหลัก — STRATEGY_BASED, approved, 2 budget years.
    makeRow({
      id: 'aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      budgets: [
        { year: 2566, quantity: 50000 },
        { year: 2567, quantity: 25000 },
      ],
    }),
    // เล่มหลัก — §16.5 ISSUE_BASED shape (no strategy fields), pending.
    makeRow({
      id: 'aaaaaaa2-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
      equipmentName: 'เครื่องพ่นหมอกควัน',
      equipmentCategory: null,
      strategy: null,
      developmentIssue: { id: 'di-1', name: 'ประเด็นสาธารณสุข' },
      status: { name: 'Pending', thName: 'รอตรวจสอบ', statusAt: null },
      executiveStatusGroup: 'pending_review',
      budgets: [{ year: 2567, quantity: 30000 }],
    }),
    // เล่มแก้ไขครุภัณฑ์ ครั้งที่ 1 — awaiting approval.
    makeRow({
      id: 'aaaaaaa3-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
      kind: 'revised-equipment',
      equipmentName: 'เครื่องปรับอากาศ (แก้ไข)',
      developmentPlanRevision: {
        id: DPR_1,
        revisionNumber: 1,
        revisionTypeName: 'แก้ไข',
        description: null,
        isLatest: true,
        isBooked: false,
        isOpen: true,
      },
      status: { name: 'Verified', thName: 'ตรวจสอบแล้ว', statusAt: null },
      executiveStatusGroup: 'awaiting_approval',
      budgets: [{ year: 2567, quantity: 40000 }],
    }),
    // เล่มเพิ่มเติมครุภัณฑ์ ครั้งที่ 2 — rejected.
    makeRow({
      id: 'aaaaaaa4-aaaa-4aaa-8aaa-aaaaaaaaaaa4',
      kind: 'supplement-equipment',
      equipmentName: 'กล้องวงจรปิด',
      developmentPlanSupplement: {
        id: DPS_1,
        supplementNumber: 2,
        description: null,
        isOpen: false,
        isBooked: true,
      },
      status: { name: 'Rejected', thName: 'เกินศักยภาพ', statusAt: null },
      executiveStatusGroup: 'rejected',
      budgets: [{ year: null, quantity: 15000 }],
    }),
  ];
}

/** Default document-count shape (overridable per test). `countsByChildBook`
 *  now delegates to `UnifiedEquipmentService.documentCountsByBook` (document
 *  semantics), so tests that exercise it mock this instead of the row spine. */
type DocCounts = {
  main: number;
  byRevision: Array<{
    revisionId: string;
    revisionNumber: number;
    revisionTypeName: string;
    itemCount: number;
  }>;
  bySupplement: Array<{
    supplementId: string;
    supplementNumber: number;
    itemCount: number;
  }>;
};

function buildService(
  rows: UnifiedEquipmentRow[],
  docCounts?: DocCounts,
): {
  service: UnifiedEquipmentAggregatorService;
  executiveList: jest.Mock;
  documentList: jest.Mock;
  documentCountsByBook: jest.Mock;
  resolveEquipmentOriginBookType: jest.Mock;
} {
  const executiveList = jest.fn().mockResolvedValue(rows);
  // Wave AI-EXEC-CHAT-WHOLE-PLAN-EQUIPMENT-LISTING-HEAD-CONSISTENCY —
  // `listInPlan` now SWITCHES source by scope: WHOLE-PLAN (scope 'all'/omitted)
  // → `executiveList` (HEAD, distinct latest) so listing == count; PER-BOOK
  // (main/revision/supplement) → `documentList` (as printed in that book).
  // Analytical methods (budget/status/category/search) keep `executiveList`
  // (HEAD). Default the document mock to the SAME rows so per-book listing
  // assertions hold when both spines carry identical fixtures.
  const documentList = jest.fn().mockResolvedValue(rows);
  const documentCountsByBook = jest.fn().mockResolvedValue(
    docCounts ?? { main: 0, byRevision: [], bySupplement: [] },
  );
  // Wave AI-EXEC-CHAT-EQUIPMENT-HEAD-ROSTER — origin back-walk resolver used
  // by `headRoster` for revised-equipment rows. Default → 'main'.
  const resolveEquipmentOriginBookType = jest.fn().mockResolvedValue('main');
  const stub = {
    executiveList,
    documentList,
    documentCountsByBook,
    resolveEquipmentOriginBookType,
  } as unknown as UnifiedEquipmentService;
  return {
    service: new UnifiedEquipmentAggregatorService(stub),
    executiveList,
    documentList,
    documentCountsByBook,
    resolveEquipmentOriginBookType,
  };
}

describe('UnifiedEquipmentAggregatorService', () => {
  it('search matches equipmentName + categoryName, caps at limit, single spine call', async () => {
    const { service, executiveList } = buildService(buildFixture());
    const res = await service.search('เครื่อง', { limit: 2 });
    // 3 rows contain "เครื่อง" in the name; category match adds none new.
    expect(res.totalMatched).toBe(3);
    expect(res.items).toHaveLength(2);
    expect(executiveList).toHaveBeenCalledTimes(1);
    // Category-name match path.
    const catRes = await service.search('คอมพิวเตอร์');
    expect(catRes.totalMatched).toBeGreaterThanOrEqual(1);
  });

  it('search with blank keyword returns empty (never dumps the table)', async () => {
    const { service } = buildService(buildFixture());
    const res = await service.search('   ');
    expect(res.items).toEqual([]);
    expect(res.totalMatched).toBe(0);
  });

  it('listInPlan PER-BOOK (scope=main) routes to the DOCUMENT spine and honors scope filter', async () => {
    // Per-book listing (Wave DOCUMENT-EQUIPMENT-LISTING) — routes to
    // documentList (no HEAD REPLACE, as printed in that ผ.03 book), NOT
    // executiveList. UNCHANGED by the whole-plan HEAD wave.
    const { service, documentList, executiveList } = buildService(
      buildFixture(),
    );
    const res = await service.listInPlan(PLAN_A, { scope: 'main' });
    expect(documentList).toHaveBeenCalledWith({ developmentPlanId: PLAN_A });
    expect(documentList).toHaveBeenCalledTimes(1);
    // The HEAD spine is NOT used for a single-book (document) listing.
    expect(executiveList).not.toHaveBeenCalled();
    expect(res.totalCount).toBe(2);
    expect(res.items.every((i) => i.equipmentKind === 'equipment')).toBe(true);
    // Per-book label keeps the equipment-specific bookLabel() phrasing.
    expect(res.items[0].bookLabel).toBe('เล่มหลัก');
  });

  it('listInPlan WHOLE-PLAN (scope=all) routes to the HEAD spine so listing == count', async () => {
    // Wave WHOLE-PLAN-EQUIPMENT-LISTING-HEAD-CONSISTENCY — a whole-plan listing
    // must use executiveList (HEAD, distinct latest) — the SAME spine that
    // feeds budgetSummary.headItemCount / statusBreakdown.totalCount — so
    // "ครุภัณฑ์ในแผนมีกี่รายการ" (count) and "ขอดูรายละเอียด...ในแผน" (listing)
    // return the SAME set. documentList must NOT be consulted.
    const { service, documentList, executiveList } = buildService(
      buildFixture(),
    );
    const res = await service.listInPlan(PLAN_A, { scope: 'all' });
    expect(executiveList).toHaveBeenCalledWith({ developmentPlanId: PLAN_A });
    expect(documentList).not.toHaveBeenCalled();
    // The HEAD count is whatever executiveList returns (already deduped) — the
    // listing totalCount agrees with the budget/status headItemCount.
    const budget = await service.budgetSummary({ planId: PLAN_A });
    expect(res.totalCount).toBe(budget.headItemCount);
    // Whole-plan HEAD listing uses the roster-style book label (RELPG head →
    // "เล่มแก้ไข…"), NOT the equipment-specific "เล่มแก้ไขครุภัณฑ์" phrasing.
    const revisedItem = res.items.find(
      (i) => i.equipmentKind === 'revised-equipment',
    );
    expect(revisedItem?.bookLabel.startsWith('เล่มแก้ไข')).toBe(true);
    expect(revisedItem?.bookLabel).not.toContain('ครุภัณฑ์');
  });

  it('listInPlan WHOLE-PLAN (scope omitted) also routes to the HEAD spine', async () => {
    const { service, documentList, executiveList } = buildService(
      buildFixture(),
    );
    await service.listInPlan(PLAN_A);
    expect(executiveList).toHaveBeenCalledWith({ developmentPlanId: PLAN_A });
    expect(documentList).not.toHaveBeenCalled();
  });

  it('listInPlan status filter uses canonical status name', async () => {
    const { service } = buildService(buildFixture());
    const res = await service.listInPlan(PLAN_A, { status: 'Approved' });
    expect(res.totalCount).toBe(1);
    expect(res.items[0].currentStatus).toBe('Approved');
  });

  it('pagination clamps limit to [1,200] and reports nextOffset', async () => {
    const { service } = buildService(buildFixture());
    const page1 = await service.listInPlan(PLAN_A, { limit: 2, offset: 0 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextOffset).toBe(2);
    const page2 = await service.listInPlan(PLAN_A, { limit: 2, offset: 2 });
    expect(page2.nextOffset).toBeNull();
    const clamped = await service.listInPlan(PLAN_A, { limit: 9999 });
    expect(clamped.limit).toBe(200);
  });

  it('budgetSummary rolls up total / average / byYear / byBook', async () => {
    const { service, executiveList } = buildService(buildFixture());
    const res = await service.budgetSummary({ planId: PLAN_A });
    expect(res.headItemCount).toBe(4);
    // 50000+25000 + 30000 + 40000 + 15000
    expect(res.totalBudget).toBe(160000);
    expect(res.averageBudget).toBe(40000);
    expect(res.byBook.main).toEqual({ headItemCount: 2, totalBudget: 105000 });
    // BUG3 — the fixture's single revised-equipment row is type 'แก้ไข', so it
    // lands in `edit`; `change` stays empty (แก้ไข≠เปลี่ยนแปลง never merged).
    expect(res.byBook.edit).toEqual({ headItemCount: 1, totalBudget: 40000 });
    expect(res.byBook.change).toEqual({ headItemCount: 0, totalBudget: 0 });
    expect(res.byBook.supplement).toEqual({
      headItemCount: 1,
      totalBudget: 15000,
    });
    const y2567 = res.byYear.find((y) => y.year === 2567);
    expect(y2567).toEqual({ year: 2567, headItemCount: 3, totalBudget: 95000 });
    // Null-year bucket sorts last.
    expect(res.byYear[res.byYear.length - 1].year).toBeNull();
    expect(executiveList).toHaveBeenCalledTimes(1);
  });

  it('budgetSummary.byBook splits แก้ไข (edit) vs เปลี่ยนแปลง (change) — BUG3', async () => {
    // Two revised-equipment rows: one 'แก้ไข' (500k), one 'เปลี่ยนแปลง' (100k).
    // The pre-fix single `revision` bucket merged them to 600k under the
    // "เล่มแก้ไข" label — a แก้ไข≠เปลี่ยนแปลง violation. They MUST stay separate.
    const rows: UnifiedEquipmentRow[] = [
      makeRow({
        id: 'bbbbbbb1-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
        kind: 'revised-equipment',
        equipmentName: 'คอมพิวเตอร์ (แก้ไข)',
        developmentPlanRevision: {
          id: DPR_1,
          revisionNumber: 1,
          revisionTypeName: 'แก้ไข',
          description: 'แก้ไข ครั้งที่ 1/2569',
          isLatest: true,
          isBooked: true,
          isOpen: false,
        },
        budgets: [{ year: 2569, quantity: 500000 }],
      }),
      makeRow({
        id: 'bbbbbbb2-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
        kind: 'revised-equipment',
        equipmentName: 'คอมพิวเตอร์ประเภท 14 (เปลี่ยนแปลง)',
        developmentPlanRevision: {
          id: '44444444-4444-4444-8444-444444444444',
          revisionNumber: 1,
          revisionTypeName: 'เปลี่ยนแปลง',
          description: 'เปลี่ยนแปลง ครั้งที่ 1/2569',
          isLatest: true,
          isBooked: true,
          isOpen: false,
        },
        budgets: [{ year: 2569, quantity: 100000 }],
      }),
    ];
    const { service } = buildService(rows);
    const res = await service.budgetSummary({ planId: PLAN_A });
    expect(res.byBook.edit).toEqual({ headItemCount: 1, totalBudget: 500000 });
    expect(res.byBook.change).toEqual({ headItemCount: 1, totalBudget: 100000 });
    expect(res.byBook.main).toEqual({ headItemCount: 0, totalBudget: 0 });
    expect(res.byBook.supplement).toEqual({ headItemCount: 0, totalBudget: 0 });
  });

  it('statusBreakdown emits per-status counts + W67 4-group rollup', async () => {
    const { service } = buildService(buildFixture());
    const res = await service.statusBreakdown({});
    expect(res.totalCount).toBe(4);
    expect(res.executiveStatusBreakdown).toEqual({
      pendingReviewCount: 1,
      awaitingApprovalCount: 1,
      approvedCount: 1,
      rejectedCount: 1,
    });
    const approved = res.items.find((i) => i.status === 'Approved');
    expect(approved).toEqual({
      status: 'Approved',
      statusTh: 'อนุมัติ',
      count: 1,
    });
  });

  it('categoryBreakdown groups by category with uncategorized bucket (§16.5 rows kept)', async () => {
    const { service } = buildService(buildFixture());
    const res = await service.categoryBreakdown({});
    expect(res.totalCount).toBe(4);
    const cat = res.items.find((i) => i.categoryName === 'ครุภัณฑ์คอมพิวเตอร์');
    expect(cat?.itemCount).toBe(3);
    const uncategorized = res.items.find((i) => i.categoryName === null);
    // The ISSUE_BASED row (null category) is present — dual shape never drops rows.
    expect(uncategorized?.itemCount).toBe(1);
  });

  it('listInRevisionBook filters by DPR id and projects revisionMeta', async () => {
    const { service, executiveList } = buildService(buildFixture());
    const res = await service.listInRevisionBook(DPR_1);
    expect(res.totalCount).toBe(1);
    expect(res.items[0].bookLabel).toBe('เล่มแก้ไขครุภัณฑ์ ครั้งที่ 1');
    expect(res.revisionMeta).toEqual({
      revisionId: DPR_1,
      revisionNumber: 1,
      revisionTypeName: 'แก้ไข',
      isOpen: true,
      isBooked: false,
    });
    expect(executiveList).toHaveBeenCalledTimes(1);
  });

  it('listInRevisionBook unknown id → empty rows + sentinel meta (no throw)', async () => {
    const { service } = buildService(buildFixture());
    const res = await service.listInRevisionBook(
      '99999999-9999-4999-8999-999999999999',
    );
    expect(res.totalCount).toBe(0);
    expect(res.items).toEqual([]);
    expect(res.revisionMeta.revisionNumber).toBe(0);
    expect(res.revisionMeta.revisionTypeName).toBe('(ไม่ระบุ)');
  });

  it('listInSupplementBook filters by DPS id and projects supplementMeta', async () => {
    const { service } = buildService(buildFixture());
    const res = await service.listInSupplementBook(DPS_1);
    expect(res.totalCount).toBe(1);
    expect(res.items[0].bookLabel).toBe('เล่มเพิ่มเติมครุภัณฑ์ ครั้งที่ 2');
    expect(res.supplementMeta).toEqual({
      supplementId: DPS_1,
      supplementNumber: 2,
      isOpen: false,
      isBooked: true,
    });
  });

  it('PII discipline — no creator fields ever appear on projected items', async () => {
    const { service } = buildService(buildFixture());
    const res = await service.listInPlan(PLAN_A, {});
    for (const item of res.items) {
      const keys = Object.keys(item);
      expect(keys).not.toContain('createdBy');
      expect(keys).not.toContain('createdByWorkHistoryId');
      expect(keys).not.toContain('firstName');
      expect(keys).not.toContain('lastName');
      expect(keys).not.toContain('profileImageUrl');
      expect(JSON.stringify(item)).not.toContain('สมชาย');
    }
  });

  // ────────────────────────────────────────────────────────────────
  // BE-AGG-01 (Wave AI-EXEC-CHAT-BOOK-ANSWER-QUALITY) — countsByChildBook
  // ────────────────────────────────────────────────────────────────

  it('countsByChildBook maps document counts per child book (single document call)', async () => {
    // DOCUMENT semantics (2026-07-18): main is counted from the printed ผ.03,
    // NOT HEAD-of-lineage — e.g. main=3 even if 2 items were later revised.
    const { service, documentCountsByBook, executiveList } = buildService([], {
      main: 3,
      byRevision: [
        { revisionId: DPR_1, revisionNumber: 1, revisionTypeName: 'แก้ไข', itemCount: 1 },
      ],
      bySupplement: [{ supplementId: DPS_1, supplementNumber: 2, itemCount: 1 }],
    });
    const res = await service.countsByChildBook(PLAN_A);
    expect(documentCountsByBook).toHaveBeenCalledWith(PLAN_A);
    expect(documentCountsByBook).toHaveBeenCalledTimes(1);
    // No HEAD spine call — document counts come from the dedicated method.
    expect(executiveList).not.toHaveBeenCalled();
    expect(res.main.itemCount).toBe(3);
    expect(res.byRevision).toEqual([
      { revisionId: DPR_1, revisionNumber: 1, revisionTypeName: 'แก้ไข', itemCount: 1 },
    ]);
    expect(res.bySupplement).toEqual([
      { supplementId: DPS_1, supplementNumber: 2, itemCount: 1 },
    ]);
    expect(res.unresolvedCount).toBe(0);
  });

  it('countsByChildBook keeps แก้ไข and เปลี่ยนแปลง as DISTINCT buckets (D1)', async () => {
    const DPR_2 = '44444444-4444-4444-8444-444444444444';
    const { service } = buildService([], {
      main: 0,
      byRevision: [
        { revisionId: DPR_1, revisionNumber: 1, revisionTypeName: 'แก้ไข', itemCount: 1 },
        { revisionId: DPR_2, revisionNumber: 1, revisionTypeName: 'เปลี่ยนแปลง', itemCount: 1 },
      ],
      bySupplement: [],
    });
    const res = await service.countsByChildBook(PLAN_A);
    expect(res.byRevision).toHaveLength(2);
    const edit = res.byRevision.find((r) => r.revisionId === DPR_1);
    const change = res.byRevision.find((r) => r.revisionId === DPR_2);
    expect(edit?.revisionTypeName).toBe('แก้ไข');
    expect(change?.revisionTypeName).toBe('เปลี่ยนแปลง');
  });

  it('countsByChildBook returns unresolvedCount=0 (document INNER JOINs can never orphan)', async () => {
    // Document counts join each child-book row to its parent-book FK via an
    // INNER JOIN, so a missing FK is structurally impossible — no drift.
    const { service } = buildService([], {
      main: 1,
      byRevision: [
        { revisionId: DPR_1, revisionNumber: 1, revisionTypeName: 'แก้ไข', itemCount: 2 },
      ],
      bySupplement: [],
    });
    const res = await service.countsByChildBook(PLAN_A);
    expect(res.unresolvedCount).toBe(0);
  });

  it('countsByChildBook returns zero envelope when planId is undefined', async () => {
    const { service, documentCountsByBook } = buildService([]);
    const res = await service.countsByChildBook(undefined);
    expect(documentCountsByBook).not.toHaveBeenCalled();
    expect(res.main.itemCount).toBe(0);
    expect(res.byRevision).toEqual([]);
    expect(res.bySupplement).toEqual([]);
    expect(res.unresolvedCount).toBe(0);
  });

  // ────────────────────────────────────────────────────────────────
  // BE — headRoster (Wave AI-EXEC-CHAT-EQUIPMENT-HEAD-ROSTER)
  // ────────────────────────────────────────────────────────────────

  it('headRoster: derives origin + project-consistent book labels from executiveList', async () => {
    const { service, executiveList, resolveEquipmentOriginBookType } =
      buildService(buildFixture());
    const roster = await service.headRoster(PLAN_A);
    // Reuses the HEAD spine (no document dump).
    expect(executiveList).toHaveBeenCalledWith({ developmentPlanId: PLAN_A });
    // 4 fixture rows → 4 roster rows (executiveList already deduped to HEAD).
    expect(roster).toHaveLength(4);
    // EPG (main) → 'เล่มหลัก'; back-walk NOT invoked for kind==='equipment'.
    const main = roster.find((r) => r.originBookType === 'main' && r.headBookType === 'main');
    expect(main?.headBookLabel).toBe('เล่มหลัก');
    // RELPG (แก้ไข, description null) → static edit fallback (project-consistent).
    const edit = roster.find((r) => r.headBookType === 'edit');
    expect(edit?.headBookLabel).toBe('เล่มแก้ไขครั้งที่ 1');
    // Origin back-walk was consulted for the revised-equipment row.
    expect(resolveEquipmentOriginBookType).toHaveBeenCalled();
    // SEPG → supplement head.
    const sup = roster.find((r) => r.headBookType === 'supplement');
    expect(sup?.originBookType).toBe('supplement');
  });

  it('headRoster: originScope=main filters out supplement-origin rows', async () => {
    const { service } = buildService(buildFixture());
    const roster = await service.headRoster(PLAN_A, 'main');
    expect(roster.every((r) => r.originBookType === 'main')).toBe(true);
    // The SEPG (supplement origin) is excluded.
    expect(roster.some((r) => r.headBookType === 'supplement')).toBe(false);
  });

  it('headRoster: description-verbatim label gains a self-contained "เล่ม" prefix (BOOK-LABEL-DOUBLING-FIX)', async () => {
    // A revised-equipment HEAD whose DPR carries a user-authored description
    // ("เปลี่ยนแปลง ครั้งที่ 1/2569", NO "เล่ม") must surface to the LLM as a
    // self-contained label so the render template can emit it verbatim → the
    // template never prepends "เล่ม" → "เล่มเล่ม…" doubling is impossible.
    const rows = [
      makeRow({
        id: 'ccccccc1-cccc-4ccc-8ccc-ccccccccccc1',
        kind: 'revised-equipment',
        equipmentName: 'ประเภทครุภัณฑ์ 14. ครุภัณฑ์คอมพิวเตอร์',
        developmentPlanRevision: {
          id: DPR_1,
          revisionNumber: 1,
          revisionTypeName: 'เปลี่ยนแปลง',
          description: 'เปลี่ยนแปลง ครั้งที่ 1/2569',
          isLatest: true,
          isBooked: true,
          isOpen: false,
        },
      }),
    ];
    const { service } = buildService(rows);
    const roster = await service.headRoster(PLAN_A);
    expect(roster).toHaveLength(1);
    expect(roster[0].headBookLabel).toBe('เล่มเปลี่ยนแปลง ครั้งที่ 1/2569');
    expect(roster[0].headBookLabel.startsWith('เล่มเล่ม')).toBe(false);
  });

  it('empty spine → all methods return schema-shaped zero envelopes', async () => {
    const { service } = buildService([]);
    expect((await service.search('เครื่อง')).totalMatched).toBe(0);
    expect((await service.listInPlan(PLAN_A)).totalCount).toBe(0);
    const budget = await service.budgetSummary({});
    expect(budget.totalBudget).toBe(0);
    expect(budget.averageBudget).toBe(0);
    expect(budget.byYear).toEqual([]);
    const status = await service.statusBreakdown({});
    expect(status.items).toEqual([]);
    expect(status.executiveStatusBreakdown.approvedCount).toBe(0);
    expect((await service.categoryBreakdown({})).items).toEqual([]);
  });
});
