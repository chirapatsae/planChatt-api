/**
 * Wave 67 W67-AGENCY-RESOLVER — listAgencies resolver spec.
 *
 * Coverage:
 *   - Returns all agencies when `nameContains` is omitted
 *   - Returns filtered set when `nameContains` is provided (partial,
 *     case-insensitive)
 *   - Returns empty `items: []` when no row matches
 *   - Whitespace-only `nameContains` treated as omitted (returns all)
 *   - Soft-deleted agencies excluded (`deleted_at IS NULL`)
 *   - Output shape matches the registered returnSchema
 *   - Handler is registered in EXECUTIVE_TOOL_HANDLERS and the spec is
 *     in EXECUTIVE_TOOL_REGISTRY
 *   - §17.11 — non-executive role rejection
 *
 * §17.2 advisory only / §17.3 read-only — uses an in-memory DataSource
 * stub; no DB and no mutation paths. §17.11 — role re-checked inside
 * the handler regardless of the controller-level guard.
 */

import { EXECUTIVE_TOOL_HANDLERS } from '../handlers/executive-tool-handlers';
import {
  EXECUTIVE_TOOL_NAMES,
  EXECUTIVE_TOOL_REGISTRY,
} from '../tool-registry';
import type {
  ExecutiveCallerContext,
  ExecutiveToolHandlerDeps,
} from '../handlers/handler-types';
import { GovernmentAgency } from 'src/government-agencies/entities/government-agency.entity';

interface AgencyRow {
  id: string;
  name: string;
  // Soft-delete column simulated at the stub layer; the real handler
  // filters via `WHERE a.deletedAt IS NULL` so we drop these rows
  // before applying any nameContains filter.
  deletedAt?: Date | null;
}

function makeDataSource(rows: AgencyRow[]) {
  // Mirror the chained QueryBuilder API the handler uses:
  //   .createQueryBuilder('a')
  //   .select('a.id', 'id').addSelect('a.name', 'name')
  //   .where('a.deletedAt IS NULL')
  //   .andWhere('LOWER(a.name) LIKE LOWER(:pat)', { pat })?
  //   .orderBy('a.name', 'ASC')
  //   .getRawMany()
  const qb: Record<string, unknown> = {};
  let pat: string | undefined;
  qb.select = () => qb;
  qb.addSelect = () => qb;
  qb.where = () => qb;
  qb.andWhere = (_clause: string, params?: { pat?: string }) => {
    if (params && typeof params.pat === 'string') {
      pat = params.pat;
    }
    return qb;
  };
  qb.orderBy = () => qb;
  qb.getRawMany = jest.fn(async () => {
    // Soft-delete filter: only rows with deletedAt nullish are returned.
    const live = rows.filter((r) => r.deletedAt == null);
    if (!pat) {
      return live.map((r) => ({ id: r.id, name: r.name }));
    }
    const stripped = pat.replace(/^%/, '').replace(/%$/, '').toLowerCase();
    return live
      .filter((r) => r.name.toLowerCase().includes(stripped))
      .map((r) => ({ id: r.id, name: r.name }));
  });
  return {
    getRepository: (entity: unknown) => {
      if (entity === GovernmentAgency) {
        return { createQueryBuilder: () => qb };
      }
      throw new Error(
        `Unexpected entity in listAgencies spec: ${String(entity)}`,
      );
    },
  };
}

const CTX: ExecutiveCallerContext = {
  userId: 'user-1',
  workHistoryId: 'wh-1',
  roleName: 'staff',
  workStatusName: 'approved',
};

function buildDeps(
  ds: ReturnType<typeof makeDataSource>,
): ExecutiveToolHandlerDeps {
  return {
    dataSource: ds as never,
    unifiedProject: {} as never,
    budget: {} as never,
    status: {} as never,
    geo: {} as never,
    agency: {} as never,
    resilience: {} as never,
  };
}

const SAMPLE_AGENCIES: AgencyRow[] = [
  { id: '1', name: 'กองยุทธศาสตร์และงบประมาณ' },
  { id: '2', name: 'กองการช่าง' },
  { id: '3', name: 'กองคลัง' },
  { id: '4', name: 'สำนักปลัดองค์การบริหารส่วนจังหวัด' },
  { id: '5', name: 'กองสาธารณสุข' },
];

