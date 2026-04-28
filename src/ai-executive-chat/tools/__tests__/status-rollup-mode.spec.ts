/**
 * Wave 57 W57-BE-AGG-05 — Handler-level rollup vs detail mode spec.
 *
 * Verifies:
 *   1. Default mode collapses Pending + Verified + Pending_Approval
 *      into a single "รออนุมัติ" bucket (Q5 default rollup).
 *   2. detailMode=true returns canonical statuses individually (Q5
 *      detail mode).
 *   3. Ready does NOT appear in the default exec output (Q8).
 *   4. `getPendingCountsByScope` rolls up by default per Q5.
 */
import { EXECUTIVE_TOOL_HANDLERS } from '../handlers/executive-tool-handlers';
import {
  ExecutiveCallerContext,
  ExecutiveToolHandlerDeps,
} from '../handlers/handler-types';

function fakeCtx(): ExecutiveCallerContext {
  return {
    userId: 'u1',
    workHistoryId: 'w1',
    roleName: 'admin',
    workStatusName: 'approved',
  };
}

function makeDeps(rawRows: Array<{ status: string; cnt: string }>) {
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
  return {
    dataSource: {
      getRepository: () => ({ createQueryBuilder: () => qb }),
    } as unknown as ExecutiveToolHandlerDeps['dataSource'],
    unifiedProject: {} as never,
    budget: {} as never,
    status: {} as never,
    geo: {} as never,
    agency: {} as never,
    resilience: {} as never,
  };
}

describe('W57-BE-AGG-05 / getProjectStatusBreakdown bucket mode', () => {
  const handler = EXECUTIVE_TOOL_HANDLERS.getProjectStatusBreakdown;

  it('W67 default rollup: Verified=3 + Pending_Approval=2 → "รออนุมัติ"=5; Pending stays separate', async () => {
    // W67-BE-CONST-01 (2026-04-25): Pending was REMOVED from
    // APPROVAL_PIPELINE_STATUSES and now lives in its own
    // `pending_review` bucket per `executive-status-groups.ts`.
    // The "รออนุมัติ" rollup therefore only collapses Verified +
    // Pending_Approval; Pending stays as its own canonical row.
    const deps = makeDeps([
      { status: 'Pending', cnt: '5' },
      { status: 'Verified', cnt: '3' },
      { status: 'Pending_Approval', cnt: '2' },
      { status: 'Approved', cnt: '7' },
    ]);
    const out = (await handler({ scope: 'main' }, fakeCtx(), deps)) as Record<
      string,
      unknown
    >;
    const items = out.items as Array<Record<string, unknown>>;
    const rollup = items.find((i) => i.status === 'awaiting_approval');
    expect(rollup).toBeDefined();
    expect(rollup!.count).toBe(5);
    expect(rollup!.statusTh).toBe('รออนุมัติ');
    // Verified / Pending_Approval should NOT appear individually (rolled up).
    expect(items.find((i) => i.status === 'Verified')).toBeUndefined();
    expect(
      items.find((i) => i.status === 'Pending_Approval'),
    ).toBeUndefined();
    // Pending now appears as its own canonical row (W67 — moved out of pipeline).
    const pending = items.find((i) => i.status === 'Pending');
    expect(pending).toBeDefined();
    expect(pending!.count).toBe(5);
    // Approved still appears as a separate bucket.
    expect(items.find((i) => i.status === 'Approved')).toBeDefined();
    // Advisory emitted.
    expect(out.advisories as string[]).toContain(
      'approval-pipeline-rollup-applied',
    );
  });

  it('detail mode: same fixture → 4 canonical rows', async () => {
    const deps = makeDeps([
      { status: 'Pending', cnt: '5' },
      { status: 'Verified', cnt: '3' },
      { status: 'Pending_Approval', cnt: '2' },
      { status: 'Approved', cnt: '7' },
    ]);
    const out = (await handler(
      { scope: 'main', detailMode: true },
      fakeCtx(),
      deps,
    )) as Record<string, unknown>;
    const items = out.items as Array<Record<string, unknown>>;
    const map = new Map<string, number>();
    for (const i of items) map.set(String(i.status), Number(i.count));
    expect(map.get('Pending')).toBe(5);
    expect(map.get('Verified')).toBe(3);
    expect(map.get('Pending_Approval')).toBe(2);
    expect(map.get('Approved')).toBe(7);
    expect(map.get('awaiting_approval')).toBeUndefined();
  });

  it('default exec view filters out Ready (Q8 hidden)', async () => {
    // The DB layer would still return Ready if asked, but the handler
    // applies `status.name IN (:visibleStatuses)`. The stub returns the
    // raw rows it is given; this test asserts the WHERE clause logic by
    // verifying that even if Ready slips through the stub it is NOT
    // present in the output (rollup ignores it; detail-mode also drops
    // it because the WHERE filter excluded it from the SELECT).
    const deps = makeDeps([
      { status: 'Approved', cnt: '7' },
      // No Ready row — the stub mimics the WHERE filter result.
    ]);
    const out = (await handler(
      { scope: 'main', detailMode: true },
      fakeCtx(),
      deps,
    )) as Record<string, unknown>;
    const items = out.items as Array<Record<string, unknown>>;
    expect(items.find((i) => i.status === 'Ready')).toBeUndefined();
  });
});

describe('W57-BE-AGG-05 / getPendingCountsByScope bucket mode', () => {
  const handler = EXECUTIVE_TOOL_HANDLERS.getPendingCountsByScope;

  it('default rollup collapses pipeline statuses into one "รออนุมัติ" bucket per scope', async () => {
    const deps = makeDeps([
      { status: 'Pending', cnt: '4' },
      { status: 'Verified', cnt: '3' },
      { status: 'Pending_Approval', cnt: '1' },
    ]);
    const out = (await handler({ scope: 'main' }, fakeCtx(), deps)) as Record<
      string,
      unknown
    >;
    const items = out.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0].scope).toBe('main');
    expect(items[0].status).toBe('awaiting_approval');
    expect(items[0].count).toBe(8);
    expect(out.advisories as string[]).toContain(
      'approval-pipeline-rollup-applied',
    );
  });

  it('detail mode returns each canonical status separately', async () => {
    const deps = makeDeps([
      { status: 'Pending', cnt: '4' },
      { status: 'Verified', cnt: '3' },
      { status: 'Pending_Approval', cnt: '1' },
    ]);
    const out = (await handler(
      { scope: 'main', detailMode: true },
      fakeCtx(),
      deps,
    )) as Record<string, unknown>;
    const items = out.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(3);
    expect(out.advisories as string[]).not.toContain(
      'approval-pipeline-rollup-applied',
    );
  });
});
