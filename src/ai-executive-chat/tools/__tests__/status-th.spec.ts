/**
 * BE-W48-02 — Thai status label helper + handler sibling-field tests.
 *
 * Covers:
 *   1. Map exactness — every canonical CLAUDE.md status has the expected
 *      Thai label (9 rows: Draft, Ready, Pending, Verified,
 *      Pending_Approval, Approved, Returned_For_Revision, Revision
 *      alias, Pull_Back, Rejected).
 *   2. Fallback — unknown status returns the input unchanged.
 *   3. Null / undefined / empty-string safety.
 *   4. Handler integration — `getProjectStatusBreakdown` and
 *      `getApprovalPipelineSnapshot` emit `statusTh` siblings on every
 *      status-bearing row without removing or mutating the canonical
 *      English `status` / `fromStatus` / `toStatus` fields.
 *
 * CLAUDE.md references:
 *   - §17.2 — Thai labels are advisory; no gating.
 *   - §17.9 — tool result shape remains schema-valid; new field is
 *     additive and plain-string.
 */

import { STATUS_TH_MAP, toThaiStatus } from '../status-th';
import { EXECUTIVE_TOOL_HANDLERS } from '../handlers/executive-tool-handlers';
import type { ExecutiveCallerContext } from '../handlers/handler-types';

describe('BE-W48-02 / Thai status helper (§17.2)', () => {
  describe('STATUS_TH_MAP', () => {
    it('covers every canonical CLAUDE.md status', () => {
      expect(STATUS_TH_MAP.Draft).toBe('ร่าง');
      expect(STATUS_TH_MAP.Ready).toBe('รอนำส่ง');
      // W67 (2026-04-25) — synced to the new DB seed value. The DB
      // `status.th_name` for `Pending` was updated from "รอการอนุมัติ"
      // to "รอตรวจสอบ" by migration
      // `1748400000000-W67-AddRejectedStatusAndAlignThaiLabels`; the
      // deprecated static map mirrors the SOT for legacy callers.
      expect(STATUS_TH_MAP.Pending).toBe('รอตรวจสอบ');
      expect(STATUS_TH_MAP.Verified).toBe('ตรวจสอบผ่าน');
      expect(STATUS_TH_MAP.Pending_Approval).toBe('รออนุมัติ');
      expect(STATUS_TH_MAP.Approved).toBe('อนุมัติ');
      expect(STATUS_TH_MAP.Returned_For_Revision).toBe('รอแก้ไข');
      expect(STATUS_TH_MAP.Pull_Back).toBe('ดึงกลับ');
      expect(STATUS_TH_MAP.Rejected).toBe('เกินศักยภาพ');
    });

    it('keeps the legacy "Revision" alias for FE-map parity', () => {
      expect(STATUS_TH_MAP.Revision).toBe('รอแก้ไข');
    });
  });

  describe('toThaiStatus()', () => {
    it('translates every known canonical status', () => {
      // W67: Pending Thai label now "รอตรวจสอบ" (was "รอการอนุมัติ").
      expect(toThaiStatus('Pending')).toBe('รอตรวจสอบ');
      expect(toThaiStatus('Pending_Approval')).toBe('รออนุมัติ');
      expect(toThaiStatus('Approved')).toBe('อนุมัติ');
      expect(toThaiStatus('Verified')).toBe('ตรวจสอบผ่าน');
      expect(toThaiStatus('Returned_For_Revision')).toBe('รอแก้ไข');
      expect(toThaiStatus('Pull_Back')).toBe('ดึงกลับ');
      expect(toThaiStatus('Ready')).toBe('รอนำส่ง');
    });

    it('returns empty string for null / undefined / empty input', () => {
      expect(toThaiStatus(null)).toBe('');
      expect(toThaiStatus(undefined)).toBe('');
      expect(toThaiStatus('')).toBe('');
    });

    it('returns input unchanged for unknown status (safe fallback)', () => {
      expect(toThaiStatus('SomeFutureStatus')).toBe('SomeFutureStatus');
      expect(toThaiStatus('Garbage')).toBe('Garbage');
    });
  });
});

// ────────────────────────────────────────────────────────────────────
// Handler integration — asserts `statusTh` sibling field emission.
// ────────────────────────────────────────────────────────────────────

function fakeCtx(): ExecutiveCallerContext {
  return {
    userId: 'u1',
    workHistoryId: 'w1',
    roleName: 'admin',
    workStatusName: 'approved',
  };
}

