/**
 * BE-W48-03 — `listProjectsInPlan` handler smoke test.
 *
 * Covers:
 *   - Registry contract (name / params / return schema)
 *   - Role guard re-assertion (§17.11)
 *   - Projection discipline — NO createdBy / firstName / lastName / citizenId
 *   - Thai status sibling (statusTh) populated via `toThaiStatus`
 *   - scope param accepted but clamped to `main` (Wave 48 scope)
 *   - Schema-validator accepts the emitted envelope (§17.9)
 *
 * The DB layer is mocked — we build a DataSource stub that returns a
 * canned `getRawMany` payload shaped like the query projects.
 */
import {
  EXECUTIVE_TOOL_REGISTRY,
  EXECUTIVE_TOOL_NAMES,
} from '../tool-registry';
import { EXECUTIVE_TOOL_HANDLERS } from '../handlers/executive-tool-handlers';
import {
  ExecutiveCallerContext,
  ExecutiveToolHandlerDeps,
} from '../handlers/handler-types';
import { validateAgainstSchema } from '../tool-schema-validator';

const UUID_PLAN = '11111111-1111-4111-8111-111111111111';
const UUID_PG1 = '22222222-2222-4222-8222-222222222222';
const UUID_PG2 = '33333333-3333-4333-8333-333333333333';
const UUID_PG3 = '44444444-4444-4444-8444-444444444444';

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

