/**
 * BE-W53-04 — Wave 53 user-reported production reproductions (2026-04-24).
 *
 * Reproduces the three Thai prompts the user reported in the production
 * outage caused by the raw-SQL plural-table literal in the
 * `listProjectsInPlan` tool handler (see
 * docs/reports/wave53/WAVE53_CHAT_AI_TOOLING_RCA.md).
 *
 * Each test:
 *   - Builds a DataSource stub whose `getRawMany` chain inspects the
 *     compiled SQL and short-circuits with
 *     `relation "budgets" does not exist` if the literal appears, thus
 *     flipping red against the pre-Wave-53 build and green post-fix.
 *   - Invokes the handler with a valid plan UUID.
 *   - Asserts a 200-shape envelope + `items[0].budget` is `typeof 'number'`.
 *   - Spies `assertExecutiveRole` via the role-guard error path to prove
 *     it ran.
 *
 * CLAUDE.md references:
 *   - §17.2 — advisory read aggregator; tool MUST NOT gate workflow.
 *   - §17.9 — returnSchema validator gate preserved.
 *   - §17.11 — role guard belt-and-braces inside handler.
 */
import { EXECUTIVE_TOOL_HANDLERS } from '../handlers/executive-tool-handlers';
import {
  ExecutiveCallerContext,
  ExecutiveToolHandlerDeps,
} from '../handlers/handler-types';

const UUID_PLAN = '11111111-1111-4111-8111-111111111111';
const UUID_PG1 = '22222222-2222-4222-8222-222222222222';

function makeCtx(
  overrides: Partial<ExecutiveCallerContext> = {},
): ExecutiveCallerContext {
  return {
    userId: 'user-1',
    workHistoryId: 'wh-1',
    roleName: 'staff',
    workStatusName: 'approved',
    ...overrides,
  };
}

type FakeRow = {
  pgid: string;
  title: string;
  statusname: string | null;
  amphoeid: number | null;
  agencyid: number | null;
  budget: string | null;
};

/**
 * QB stub that tracks every SQL-ish string it is handed. Any string arg
 * (or sub-query-callback-returned string) that matches /FROM\s+budgets/i
 * causes the next `getRawMany()` to throw
 * `relation "budgets" does not exist` — exactly the error production saw.
 *
 * Under Option 2 (correlated sub-query via `.from(Budget, 'b')`) the
 * handler never passes such a literal, and the stub returns canned rows.
 */
function makeDeps(rows: FakeRow[]): {
  deps: ExecutiveToolHandlerDeps;
  seenSqlFragments: string[];
} {
  const seenSqlFragments: string[] = [];
  const trapRegex = /FROM\s+budgets\b/i;

  // Mock SelectQueryBuilder the sub-query callback receives. If the
  // real handler ever called `.from(anything, 'b')` with a plural
  // "budgets" string literal, it would be visible here.
  const makeSubQb = (): Record<string, unknown> => {
    const subQb: Record<string, unknown> = {};
    const self = () => subQb;
    Object.assign(subQb, {
      select: (s: unknown) => {
        if (typeof s === 'string') seenSqlFragments.push(s);
        return subQb;
      },
      from: (target: unknown, _alias?: unknown) => {
        // Record the entity class name OR the string literal; production
        // bug was `'budgets'` as a string literal.
        if (typeof target === 'string') {
          seenSqlFragments.push(`FROM ${target}`);
        } else if (target && typeof target === 'function') {
          seenSqlFragments.push(`FROM <entity:${(target as Function).name}>`);
        }
        return subQb;
      },
      where: self,
      andWhere: self,
      getQuery: () => seenSqlFragments.join(' '),
    });
    return subQb;
  };

  const qb: Record<string, unknown> = {};
  const chain = (arg?: unknown) => {
    if (typeof arg === 'string') seenSqlFragments.push(arg);
    if (typeof arg === 'function') {
      try {
        // Invoke the sub-query callback so it funnels any
        // `.from(..., 'b')` call into our trap above.
        (arg as (sub: Record<string, unknown>) => unknown)(makeSubQb());
      } catch {
        // Swallow — we only care about the strings it emitted.
      }
    }
    return qb;
  };

  Object.assign(qb, {
    select: chain,
    addSelect: chain,
    leftJoin: chain,
    innerJoin: chain,
    where: chain,
    andWhere: chain,
    orderBy: chain,
    addOrderBy: chain,
    groupBy: chain,
    addGroupBy: chain,
    limit: chain,
    take: chain,
    getRawMany: async () => {
      for (const s of seenSqlFragments) {
        if (trapRegex.test(s)) {
          // Mimic the production Postgres error. Under the fix this
          // path is never reached because the handler uses
          // `.from(Budget, 'b')` (entity reference) — the trap stays
          // silent and canned rows are returned.
          throw new Error('relation "budgets" does not exist');
        }
      }
      return rows;
    },
    getMany: async () => rows,
  });

  const deps: ExecutiveToolHandlerDeps = {
    dataSource: {
      getRepository: () => ({
        createQueryBuilder: () => qb,
      }),
    } as unknown as ExecutiveToolHandlerDeps['dataSource'],
    // Wave 54 Tier B — unused by Wave 53 handlers under test.
    unifiedProject: {} as never,
    budget: {} as never,
    status: {} as never,
    geo: {} as never,
    agency: {} as never,
    resilience: {} as never,
  };

  return { deps, seenSqlFragments };
}

