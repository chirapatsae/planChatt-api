/**
 * BE-W53-04 — `listDevelopmentPlanSupplements` coverage.
 *
 * Analogous to `list-plan-revisions.spec.ts`. The handler enumerates
 * DevelopmentPlanSupplement books of a plan and attaches a per-book
 * project count from SupplementProjectGroup.
 *
 * CLAUDE.md references:
 *   - §15 Book lineage — handler is READ-ONLY; no mutation.
 *   - §17.2 / §17.11 — advisory, role guard re-asserted.
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
const UUID_DPS1 = '22222222-2222-4222-8222-222222222222';
const UUID_DPS2 = '33333333-3333-4333-8333-333333333333';

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

type SupplementRow = {
  id: string;
  supplementNumber: number;
  isLatest: boolean;
  isOpen: boolean;
  isBooked: boolean;
};

type CountRow = { dpsid: string; cnt: string };

function makeDeps(
  supplements: SupplementRow[],
  counts: CountRow[],
): ExecutiveToolHandlerDeps {
  const supplementQb: Record<string, unknown> = {};
  const countQb: Record<string, unknown> = {};
  const chain = (qb: Record<string, unknown>) => () => qb;
  Object.assign(supplementQb, {
    where: chain(supplementQb),
    andWhere: chain(supplementQb),
    orderBy: chain(supplementQb),
    take: chain(supplementQb),
    getMany: async () => supplements,
    select: chain(supplementQb),
    addSelect: chain(supplementQb),
    leftJoin: chain(supplementQb),
    leftJoinAndSelect: chain(supplementQb),
    groupBy: chain(supplementQb),
    getRawMany: async () => [],
  });
  Object.assign(countQb, {
    select: chain(countQb),
    addSelect: chain(countQb),
    where: chain(countQb),
    andWhere: chain(countQb),
    groupBy: chain(countQb),
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
          if (n === 'DevelopmentPlanSupplement') return supplementQb;
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

describe('BE-W53-04 / listDevelopmentPlanSupplements', () => {
  describe('registry contract', () => {
    const spec = EXECUTIVE_TOOL_REGISTRY.listDevelopmentPlanSupplements;

    it('is registered in EXECUTIVE_TOOL_REGISTRY', () => {
      expect(spec).toBeDefined();
      expect(spec.name).toBe('listDevelopmentPlanSupplements');
    });

    it('is present in EXECUTIVE_TOOL_NAMES', () => {
      expect(EXECUTIVE_TOOL_NAMES).toContain('listDevelopmentPlanSupplements');
    });

    it('paramsSchema requires planId as uuid', () => {
      expect(spec.paramsSchema.required).toContain('planId');
      expect(spec.paramsSchema.properties?.planId?.format).toBe('uuid');
    });

    it('returnSchema.items[] requires supplementNumber and projectCount', () => {
      const item = spec.returnSchema.properties?.items?.items;
      expect(item?.required).toEqual(
        expect.arrayContaining([
          'supplementId',
          'supplementNumber',
          'projectCount',
        ]),
      );
      expect(item?.properties?.supplementNumber?.type).toBe('integer');
    });

    it('description mentions read-only (อ่านอย่างเดียว)', () => {
      expect(spec.description).toMatch(/อ่านอย่างเดียว/);
    });
  });

  describe('handler behaviour', () => {
    const handler = EXECUTIVE_TOOL_HANDLERS.listDevelopmentPlanSupplements;

    it('is registered in EXECUTIVE_TOOL_HANDLERS', () => {
      expect(typeof handler).toBe('function');
    });

    it('role guard: user role throws EXECUTIVE_ROLE_REQUIRED', async () => {
      const deps = makeDeps([], []);
      await expect(
        handler({ planId: UUID_PLAN }, makeCtx({ roleName: 'user' }), deps),
      ).rejects.toThrow(/EXECUTIVE_ROLE_REQUIRED/);
    });

    it('happy path: two canned supplement books with per-book counts', async () => {
      const deps = makeDeps(
        [
          {
            id: UUID_DPS1,
            supplementNumber: 1,
            isLatest: false,
            isOpen: false,
            isBooked: true,
          },
          {
            id: UUID_DPS2,
            supplementNumber: 2,
            isLatest: true,
            isOpen: true,
            isBooked: false,
          },
        ],
        [
          { dpsid: UUID_DPS1, cnt: '3' },
          { dpsid: UUID_DPS2, cnt: '7' },
        ],
      );
      const out = await handler({ planId: UUID_PLAN }, makeCtx(), deps);
      expect(out.planId).toBe(UUID_PLAN);
      const items = out.items as Array<Record<string, unknown>>;
      expect(items).toHaveLength(2);
      const byId = new Map(items.map((i) => [i.supplementId, i]));
      expect(byId.get(UUID_DPS1)?.projectCount).toBe(3);
      expect(byId.get(UUID_DPS2)?.projectCount).toBe(7);
      expect(byId.get(UUID_DPS2)?.isLatest).toBe(true);
      assertNoPii(out);
    });

    it('empty: zero supplements returns items: []', async () => {
      const deps = makeDeps([], []);
      const out = await handler({ planId: UUID_PLAN }, makeCtx(), deps);
      expect(out.items).toEqual([]);
      expect(out.planId).toBe(UUID_PLAN);
      expect(typeof (out as { asOf?: unknown }).asOf).toBe('string');
      assertNoPii(out);
    });
  });
});
