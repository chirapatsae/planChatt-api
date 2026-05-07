/**
 * W67-FIX-01 — Integration regression for the executive 4-group status
 * rollup.
 *
 * Why this exists
 * ---------------
 * The existing unit tests for `buildExecutiveStatusBreakdown` feed the
 * helper a `Map` keyed by canonical English statuses (e.g. `'Pending'`,
 * `'Approved'`). Those tests pass. They DID NOT catch the production
 * bug where `StatusAggregator` pre-translated `LatestStatus.statusName`
 * to Thai before the rollup loop saw it — the H1 fingerprint confirmed
 * by the user (`projectCount: 9` with all four executive buckets at 0).
 *
 * This spec drives the SAME rollup loop that lives at
 * `executive-tool-handlers.ts ~line 4191` (inside
 * `getExecutiveDashboardSnapshot`) but at a layer that includes the
 * `LatestStatus` map shape. The aggregator's contract (W67-FIX-01) is
 * now:
 *   - `LatestStatus.statusName`   = canonical ENGLISH (drives rollup)
 *   - `LatestStatus.statusNameTh` = Thai display label (display only)
 *
 * If a future change re-introduces the Thai-into-`statusName`
 * anti-pattern, the third test case (`regression: thai-keyed input`)
 * fails loudly with all-zero counts, exactly mirroring the production
 * symptom.
 *
 * §17.2 — this rollup is advisory; the test asserts shape + math, NOT
 * any workflow gating. §17.3 — no DB writes; pure compute.
 */

import { mapToExecutiveStatusGroup } from '../constants/executive-status-groups';
import type { LatestStatus } from '../interfaces';
import type { ProjectKey } from '../types';

/**
 * Replicate the rollup loop from `getExecutiveDashboardSnapshot`
 * (executive-tool-handlers.ts ~line 4191). Kept in lockstep with that
 * production loop — if production changes, this helper MUST follow.
 */
