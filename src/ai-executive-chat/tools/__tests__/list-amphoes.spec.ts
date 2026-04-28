/**
 * Wave 67 W67-AMPHOE-FIX-PROMPT-01 (Path A) — listAmphoes resolver spec.
 *
 * Coverage:
 *   - Returns all amphoes when `nameContains` is omitted
 *   - Returns filtered set when `nameContains` is provided (partial,
 *     case-insensitive)
 *   - Returns empty `items: []` when no row matches
 *   - Rejects non-executive role (assertExecutiveRole)
 *   - Output shape matches the registered returnSchema
 *   - Handler is registered in EXECUTIVE_TOOL_HANDLERS and the spec is
 *     in EXECUTIVE_TOOL_REGISTRY
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
import { Amphoe } from 'src/amphoes/entities/amphoe.entity';

interface AmphoeRow {
  id: string;
  name: string;
}

function makeDataSource(rows: AmphoeRow[]) {
  // The handler chains where().andWhere() with a `:pat` parameter when
  // nameContains is provided. We capture that bind value off the
  // andWhere call so the stub can apply the same filter the SQL would.
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
    if (!pat) return rows;
    // Strip leading/trailing % and apply case-insensitive substring
    // match — mirrors the SQL `LOWER(a.name) LIKE LOWER(:pat)` predicate.
    const stripped = (pat as string).replace(/^%/, '').replace(/%$/, '').toLowerCase();
    return rows.filter((r) => r.name.toLowerCase().includes(stripped));
  });
  return {
    getRepository: (entity: unknown) => {
      if (entity === Amphoe) {
        return { createQueryBuilder: () => qb };
      }
      throw new Error(`Unexpected entity in listAmphoes spec: ${String(entity)}`);
    },
  };
}

const CTX: ExecutiveCallerContext = {
  userId: 'user-1',
  workHistoryId: 'wh-1',
  roleName: 'staff',
  workStatusName: 'approved',
};

function buildDeps(ds: ReturnType<typeof makeDataSource>): ExecutiveToolHandlerDeps {
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

const SAMPLE_AMPHOES: AmphoeRow[] = [
  { id: '3001', name: 'เมืองนครราชสีมา' },
  { id: '3007', name: 'ขามสะแกแสง' },
  { id: '3015', name: 'บ้านเหลื่อม' },
  { id: '3020', name: 'สีคิ้ว' },
];

describe('W67-AMPHOE-FIX-PROMPT-01 / listAmphoes resolver tool', () => {
  describe('registry parity', () => {
    it('listAmphoes is registered in EXECUTIVE_TOOL_REGISTRY', () => {
      expect(EXECUTIVE_TOOL_REGISTRY.listAmphoes).toBeDefined();
      expect(EXECUTIVE_TOOL_REGISTRY.listAmphoes.name).toBe('listAmphoes');
    });

    it('listAmphoes is in EXECUTIVE_TOOL_NAMES', () => {
      expect(EXECUTIVE_TOOL_NAMES).toContain('listAmphoes');
    });

    it('listAmphoes handler is registered in EXECUTIVE_TOOL_HANDLERS', () => {
      expect(typeof EXECUTIVE_TOOL_HANDLERS.listAmphoes).toBe('function');
    });

    it('paramsSchema enforces additionalProperties=false (§17.9)', () => {
      const spec = EXECUTIVE_TOOL_REGISTRY.listAmphoes;
      expect(spec.paramsSchema.additionalProperties).toBe(false);
      expect(spec.paramsSchema.properties?.nameContains?.type).toBe('string');
    });

    it('returnSchema declares items + envelope shape', () => {
      const spec = EXECUTIVE_TOOL_REGISTRY.listAmphoes;
      expect(spec.returnSchema.required).toEqual(
        expect.arrayContaining(['items', 'asOf', 'missingDimensions', 'advisories', 'partial']),
      );
      const itemsItems = spec.returnSchema.properties?.items?.items;
      expect(itemsItems?.required).toEqual(
        expect.arrayContaining(['amphoeId', 'name']),
      );
    });
  });

  describe('handler behavior', () => {
    it('returns all amphoes when nameContains is omitted', async () => {
      const ds = makeDataSource(SAMPLE_AMPHOES);
      const deps = buildDeps(ds);
      const result = await EXECUTIVE_TOOL_HANDLERS.listAmphoes({}, CTX, deps);

      expect(Array.isArray(result.items)).toBe(true);
      expect(result.items as unknown[]).toHaveLength(SAMPLE_AMPHOES.length);
      const items = result.items as Array<{ amphoeId: string; name: string }>;
      const names = items.map((i) => i.name);
      expect(names).toEqual(expect.arrayContaining(['เมืองนครราชสีมา', 'ขามสะแกแสง']));
      // PK must be a string (per Amphoe.id type — string PK).
      expect(typeof items[0].amphoeId).toBe('string');
    });

    it('returns filtered set when nameContains is provided (partial match)', async () => {
      const ds = makeDataSource(SAMPLE_AMPHOES);
      const deps = buildDeps(ds);
      const result = await EXECUTIVE_TOOL_HANDLERS.listAmphoes(
        { nameContains: 'เมือง' },
        CTX,
        deps,
      );

      const items = result.items as Array<{ amphoeId: string; name: string }>;
      expect(items).toHaveLength(1);
      expect(items[0].amphoeId).toBe('3001');
      expect(items[0].name).toBe('เมืองนครราชสีมา');
    });

    it('case-insensitive partial match works for Latin substrings too', async () => {
      const fixture: AmphoeRow[] = [
        { id: '3001', name: 'Mueang Nakhon Ratchasima' },
        { id: '3007', name: 'Khong' },
      ];
      const ds = makeDataSource(fixture);
      const deps = buildDeps(ds);
      const result = await EXECUTIVE_TOOL_HANDLERS.listAmphoes(
        { nameContains: 'mueang' },
        CTX,
        deps,
      );

      const items = result.items as Array<{ amphoeId: string; name: string }>;
      expect(items).toHaveLength(1);
      expect(items[0].amphoeId).toBe('3001');
    });

    it('returns empty items[] when no row matches', async () => {
      const ds = makeDataSource(SAMPLE_AMPHOES);
      const deps = buildDeps(ds);
      const result = await EXECUTIVE_TOOL_HANDLERS.listAmphoes(
        { nameContains: 'ไม่มีอำเภอนี้แน่ ๆ' },
        CTX,
        deps,
      );

      expect(result.items).toEqual([]);
      // Envelope shape preserved on empty result.
      expect(result.missingDimensions).toEqual([]);
      expect(result.advisories).toEqual([]);
      expect(result.partial).toBe(false);
      expect(typeof result.asOf).toBe('string');
    });

    it('treats whitespace-only nameContains as omitted (returns all)', async () => {
      const ds = makeDataSource(SAMPLE_AMPHOES);
      const deps = buildDeps(ds);
      const result = await EXECUTIVE_TOOL_HANDLERS.listAmphoes(
        { nameContains: '   ' },
        CTX,
        deps,
      );

      const items = result.items as Array<{ amphoeId: string; name: string }>;
      // No filter applied — all rows returned.
      expect(items).toHaveLength(SAMPLE_AMPHOES.length);
    });

    it('output shape matches the registered returnSchema (envelope keys)', async () => {
      const ds = makeDataSource(SAMPLE_AMPHOES);
      const deps = buildDeps(ds);
      const result = await EXECUTIVE_TOOL_HANDLERS.listAmphoes({}, CTX, deps);

      // Envelope-level keys.
      expect(result).toHaveProperty('items');
      expect(result).toHaveProperty('asOf');
      expect(result).toHaveProperty('missingDimensions');
      expect(result).toHaveProperty('advisories');
      expect(result).toHaveProperty('partial');

      // Per-item keys.
      const items = result.items as Array<{ amphoeId: string; name: string }>;
      for (const it of items) {
        expect(it).toHaveProperty('amphoeId');
        expect(it).toHaveProperty('name');
        expect(typeof it.amphoeId).toBe('string');
        expect(typeof it.name).toBe('string');
      }
    });
  });

  describe('§17.11 — non-executive role rejection', () => {
    it('throws EXECUTIVE_ROLE_REQUIRED for role=user', async () => {
      const ds = makeDataSource(SAMPLE_AMPHOES);
      const deps = buildDeps(ds);
      const userCtx: ExecutiveCallerContext = {
        userId: 'u',
        workHistoryId: 'wh',
        roleName: 'user',
        workStatusName: 'approved',
      };
      await expect(
        EXECUTIVE_TOOL_HANDLERS.listAmphoes({}, userCtx, deps),
      ).rejects.toThrow(/EXECUTIVE_ROLE_REQUIRED/);
    });

    it('throws EXECUTIVE_ROLE_REQUIRED for non-approved workStatus', async () => {
      const ds = makeDataSource(SAMPLE_AMPHOES);
      const deps = buildDeps(ds);
      const pendingCtx: ExecutiveCallerContext = {
        userId: 'u',
        workHistoryId: 'wh',
        roleName: 'staff',
        workStatusName: 'pending',
      };
      await expect(
        EXECUTIVE_TOOL_HANDLERS.listAmphoes({}, pendingCtx, deps),
      ).rejects.toThrow(/EXECUTIVE_ROLE_REQUIRED/);
    });

    it.each([['admin'], ['super-admin'], ['c-level']])(
      'allows role=%s with approved workStatus',
      async (role) => {
        const ds = makeDataSource(SAMPLE_AMPHOES);
        const deps = buildDeps(ds);
        const ctx: ExecutiveCallerContext = {
          userId: 'u',
          workHistoryId: 'wh',
          roleName: role,
          workStatusName: 'approved',
        };
        const result = await EXECUTIVE_TOOL_HANDLERS.listAmphoes({}, ctx, deps);
        expect(Array.isArray(result.items)).toBe(true);
      },
    );
  });
});
