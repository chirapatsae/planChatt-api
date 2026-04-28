/**
 * BE-W54-05 / W55-BE-04 — GeoEnrichment unit spec.
 *
 * Covers:
 *   1. Empty input → empty result, no DB call.
 *   2. Main + revised amphoe join success (Thai amphoe name projected).
 *   3. Wave 55 W55-BE-04 — PER-ROW SPG semantics:
 *      - SPG row with `amphoeId` populated → enriched normally via a
 *        third parallel query against the SPG table. NO per-run
 *        advisory when every SPG row has a non-null amphoe.
 *      - SPG row with `amphoeId = null` → NOT enriched; run emits the
 *        `geo:supplement` missingDimension + the paired Thai advisory
 *        (exactly once per run, deduped).
 *   4. Mixed batch (main + revised + supplement) — all enriched; SPG
 *      NULL rows still trigger the per-run advisory.
 *   5. Null `amphoe_id` → `{ amphoeId: null, amphoeName: null }`.
 *   6. Empty / whitespace amphoe name → `amphoeName: null`.
 *   7. Advisory string is exported as a module `const` (prompt-
 *      injection defense).
 *   8. Grep gate — no raw `amphoes` / `project_groups` / `revised_*` /
 *      `supplement_project_groups` table literals in the service source.
 *   9. No write-method calls. No `tracking_status` references.
 *
 * CLAUDE.md §17.2 / §17.9 / §17.11 — read-only; advisory is a
 * server-authored static Thai string; role check lives at Tier C.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import {
  GeoEnrichmentService,
  SUPPLEMENT_GEO_ADVISORY,
} from '../services/geo-enrichment.service';
import type { UnifiedProject } from '../types';

// ────────────────────────────────────────────────────────────────
// Mock DataSource harness. Captures per-call alias + `ids` so each
// test can assert which repository was hit and with which ids.
// ────────────────────────────────────────────────────────────────

interface QbCall {
  alias: 'pg' | 'rpg' | 'spg';
  ids: string[];
}

type AmphoeRow = {
  pgid?: string | null;
  rpgid?: string | null;
  spgid?: string | null;
  amphoeid: string | null;
  amphoename: string | null;
};

function makeDataSource(opts: {
  rows?: (call: QbCall) => AmphoeRow[];
  throwOn?: (call: QbCall) => Error | null;
}) {
  const calls: QbCall[] = [];
  const rows = opts.rows ?? (() => []);
  const throwOn = opts.throwOn ?? (() => null);

  const qbFactory = (alias: 'pg' | 'rpg' | 'spg') => {
    const state: { ids?: string[] } = {};
    const qb: Record<string, unknown> = {};
    const self = () => qb;
    Object.assign(qb, {
      leftJoin: self,
      select: self,
      addSelect: self,
      where: (_clause: string, params: { ids: string[] }) => {
        state.ids = params?.ids ?? [];
        return qb;
      },
      andWhere: self,
      getRawMany: async () => {
        const call: QbCall = { alias, ids: state.ids ?? [] };
        calls.push(call);
        const err = throwOn(call);
        if (err) throw err;
        return rows(call);
      },
    });
    return qb;
  };

  const dataSource = {
    getRepository: (target: unknown) => {
      // Choose alias based on the entity class name — ProjectGroup,
      // RevisedProjectGroup, or SupplementProjectGroup.
      const name =
        typeof target === 'function'
          ? (target as { name?: string }).name ?? ''
          : '';
      const alias: 'pg' | 'rpg' | 'spg' =
        name === 'RevisedProjectGroup'
          ? 'rpg'
          : name === 'SupplementProjectGroup'
            ? 'spg'
            : 'pg';
      return { createQueryBuilder: (_a: string) => qbFactory(alias) };
    },
  };

  return { dataSource, calls };
}

function mk(
  projectKind: 'main' | 'revised' | 'supplement',
  projectId: string,
  amphoeId: number | null = null,
): UnifiedProject {
  const base: UnifiedProject = {
    projectKind,
    projectId,
    name: `proj-${projectId}`,
    planId: 'plan-1',
    planReportFormat: 'STRATEGY_BASED',
    // Wave 55 W55-BE-07 — `originType` is a required field on every
    // UnifiedProject; GeoEnrichment does not branch on it, so the
    // fixture uses the safe default.
    originType: 'lao-coordinated',
  };
  // Wave 55 W55-BE-04 — GeoEnrichment reads `p.amphoeId` for SPG rows
  // to decide enrich-vs-advisory. Default `null` preserves the
  // historical backfill-gap semantics.
  if (amphoeId !== null) {
    base.amphoeId = amphoeId;
  } else if (projectKind === 'supplement') {
    base.amphoeId = null;
  }
  return base;
}

function svc(ds: unknown): GeoEnrichmentService {
  return new GeoEnrichmentService(ds as never);
}

// ────────────────────────────────────────────────────────────────

describe('BE-W54-05 / W55-BE-04 / GeoEnrichment', () => {
  // ── 1. Empty input ──────────────────────────────────────────
  describe('empty input', () => {
    it('returns empty result without issuing any DB call', async () => {
      const { dataSource, calls } = makeDataSource({});
      const out = await svc(dataSource).annotate([]);
      expect(out.labels.size).toBe(0);
      expect(out.missingDimensions).toEqual([]);
      expect(out.advisories).toEqual([]);
      expect(calls).toHaveLength(0);
    });
  });

  // ── 2. Main + revised join success ─────────────────────────
  describe('main + revised amphoe join success', () => {
    it('projects Thai amphoe name for main rows, keys by projectId', async () => {
      const { dataSource } = makeDataSource({
        rows: (c) =>
          c.alias === 'pg'
            ? [
                {
                  pgid: 'p1',
                  amphoeid: '3001',
                  amphoename: 'เมืองนครราชสีมา',
                },
              ]
            : [],
      });
      const out = await svc(dataSource).annotate([mk('main', 'p1')]);
      expect(out.labels.get('p1')).toEqual({
        amphoeId: 3001,
        amphoeName: 'เมืองนครราชสีมา',
      });
      expect(out.missingDimensions).toEqual([]);
      expect(out.advisories).toEqual([]);
    });

    it('projects Thai amphoe name for revised rows, keys by projectId', async () => {
      const { dataSource } = makeDataSource({
        rows: (c) =>
          c.alias === 'rpg'
            ? [{ rpgid: 'r1', amphoeid: '3002', amphoename: 'ครบุรี' }]
            : [],
      });
      const out = await svc(dataSource).annotate([mk('revised', 'r1')]);
      expect(out.labels.get('r1')).toEqual({
        amphoeId: 3002,
        amphoeName: 'ครบุรี',
      });
    });

    it('issues parallel queries for each requested kind (pg + rpg)', async () => {
      const { dataSource, calls } = makeDataSource({
        rows: () => [],
      });
      await svc(dataSource).annotate([
        mk('main', 'p1'),
        mk('revised', 'r1'),
      ]);
      const aliases = calls.map((c) => c.alias).sort();
      expect(aliases).toEqual(['pg', 'rpg']);
    });
  });

  // ── 3. Wave 55 per-row SPG semantics ───────────────────────
  describe('W55-BE-04 — per-row SPG semantics', () => {
    it('SPG row WITH amphoeId → enriched via third parallel query, NO advisory', async () => {
      const { dataSource, calls } = makeDataSource({
        rows: (c) =>
          c.alias === 'spg'
            ? [
                {
                  spgid: 's1',
                  amphoeid: '3003',
                  amphoename: 'โนนสูง',
                },
              ]
            : [],
      });
      const out = await svc(dataSource).annotate([
        mk('supplement', 's1', 3003),
      ]);
      expect(out.labels.get('s1')).toEqual({
        amphoeId: 3003,
        amphoeName: 'โนนสูง',
      });
      expect(out.missingDimensions).toEqual([]);
      expect(out.advisories).toEqual([]);
      // The SPG query should have fired exactly once with the single id.
      const spgCalls = calls.filter((c) => c.alias === 'spg');
      expect(spgCalls).toHaveLength(1);
      expect(spgCalls[0].ids).toEqual(['s1']);
    });

    it('SPG row with NULL amphoeId → NOT enriched, emits per-run advisory', async () => {
      const { dataSource, calls } = makeDataSource({ rows: () => [] });
      const out = await svc(dataSource).annotate([
        mk('supplement', 's1', null),
      ]);
      // The NULL row must not trigger an SPG query.
      const spgCalls = calls.filter((c) => c.alias === 'spg');
      expect(spgCalls).toHaveLength(0);
      expect(out.labels.has('s1')).toBe(false);
      expect(out.missingDimensions).toEqual(['geo:supplement']);
      expect(out.advisories).toEqual([SUPPLEMENT_GEO_ADVISORY]);
    });

    it('N SPG rows with NULL amphoeId → advisory emitted EXACTLY ONCE', async () => {
      const { dataSource } = makeDataSource({ rows: () => [] });
      const out = await svc(dataSource).annotate([
        mk('supplement', 's1', null),
        mk('supplement', 's2', null),
        mk('supplement', 's3', null),
      ]);
      expect(out.missingDimensions).toEqual(['geo:supplement']);
      expect(out.advisories).toHaveLength(1);
      expect(out.advisories[0]).toBe(SUPPLEMENT_GEO_ADVISORY);
    });

    it('mixed SPG: populated + NULL → populated enriched, NULL triggers advisory', async () => {
      const { dataSource, calls } = makeDataSource({
        rows: (c) =>
          c.alias === 'spg'
            ? [{ spgid: 's1', amphoeid: '3003', amphoename: 'โนนสูง' }]
            : [],
      });
      const out = await svc(dataSource).annotate([
        mk('supplement', 's1', 3003),
        mk('supplement', 's2', null),
      ]);
      // The SPG query should only carry the populated id.
      const spgCalls = calls.filter((c) => c.alias === 'spg');
      expect(spgCalls).toHaveLength(1);
      expect(spgCalls[0].ids).toEqual(['s1']);
      expect(out.labels.get('s1')).toEqual({
        amphoeId: 3003,
        amphoeName: 'โนนสูง',
      });
      expect(out.labels.has('s2')).toBe(false);
      expect(out.missingDimensions).toEqual(['geo:supplement']);
      expect(out.advisories).toEqual([SUPPLEMENT_GEO_ADVISORY]);
    });

    it('advisory matches the exact Thai string constant (byte-equality)', async () => {
      const { dataSource } = makeDataSource({ rows: () => [] });
      const out = await svc(dataSource).annotate([
        mk('supplement', 's1', null),
      ]);
      expect(out.advisories[0]).toBe(SUPPLEMENT_GEO_ADVISORY);
      // Explicit Thai string assertion guarantees the advisory copy
      // matches design §5.3 / task §7 verbatim.
      expect(out.advisories[0]).toBe(
        'ข้อมูลพื้นที่ของเล่มเพิ่มเติมยังไม่พร้อมใช้งาน (ไม่มีคอลัมน์ amphoe_id)',
      );
    });

    it('all SPG populated → NO advisory (historical batch-wide exclusion is gone)', async () => {
      const { dataSource } = makeDataSource({
        rows: (c) =>
          c.alias === 'spg'
            ? [
                { spgid: 's1', amphoeid: '3001', amphoename: 'เมืองนครราชสีมา' },
                { spgid: 's2', amphoeid: '3002', amphoename: 'ครบุรี' },
              ]
            : [],
      });
      const out = await svc(dataSource).annotate([
        mk('supplement', 's1', 3001),
        mk('supplement', 's2', 3002),
      ]);
      expect(out.labels.size).toBe(2);
      expect(out.missingDimensions).toEqual([]);
      expect(out.advisories).toEqual([]);
    });

    it('SPG exclusion does NOT throw — service skips gracefully', async () => {
      const { dataSource } = makeDataSource({ rows: () => [] });
      await expect(
        svc(dataSource).annotate([mk('supplement', 's1', null)]),
      ).resolves.toBeDefined();
    });
  });

  // ── 4. Mixed batch (main + revised + supplement) ────────────
  describe('mixed batch', () => {
    it('labels main+revised+populated-SPG AND appends advisory for NULL SPG', async () => {
      const { dataSource } = makeDataSource({
        rows: (c) => {
          if (c.alias === 'pg')
            return [
              {
                pgid: 'p1',
                amphoeid: '3001',
                amphoename: 'เมืองนครราชสีมา',
              },
            ];
          if (c.alias === 'rpg')
            return [{ rpgid: 'r1', amphoeid: '3002', amphoename: 'ครบุรี' }];
          if (c.alias === 'spg')
            return [{ spgid: 's1', amphoeid: '3003', amphoename: 'โนนสูง' }];
          return [];
        },
      });
      const out = await svc(dataSource).annotate([
        mk('main', 'p1'),
        mk('revised', 'r1'),
        mk('supplement', 's1', 3003),
        mk('supplement', 's2', null),
      ]);
      expect(out.labels.size).toBe(3);
      expect(out.labels.get('p1')?.amphoeName).toBe('เมืองนครราชสีมา');
      expect(out.labels.get('r1')?.amphoeName).toBe('ครบุรี');
      expect(out.labels.get('s1')?.amphoeName).toBe('โนนสูง');
      expect(out.labels.has('s2')).toBe(false);
      expect(out.missingDimensions).toEqual(['geo:supplement']);
      expect(out.advisories).toEqual([SUPPLEMENT_GEO_ADVISORY]);
    });

    it('emits SPG advisory exactly once even with multiple NULL SPG rows', async () => {
      const { dataSource } = makeDataSource({ rows: () => [] });
      const out = await svc(dataSource).annotate([
        mk('supplement', 's1', null),
        mk('supplement', 's2', null),
        mk('supplement', 's3', null),
        mk('main', 'p1'),
      ]);
      expect(
        out.missingDimensions.filter((d) => d === 'geo:supplement'),
      ).toHaveLength(1);
      expect(out.advisories).toHaveLength(1);
    });
  });

  // ── 5. Null amphoe_id ──────────────────────────────────────
  describe('null amphoe_id handling', () => {
    it('row with null amphoe_id → { amphoeId: null, amphoeName: null }', async () => {
      const { dataSource } = makeDataSource({
        rows: (c) =>
          c.alias === 'pg'
            ? [{ pgid: 'p1', amphoeid: null, amphoename: null }]
            : [],
      });
      const out = await svc(dataSource).annotate([mk('main', 'p1')]);
      expect(out.labels.get('p1')).toEqual({
        amphoeId: null,
        amphoeName: null,
      });
    });

    it('non-numeric amphoe_id coerces to null (defensive)', async () => {
      const { dataSource } = makeDataSource({
        rows: (c) =>
          c.alias === 'pg'
            ? [
                {
                  pgid: 'p1',
                  amphoeid: 'not-a-number',
                  amphoename: 'ของปลอม',
                },
              ]
            : [],
      });
      const out = await svc(dataSource).annotate([mk('main', 'p1')]);
      expect(out.labels.get('p1')?.amphoeId).toBeNull();
    });
  });

  // ── 6. Empty / whitespace amphoe name ──────────────────────
  describe('empty / whitespace amphoe name', () => {
    it('empty string name → amphoeName: null', async () => {
      const { dataSource } = makeDataSource({
        rows: (c) =>
          c.alias === 'pg'
            ? [{ pgid: 'p1', amphoeid: '3001', amphoename: '' }]
            : [],
      });
      const out = await svc(dataSource).annotate([mk('main', 'p1')]);
      expect(out.labels.get('p1')?.amphoeName).toBeNull();
    });

    it('whitespace-only name → amphoeName: null', async () => {
      const { dataSource } = makeDataSource({
        rows: (c) =>
          c.alias === 'pg'
            ? [{ pgid: 'p1', amphoeid: '3001', amphoename: '   ' }]
            : [],
      });
      const out = await svc(dataSource).annotate([mk('main', 'p1')]);
      expect(out.labels.get('p1')?.amphoeName).toBeNull();
    });
  });

  // ── 7. Advisory constant exported ───────────────────────────
  describe('§17.9 — advisory constant exported as module-level const', () => {
    it('SUPPLEMENT_GEO_ADVISORY is a string constant', () => {
      expect(typeof SUPPLEMENT_GEO_ADVISORY).toBe('string');
      expect(SUPPLEMENT_GEO_ADVISORY.length).toBeGreaterThan(0);
    });

    it('source file declares SUPPLEMENT_GEO_ADVISORY as `export const`', () => {
      const src = readFileSync(
        join(
          __dirname,
          '..',
          'services',
          'geo-enrichment.service.ts',
        ),
        'utf8',
      );
      expect(src).toMatch(/export\s+const\s+SUPPLEMENT_GEO_ADVISORY\s*=/);
    });
  });

  // ── 8. Grep gate — no raw table literals ───────────────────
  describe('grep gate — no raw table literals in service source', () => {
    const SERVICE_PATH = join(
      __dirname,
      '..',
      'services',
      'geo-enrichment.service.ts',
    );
    const src = readFileSync(SERVICE_PATH, 'utf8');

    it('does not contain `FROM amphoes` literal', () => {
      expect(/\bFROM\s+amphoes\b/i.test(src)).toBe(false);
    });

    it('does not contain `"amphoes"` double-quoted literal', () => {
      expect(/"amphoes"/i.test(src)).toBe(false);
    });

    it("does not contain `'amphoes'` single-quoted literal", () => {
      expect(/'amphoes'/i.test(src)).toBe(false);
    });

    it('does not contain `"project_groups"` or `"revised_project_groups"` or `"supplement_project_groups"` literals', () => {
      expect(/"project_groups"/i.test(src)).toBe(false);
      expect(/"revised_project_groups"/i.test(src)).toBe(false);
      expect(/"supplement_project_groups"/i.test(src)).toBe(false);
    });

    it('uses entity-metadata resolution — imports Amphoe + leftJoin(Amphoe, ...)', () => {
      expect(src).toMatch(
        /from\s*['"]src\/amphoes\/entities\/amphoe\.entity['"]/,
      );
      expect(src).toMatch(/leftJoin\(\s*Amphoe\s*,/);
      expect(src).toMatch(/getRepository\(\s*ProjectGroup\s*\)/);
      expect(src).toMatch(/getRepository\(\s*RevisedProjectGroup\s*\)/);
      expect(src).toMatch(/getRepository\(\s*SupplementProjectGroup\s*\)/);
    });
  });

  // ── 9. No write-method calls, no tracking_status ───────────
  describe('§12 audit separation + §17.2 advisory-only', () => {
    const SERVICE_PATH = join(
      __dirname,
      '..',
      'services',
      'geo-enrichment.service.ts',
    );
    const src = readFileSync(SERVICE_PATH, 'utf8');

    it('contains NO write-method calls', () => {
      expect(/\.save\(/.test(src)).toBe(false);
      expect(/\.update\(/.test(src)).toBe(false);
      expect(/\.delete\(/.test(src)).toBe(false);
      expect(/\.softRemove\(/.test(src)).toBe(false);
      expect(/\.softDelete\(/.test(src)).toBe(false);
      expect(/\.remove\(/.test(src)).toBe(false);
      expect(/\.insert\(/.test(src)).toBe(false);
      expect(/\.upsert\(/.test(src)).toBe(false);
    });

    it('no tracking_status writes (§12 audit separation)', () => {
      const stripped = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      expect(/tracking_status/i.test(stripped)).toBe(false);
      expect(/TrackingStatus/.test(stripped)).toBe(false);
    });
  });
});