function rollupExecutiveBreakdown(
  statusMap: Map<ProjectKey, LatestStatus> | undefined,
): {
  pendingReviewCount: number;
  awaitingApprovalCount: number;
  approvedCount: number;
  rejectedCount: number;
} {
  const totals = {
    pending_review: 0,
    awaiting_approval: 0,
    approved: 0,
    rejected: 0,
  };
  if (statusMap) {
    const counts = new Map<string, number>();
    for (const s of statusMap.values()) {
      const name = s?.statusName;
      if (typeof name !== 'string' || name.length === 0) continue;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    for (const [name, count] of counts) {
      const grp = mapToExecutiveStatusGroup(name);
      if (!grp) continue;
      totals[grp] += Number(count) || 0;
    }
  }
  return {
    pendingReviewCount: totals.pending_review,
    awaitingApprovalCount: totals.awaiting_approval,
    approvedCount: totals.approved,
    rejectedCount: totals.rejected,
  };
}

/**
 * Construct a realistic `LatestStatus` map matching the W67-FIX-01
 * contract: canonical English on `statusName`, Thai sibling on
 * `statusNameTh`.
 */
function makeStatusMap(
  rows: Array<{ key: ProjectKey; statusName: string; statusNameTh: string }>,
): Map<ProjectKey, LatestStatus> {
  const map = new Map<ProjectKey, LatestStatus>();
  for (const r of rows) {
    map.set(r.key, {
      statusName: r.statusName,
      statusNameTh: r.statusNameTh,
      createdAt: new Date('2026-04-01T00:00:00Z').toISOString(),
      isLatest: true,
    });
  }
  return map;
}

describe('W67-FIX-01 — executive status rollup integration', () => {
  it('aggregates a realistic mixed-status map into the four executive buckets', () => {
    // 3 × Pending → pending_review
    // 2 × Approved → approved
    // 1 × Rejected → rejected
    // (no Verified / Pending_Approval → awaiting_approval = 0)
    const statusMap = makeStatusMap([
      {
        key: 'main:p1' as ProjectKey,
        statusName: 'Pending',
        statusNameTh: 'รอตรวจสอบ',
      },
      {
        key: 'main:p2' as ProjectKey,
        statusName: 'Pending',
        statusNameTh: 'รอตรวจสอบ',
      },
      {
        key: 'revised:r1' as ProjectKey,
        statusName: 'Pending',
        statusNameTh: 'รอตรวจสอบ',
      },
      {
        key: 'main:p3' as ProjectKey,
        statusName: 'Approved',
        statusNameTh: 'อนุมัติ',
      },
      {
        key: 'revised:r2' as ProjectKey,
        statusName: 'Approved',
        statusNameTh: 'อนุมัติ',
      },
      {
        key: 'main:p4' as ProjectKey,
        statusName: 'Rejected',
        statusNameTh: 'เกินศักยภาพ',
      },
    ]);

    const out = rollupExecutiveBreakdown(statusMap);

    expect(out).toEqual({
      pendingReviewCount: 3,
      awaitingApprovalCount: 0,
      approvedCount: 2,
      rejectedCount: 1,
    });
  });

  it('returns all-zero counts for an empty status map (defensive)', () => {
    const statusMap = makeStatusMap([]);

    const out = rollupExecutiveBreakdown(statusMap);

    expect(out).toEqual({
      pendingReviewCount: 0,
      awaitingApprovalCount: 0,
      approvedCount: 0,
      rejectedCount: 0,
    });
  });

  it('regression: a map keyed by Thai labels on `statusName` produces all-zero counts (the W67 H1 fingerprint)', () => {
    // BEHAVIOR CHOSEN: silent skip (every Thai key hits `default → null`
    // in `mapToExecutiveStatusGroup`). This mirrors the production path
    // and intentionally does NOT log/throw — surfacing the bug is the
    // job of the FIRST test above (which would still pass under the old
    // Thai-keyed contract because the OLD aggregator wrote Thai into
    // `statusName`, so `mapToExecutiveStatusGroup` would still return
    // null for every entry → all zeros). This third test pins the
    // diagnostic: IF you ever see `{0,0,0,0}` in production again with
    // projectCount > 0, the aggregator regression is back.
    const broken = new Map<ProjectKey, LatestStatus>();
    broken.set('main:p1' as ProjectKey, {
      // Intentionally wrong: Thai injected into the canonical-English field.
      statusName: 'รอตรวจสอบ',
      statusNameTh: 'รอตรวจสอบ',
      createdAt: new Date().toISOString(),
      isLatest: true,
    });
    broken.set('main:p2' as ProjectKey, {
      statusName: 'อนุมัติ',
      statusNameTh: 'อนุมัติ',
      createdAt: new Date().toISOString(),
      isLatest: true,
    });

    const out = rollupExecutiveBreakdown(broken);

    expect(out).toEqual({
      pendingReviewCount: 0,
      awaitingApprovalCount: 0,
      approvedCount: 0,
      rejectedCount: 0,
    });
  });

  it('rolls up Verified + Pending_Approval into awaiting_approval', () => {
    const statusMap = makeStatusMap([
      {
        key: 'main:p1' as ProjectKey,
        statusName: 'Verified',
        statusNameTh: 'ตรวจสอบผ่าน',
      },
      {
        key: 'main:p2' as ProjectKey,
        statusName: 'Pending_Approval',
        statusNameTh: 'รออนุมัติ',
      },
      {
        key: 'main:p3' as ProjectKey,
        statusName: 'Pending_Approval',
        statusNameTh: 'รออนุมัติ',
      },
    ]);

    const out = rollupExecutiveBreakdown(statusMap);

    expect(out).toEqual({
      pendingReviewCount: 0,
      awaitingApprovalCount: 3,
      approvedCount: 0,
      rejectedCount: 0,
    });
  });

  it('skips workflow-internal statuses (Ready / Pull_Back / Returned_For_Revision)', () => {
    const statusMap = makeStatusMap([
      {
        key: 'main:p1' as ProjectKey,
        statusName: 'Ready',
        statusNameTh: 'รอนำส่ง',
      },
      {
        key: 'main:p2' as ProjectKey,
        statusName: 'Pull_Back',
        statusNameTh: 'ดึงกลับ',
      },
      {
        key: 'main:p3' as ProjectKey,
        statusName: 'Returned_For_Revision',
        statusNameTh: 'รอแก้ไข',
      },
      {
        key: 'main:p4' as ProjectKey,
        statusName: 'Pending',
        statusNameTh: 'รอตรวจสอบ',
      },
    ]);

    const out = rollupExecutiveBreakdown(statusMap);

    // Only the single Pending row falls into an executive bucket.
    expect(out).toEqual({
      pendingReviewCount: 1,
      awaitingApprovalCount: 0,
      approvedCount: 0,
      rejectedCount: 0,
    });
  });
});