describe('BE-W48-02 / handler statusTh emission (§17.2 additive)', () => {
  it('getProjectStatusBreakdown emits statusTh alongside each status row', async () => {
    const rawRows = [
      { status: 'Pending', cnt: '3' },
      { status: 'Approved', cnt: '7' },
      { status: 'Returned_For_Revision', cnt: '1' },
    ];

    // Minimal DataSource stub — the handler only exercises one QB chain.
    const qb = {
      select: () => qb,
      addSelect: () => qb,
      innerJoin: () => qb,
      leftJoin: () => qb,
      where: () => qb,
      andWhere: () => qb,
      groupBy: () => qb,
      getRawMany: () => Promise.resolve(rawRows),
    };
    const deps = {
      dataSource: {
        getRepository: () => ({
          createQueryBuilder: () => qb,
        }),
      } as any,
      // Wave 54 Tier B — unused by Wave 53 handlers under test.
      unifiedProject: {} as never,
      budget: {} as never,
      status: {} as never,
      geo: {} as never,
      agency: {} as never,
      resilience: {} as never,
    };

    // BE-W53-02 widened `getProjectStatusBreakdown` to iterate
    // main+revision+supplement for `scope='all'`. To keep this test
    // focused on §17.2 Thai-sibling emission (not BE-W53-02 scope
    // merging), pin the call to `scope='main'` so the stubbed QB runs
    // exactly once and the sums match the raw-row fixture.
    //
    // Wave 57 W57-BE-AGG-05 — opt into `detailMode: true` so the new
    // Q5 rollup ("รออนุมัติ" = Pending+Verified+Pending_Approval)
    // does NOT collapse Pending into the rollup bucket; this test
    // pre-dates AGG-05 and asserts canonical Thai labels per status.
    const result: any = await EXECUTIVE_TOOL_HANDLERS.getProjectStatusBreakdown(
      { scope: 'main', detailMode: true },
      fakeCtx(),
      deps,
    );

    expect(Array.isArray(result.items)).toBe(true);
    expect(result.items).toHaveLength(3);
    // Canonical English `status` preserved.
    expect(result.items[0].status).toBe('Pending');
    expect(result.items[1].status).toBe('Approved');
    // Sibling `statusTh` present with correct Thai mapping.
    // W67: Pending Thai label now "รอตรวจสอบ" (was "รอการอนุมัติ").
    expect(result.items[0].statusTh).toBe('รอตรวจสอบ');
    expect(result.items[1].statusTh).toBe('อนุมัติ');
    expect(result.items[2].statusTh).toBe('รอแก้ไข');
    // Counts untouched.
    expect(result.items[0].count).toBe(3);
    expect(result.items[1].count).toBe(7);
  });

  it('getApprovalPipelineSnapshot emits fromStatusTh and toStatusTh on every stage', async () => {
    const rawRows = [
      { status: 'Ready', cnt: '2' },
      { status: 'Pending', cnt: '5' },
      { status: 'Verified', cnt: '1' },
      { status: 'Pending_Approval', cnt: '4' },
      { status: 'Approved', cnt: '10' },
    ];
    const qb = {
      select: () => qb,
      addSelect: () => qb,
      innerJoin: () => qb,
      where: () => qb,
      andWhere: () => qb,
      groupBy: () => qb,
      getRawMany: () => Promise.resolve(rawRows),
    };
    const deps = {
      dataSource: {
        getRepository: () => ({
          createQueryBuilder: () => qb,
        }),
      } as any,
      // Wave 54 Tier B — unused by Wave 53 handlers under test.
      unifiedProject: {} as never,
      budget: {} as never,
      status: {} as never,
      geo: {} as never,
      agency: {} as never,
      resilience: {} as never,
    };

    const result: any =
      await EXECUTIVE_TOOL_HANDLERS.getApprovalPipelineSnapshot(
        {},
        fakeCtx(),
        deps,
      );

    expect(Array.isArray(result.stages)).toBe(true);
    expect(result.stages).toHaveLength(4);

    for (const stage of result.stages) {
      // Canonical English preserved.
      expect(typeof stage.fromStatus).toBe('string');
      expect(typeof stage.toStatus).toBe('string');
      // Thai siblings emitted.
      expect(typeof stage.fromStatusTh).toBe('string');
      expect(stage.fromStatusTh.length).toBeGreaterThan(0);
      expect(typeof stage.toStatusTh).toBe('string');
      expect(stage.toStatusTh.length).toBeGreaterThan(0);
    }

    // Spot-check a couple of specific mappings.
    const readyToPending = result.stages.find(
      (s: any) => s.fromStatus === 'Ready',
    );
    expect(readyToPending.fromStatusTh).toBe('รอนำส่ง');
    // W67: Pending Thai label now "รอตรวจสอบ" (was "รอการอนุมัติ").
    expect(readyToPending.toStatusTh).toBe('รอตรวจสอบ');

    const pApprovedToApproved = result.stages.find(
      (s: any) => s.fromStatus === 'Pending_Approval',
    );
    expect(pApprovedToApproved.fromStatusTh).toBe('รออนุมัติ');
    expect(pApprovedToApproved.toStatusTh).toBe('อนุมัติ');
  });
});