describe('W67-AGENCY-RESOLVER / listAgencies resolver tool', () => {
  describe('registry parity', () => {
    it('listAgencies is registered in EXECUTIVE_TOOL_REGISTRY', () => {
      expect(EXECUTIVE_TOOL_REGISTRY.listAgencies).toBeDefined();
      expect(EXECUTIVE_TOOL_REGISTRY.listAgencies.name).toBe('listAgencies');
    });

    it('listAgencies is in EXECUTIVE_TOOL_NAMES', () => {
      expect(EXECUTIVE_TOOL_NAMES).toContain('listAgencies');
    });

    it('listAgencies handler is registered in EXECUTIVE_TOOL_HANDLERS', () => {
      expect(typeof EXECUTIVE_TOOL_HANDLERS.listAgencies).toBe('function');
    });

    it('paramsSchema enforces additionalProperties=false (§17.9)', () => {
      const spec = EXECUTIVE_TOOL_REGISTRY.listAgencies;
      expect(spec.paramsSchema.additionalProperties).toBe(false);
      expect(spec.paramsSchema.properties?.nameContains?.type).toBe('string');
    });

    it('returnSchema declares items + envelope shape', () => {
      const spec = EXECUTIVE_TOOL_REGISTRY.listAgencies;
      expect(spec.returnSchema.required).toEqual(
        expect.arrayContaining([
          'items',
          'asOf',
          'missingDimensions',
          'advisories',
          'partial',
        ]),
      );
      const itemsItems = spec.returnSchema.properties?.items?.items;
      expect(itemsItems?.required).toEqual(
        expect.arrayContaining(['agencyId', 'name']),
      );
    });
  });

  describe('handler behavior', () => {
    it('returns all agencies when nameContains is omitted', async () => {
      const ds = makeDataSource(SAMPLE_AGENCIES);
      const deps = buildDeps(ds);
      const result = await EXECUTIVE_TOOL_HANDLERS.listAgencies({}, CTX, deps);

      expect(Array.isArray(result.items)).toBe(true);
      expect(result.items as unknown[]).toHaveLength(SAMPLE_AGENCIES.length);
      const items = result.items as Array<{ agencyId: number; name: string }>;
      const names = items.map((i) => i.name);
      expect(names).toEqual(
        expect.arrayContaining([
          'กองยุทธศาสตร์และงบประมาณ',
          'กองการช่าง',
          'กองคลัง',
        ]),
      );
      // PK is auto-increment integer at DB level but typed as `string`
      // in the entity — handler must coerce via String() so the wire
      // contract is consistent across resolver tools.
      expect(typeof items[0].agencyId).toBe('number');
    });

    it('returns filtered set when nameContains is provided (partial match)', async () => {
      const ds = makeDataSource(SAMPLE_AGENCIES);
      const deps = buildDeps(ds);
      const result = await EXECUTIVE_TOOL_HANDLERS.listAgencies(
        { nameContains: 'ยุทธ' },
        CTX,
        deps,
      );

      const items = result.items as Array<{ agencyId: number; name: string }>;
      expect(items).toHaveLength(1);
      expect(items[0].agencyId).toBe(1);
      expect(items[0].name).toBe('กองยุทธศาสตร์และงบประมาณ');
    });

    it('case-insensitive partial match works for Latin substrings too', async () => {
      const fixture: AgencyRow[] = [
        { id: '10', name: 'IT Department' },
        { id: '11', name: 'Finance Office' },
      ];
      const ds = makeDataSource(fixture);
      const deps = buildDeps(ds);
      const result = await EXECUTIVE_TOOL_HANDLERS.listAgencies(
        { nameContains: 'finance' },
        CTX,
        deps,
      );

      const items = result.items as Array<{ agencyId: number; name: string }>;
      expect(items).toHaveLength(1);
      expect(items[0].agencyId).toBe(11);
    });

    it('returns empty items[] when no row matches', async () => {
      const ds = makeDataSource(SAMPLE_AGENCIES);
      const deps = buildDeps(ds);
      const result = await EXECUTIVE_TOOL_HANDLERS.listAgencies(
        { nameContains: 'หน่วยงานที่ไม่มีอยู่จริง' },
        CTX,
        deps,
      );

      expect(result.items).toEqual([]);
      expect(result.missingDimensions).toEqual([]);
      expect(result.advisories).toEqual([]);
      expect(result.partial).toBe(false);
      expect(typeof result.asOf).toBe('string');
    });

    it('treats whitespace-only nameContains as omitted (returns all live rows)', async () => {
      const ds = makeDataSource(SAMPLE_AGENCIES);
      const deps = buildDeps(ds);
      const result = await EXECUTIVE_TOOL_HANDLERS.listAgencies(
        { nameContains: '   ' },
        CTX,
        deps,
      );

      const items = result.items as Array<{ agencyId: number; name: string }>;
      expect(items).toHaveLength(SAMPLE_AGENCIES.length);
    });

    it('soft-deleted agencies are excluded (deleted_at IS NULL filter)', async () => {
      const fixture: AgencyRow[] = [
        { id: '1', name: 'กองยุทธศาสตร์และงบประมาณ' },
        { id: '2', name: 'กองที่ถูกลบ', deletedAt: new Date() },
        { id: '3', name: 'กองคลัง' },
      ];
      const ds = makeDataSource(fixture);
      const deps = buildDeps(ds);
      const result = await EXECUTIVE_TOOL_HANDLERS.listAgencies({}, CTX, deps);

      const items = result.items as Array<{ agencyId: number; name: string }>;
      expect(items).toHaveLength(2);
      const names = items.map((i) => i.name);
      expect(names).not.toContain('กองที่ถูกลบ');
    });

    it('output shape matches the registered returnSchema (envelope keys)', async () => {
      const ds = makeDataSource(SAMPLE_AGENCIES);
      const deps = buildDeps(ds);
      const result = await EXECUTIVE_TOOL_HANDLERS.listAgencies({}, CTX, deps);

      // Envelope-level keys.
      expect(result).toHaveProperty('items');
      expect(result).toHaveProperty('asOf');
      expect(result).toHaveProperty('missingDimensions');
      expect(result).toHaveProperty('advisories');
      expect(result).toHaveProperty('partial');

      // Per-item keys.
      const items = result.items as Array<{ agencyId: number; name: string }>;
      for (const it of items) {
        expect(it).toHaveProperty('agencyId');
        expect(it).toHaveProperty('name');
        expect(typeof it.agencyId).toBe('number');
        expect(typeof it.name).toBe('string');
      }
    });
  });

  describe('§17.11 — non-executive role rejection', () => {
    it('throws EXECUTIVE_ROLE_REQUIRED for role=user', async () => {
      const ds = makeDataSource(SAMPLE_AGENCIES);
      const deps = buildDeps(ds);
      const userCtx: ExecutiveCallerContext = {
        userId: 'u',
        workHistoryId: 'wh',
        roleName: 'user',
        workStatusName: 'approved',
      };
      await expect(
        EXECUTIVE_TOOL_HANDLERS.listAgencies({}, userCtx, deps),
      ).rejects.toThrow(/EXECUTIVE_ROLE_REQUIRED/);
    });

    it('throws EXECUTIVE_ROLE_REQUIRED for non-approved workStatus', async () => {
      const ds = makeDataSource(SAMPLE_AGENCIES);
      const deps = buildDeps(ds);
      const pendingCtx: ExecutiveCallerContext = {
        userId: 'u',
        workHistoryId: 'wh',
        roleName: 'staff',
        workStatusName: 'pending',
      };
      await expect(
        EXECUTIVE_TOOL_HANDLERS.listAgencies({}, pendingCtx, deps),
      ).rejects.toThrow(/EXECUTIVE_ROLE_REQUIRED/);
    });

    it.each([['admin'], ['super-admin'], ['c-level']])(
      'allows role=%s with approved workStatus',
      async (role) => {
        const ds = makeDataSource(SAMPLE_AGENCIES);
        const deps = buildDeps(ds);
        const ctx: ExecutiveCallerContext = {
          userId: 'u',
          workHistoryId: 'wh',
          roleName: role,
          workStatusName: 'approved',
        };
        const result = await EXECUTIVE_TOOL_HANDLERS.listAgencies(
          {},
          ctx,
          deps,
        );
        expect(Array.isArray(result.items)).toBe(true);
      },
    );
  });
});