function makeDeps(rows: FakeRow[]): ExecutiveToolHandlerDeps {
  const qb: Record<string, unknown> = {};
  const chain = () => qb;
  Object.assign(qb, {
    select: chain,
    addSelect: chain,
    leftJoin: chain,
    innerJoin: chain,
    from: chain,
    where: chain,
    andWhere: chain,
    orderBy: chain,
    addOrderBy: chain,
    groupBy: chain,
    addGroupBy: chain,
    limit: chain,
    take: chain,
    getRawMany: async () => rows,
  });
  return {
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
}

describe('BE-W48-03 / listProjectsInPlan', () => {
  describe('registry contract', () => {
    const spec = EXECUTIVE_TOOL_REGISTRY.listProjectsInPlan;

    it('is registered in EXECUTIVE_TOOL_REGISTRY', () => {
      expect(spec).toBeDefined();
      expect(spec.name).toBe('listProjectsInPlan');
    });

    it('is present in EXECUTIVE_TOOL_NAMES', () => {
      expect(EXECUTIVE_TOOL_NAMES).toContain('listProjectsInPlan');
    });

    it('planId is OPTIONAL (Wave FOLLOWUP-CONTINUITY); validation owned by handler', () => {
      // W60c (2026-04-25): dropped strict `format: 'uuid'` from the
      // schema so the schema validator stops short-circuiting the turn
      // BEFORE the handler can return its friendly hint envelope.
      // Wave FOLLOWUP-CONTINUITY (2026-07-18): planId dropped from
      // `required` — omitting it makes the handler default to a
      // WHOLE-MUNICIPALITY listing (symmetric with listEquipmentInPlan),
      // so a detail/listing follow-up after a plan-less turn still
      // resolves. A non-empty MALFORMED planId still returns the handler's
      // friendly-hint envelope (UUID_RX check).
      expect(spec.paramsSchema.required).not.toContain('planId');
      expect(spec.paramsSchema.properties?.planId?.type).toBe('string');
    });

    it('scope enum is ["main","revised","supplement","all"] (Wave 53 widened)', () => {
      // BE-W53-02 widened scope to honour main/revised/supplement; Wave
      // 48's original ["main","all"] was narrowed to reflect the
      // original deferred state and has been lifted now that the
      // handler composes all three scopes.
      expect(spec.paramsSchema.properties?.scope?.enum).toEqual([
        'main',
        'revised',
        'supplement',
        'all',
      ]);
    });

    it('limit clamps 1..50 with default 20', () => {
      const p = spec.paramsSchema.properties?.limit;
      expect(p?.minimum).toBe(1);
      expect(p?.maximum).toBe(50);
      expect(p?.default).toBe(20);
    });

    it('returnSchema.items requires projectId/projectKind/name/currentStatus/statusTh + Wave 58 + Wave 59 + Wave 62 envelope keys', () => {
      // Wave 58 W58-BE-AGG-01 (D3 / D4 / D6) — five new envelope keys
      // are now ALWAYS-present:
      //   - responsibleAgencyName / responsibleAgencyDisclosure (D3 / D6)
      //   - revisionRoundType / revisionRoundId / revisionRoundLabel (D4)
      // Wave 58 W58-BE-AGG-03 (D7) — `pageNumber` joined the always-present
      // key set (value MAY be null at runtime when the book is unbooked).
      // Wave 59 W59-BE-AGG-01 (D-B / D-C) — five further keys joined:
      //   - objective / objectiveTruncated (D-B)
      //   - amphoeName / laoName / geoCoordinates (D-C)
      // Wave 62 W62-BE-AGG-01 — six further keys joined for the
      // extended classification surface:
      //   - goal / goalTruncated / expected / expectedTruncated (always)
      //   - indicator / developmentIssueLabel (§16.5 mutually-exclusive,
      //     driven by parent plan's reportFormat per §17.7)
      const itemSchema = spec.returnSchema.properties?.items?.items;
      expect(itemSchema?.required).toEqual([
        'projectId',
        'projectKind',
        'name',
        'currentStatus',
        'statusTh',
        'executiveStatus',
        'responsibleAgencyName',
        'responsibleAgencyDisclosure',
        'revisionRoundType',
        'revisionRoundId',
        'revisionRoundLabel',
        'pageNumber',
        'objective',
        'objectiveTruncated',
        'goal',
        'goalTruncated',
        'expected',
        'expectedTruncated',
        'indicator',
        'developmentIssueLabel',
        'amphoeName',
        'laoName',
        'geoCoordinates',
      ]);
    });

    it('projectKind enum is ["original","revised","supplement"] (Wave 53 widened)', () => {
      // BE-W53-02 widened the returned row's projectKind to match the
      // widened scope handler. Wave 48's main-only restriction was
      // deliberately deferred; it is now lifted.
      const itemSchema = spec.returnSchema.properties?.items?.items;
      expect(itemSchema?.properties?.projectKind?.enum).toEqual([
        'original',
        'revised',
        'supplement',
      ]);
    });

    it('description is read-only (อ่านอย่างเดียว)', () => {
      expect(spec.description).toMatch(/อ่านอย่างเดียว/);
    });

    it('does NOT leak createdBy / firstName / lastName / citizenId', () => {
      const itemProps =
        spec.returnSchema.properties?.items?.items?.properties ?? {};
      for (const forbidden of [
        'createdBy',
        'firstName',
        'lastName',
        'citizenId',
        'email',
        'phone',
      ]) {
        expect({
          key: forbidden,
          present: forbidden in itemProps,
        }).toEqual({ key: forbidden, present: false });
      }
    });
  });

  describe('handler behaviour', () => {
    const handler = EXECUTIVE_TOOL_HANDLERS.listProjectsInPlan;

    it('is registered in EXECUTIVE_TOOL_HANDLERS', () => {
      expect(handler).toBeDefined();
      expect(typeof handler).toBe('function');
    });

    it('returns N items with Thai statuses for N seeded PG rows', async () => {
      const deps = makeDeps([
        {
          pgid: UUID_PG1,
          title: 'โครงการ A',
          statusname: 'Approved',
          amphoeid: 1,
          agencyid: 100,
          budget: '1000',
        },
        {
          pgid: UUID_PG2,
          title: 'โครงการ B',
          statusname: 'Pending',
          amphoeid: 2,
          agencyid: null,
          budget: '0',
        },
        {
          pgid: UUID_PG3,
          title: 'โครงการ C',
          statusname: 'Pending_Approval',
          amphoeid: null,
          agencyid: null,
          budget: null,
        },
      ]);
      const out = await handler(
        { planId: UUID_PLAN, groupBy: 'flat' },
        makeCtx(),
        deps,
      );

      expect(out.planId).toBe(UUID_PLAN);
      expect(Array.isArray(out.items)).toBe(true);
      const items = out.items as Array<Record<string, unknown>>;
      expect(items).toHaveLength(3);

      expect(items[0]).toMatchObject({
        projectId: UUID_PG1,
        projectKind: 'original',
        name: 'โครงการ A',
        currentStatus: 'Approved',
        statusTh: 'อนุมัติ',
        planId: UUID_PLAN,
        budget: 1000,
        amphoeId: 1,
        responsibleAgencyId: 100,
      });
      expect(items[1]).toMatchObject({
        projectId: UUID_PG2,
        currentStatus: 'Pending',
        // W67: Pending Thai label now "รอตรวจสอบ" (was "รอการอนุมัติ").
        statusTh: 'รอตรวจสอบ',
        budget: 0,
        amphoeId: 2,
      });
      // Agency null → field omitted (not serialized as null).
      expect('responsibleAgencyId' in items[1]).toBe(false);

      expect(items[2]).toMatchObject({
        projectId: UUID_PG3,
        currentStatus: 'Pending_Approval',
        statusTh: 'รออนุมัติ',
        budget: 0,
      });
      // Both nullables omitted.
      expect('amphoeId' in items[2]).toBe(false);
      expect('responsibleAgencyId' in items[2]).toBe(false);
    });

    it('handler output does NOT contain createdBy / firstName / lastName / citizenId', async () => {
      const deps = makeDeps([
        {
          pgid: UUID_PG1,
          title: 'โครงการ A',
          statusname: 'Approved',
          amphoeid: 1,
          agencyid: 100,
          budget: '500',
        },
      ]);
      const out = await handler(
        { planId: UUID_PLAN, groupBy: 'flat' },
        makeCtx(),
        deps,
      );
      const serialized = JSON.stringify(out);
      for (const forbidden of [
        'createdBy',
        'firstName',
        'lastName',
        'citizenId',
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
    });

    it('empty result returns items: [] with planId and asOf', async () => {
      const deps = makeDeps([]);
      const out = await handler(
        { planId: UUID_PLAN, groupBy: 'flat' },
        makeCtx(),
        deps,
      );
      expect(out.items).toEqual([]);
      expect(out.planId).toBe(UUID_PLAN);
      expect(typeof out.asOf).toBe('string');
    });

    it('re-asserts role via assertExecutiveRole (§17.11)', async () => {
      const deps = makeDeps([]);
      await expect(
        handler({ planId: UUID_PLAN }, makeCtx({ roleName: 'user' }), deps),
      ).rejects.toThrow(/EXECUTIVE_ROLE_REQUIRED/);
    });

    it('re-asserts workStatus = approved (§17.11)', async () => {
      const deps = makeDeps([]);
      await expect(
        handler(
          { planId: UUID_PLAN },
          makeCtx({ workStatusName: 'pending' }),
          deps,
        ),
      ).rejects.toThrow(/EXECUTIVE_ROLE_REQUIRED/);
    });

    it('return envelope validates against the registry returnSchema (§17.9)', async () => {
      const deps = makeDeps([
        {
          pgid: UUID_PG1,
          title: 'โครงการ A',
          statusname: 'Approved',
          amphoeid: 1,
          agencyid: 100,
          budget: '1000',
        },
      ]);
      const out = await handler(
        { planId: UUID_PLAN, groupBy: 'flat' },
        makeCtx(),
        deps,
      );
      const spec = EXECUTIVE_TOOL_REGISTRY.listProjectsInPlan;
      const res = validateAgainstSchema(spec.returnSchema, out);
      expect(res.ok).toBe(true);
    });

    // ──────────────────────────────────────────────────────────────
    // BE-W49-01 — UUID guard (P0 hotfix).
    //
    // Non-UUID `planId` inputs MUST NOT throw. They MUST return a
    // structured soft-error envelope whose `planId` is a valid UUID
    // (nil-UUID sentinel) so that the return-schema validator still
    // passes (see tool-schema-validator.ts — `format: uuid` check).
    // This converts the outage path (FE "ระบบขัดข้อง" banner) into a
    // graceful LLM-recoverable turn.
    // ──────────────────────────────────────────────────────────────
    const NIL_UUID = '00000000-0000-0000-0000-000000000000';

    it('BE-W49-01: non-UUID planId returns soft-error envelope, does NOT throw', async () => {
      const deps = makeDeps([]);
      const out = await handler(
        { planId: '2566-2570' } as unknown as Record<string, unknown>,
        makeCtx(),
        deps,
      );
      expect(out.items).toEqual([]);
      expect(out.planId).toBe(NIL_UUID);
      expect(typeof out.asOf).toBe('string');
      expect(typeof (out as { message?: unknown }).message).toBe('string');
      expect(
        ((out as { message?: string }).message ?? '').length,
      ).toBeGreaterThan(0);
    });

    // Wave FOLLOWUP-CONTINUITY (2026-07-18) — empty / null planId is NO
    // LONGER a soft-error. It now defaults to a WHOLE-MUNICIPALITY listing
    // (no plan WHERE filter, no `message`), echoing NIL_UUID as the
    // "no plan anchored" sentinel. This fixes the follow-up-continuity bug
    // (detail/listing follow-up after a plan-less turn returns the items).
    // `groupBy: 'flat'` keeps the `items[]` envelope shape for the assertion.
    it('W-FOLLOWUP: empty-string planId → whole-municipality listing (no soft-error)', async () => {
      const deps = makeDeps([]);
      const out = await handler(
        { planId: '', groupBy: 'flat' } as unknown as Record<string, unknown>,
        makeCtx(),
        deps,
      );
      expect(out.items).toEqual([]);
      expect(out.planId).toBe(NIL_UUID);
      expect((out as { message?: unknown }).message).toBeUndefined();
    });

    it('W-FOLLOWUP: null planId → whole-municipality listing (no soft-error)', async () => {
      const deps = makeDeps([]);
      const out = await handler(
        { planId: null, groupBy: 'flat' } as unknown as Record<string, unknown>,
        makeCtx(),
        deps,
      );
      expect(out.items).toEqual([]);
      expect(out.planId).toBe(NIL_UUID);
      expect((out as { message?: unknown }).message).toBeUndefined();
    });

    it('BE-W49-01: plan-name string is rejected as non-UUID (soft-error envelope)', async () => {
      const deps = makeDeps([]);
      const out = await handler(
        { planId: 'แผน 2566-2570' } as unknown as Record<string, unknown>,
        makeCtx(),
        deps,
      );
      expect(out.items).toEqual([]);
      expect(out.planId).toBe(NIL_UUID);
    });

    it('BE-W49-01: soft-error envelope validates against registry returnSchema (§17.9)', async () => {
      const deps = makeDeps([]);
      const out = await handler(
        { planId: '2566-2570' } as unknown as Record<string, unknown>,
        makeCtx(),
        deps,
      );
      const spec = EXECUTIVE_TOOL_REGISTRY.listProjectsInPlan;
      const res = validateAgainstSchema(spec.returnSchema, out);
      expect(res.ok).toBe(true);
    });

    it('BE-W49-01: valid UUID with zero seeded rows returns empty items (no throw, no soft-error message)', async () => {
      const deps = makeDeps([]);
      const out = await handler(
        { planId: UUID_PLAN, groupBy: 'flat' },
        makeCtx(),
        deps,
      );
      expect(out.items).toEqual([]);
      expect(out.planId).toBe(UUID_PLAN);
      expect(typeof out.asOf).toBe('string');
      // Happy-path envelopes MUST NOT carry the soft-error `message`.
      expect('message' in out).toBe(false);
    });

    it('BE-W49-01: valid UUID with seeded rows returns normal items (regression guard)', async () => {
      const deps = makeDeps([
        {
          pgid: UUID_PG1,
          title: 'โครงการ A',
          statusname: 'Approved',
          amphoeid: 1,
          agencyid: 100,
          budget: '1000',
        },
      ]);
      const out = await handler(
        { planId: UUID_PLAN, groupBy: 'flat' },
        makeCtx(),
        deps,
      );
      expect(out.planId).toBe(UUID_PLAN);
      const items = out.items as Array<Record<string, unknown>>;
      expect(items).toHaveLength(1);
      expect(items[0].projectId).toBe(UUID_PG1);
      expect(items[0].statusTh).toBe('อนุมัติ');
      // Happy-path envelope MUST NOT carry the soft-error `message`.
      expect('message' in out).toBe(false);
    });

    it('BE-W49-01: UUID guard runs AFTER assertExecutiveRole — non-executive with non-UUID planId still throws role error', async () => {
      const deps = makeDeps([]);
      await expect(
        handler(
          { planId: '2566-2570' } as unknown as Record<string, unknown>,
          makeCtx({ roleName: 'user' }),
          deps,
        ),
      ).rejects.toThrow(/EXECUTIVE_ROLE_REQUIRED/);
    });

    // ──────────────────────────────────────────────────────────────
    // BE-W53-04 — budget-field invariant.
    //
    // Under BE-W53-01 Option 2 (correlated sub-query via `.from(Budget, 'b')`)
    // the mock's `addSelect: chain` callback argument is discarded, so the
    // existing mock surface still drives the spec to green. Rows with a
    // positive budget string must surface `budget > 0`; rows with '0' or
    // null must surface `budget === 0`. This is a regression guard against
    // a future regression that drops the budget field entirely.
    // ──────────────────────────────────────────────────────────────
    it('BE-W53-04: budget numeric invariant (>0 for positive fixtures, 0 for zero/null fixtures)', async () => {
      const deps = makeDeps([
        {
          pgid: UUID_PG1,
          title: 'with-budget',
          statusname: 'Approved',
          amphoeid: 1,
          agencyid: 100,
          budget: '1000',
        },
        {
          pgid: UUID_PG2,
          title: 'zero-budget',
          statusname: 'Pending',
          amphoeid: 2,
          agencyid: null,
          budget: '0',
        },
        {
          pgid: UUID_PG3,
          title: 'null-budget',
          statusname: 'Pending_Approval',
          amphoeid: null,
          agencyid: null,
          budget: null,
        },
      ]);
      const out = await handler(
        { planId: UUID_PLAN, groupBy: 'flat' },
        makeCtx(),
        deps,
      );
      const items = out.items as Array<Record<string, unknown>>;
      expect(items).toHaveLength(3);
      for (const it of items) {
        expect(typeof it.budget).toBe('number');
      }
      expect((items[0].budget as number) > 0).toBe(true);
      expect(items[1].budget).toBe(0);
      expect(items[2].budget).toBe(0);
    });

    it('unknown canonical status passes through verbatim via toThaiStatus fallback', async () => {
      // toThaiStatus returns the input unchanged for unknown keys — this
      // guards against silent mistranslation if DB holds a stray value.
      const deps = makeDeps([
        {
          pgid: UUID_PG1,
          title: 'X',
          statusname: 'WEIRD_STATUS',
          amphoeid: null,
          agencyid: null,
          budget: '0',
        },
      ]);
      const out = await handler(
        { planId: UUID_PLAN, groupBy: 'flat' },
        makeCtx(),
        deps,
      );
      const items = out.items as Array<Record<string, unknown>>;
      expect(items[0].currentStatus).toBe('WEIRD_STATUS');
      expect(items[0].statusTh).toBe('WEIRD_STATUS');
    });
  });
});