function assertRoleWasChecked(
  handler: (
    p: Record<string, unknown>,
    c: ExecutiveCallerContext,
    d: ExecutiveToolHandlerDeps,
  ) => Promise<unknown>,
  deps: ExecutiveToolHandlerDeps,
): Promise<void> {
  // If assertExecutiveRole fired, a `user`-role ctx throws
  // EXECUTIVE_ROLE_REQUIRED. That proves the belt-and-braces guard
  // still runs inside the handler (§17.11).
  return expect(
    handler({ planId: UUID_PLAN }, makeCtx({ roleName: 'user' }), deps),
  ).rejects.toThrow(/EXECUTIVE_ROLE_REQUIRED/);
}

const PII_KEYS = [
  'createdBy',
  'firstName',
  'lastName',
  'citizenId',
  'phone',
  'email',
] as const;
function assertNoPii(envelope: unknown): void {
  const json = JSON.stringify(envelope);
  for (const k of PII_KEYS) {
    expect(json).not.toMatch(new RegExp(`"${k}"`));
  }
}

describe('Wave 53 — user-reported production reproductions (2026-04-24)', () => {
  const handler = EXECUTIVE_TOOL_HANDLERS.listProjectsInPlan;
  const cannedRow: FakeRow = {
    pgid: UUID_PG1,
    title: 'โครงการปรับปรุงถนน',
    statusname: 'Approved',
    amphoeid: 1,
    agencyid: 100,
    budget: '2500',
  };

  it('Prompt 1 — "ขอรายชื่อโครงการในแผน X" returns budget as number, no "relation does not exist"', async () => {
    const { deps, seenSqlFragments } = makeDeps([cannedRow]);
    // W60c — legacy flat shape requires explicit groupBy: 'flat'
    const out = await handler({ planId: UUID_PLAN, groupBy: 'flat' }, makeCtx(), deps);
    expect(out.planId).toBe(UUID_PLAN);
    const items = out.items as Array<Record<string, unknown>>;
    expect(items.length).toBeGreaterThan(0);
    expect(typeof items[0].budget).toBe('number');
    expect(items[0].budget).toBe(2500);
    // No raw plural-table literal was smuggled through the QB.
    const hit = seenSqlFragments.find((s) => /FROM\s+budgets\b/i.test(s));
    expect(hit).toBeUndefined();
    assertNoPii(out);
    await assertRoleWasChecked(handler, deps);
  });

  it('Prompt 2 — "โครงการทั้งหมดในแผน Y มีอะไรบ้าง" returns populated items with numeric budget', async () => {
    const { deps, seenSqlFragments } = makeDeps([
      cannedRow,
      {
        ...cannedRow,
        pgid: '33333333-3333-4333-8333-333333333333',
        title: 'โครงการน้ำประปา',
        budget: '1000',
      },
    ]);
    const out = await handler({ planId: UUID_PLAN, groupBy: 'flat' }, makeCtx(), deps);
    const items = out.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    for (const it of items) {
      expect(typeof it.budget).toBe('number');
    }
    expect(seenSqlFragments.some((s) => /FROM\s+budgets\b/i.test(s))).toBe(
      false,
    );
    assertNoPii(out);
    await assertRoleWasChecked(handler, deps);
  });

  it('Prompt 3 — "โครงการในแผน Z" with scope=main returns envelope + budget number', async () => {
    const { deps, seenSqlFragments } = makeDeps([cannedRow]);
    const out = await handler(
      // W60c (2026-04-25) — handler default flipped to byBookCompleteness;
      // legacy flat shape now requires explicit `groupBy: 'flat'`. This
      // test asserts the legacy contract.
      { planId: UUID_PLAN, scope: 'main', groupBy: 'flat' },
      makeCtx(),
      deps,
    );
    expect(out.planId).toBe(UUID_PLAN);
    expect(Array.isArray(out.items)).toBe(true);
    expect(typeof (out as { asOf?: unknown }).asOf).toBe('string');
    const items = out.items as Array<Record<string, unknown>>;
    expect(items[0].projectKind).toBe('original');
    expect(typeof items[0].budget).toBe('number');
    expect(seenSqlFragments.some((s) => /FROM\s+budgets\b/i.test(s))).toBe(
      false,
    );
    assertNoPii(out);
    await assertRoleWasChecked(handler, deps);
  });
});
