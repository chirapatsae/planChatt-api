/**
 * BE-W53-04 — `listDevelopmentPlanRevisions` coverage.
 *
 * Covers:
 *   - Registry contract — tool present; paramsSchema requires planId;
 *     returnSchema.items[].revisionTypeName is a string.
 *   - §17.11 role guard — `user` role throws EXECUTIVE_ROLE_REQUIRED.
 *   - Happy path — two canned rows with Thai revision-type names
 *     (`แก้ไข`, `เปลี่ยนแปลง`) preserved verbatim.
 *   - Empty result — no revisions → `items: []`.
 *   - PII projection gate — envelope MUST NOT carry any of
 *     createdBy / firstName / lastName / citizenId / phone / email.
 *
 * Handler source: `executive-tool-handlers.ts::listDevelopmentPlanRevisions`.
 * The handler uses `getMany()` over DevelopmentPlanRevision (with
 * leftJoinAndSelect) plus a second grouped `getRawMany()` over
 * RevisedProjectGroup for the projectCount aggregate.
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

const UUID_PLAN = '11111111-1111-4111-8111-111111111111';
const UUID_DPR1 = '22222222-2222-4222-8222-222222222222';
const UUID_DPR2 = '33333333-3333-4333-8333-333333333333';

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

type RevisionRow = {
  id: string;
  revisionNumber: number;
  isLatest: boolean;
  isOpen: boolean;
  isBooked: boolean;
  revisionType: { id: string; name: string } | null;
};

type CountRow = { dprid: string; cnt: string };

/**
 * Route `getRepository(DevelopmentPlanRevision)` to a QB that resolves
 * `.getMany()` to the revisions fixture, and
 * `getRepository(RevisedProjectGroup)` to a QB that resolves
 * `.getRawMany()` to the count fixture.  The handler inspects the
 * entity class to pick the repo — our stub just returns the right QB
 * based on a sentinel in the target's name or constructor reference.
 */
function makeDeps(
  revisions: RevisionRow[],
  counts: CountRow[],
): ExecutiveToolHandlerDeps {
  const revisionQb: Record<string, unknown> = {};
  const countQb: Record<string, unknown> = {};
  const chain = (qb: Record<string, unknown>) => () => qb;
  Object.assign(revisionQb, {
    leftJoinAndSelect: chain(revisionQb),
    where: chain(revisionQb),
    andWhere: chain(revisionQb),
    orderBy: chain(revisionQb),
    take: chain(revisionQb),
    getMany: async () => revisions,
    // fall-throughs just in case:
    select: chain(revisionQb),
    addSelect: chain(revisionQb),
    leftJoin: chain(revisionQb),
    groupBy: chain(revisionQb),
    getRawMany: async () => [],
  });
  Object.assign(countQb, {
    select: chain(countQb),
    addSelect: chain(countQb),
    where: chain(countQb),
    andWhere: chain(countQb),
    groupBy: chain(countQb),
    leftJoin: chain(countQb),
    orderBy: chain(countQb),
    take: chain(countQb),
    getRawMany: async () => counts,
    getMany: async () => [],
  });

  return {
    dataSource: {
      getRepository: (target: { name?: string }) => ({
        createQueryBuilder: () => {
          const n = typeof target === 'function' ? target.name : target?.name;
          if (n === 'DevelopmentPlanRevision') return revisionQb;
          return countQb;
        },
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

describe('BE-W53-04 / listDevelopmentPlanRevisions', () => {
  describe('registry contract', () => {
    const spec = EXECUTIVE_TOOL_REGISTRY.listDevelopmentPlanRevisions;

    it('is registered in EXECUTIVE_TOOL_REGISTRY', () => {
      expect(spec).toBeDefined();
      expect(spec.name).toBe('listDevelopmentPlanRevisions');
    });

    it('is present in EXECUTIVE_TOOL_NAMES', () => {
      expect(EXECUTIVE_TOOL_NAMES).toContain('listDevelopmentPlanRevisions');
    });

    it('paramsSchema requires planId as uuid', () => {
      expect(spec.paramsSchema.required).toContain('planId');
      expect(spec.paramsSchema.properties?.planId?.format).toBe('uuid');
    });

    it('returnSchema.items[].revisionTypeName is a string', () => {
      const item = spec.returnSchema.properties?.items?.items;
      expect(item?.properties?.revisionTypeName?.type).toBe('string');
      expect(item?.required).toContain('revisionTypeName');
    });

    it('description mentions read-only (อ่านอย่างเดียว)', () => {
      expect(spec.description).toMatch(/อ่านอย่างเดียว/);
    });
  });

  describe('handler behaviour', () => {
    const handler = EXECUTIVE_TOOL_HANDLERS.listDevelopmentPlanRevisions;

    it('is registered in EXECUTIVE_TOOL_HANDLERS', () => {
      expect(typeof handler).toBe('function');
    });

    it('role guard: user role throws EXECUTIVE_ROLE_REQUIRED', async () => {
      const deps = makeDeps([], []);
      await expect(
        handler({ planId: UUID_PLAN }, makeCtx({ roleName: 'user' }), deps),
      ).rejects.toThrow(/EXECUTIVE_ROLE_REQUIRED/);
    });

    it('happy path: two canned rows preserve Thai revisionTypeName verbatim', async () => {
      const deps = makeDeps(
        [
          {
            id: UUID_DPR1,
            revisionNumber: 1,
            isLatest: false,
            isOpen: false,
            isBooked: true,
            revisionType: {
              id: 'rt-edit',
              name: 'แก้ไข',
            },
          },
          {
            id: UUID_DPR2,
            revisionNumber: 2,
            isLatest: true,
            isOpen: true,
            isBooked: false,
            revisionType: {
              id: 'rt-change',
              name: 'เปลี่ยนแปลง',
            },
          },
        ],
        [
          { dprid: UUID_DPR1, cnt: '5' },
          { dprid: UUID_DPR2, cnt: '2' },
        ],
      );
      const out = await handler({ planId: UUID_PLAN }, makeCtx(), deps);
      expect(out.planId).toBe(UUID_PLAN);
      const items = out.items as Array<Record<string, unknown>>;
      expect(items).toHaveLength(2);
      const names = items.map((i) => i.revisionTypeName);
      expect(names).toEqual(expect.arrayContaining(['แก้ไข', 'เปลี่ยนแปลง']));
      // projectCount correctly joined from the second query.
      const byId = new Map(items.map((i) => [i.revisionId, i]));
      expect(byId.get(UUID_DPR1)?.projectCount).toBe(5);
      expect(byId.get(UUID_DPR2)?.projectCount).toBe(2);
      assertNoPii(out);
    });

    it('empty: zero revisions returns items: []', async () => {
      const deps = makeDeps([], []);
      const out = await handler({ planId: UUID_PLAN }, makeCtx(), deps);
      expect(out.items).toEqual([]);
      expect(out.planId).toBe(UUID_PLAN);
      expect(typeof (out as { asOf?: unknown }).asOf).toBe('string');
      assertNoPii(out);
    });

    it('revisionType null falls back to "(ไม่ระบุ)"', async () => {
      const deps = makeDeps(
        [
          {
            id: UUID_DPR1,
            revisionNumber: 1,
            isLatest: true,
            isOpen: false,
            isBooked: true,
            revisionType: null,
          },
        ],
        [{ dprid: UUID_DPR1, cnt: '0' }],
      );
      const out = await handler({ planId: UUID_PLAN }, makeCtx(), deps);
      const items = out.items as Array<Record<string, unknown>>;
      expect(items[0].revisionTypeName).toBe('(ไม่ระบุ)');
    });
  });
});
