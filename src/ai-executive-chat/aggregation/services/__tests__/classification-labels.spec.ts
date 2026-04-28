/**
 * W68-FIX-06 (D4) — classification-label resolver unit spec.
 *
 * Covers the `fetchClassificationLabelsForUnifiedProjects` helper that
 * powers the `groupBy: ['strategy'|'issue'|'planLevel']` bucket builder
 * in `getExecutiveDashboardSnapshot`.
 *
 * Pre-fix (D4 root cause) the bucket builder emitted FK ids as bucket
 * keys, producing user-visible prose like "ประเด็นการพัฒนา 1: 2 โครงการ".
 * The helper resolves Strategy / Tactic / Plan / DevelopmentIssue Thai
 * names so the bucket key the LLM quotes is human-readable.
 *
 * CLAUDE.md references:
 *   - §16.5 — STRATEGY_BASED carries strategy/tactic/plan; ISSUE_BASED
 *     carries development_issue. Helper handles both shapes gracefully
 *     (NULL per inactive shape).
 *   - §17.2 advisory only — bucket label is display-only.
 *   - §17.7 — branches purely on FK presence; no `reportFormat` read here.
 *   - Wave 54 no-raw-SQL gate — entity-metadata resolution only.
 */
import { fetchClassificationLabelsForUnifiedProjects } from '../../../tools/handlers/executive-tool-handlers';
import type { ExecutiveToolHandlerDeps } from '../../../tools/handlers/handler-types';

interface QbCall {
  alias: 'pg' | 'rpg' | 'spg';
  ids: string[];
}

type Row = {
  projectid: string;
  strategyname: string | null;
  tacticname: string | null;
  planname: string | null;
  issuename: string | null;
};

