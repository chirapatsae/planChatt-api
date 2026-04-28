/**
 * Wave 67 W67-LAO-RESOLVER — listLaos resolver spec.
 *
 * Coverage (mirror of list-amphoes.spec.ts with Q2=c hybrid validation):
 *   - Registry parity (4 assertions)
 *   - Empty params → returns `items: []` + `advisories: ['lao-filter-required']`
 *   - `amphoeId` only → returns LAOs in that amphoe
 *   - `nameContains` only → returns LAOs across province matching name pattern
 *   - Both → intersection
 *   - No match → empty `items: []`
 *   - Soft-deleted LAOs excluded (`lao.delete_at IS NULL`)
 *   - amphoe LEFT JOIN populates `amphoeId` + `amphoeName`
 *   - §17.11 — non-executive role rejection (≥ 3 cases)
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
import { LocalAdministrativeOrganization } from 'src/local-administrative-organizations/entities/local-administrative-organization.entity';

interface LaoRow {
  id: string;
  name: string;
  type: string;
  amphoeId: string | null;
  amphoeName: string | null;
  /** When true, the row is soft-deleted (delete_at IS NOT NULL) and MUST be filtered out. */
  deleted?: boolean;
}

function makeDataSource(rows: LaoRow[]) {
  // Capture filter binds off the chained where/andWhere calls so the
  // stub can apply the same predicates the SQL would.
  const qb: Record<string, unknown> = {};
  let pat: string | undefined;
  let amphoeId: string | undefined;
  // W68-FIX-11 (2026-04-28) — captures `lao.type = :typeFilter` bind.
  let typeFilter: string | undefined;
  qb.leftJoin = () => qb;
  qb.select = () => qb;
  qb.addSelect = () => qb;
  qb.where = () => qb;
  qb.andWhere = (
    _clause: string,
    params?: { pat?: string; amphoeId?: string; typeFilter?: string },
  ) => {
    if (params && typeof params.pat === 'string') pat = params.pat;
    if (params && typeof params.amphoeId === 'string') {
      amphoeId = params.amphoeId;
    }
    if (params && typeof params.typeFilter === 'string') {
      typeFilter = params.typeFilter;
    }
    return qb;
  };
  qb.orderBy = () => qb;
  qb.addOrderBy = () => qb;
  qb.getRawMany = jest.fn(async () => {
    let filtered = rows.filter((r) => !r.deleted);
    if (amphoeId !== undefined) {
      filtered = filtered.filter((r) => r.amphoeId === amphoeId);
    }
    if (pat !== undefined) {
      const stripped = (pat as string).replace(/^%/, '').replace(/%$/, '').toLowerCase();
      filtered = filtered.filter((r) => r.name.toLowerCase().includes(stripped));
    }
    if (typeFilter !== undefined) {
      // W68-FIX-11 — strict equality match (mirrors handler's
      // `lao.type = :typeFilter` SQL bind).
      filtered = filtered.filter((r) => r.type === typeFilter);
    }
    // Match the raw-projection shape the handler reads.
    return filtered.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      amphoeId: r.amphoeId,
      amphoeName: r.amphoeName,
    }));
  });
  return {
    getRepository: (entity: unknown) => {
      if (entity === LocalAdministrativeOrganization) {
        return { createQueryBuilder: () => qb };
      }
      throw new Error(
        `Unexpected entity in listLaos spec: ${String(entity)}`,
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

const SAMPLE_LAOS: LaoRow[] = [
  {
    id: '3001027',
    name: 'อบจ. นครราชสีมา',
    type: 'อบจ.',
    amphoeId: '3001',
    amphoeName: 'เมืองนครราชสีมา',
  },
  {
    id: '3001001',
    name: 'อบต. โคกกรวด',
    type: 'อบต.',
    amphoeId: '3001',
    amphoeName: 'เมืองนครราชสีมา',
  },
  {
    id: '3007001',
    name: 'อบต. ขามสะแกแสง',
    type: 'อบต.',
    amphoeId: '3007',
    amphoeName: 'ขามสะแกแสง',
  },
  {
    id: '3007002',
    name: 'เทศบาลตำบลขามสะแกแสง',
    type: 'เทศบาล',
    amphoeId: '3007',
    amphoeName: 'ขามสะแกแสง',
  },
  // Soft-deleted row — MUST be filtered by the handler.
  {
    id: '9999999',
    name: 'อบต. ที่ถูกลบแล้ว',
    type: 'อบต.',
    amphoeId: '3001',
    amphoeName: 'เมืองนครราชสีมา',
    deleted: true,
  },
];

describe('W67-LAO-RESOLVER / listLaos resolver tool', () => {
  describe('registry parity', () => {
    it('listLaos is registered in EXECUTIVE_TOOL_REGISTRY', () => {
      expect(EXECUTIVE_TOOL_REGISTRY.listLaos).toBeDefined();
      expect(EXECUTIVE_TOOL_REGISTRY.listLaos.name).toBe('listLaos');
    });

    it('listLaos is in EXECUTIVE_TOOL_NAMES', () => {
      expect(EXECUTIVE_TOOL_NAMES).toContain('listLaos');
    });

    it('listLaos handler is registered in EXECUTIVE_TOOL_HANDLERS', () => {
      expect(typeof EXECUTIVE_TOOL_HANDLERS.listLaos).toBe('function');
    });

    it('paramsSchema enforces additionalProperties=false (§17.9) and accepts all three optional params (W68-FIX-11)', () => {
      const spec = EXECUTIVE_TOOL_REGISTRY.listLaos;
      expect(spec.paramsSchema.additionalProperties).toBe(false);
      expect(spec.paramsSchema.properties?.amphoeId?.type).toBe('string');
      expect(spec.paramsSchema.properties?.nameContains?.type).toBe('string');
      // W68-FIX-11 (2026-04-28) — exact-match type filter for LAO category.
      expect(spec.paramsSchema.properties?.type?.type).toBe('string');
      // No `required` array — Q2=c hybrid validation lives in the handler.
      expect(spec.paramsSchema.required ?? []).toEqual([]);
    });

    it('returnSchema declares envelope shape with full per-item field set', () => {
      const spec = EXECUTIVE_TOOL_REGISTRY.listLaos;
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
        expect.arrayContaining([
          'laoId',
          'name',
          'type',
          'amphoeId',
          'amphoeName',
        ]),
      );
    });
  });

  describe('handler behavior — Q2=c hybrid validation', () => {
    it('empty params → returns items=[] + advisory lao-filter-required', async () => {
      const ds = makeDataSource(SAMPLE_LAOS);
      const deps = buildDeps(ds);
      const result = await EXECUTIVE_TOOL_HANDLERS.listLaos({}, CTX, deps);

      expect(result.items).toEqual([]);
      expect(result.advisories).toEqual(['lao-filter-required']);
      expect(result.partial).toBe(false);
      expect(typeof result.asOf).toBe('string');
    });

    it('whitespace-only nameContains AND no amphoeId → returns items=[] + advisory', async () => {
      const ds = makeDataSource(SAMPLE_LAOS);
      const deps = buildDeps(ds);
      const result = await EXECUTIVE_TOOL_HANDLERS.listLaos(
        { nameContains: '   ' },
        CTX,
        deps,
      );
      expect(result.items).toEqual([]);
      expect(result.advisories).toEqual(['lao-filter-required']);
    });

    it('amphoeId only → returns LAOs in that amphoe', async () => {
      const ds = makeDataSource(SAMPLE_LAOS);
      const deps = buildDeps(ds);
      const result = await EXECUTIVE_TOOL_HANDLERS.listLaos(
        { amphoeId: '3007' },
        CTX,
        deps,
      );

      const items = result.items as Array<{
        laoId: string;
        name: string;
        type: string;
        amphoeId: string;
        amphoeName: string;
      }>;
      expect(items).toHaveLength(2);
      const names = items.map((i) => i.name).sort();
      expect(names).toEqual(['อบต. ขามสะแกแสง', 'เทศบาลตำบลขามสะแกแสง'].sort());
      // amphoe LEFT JOIN populates the labels.
      for (const it of items) {
        expect(it.amphoeId).toBe('3007');
        expect(it.amphoeName).toBe('ขามสะแกแสง');
      }
    });

    it('nameContains only → returns LAOs across province matching name pattern', async () => {
      const ds = makeDataSource(SAMPLE_LAOS);
      const deps = buildDeps(ds);
      const result = await EXECUTIVE_TOOL_HANDLERS.listLaos(
        { nameContains: 'ขามสะแกแสง' },
        CTX,
        deps,
      );

      const items = result.items as Array<{ laoId: string; name: string }>;
      expect(items).toHaveLength(2);
      const names = items.map((i) => i.name).sort();
      expect(names).toEqual(['อบต. ขามสะแกแสง', 'เทศบาลตำบลขามสะแกแสง'].sort());
    });

    it('both amphoeId AND nameContains → intersection', async () => {
      const ds = makeDataSource(SAMPLE_LAOS);
      const deps = buildDeps(ds);
      const result = await EXECUTIVE_TOOL_HANDLERS.listLaos(
        { amphoeId: '3007', nameContains: 'อบต' },
        CTX,
        deps,
      );

      const items = result.items as Array<{ laoId: string; name: string }>;
      expect(items).toHaveLength(1);
      expect(items[0].name).toBe('อบต. ขามสะแกแสง');
      expect(items[0].laoId).toBe('3007001');
    });

    it('no match → empty items[]', async () => {
      const ds = makeDataSource(SAMPLE_LAOS);
      const deps = buildDeps(ds);
      const result = await EXECUTIVE_TOOL_HANDLERS.listLaos(
        { nameContains: 'ไม่มี อปท นี้' },
        CTX,
        deps,
      );

      expect(result.items).toEqual([]);
      expect(result.missingDimensions).toEqual([]);
      expect(result.advisories).toEqual([]);
      expect(result.partial).toBe(false);
    });

    it('soft-deleted LAOs are excluded from results', async () => {
      const ds = makeDataSource(SAMPLE_LAOS);
      const deps = buildDeps(ds);
      const result = await EXECUTIVE_TOOL_HANDLERS.listLaos(
        { amphoeId: '3001' },
        CTX,
        deps,
      );

      const items = result.items as Array<{ laoId: string; name: string }>;
      // SAMPLE_LAOS has 2 active rows in amphoeId=3001 + 1 soft-deleted.
      // Soft-deleted row MUST be excluded.
      expect(items).toHaveLength(2);
      const ids = items.map((i) => i.laoId);
      expect(ids).not.toContain('9999999');
    });

    // ──────────────────────────────────────────────────────────────────
    // W68-FIX-11 (2026-04-28) — exact-match `type` filter assertions.
    // Closes the gap that allowed an "อบต. โคกกรวด" user query to
    // resolve to "เทศบาลตำบลโคกกรวด" silently. The handler now strict-
    // equals against `local_administrative_organizations.type`; prompt
    // rule #25b Path A drives the type-aware lookup with fallback.
    // ──────────────────────────────────────────────────────────────────
    it('W68-FIX-11 — type only → exact-match filter on lao.type', async () => {
      const ds = makeDataSource(SAMPLE_LAOS);
      const deps = buildDeps(ds);
      const result = await EXECUTIVE_TOOL_HANDLERS.listLaos(
        { type: 'อบต.' },
        CTX,
        deps,
      );

      const items = result.items as Array<{ name: string; type: string }>;
      // Active SAMPLE_LAOS rows with type='อบต.' = 2
      // (อบต. โคกกรวด + อบต. ขามสะแกแสง). The third 'อบต.' row is
      // soft-deleted (id=9999999) and MUST be excluded.
      expect(items).toHaveLength(2);
      for (const it of items) {
        expect(it.type).toBe('อบต.');
      }
      const names = items.map((i) => i.name).sort();
      expect(names).toEqual(['อบต. ขามสะแกแสง', 'อบต. โคกกรวด'].sort());
    });

    it('W68-FIX-11 — type + nameContains → AND filter (the canonical Path A call)', async () => {
      const ds = makeDataSource(SAMPLE_LAOS);
      const deps = buildDeps(ds);
      // Canonical "อบต. โคกกรวด" lookup per prompt rule #25b Path A
      // step 2. SAMPLE has exactly one match.
      const result = await EXECUTIVE_TOOL_HANDLERS.listLaos(
        { type: 'อบต.', nameContains: 'โคกกรวด' },
        CTX,
        deps,
      );

      const items = result.items as Array<{
        laoId: string;
        name: string;
        type: string;
      }>;
      expect(items).toHaveLength(1);
      expect(items[0].name).toBe('อบต. โคกกรวด');
      expect(items[0].type).toBe('อบต.');
      expect(items[0].laoId).toBe('3001001');
    });

    it('W68-FIX-11 — type-mismatch fallback semantics (no อบต. โคกกรวด → empty)', async () => {
      // Path A step 4: type='อบต.' + nameContains='ขามสะแกแสง'.
      // SAMPLE has BOTH "อบต. ขามสะแกแสง" and "เทศบาลตำบลขามสะแกแสง"
      // but the type filter pins us to 'อบต.' only.
      const ds = makeDataSource(SAMPLE_LAOS);
      const deps = buildDeps(ds);
      const result = await EXECUTIVE_TOOL_HANDLERS.listLaos(
        { type: 'อบต.', nameContains: 'ขามสะแกแสง' },
        CTX,
        deps,
      );

      const items = result.items as Array<{ name: string; type: string }>;
      expect(items).toHaveLength(1);
      expect(items[0].name).toBe('อบต. ขามสะแกแสง');
      expect(items[0].type).toBe('อบต.');

      // Now retry WITHOUT type filter (Path A step 4 fallback) — the
      // เทศบาลตำบลขามสะแกแสง row MUST surface as the alternative the
      // LLM offers to the user.
      const ds2 = makeDataSource(SAMPLE_LAOS);
      const deps2 = buildDeps(ds2);
      const fallback = await EXECUTIVE_TOOL_HANDLERS.listLaos(
        { nameContains: 'ขามสะแกแสง' },
        CTX,
        deps2,
      );
      const fallbackItems = fallback.items as Array<{
        name: string;
        type: string;
      }>;
      expect(fallbackItems).toHaveLength(2);
      const fallbackTypes = fallbackItems.map((i) => i.type).sort();
      expect(fallbackTypes).toEqual(['อบต.', 'เทศบาล'].sort());
    });

    it('W68-FIX-11 — type-only with no match → empty items (no fabrication)', async () => {
      const ds = makeDataSource(SAMPLE_LAOS);
      const deps = buildDeps(ds);
      // 'เทศบาลนคร' is not represented in SAMPLE — must be empty.
      const result = await EXECUTIVE_TOOL_HANDLERS.listLaos(
        { type: 'เทศบาลนคร' },
        CTX,
        deps,
      );
      expect(result.items).toEqual([]);
      expect(result.advisories).toEqual([]);
      expect(result.partial).toBe(false);
    });

    it('per-item shape contains laoId/name/type/amphoeId/amphoeName as strings', async () => {
      const ds = makeDataSource(SAMPLE_LAOS);
      const deps = buildDeps(ds);
      const result = await EXECUTIVE_TOOL_HANDLERS.listLaos(
        { amphoeId: '3001' },
        CTX,
        deps,
      );

      const items = result.items as Array<{
        laoId: string;
        name: string;
        type: string;
        amphoeId: string;
        amphoeName: string;
      }>;
      for (const it of items) {
        expect(typeof it.laoId).toBe('string');
        expect(typeof it.name).toBe('string');
        expect(typeof it.type).toBe('string');
        expect(typeof it.amphoeId).toBe('string');
        expect(typeof it.amphoeName).toBe('string');
      }
    });
  });

  describe('§17.11 — non-executive role rejection', () => {
    it('throws EXECUTIVE_ROLE_REQUIRED for role=user', async () => {
      const ds = makeDataSource(SAMPLE_LAOS);
      const deps = buildDeps(ds);
      const userCtx: ExecutiveCallerContext = {
        userId: 'u',
        workHistoryId: 'wh',
        roleName: 'user',
        workStatusName: 'approved',
      };
      await expect(
        EXECUTIVE_TOOL_HANDLERS.listLaos({ amphoeId: '3001' }, userCtx, deps),
      ).rejects.toThrow(/EXECUTIVE_ROLE_REQUIRED/);
    });

    it('throws EXECUTIVE_ROLE_REQUIRED for non-approved workStatus', async () => {
      const ds = makeDataSource(SAMPLE_LAOS);
      const deps = buildDeps(ds);
      const pendingCtx: ExecutiveCallerContext = {
        userId: 'u',
        workHistoryId: 'wh',
        roleName: 'staff',
        workStatusName: 'pending',
      };
      await expect(
        EXECUTIVE_TOOL_HANDLERS.listLaos({ amphoeId: '3001' }, pendingCtx, deps),
      ).rejects.toThrow(/EXECUTIVE_ROLE_REQUIRED/);
    });

    it.each([['admin'], ['super-admin'], ['c-level']])(
      'allows role=%s with approved workStatus',
      async (role) => {
        const ds = makeDataSource(SAMPLE_LAOS);
        const deps = buildDeps(ds);
        const ctx: ExecutiveCallerContext = {
          userId: 'u',
          workHistoryId: 'wh',
          roleName: role,
          workStatusName: 'approved',
        };
        const result = await EXECUTIVE_TOOL_HANDLERS.listLaos(
          { amphoeId: '3001' },
          ctx,
          deps,
        );
        expect(Array.isArray(result.items)).toBe(true);
      },
    );
  });

  describe('description references read-only contract (§17.3)', () => {
    it('listLaos.description matches /อ่านอย่างเดียว/', () => {
      expect(EXECUTIVE_TOOL_REGISTRY.listLaos.description).toMatch(
        /อ่านอย่างเดียว/,
      );
    });
  });
});
