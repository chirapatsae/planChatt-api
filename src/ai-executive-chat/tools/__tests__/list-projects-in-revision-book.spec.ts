/**
 * Wave AI-Exec-Chat-Book-Coverage BE-01 (2026-05-28) —
 * `listProjectsInRevisionBook` coverage.
 *
 * Covers:
 *   - Registry contract — tool present in `EXECUTIVE_TOOL_REGISTRY` and
 *     `EXECUTIVE_TOOL_NAMES`; paramsSchema requires `revisionId`; limit
 *     caps at 200 with default 50; offset defaults to 0;
 *     `additionalProperties: false`.
 *   - §17.11 role guard — `user` role throws EXECUTIVE_ROLE_REQUIRED.
 *   - Invalid UUID — returns friendly hint envelope (nil revisionMeta,
 *     empty items, NO throw) per the `listProjectsInPlan` precedent.
 *   - Missing DPR — well-formed UUID with no matching row returns
 *     empty envelope with `message`.
 *   - Happy path — rows pass through buildSubBookProjectItem with
 *     responsibleAgencyName + status + budget projected.
 *   - Pagination — `nextOffset` = offset + items.length when more
 *     rows remain; null when at end.
 *   - HEAD-of-lineage default — opt-out via `includeHistoricalVersions`
 *     is verified at the schema level (handler delegates the WHERE).
 *   - PII discipline — envelope MUST NOT carry createdBy / firstName /
 *     lastName / citizenId / phone / email.
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

const UUID_DPR = '11111111-1111-4111-8111-111111111111';
const UUID_RPG1 = '22222222-2222-4222-8222-222222222222';
const UUID_RPG2 = '33333333-3333-4333-8333-333333333333';
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

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

type RpgRow = {
  rpgid: string;
  title: string;
  statusname: string | null;
  statusth: string | null;
  agencyid: string | number | null;
  agencyname: string | null;
  pagenumber: number | null;
  createdat: string;
  budget: string | null;
};

type DprFixture = {
  id: string;
  revisionNumber: number;
  isOpen: boolean;
  isBooked: boolean;
  revisionType: { name: string } | null;
} | null;

function makeDeps(opts: {
  dpr: DprFixture;
  rows: RpgRow[];
  totalCount: number;
}): ExecutiveToolHandlerDeps {
  const dprQb: Record<string, unknown> = {};
  const rpgQb: Record<string, unknown> = {};
  const chain = (qb: Record<string, unknown>) => () => qb;
  Object.assign(dprQb, {
    leftJoinAndSelect: chain(dprQb),
    where: chain(dprQb),
    andWhere: chain(dprQb),
    getOne: async () => opts.dpr,
  });
  Object.assign(rpgQb, {
    select: chain(rpgQb),
    addSelect: chain(rpgQb),
    leftJoin: chain(rpgQb),
    innerJoin: chain(rpgQb),
    where: chain(rpgQb),
    andWhere: chain(rpgQb),
    orderBy: chain(rpgQb),
    addOrderBy: chain(rpgQb),
    groupBy: chain(rpgQb),
    addGroupBy: chain(rpgQb),
    offset: chain(rpgQb),
    limit: chain(rpgQb),
    take: chain(rpgQb),
    getRawOne: async () => ({ cnt: String(opts.totalCount) }),
    getRawMany: async () => opts.rows,
  });
  return {
    dataSource: {
      getRepository: (target: { name?: string }) => ({
        createQueryBuilder: () => {
          const n = typeof target === 'function' ? target.name : target?.name;
          if (n === 'DevelopmentPlanRevision') return dprQb;
          return rpgQb;
        },
      }),
    } as unknown as ExecutiveToolHandlerDeps['dataSource'],
    unifiedProject: {} as never,
    budget: {} as never,
    status: {} as never,
    geo: {} as never,
    agency: {} as never,
    resilience: {} as never,
  };
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

describe('BE-01 / listProjectsInRevisionBook', () => {
  describe('registry contract', () => {
    const spec = EXECUTIVE_TOOL_REGISTRY.listProjectsInRevisionBook;

    it('is registered', () => {
      expect(spec).toBeDefined();
      expect(spec.name).toBe('listProjectsInRevisionBook');
      expect(EXECUTIVE_TOOL_NAMES).toContain('listProjectsInRevisionBook');
    });

    it('paramsSchema requires revisionId', () => {
      expect(spec.paramsSchema.required).toContain('revisionId');
      expect(spec.paramsSchema.additionalProperties).toBe(false);
    });

    it('limit caps at 200 with default 50', () => {
      const p = spec.paramsSchema.properties?.limit;
      expect(p?.minimum).toBe(1);
      expect(p?.maximum).toBe(200);
      expect(p?.default).toBe(50);
    });

    it('offset defaults to 0', () => {
      const p = spec.paramsSchema.properties?.offset;
      expect(p?.minimum).toBe(0);
      expect(p?.default).toBe(0);
    });

    it('includeHistoricalVersions defaults false', () => {
      expect(
        spec.paramsSchema.properties?.includeHistoricalVersions?.default,
      ).toBe(false);
    });

    it('returnSchema requires items/totalCount/limit/offset/revisionMeta/asOf', () => {
      expect(spec.returnSchema.required).toEqual(
        expect.arrayContaining([
          'items',
          'totalCount',
          'limit',
          'offset',
          'revisionMeta',
          'asOf',
        ]),
      );
    });

    it('description is read-only (อ่านอย่างเดียว)', () => {
      expect(spec.description).toMatch(/อ่านอย่างเดียว/);
    });
  });

  describe('handler behaviour', () => {
    const handler = EXECUTIVE_TOOL_HANDLERS.listProjectsInRevisionBook;

    it('is registered in EXECUTIVE_TOOL_HANDLERS', () => {
      expect(typeof handler).toBe('function');
    });

    it('role guard: user role throws EXECUTIVE_ROLE_REQUIRED', async () => {
      const deps = makeDeps({ dpr: null, rows: [], totalCount: 0 });
      await expect(
        handler(
          { revisionId: UUID_DPR },
          makeCtx({ roleName: 'user' }),
          deps,
        ),
      ).rejects.toThrow(/EXECUTIVE_ROLE_REQUIRED/);
    });

    it('invalid UUID returns friendly hint envelope (no throw)', async () => {
      const deps = makeDeps({ dpr: null, rows: [], totalCount: 0 });
      const out = await handler(
        { revisionId: 'not-a-uuid' },
        makeCtx(),
        deps,
      );
      expect(out.items).toEqual([]);
      expect(out.totalCount).toBe(0);
      const meta = out.revisionMeta as Record<string, unknown>;
      expect(meta.revisionId).toBe(NIL_UUID);
      expect(typeof out.message).toBe('string');
      assertNoPii(out);
    });

    it('missing DPR (UUID well-formed, no row) returns empty envelope', async () => {
      const deps = makeDeps({ dpr: null, rows: [], totalCount: 0 });
      const out = await handler({ revisionId: UUID_DPR }, makeCtx(), deps);
      expect(out.items).toEqual([]);
      expect(out.totalCount).toBe(0);
      expect(typeof out.message).toBe('string');
    });

    it('happy path: rows project into envelope with status + agency + budget', async () => {
      const deps = makeDeps({
        dpr: {
          id: UUID_DPR,
          revisionNumber: 1,
          isOpen: true,
          isBooked: false,
          revisionType: { name: 'แก้ไข' },
        },
        rows: [
          {
            rpgid: UUID_RPG1,
            title: 'โครงการ A',
            statusname: 'Pending',
            statusth: 'รอตรวจสอบ',
            agencyid: 12,
            agencyname: 'กองยุทธศาสตร์',
            pagenumber: 1,
            createdat: '2026-04-01T00:00:00.000Z',
            budget: '500000',
          },
          {
            rpgid: UUID_RPG2,
            title: 'โครงการ B',
            statusname: 'Approved',
            statusth: 'อนุมัติ',
            agencyid: null,
            agencyname: null,
            pagenumber: null,
            createdat: '2026-04-02T00:00:00.000Z',
            budget: null,
          },
        ],
        totalCount: 2,
      });
      const out = await handler({ revisionId: UUID_DPR }, makeCtx(), deps);
      expect(out.totalCount).toBe(2);
      expect(out.offset).toBe(0);
      expect(out.limit).toBe(50);
      expect(out.nextOffset).toBeNull();
      const items = out.items as Array<Record<string, unknown>>;
      expect(items).toHaveLength(2);
      expect(items[0]).toMatchObject({
        projectId: UUID_RPG1,
        title: 'โครงการ A',
        currentStatus: 'Pending',
        statusTh: 'รอตรวจสอบ',
        executiveStatus: 'pending_review',
        responsibleAgencyId: 12,
        responsibleAgencyName: 'กองยุทธศาสตร์',
        budget: 500000,
        pageNumber: 1,
      });
      expect(items[1]).toMatchObject({
        projectId: UUID_RPG2,
        currentStatus: 'Approved',
        executiveStatus: 'approved',
        responsibleAgencyId: null,
        responsibleAgencyName: null,
        budget: 0,
        pageNumber: null,
      });
      const meta = out.revisionMeta as Record<string, unknown>;
      expect(meta).toEqual({
        revisionId: UUID_DPR,
        revisionNumber: 1,
        revisionTypeName: 'แก้ไข',
        isOpen: true,
        isBooked: false,
      });
      assertNoPii(out);
    });

    it('pagination: nextOffset = offset+items.length when more rows remain', async () => {
      const deps = makeDeps({
        dpr: {
          id: UUID_DPR,
          revisionNumber: 1,
          isOpen: false,
          isBooked: true,
          revisionType: { name: 'แก้ไข' },
        },
        rows: [
          {
            rpgid: UUID_RPG1,
            title: 'A',
            statusname: 'Pending',
            statusth: 'รอตรวจสอบ',
            agencyid: 1,
            agencyname: 'X',
            pagenumber: 1,
            createdat: '2026-04-01T00:00:00.000Z',
            budget: '100',
          },
        ],
        totalCount: 10,
      });
      const out = await handler(
        { revisionId: UUID_DPR, limit: 1, offset: 5 },
        makeCtx(),
        deps,
      );
      expect(out.limit).toBe(1);
      expect(out.offset).toBe(5);
      expect(out.totalCount).toBe(10);
      // 5 + 1 = 6 < 10 → nextOffset = 6
      expect(out.nextOffset).toBe(6);
    });

    it('pagination: offset >= totalCount returns nextOffset null', async () => {
      const deps = makeDeps({
        dpr: {
          id: UUID_DPR,
          revisionNumber: 1,
          isOpen: false,
          isBooked: true,
          revisionType: { name: 'แก้ไข' },
        },
        rows: [],
        totalCount: 3,
      });
      const out = await handler(
        { revisionId: UUID_DPR, limit: 50, offset: 999 },
        makeCtx(),
        deps,
      );
      expect(out.items).toEqual([]);
      expect(out.nextOffset).toBeNull();
    });

    it('limit clamps to 200 max', async () => {
      const deps = makeDeps({
        dpr: {
          id: UUID_DPR,
          revisionNumber: 1,
          isOpen: false,
          isBooked: true,
          revisionType: { name: 'แก้ไข' },
        },
        rows: [],
        totalCount: 0,
      });
      const out = await handler(
        { revisionId: UUID_DPR, limit: 1000 },
        makeCtx(),
        deps,
      );
      expect(out.limit).toBe(200);
    });
  });
});
