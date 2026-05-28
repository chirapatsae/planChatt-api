/**
 * Wave AI-Exec-Chat-Book-Coverage BE-01 (2026-05-28) —
 * `listProjectsInSupplementBook` coverage.
 *
 * Mirrors the revision-book lister spec; SPG-specific differences:
 *   - `supplementId` (vs `revisionId`)
 *   - SPG head-of-lineage filter uses `prev_project_type='supplement'`
 *     (Wave SUPP-4, 2026-05-24)
 *   - `supplementMeta` carries `supplementNumber`, no `revisionTypeName`
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

const UUID_DPS = '11111111-1111-4111-8111-111111111111';
const UUID_SPG1 = '22222222-2222-4222-8222-222222222222';
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

type SpgRow = {
  spgid: string;
  title: string;
  statusname: string | null;
  statusth: string | null;
  agencyid: string | number | null;
  agencyname: string | null;
  pagenumber: number | null;
  createdat: string;
  budget: string | null;
};

type DpsFixture = {
  id: string;
  supplementNumber: number;
  isOpen: boolean;
  isBooked: boolean;
} | null;

function makeDeps(opts: {
  dps: DpsFixture;
  rows: SpgRow[];
  totalCount: number;
}): ExecutiveToolHandlerDeps {
  const dpsQb: Record<string, unknown> = {};
  const spgQb: Record<string, unknown> = {};
  const chain = (qb: Record<string, unknown>) => () => qb;
  Object.assign(dpsQb, {
    where: chain(dpsQb),
    andWhere: chain(dpsQb),
    getOne: async () => opts.dps,
  });
  Object.assign(spgQb, {
    select: chain(spgQb),
    addSelect: chain(spgQb),
    leftJoin: chain(spgQb),
    innerJoin: chain(spgQb),
    where: chain(spgQb),
    andWhere: chain(spgQb),
    orderBy: chain(spgQb),
    addOrderBy: chain(spgQb),
    groupBy: chain(spgQb),
    addGroupBy: chain(spgQb),
    offset: chain(spgQb),
    limit: chain(spgQb),
    take: chain(spgQb),
    getRawOne: async () => ({ cnt: String(opts.totalCount) }),
    getRawMany: async () => opts.rows,
  });
  return {
    dataSource: {
      getRepository: (target: { name?: string }) => ({
        createQueryBuilder: () => {
          const n = typeof target === 'function' ? target.name : target?.name;
          if (n === 'DevelopmentPlanSupplement') return dpsQb;
          return spgQb;
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

describe('BE-01 / listProjectsInSupplementBook', () => {
  describe('registry contract', () => {
    const spec = EXECUTIVE_TOOL_REGISTRY.listProjectsInSupplementBook;

    it('is registered', () => {
      expect(spec).toBeDefined();
      expect(spec.name).toBe('listProjectsInSupplementBook');
      expect(EXECUTIVE_TOOL_NAMES).toContain('listProjectsInSupplementBook');
    });

    it('paramsSchema requires supplementId', () => {
      expect(spec.paramsSchema.required).toContain('supplementId');
      expect(spec.paramsSchema.additionalProperties).toBe(false);
    });

    it('limit max 200 default 50; offset default 0', () => {
      expect(spec.paramsSchema.properties?.limit?.maximum).toBe(200);
      expect(spec.paramsSchema.properties?.limit?.default).toBe(50);
      expect(spec.paramsSchema.properties?.offset?.default).toBe(0);
    });

    it('returnSchema requires supplementMeta', () => {
      expect(spec.returnSchema.required).toEqual(
        expect.arrayContaining(['supplementMeta']),
      );
      const meta = spec.returnSchema.properties?.supplementMeta;
      expect(meta?.required).toEqual(
        expect.arrayContaining([
          'supplementId',
          'supplementNumber',
          'isOpen',
          'isBooked',
        ]),
      );
    });

    it('description is read-only (อ่านอย่างเดียว)', () => {
      expect(spec.description).toMatch(/อ่านอย่างเดียว/);
    });
  });

  describe('handler behaviour', () => {
    const handler = EXECUTIVE_TOOL_HANDLERS.listProjectsInSupplementBook;

    it('is registered', () => {
      expect(typeof handler).toBe('function');
    });

    it('role guard rejects user role', async () => {
      const deps = makeDeps({ dps: null, rows: [], totalCount: 0 });
      await expect(
        handler(
          { supplementId: UUID_DPS },
          makeCtx({ roleName: 'user' }),
          deps,
        ),
      ).rejects.toThrow(/EXECUTIVE_ROLE_REQUIRED/);
    });

    it('invalid UUID returns friendly hint envelope', async () => {
      const deps = makeDeps({ dps: null, rows: [], totalCount: 0 });
      const out = await handler(
        { supplementId: 'bad-id' },
        makeCtx(),
        deps,
      );
      const meta = out.supplementMeta as Record<string, unknown>;
      expect(meta.supplementId).toBe(NIL_UUID);
      expect(out.items).toEqual([]);
      expect(typeof out.message).toBe('string');
      assertNoPii(out);
    });

    it('missing DPS returns empty envelope with message', async () => {
      const deps = makeDeps({ dps: null, rows: [], totalCount: 0 });
      const out = await handler({ supplementId: UUID_DPS }, makeCtx(), deps);
      expect(out.items).toEqual([]);
      expect(typeof out.message).toBe('string');
    });

    it('happy path returns items with supplement meta', async () => {
      const deps = makeDeps({
        dps: {
          id: UUID_DPS,
          supplementNumber: 1,
          isOpen: false,
          isBooked: true,
        },
        rows: [
          {
            spgid: UUID_SPG1,
            title: 'โครงการเพิ่มเติม A',
            statusname: 'Approved',
            statusth: 'อนุมัติ',
            agencyid: 5,
            agencyname: 'กองช่าง',
            pagenumber: 3,
            createdat: '2026-04-15T00:00:00.000Z',
            budget: '750000',
          },
        ],
        totalCount: 1,
      });
      const out = await handler({ supplementId: UUID_DPS }, makeCtx(), deps);
      expect(out.totalCount).toBe(1);
      expect(out.nextOffset).toBeNull();
      const items = out.items as Array<Record<string, unknown>>;
      expect(items[0]).toMatchObject({
        projectId: UUID_SPG1,
        title: 'โครงการเพิ่มเติม A',
        currentStatus: 'Approved',
        statusTh: 'อนุมัติ',
        executiveStatus: 'approved',
        responsibleAgencyName: 'กองช่าง',
        budget: 750000,
        pageNumber: 3,
      });
      const meta = out.supplementMeta as Record<string, unknown>;
      expect(meta).toEqual({
        supplementId: UUID_DPS,
        supplementNumber: 1,
        isOpen: false,
        isBooked: true,
      });
      assertNoPii(out);
    });

    it('pagination round-trip: offset + limit advance nextOffset', async () => {
      const deps = makeDeps({
        dps: {
          id: UUID_DPS,
          supplementNumber: 1,
          isOpen: false,
          isBooked: true,
        },
        rows: [
          {
            spgid: UUID_SPG1,
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
        totalCount: 50,
      });
      const out = await handler(
        { supplementId: UUID_DPS, limit: 1, offset: 10 },
        makeCtx(),
        deps,
      );
      expect(out.offset).toBe(10);
      expect(out.limit).toBe(1);
      expect(out.nextOffset).toBe(11);
    });
  });
});
