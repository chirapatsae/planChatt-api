/**
 * BE-W54-05 — AgencyEnrichment unit spec.
 *
 * Covers:
 *   1. Empty input → empty result, no DB call.
 *   2. Agency name projection for main / revised / supplement kinds.
 *   3. Null FK → fallback label `'ไม่ระบุ'`.
 *   4. Soft-deleted agency (join excluded) → fallback label `'ไม่ระบุ'`.
 *   5. NEVER emits `agency#<id>`-style surrogate labels.
 *   6. Fallback label exported as a module `const` (prompt-injection
 *      defense per §17.9).
 *   7. Mixed batch — all three kinds queried in parallel.
 *   8. Grep gate — no raw `government_agencies` / project-table literals.
 *   9. No write-method calls. No `tracking_status` references.
 *
 * CLAUDE.md §17 PII — GovernmentAgency is an organisation (public name
 * is safe). §17.2 / §17.11 — read-only; role check lives at Tier C.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import {
  AgencyEnrichmentService,
  UNRESOLVED_AGENCY_LABEL,
} from '../services/agency-enrichment.service';
import type { UnifiedProject } from '../types';

// ────────────────────────────────────────────────────────────────
// Mock DataSource. Alias tracks which project table was queried.
// ────────────────────────────────────────────────────────────────

interface QbCall {
  alias: 'pg' | 'rpg' | 'spg';
  ids: string[];
}

type AgencyRow = {
  pgid?: string | null;
  rpgid?: string | null;
  spgid?: string | null;
  agencyid: string | null;
  agencyname: string | null;
};

function makeDataSource(opts: {
  rows?: (call: QbCall) => AgencyRow[];
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
): UnifiedProject {
  return {
    projectKind,
    projectId,
    name: `proj-${projectId}`,
    planId: 'plan-1',
    planReportFormat: 'STRATEGY_BASED',
    // Wave 55 W55-BE-07 — required field; AgencyEnrichment does not
    // branch on it so the fixture uses the safe default.
    originType: 'lao-coordinated',
  };
}

function svc(ds: unknown): AgencyEnrichmentService {
  return new AgencyEnrichmentService(ds as never);
}

// ────────────────────────────────────────────────────────────────

describe('BE-W54-05 / AgencyEnrichment', () => {
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

  // ── 2. Agency name projection (all three kinds) ────────────
  describe('agency name projection', () => {
    it('projects Thai GovernmentAgency.name for main rows', async () => {
      const { dataSource } = makeDataSource({
        rows: (c) =>
          c.alias === 'pg'
            ? [
                {
                  pgid: 'p1',
                  agencyid: '7',
                  agencyname: 'สำนักงานโยธาธิการและผังเมือง',
                },
              ]
            : [],
      });
      const out = await svc(dataSource).annotate([mk('main', 'p1')]);
      expect(out.labels.get('p1')).toEqual({
        agencyId: 7,
        agencyName: 'สำนักงานโยธาธิการและผังเมือง',
      });
    });

    it('projects Thai name for revised rows', async () => {
      const { dataSource } = makeDataSource({
        rows: (c) =>
          c.alias === 'rpg'
            ? [
                {
                  rpgid: 'r1',
                  agencyid: '9',
                  agencyname: 'สำนักการศึกษา',
                },
              ]
            : [],
      });
      const out = await svc(dataSource).annotate([mk('revised', 'r1')]);
      expect(out.labels.get('r1')).toEqual({
        agencyId: 9,
        agencyName: 'สำนักการศึกษา',
      });
    });

    it('projects Thai name for supplement rows', async () => {
      const { dataSource } = makeDataSource({
        rows: (c) =>
          c.alias === 'spg'
            ? [
                {
                  spgid: 's1',
                  agencyid: '11',
                  agencyname: 'กองคลัง',
                },
              ]
            : [],
      });
      const out = await svc(dataSource).annotate([mk('supplement', 's1')]);
      expect(out.labels.get('s1')).toEqual({
        agencyId: 11,
        agencyName: 'กองคลัง',
      });
    });
  });

  // ── 3. Null FK fallback ─────────────────────────────────────
  describe('null fallback — `ไม่ระบุ`', () => {
    it('null agencyid + null agencyname → `ไม่ระบุ`', async () => {
      const { dataSource } = makeDataSource({
        rows: (c) =>
          c.alias === 'pg'
            ? [{ pgid: 'p1', agencyid: null, agencyname: null }]
            : [],
      });
      const out = await svc(dataSource).annotate([mk('main', 'p1')]);
      expect(out.labels.get('p1')).toEqual({
        agencyId: null,
        agencyName: 'ไม่ระบุ',
      });
    });

    it('matches the exported UNRESOLVED_AGENCY_LABEL constant', async () => {
      const { dataSource } = makeDataSource({
        rows: (c) =>
          c.alias === 'pg'
            ? [{ pgid: 'p1', agencyid: null, agencyname: null }]
            : [],
      });
      const out = await svc(dataSource).annotate([mk('main', 'p1')]);
      expect(out.labels.get('p1')?.agencyName).toBe(UNRESOLVED_AGENCY_LABEL);
      expect(UNRESOLVED_AGENCY_LABEL).toBe('ไม่ระบุ');
    });
  });

  // ── 4. Soft-deleted agency ──────────────────────────────────
  describe('soft-deleted agency — join excluded', () => {
    it('FK present but agencyname NULL (soft-deleted) → fallback', async () => {
      const { dataSource } = makeDataSource({
        rows: (c) =>
          c.alias === 'pg'
            ? [{ pgid: 'p1', agencyid: '42', agencyname: null }]
            : [],
      });
      const out = await svc(dataSource).annotate([mk('main', 'p1')]);
      expect(out.labels.get('p1')).toEqual({
        agencyId: 42,
        agencyName: 'ไม่ระบุ',
      });
    });

    it('empty-string agencyname is treated as unresolved', async () => {
      const { dataSource } = makeDataSource({
        rows: (c) =>
          c.alias === 'pg'
            ? [{ pgid: 'p1', agencyid: '42', agencyname: '' }]
            : [],
      });
      const out = await svc(dataSource).annotate([mk('main', 'p1')]);
      expect(out.labels.get('p1')?.agencyName).toBe('ไม่ระบุ');
    });

    it('whitespace-only agencyname is treated as unresolved', async () => {
      const { dataSource } = makeDataSource({
        rows: (c) =>
          c.alias === 'pg'
            ? [{ pgid: 'p1', agencyid: '42', agencyname: '   ' }]
            : [],
      });
      const out = await svc(dataSource).annotate([mk('main', 'p1')]);
      expect(out.labels.get('p1')?.agencyName).toBe('ไม่ระบุ');
    });

    it('service join predicate excludes soft-deleted agencies', () => {
      const src = readFileSync(
        join(
          __dirname,
          '..',
          'services',
          'agency-enrichment.service.ts',
        ),
        'utf8',
      );
      expect(src).toMatch(/ga\.deleted_at IS NULL/);
    });
  });

  // ── 5. NEVER emits `agency#<id>` label ──────────────────────
  describe('§17 PII discipline + label integrity', () => {
    it('never formats the numeric id as an `agency#<id>` label at runtime', () => {
      const src = readFileSync(
        join(
          __dirname,
          '..',
          'services',
          'agency-enrichment.service.ts',
        ),
        'utf8',
      );
      // Strip comments — block doc-comments intentionally reference the
      // banned `agency#<id>` surrogate to document what is forbidden.
      const stripped = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      // Only code-level `agency#` appearances are banned.
      expect(/agency#/i.test(stripped)).toBe(false);
      // Explicit template-literal usage is also banned.
      expect(/`agency#\$\{/.test(stripped)).toBe(false);
      expect(/["']agency#/.test(stripped)).toBe(false);
    });

    it('agencyName is never a pure number string under any code path', async () => {
      // Feed a numeric-looking agencyname; service must still project
      // it as-is (not reformat), but the integrity assertion is that
      // numeric-id masquerading as a label must NOT originate from the
      // service logic. The real defense is the code-level grep above;
      // this runtime check ensures we don't substitute the id when the
      // name is NULL.
      const { dataSource } = makeDataSource({
        rows: (c) =>
          c.alias === 'pg'
            ? [{ pgid: 'p1', agencyid: '42', agencyname: null }]
            : [],
      });
      const out = await svc(dataSource).annotate([mk('main', 'p1')]);
      expect(out.labels.get('p1')?.agencyName).not.toBe('42');
      expect(out.labels.get('p1')?.agencyName).not.toMatch(/agency#?42/i);
    });

    it('does not project any person-level PII fields at runtime', () => {
      const src = readFileSync(
        join(
          __dirname,
          '..',
          'services',
          'agency-enrichment.service.ts',
        ),
        'utf8',
      );
      // Strip comments — the file's doc comment lists the banned PII
      // fields by name in a negative policy context.
      const stripped = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      expect(/firstName|lastName|citizenId|phone|email/i.test(stripped)).toBe(
        false,
      );
      expect(/createdBy/i.test(stripped)).toBe(false);
    });
  });

  // ── 6. Constant exported ────────────────────────────────────
  describe('§17.9 — fallback label exported as module-level const', () => {
    it('UNRESOLVED_AGENCY_LABEL is a string constant', () => {
      expect(typeof UNRESOLVED_AGENCY_LABEL).toBe('string');
      expect(UNRESOLVED_AGENCY_LABEL.length).toBeGreaterThan(0);
    });

    it('source file declares UNRESOLVED_AGENCY_LABEL as `export const`', () => {
      const src = readFileSync(
        join(
          __dirname,
          '..',
          'services',
          'agency-enrichment.service.ts',
        ),
        'utf8',
      );
      expect(src).toMatch(/export\s+const\s+UNRESOLVED_AGENCY_LABEL\s*=/);
    });
  });

  // ── 7. Mixed batch — parallel fan-out ───────────────────────
  describe('mixed batch', () => {
    it('issues three parallel queries when all kinds present', async () => {
      const { dataSource, calls } = makeDataSource({ rows: () => [] });
      await svc(dataSource).annotate([
        mk('main', 'p1'),
        mk('revised', 'r1'),
        mk('supplement', 's1'),
      ]);
      const aliases = calls.map((c) => c.alias).sort();
      expect(aliases).toEqual(['pg', 'rpg', 'spg']);
    });

    it('merges rows from all three kinds into a single Map', async () => {
      const { dataSource } = makeDataSource({
        rows: (c) => {
          if (c.alias === 'pg')
            return [{ pgid: 'p1', agencyid: '1', agencyname: 'หน่วย-ก' }];
          if (c.alias === 'rpg')
            return [{ rpgid: 'r1', agencyid: '2', agencyname: 'หน่วย-ข' }];
          if (c.alias === 'spg')
            return [{ spgid: 's1', agencyid: '3', agencyname: 'หน่วย-ค' }];
          return [];
        },
      });
      const out = await svc(dataSource).annotate([
        mk('main', 'p1'),
        mk('revised', 'r1'),
        mk('supplement', 's1'),
      ]);
      expect(out.labels.size).toBe(3);
      expect(out.labels.get('p1')?.agencyName).toBe('หน่วย-ก');
      expect(out.labels.get('r1')?.agencyName).toBe('หน่วย-ข');
      expect(out.labels.get('s1')?.agencyName).toBe('หน่วย-ค');
    });

    it('only queries the kinds present in the batch', async () => {
      const { dataSource, calls } = makeDataSource({ rows: () => [] });
      await svc(dataSource).annotate([mk('main', 'p1')]);
      expect(calls.map((c) => c.alias)).toEqual(['pg']);
    });
  });

  // ── 8. Grep gate — no raw table literals ───────────────────
  describe('grep gate — no raw table literals in service source', () => {
    const SERVICE_PATH = join(
      __dirname,
      '..',
      'services',
      'agency-enrichment.service.ts',
    );
    const src = readFileSync(SERVICE_PATH, 'utf8');

    it('does not contain `FROM government_agencies` literal', () => {
      expect(/\bFROM\s+government_agencies\b/i.test(src)).toBe(false);
    });

    it('does not contain quoted `government_agencies` table literals', () => {
      expect(/"government_agencies"/i.test(src)).toBe(false);
      expect(/'government_agencies'/i.test(src)).toBe(false);
      expect(/`government_agencies`/i.test(src)).toBe(false);
    });

    it('does not contain quoted project-table literals', () => {
      expect(/"project_groups"/i.test(src)).toBe(false);
      expect(/"revised_project_groups"/i.test(src)).toBe(false);
      expect(/"supplement_project_groups"/i.test(src)).toBe(false);
    });

    it('uses entity-metadata resolution (GovernmentAgency class + getRepository)', () => {
      expect(src).toMatch(
        /from\s*['"]src\/government-agencies\/entities\/government-agency\.entity['"]/,
      );
      expect(src).toMatch(/leftJoin\(\s*\n?\s*GovernmentAgency\s*,/);
      expect(src).toMatch(/getRepository\(\s*ProjectGroup\s*\)/);
      expect(src).toMatch(/getRepository\(\s*RevisedProjectGroup\s*\)/);
      expect(src).toMatch(/getRepository\(\s*SupplementProjectGroup\s*\)/);
    });
  });

  // ── 9. No writes, no tracking_status ───────────────────────
  describe('§12 audit separation + §17.2 advisory-only', () => {
    const SERVICE_PATH = join(
      __dirname,
      '..',
      'services',
      'agency-enrichment.service.ts',
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