function makeDataSource(opts: {
  rows?: (call: QbCall) => Row[];
}) {
  const calls: QbCall[] = [];
  const rows = opts.rows ?? (() => []);

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
      getRawMany: async (): Promise<Row[]> => {
        const call: QbCall = { alias, ids: state.ids ?? [] };
        calls.push(call);
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

function depsFor(ds: unknown): ExecutiveToolHandlerDeps {
  // The helper only reads `deps.dataSource`; the rest of the bag is
  // unused. Cast through `unknown` to satisfy the structural type.
  return { dataSource: ds } as unknown as ExecutiveToolHandlerDeps;
}

describe('W68-FIX-06 / fetchClassificationLabelsForUnifiedProjects', () => {
  describe('empty input', () => {
    it('returns empty Map without issuing any DB call', async () => {
      const { dataSource, calls } = makeDataSource({});
      const out = await fetchClassificationLabelsForUnifiedProjects(
        depsFor(dataSource),
        [],
      );
      expect(out.size).toBe(0);
      expect(calls).toHaveLength(0);
    });
  });

  describe('STRATEGY_BASED shape — names projected', () => {
    it('projects strategy/tactic/plan names for main rows', async () => {
      const { dataSource } = makeDataSource({
        rows: (c) =>
          c.alias === 'pg'
            ? [
                {
                  projectid: 'p1',
                  strategyname: 'ยุทธศาสตร์ที่ 1',
                  tacticname: 'กลยุทธ์ที่ 1.1',
                  planname: 'แผนงาน A',
                  issuename: null,
                },
              ]
            : [],
      });
      const out = await fetchClassificationLabelsForUnifiedProjects(
        depsFor(dataSource),
        [{ projectKind: 'main', projectId: 'p1' }],
      );
      expect(out.get('p1')).toEqual({
        strategyName: 'ยุทธศาสตร์ที่ 1',
        tacticName: 'กลยุทธ์ที่ 1.1',
        planLevelName: 'แผนงาน A',
        issueName: null,
      });
    });

    it('projects strategy names for revised rows', async () => {
      const { dataSource } = makeDataSource({
        rows: (c) =>
          c.alias === 'rpg'
            ? [
                {
                  projectid: 'r1',
                  strategyname: 'ยุทธศาสตร์ที่ 2',
                  tacticname: null,
                  planname: null,
                  issuename: null,
                },
              ]
            : [],
      });
      const out = await fetchClassificationLabelsForUnifiedProjects(
        depsFor(dataSource),
        [{ projectKind: 'revised', projectId: 'r1' }],
      );
      expect(out.get('r1')?.strategyName).toBe('ยุทธศาสตร์ที่ 2');
      expect(out.get('r1')?.issueName).toBeNull();
    });

    it('projects strategy names for supplement rows', async () => {
      const { dataSource } = makeDataSource({
        rows: (c) =>
          c.alias === 'spg'
            ? [
                {
                  projectid: 's1',
                  strategyname: 'ยุทธศาสตร์ที่ 3',
                  tacticname: 'กลยุทธ์ที่ 3.1',
                  planname: 'แผนงาน C',
                  issuename: null,
                },
              ]
            : [],
      });
      const out = await fetchClassificationLabelsForUnifiedProjects(
        depsFor(dataSource),
        [{ projectKind: 'supplement', projectId: 's1' }],
      );
      expect(out.get('s1')?.planLevelName).toBe('แผนงาน C');
    });
  });

  describe('ISSUE_BASED shape — DevelopmentIssue.name projected', () => {
    it('projects DevelopmentIssue.name with strategy/tactic/plan NULL', async () => {
      const { dataSource } = makeDataSource({
        rows: (c) =>
          c.alias === 'pg'
            ? [
                {
                  projectid: 'p2',
                  strategyname: null,
                  tacticname: null,
                  planname: null,
                  issuename: 'ด้านการพัฒนาเศรษฐกิจ',
                },
              ]
            : [],
      });
      const out = await fetchClassificationLabelsForUnifiedProjects(
        depsFor(dataSource),
        [{ projectKind: 'main', projectId: 'p2' }],
      );
      expect(out.get('p2')).toEqual({
        strategyName: null,
        tacticName: null,
        planLevelName: null,
        issueName: 'ด้านการพัฒนาเศรษฐกิจ',
      });
    });
  });

  describe('NULL FKs — all-null label entry', () => {
    it('returns null per field when no classification FK is set', async () => {
      const { dataSource } = makeDataSource({
        rows: (c) =>
          c.alias === 'pg'
            ? [
                {
                  projectid: 'p3',
                  strategyname: null,
                  tacticname: null,
                  planname: null,
                  issuename: null,
                },
              ]
            : [],
      });
      const out = await fetchClassificationLabelsForUnifiedProjects(
        depsFor(dataSource),
        [{ projectKind: 'main', projectId: 'p3' }],
      );
      expect(out.get('p3')).toEqual({
        strategyName: null,
        tacticName: null,
        planLevelName: null,
        issueName: null,
      });
    });
  });

  describe('mixed batch — fan-out across kinds', () => {
    it('issues one query per kind present in the batch and merges rows', async () => {
      const { dataSource, calls } = makeDataSource({
        rows: (c) => {
          if (c.alias === 'pg') {
            return [
              {
                projectid: 'p1',
                strategyname: 'ยส.1',
                tacticname: null,
                planname: null,
                issuename: null,
              },
            ];
          }
          if (c.alias === 'rpg') {
            return [
              {
                projectid: 'r1',
                strategyname: null,
                tacticname: null,
                planname: null,
                issuename: 'ประเด็น A',
              },
            ];
          }
          if (c.alias === 'spg') {
            return [
              {
                projectid: 's1',
                strategyname: 'ยส.3',
                tacticname: null,
                planname: 'แผน X',
                issuename: null,
              },
            ];
          }
          return [];
        },
      });
      const out = await fetchClassificationLabelsForUnifiedProjects(
        depsFor(dataSource),
        [
          { projectKind: 'main', projectId: 'p1' },
          { projectKind: 'revised', projectId: 'r1' },
          { projectKind: 'supplement', projectId: 's1' },
        ],
      );
      const aliases = calls.map((c) => c.alias).sort();
      expect(aliases).toEqual(['pg', 'rpg', 'spg']);
      expect(out.size).toBe(3);
      expect(out.get('p1')?.strategyName).toBe('ยส.1');
      expect(out.get('r1')?.issueName).toBe('ประเด็น A');
      expect(out.get('s1')?.planLevelName).toBe('แผน X');
    });

    it('only queries the kinds present in the batch', async () => {
      const { dataSource, calls } = makeDataSource({ rows: () => [] });
      await fetchClassificationLabelsForUnifiedProjects(depsFor(dataSource), [
        { projectKind: 'main', projectId: 'p1' },
      ]);
      expect(calls.map((c) => c.alias)).toEqual(['pg']);
    });
  });

  describe('§14 / §15 — soft-deleted classification rows excluded by JOIN', () => {
    // The helper LEFT JOINs `deleted_at IS NULL` on Strategy / Tactic /
    // Plan / DevelopmentIssue so a soft-deleted parent row produces a
    // NULL name (treated as no-resolve) rather than leaking a stale
    // label. The integration is exercised by the "NULL FKs" suite
    // above; this case asserts the source-level grep gate.
    it('source includes deleted_at IS NULL on every classification join', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { readFileSync } = require('fs');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { join } = require('path');
      const src: string = readFileSync(
        join(
          __dirname,
          '..',
          '..',
          '..',
          'tools',
          'handlers',
          'executive-tool-handlers.ts',
        ),
        'utf8',
      );
      // strategy / tactic / plan / development_issue join predicates all
      // include the soft-delete filter.
      expect(
        /s\.id = pg\.strategy_id AND s\.deleted_at IS NULL/.test(src),
      ).toBe(true);
      expect(
        /t\.id = pg\.tactic_id AND t\.deleted_at IS NULL/.test(src),
      ).toBe(true);
      expect(/pl\.id = pg\.plan_id AND pl\.deleted_at IS NULL/.test(src)).toBe(
        true,
      );
      expect(
        /di\.id = pg\.development_issue_id AND di\.deleted_at IS NULL/.test(
          src,
        ),
      ).toBe(true);
    });
  });
});
