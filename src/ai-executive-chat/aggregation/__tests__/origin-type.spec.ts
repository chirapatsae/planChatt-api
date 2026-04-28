/**
 * Wave 55 W55-BE-07 — `originType` derivation + filter + grouping spec.
 *
 * CLAUDE.md references:
 *   - §1  user classification rule — agency iff
 *         workHistory.amphoe.id = 3001 AND LAO.id = 3001027,
 *         lao otherwise.
 *   - §5  project-origin classification — derived from the CREATOR's
 *         WorkHistory at creation time and immutable post-creation.
 *   - §4  ownership = WorkHistory.id (never userId). The JOIN chain
 *         reads only ID scalars, no PII.
 *   - §17 PII discipline — `originType` is derived from two ID
 *         scalars; no person-level columns are projected.
 *
 * Assertions covered:
 *   1. Agency-origin project (amphoe=3001, LAO=3001027) emits
 *      `originType: 'agency-normal'`.
 *   2. LAO-origin project (any other amphoe/LAO) emits
 *      `originType: 'lao-coordinated'`.
 *   3. Missing creator chain (NULL IDs) falls back to
 *      `'lao-coordinated'` — the safe non-agency default.
 *   4. Determinism — same raw input → same originType across repeated
 *      invocations (matches the §5 immutability contract).
 *   5. Filter predicate routing — `originType: ['agency-normal']`
 *      attaches the agency sentinel predicate; `['lao-coordinated']`
 *      attaches the negated/NULL-tolerant predicate; both-value
 *      arrays no-op (union = unfiltered).
 */
import { UnifiedProjectAggregator } from '../services/unified-project-aggregator.service';

// ─────────────────────────────────────────────────────────────────────
// Test harness — compact QB stub mirroring unified-project-aggregator
// .spec.ts. The stub captures `andWhere` predicates + bind params so
// the filter cases can assert predicate text + parameter values without
// hitting a live DB.
// ─────────────────────────────────────────────────────────────────────

type RawRow = {
  id: string;
  title: string | null;
  planid: string | null;
  reportformat: string | null;
  amphoeid: number | null;
  agencyid: number | null;
  strategyid: string | null;
  tacticid: string | null;
  planlevelid: string | null;
  indicator: string | null;
  issueid: string | null;
  creator_amphoe_id: string | null;
  creator_lao_id: string | null;
};

interface StubCall {
  repositoryName: string;
  whereChain: string[];
  params: Record<string, unknown>;
}

function makeDataSource(rowsByRepo: Record<string, RawRow[]> = {}) {
  const calls: StubCall[] = [];

  function qbFactory(repositoryName: string) {
    const call: StubCall = {
      repositoryName,
      whereChain: [],
      params: {},
    };
    const qb: Record<string, unknown> = {};
    const self = () => qb;
    Object.assign(qb, {
      innerJoin: self,
      leftJoin: self,
      select: self,
      addSelect: self,
      where: (clause: string, params?: Record<string, unknown>) => {
        call.whereChain.push(clause);
        if (params) Object.assign(call.params, params);
        return qb;
      },
      andWhere: (clause: string, params?: Record<string, unknown>) => {
        call.whereChain.push(clause);
        if (params) Object.assign(call.params, params);
        return qb;
      },
      orderBy: self,
      limit: self,
      getRawMany: async () => {
        calls.push(call);
        return rowsByRepo[repositoryName] ?? [];
      },
    });
    return qb;
  }

  const dataSource = {
    getRepository: (target: unknown) => {
      const repoName =
        typeof target === 'function'
          ? (target as { name?: string }).name ?? 'Unknown'
          : 'Unknown';
      return {
        createQueryBuilder: (_alias: string) => qbFactory(repoName),
      };
    },
    getMetadata: () => ({ tableName: 'budget' }),
  };
  return { dataSource, calls };
}

function svc(ds: unknown): UnifiedProjectAggregator {
  return new UnifiedProjectAggregator(ds as never);
}

function baseRow(id: string, overrides: Partial<RawRow> = {}): RawRow {
  return {
    id,
    title: `proj-${id}`,
    planid: 'plan-1',
    reportformat: 'STRATEGY_BASED',
    amphoeid: null,
    agencyid: null,
    strategyid: null,
    tacticid: null,
    planlevelid: null,
    indicator: null,
    issueid: null,
    creator_amphoe_id: null,
    creator_lao_id: null,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────

describe('W55-BE-07 / originType dimension', () => {
  describe('derivation from creator WorkHistory (§1 + §5)', () => {
    it('returns agency-normal when creator amphoe=3001 AND LAO=3001027', async () => {
      const { dataSource } = makeDataSource({
        ProjectGroup: [
          baseRow('pg-agency', {
            creator_amphoe_id: '3001',
            creator_lao_id: '3001027',
          }),
        ],
      });
      const out = await svc(dataSource).listUnifiedProjects({
        scope: ['main'],
      });
      expect(out).toHaveLength(1);
      expect(out[0].originType).toBe('agency-normal');
    });

    it('returns lao-coordinated when creator amphoe differs from 3001', async () => {
      const { dataSource } = makeDataSource({
        ProjectGroup: [
          baseRow('pg-lao-wrong-amphoe', {
            creator_amphoe_id: '3009',
            creator_lao_id: '3001027',
          }),
        ],
      });
      const out = await svc(dataSource).listUnifiedProjects({
        scope: ['main'],
      });
      expect(out[0].originType).toBe('lao-coordinated');
    });

    it('returns lao-coordinated when creator LAO differs from 3001027', async () => {
      const { dataSource } = makeDataSource({
        ProjectGroup: [
          baseRow('pg-lao-wrong-lao', {
            creator_amphoe_id: '3001',
            creator_lao_id: '3001015',
          }),
        ],
      });
      const out = await svc(dataSource).listUnifiedProjects({
        scope: ['main'],
      });
      expect(out[0].originType).toBe('lao-coordinated');
    });

    it('falls back to lao-coordinated when creator chain is NULL', async () => {
      const { dataSource } = makeDataSource({
        ProjectGroup: [
          baseRow('pg-no-creator', {
            creator_amphoe_id: null,
            creator_lao_id: null,
          }),
        ],
      });
      const out = await svc(dataSource).listUnifiedProjects({
        scope: ['main'],
      });
      expect(out[0].originType).toBe('lao-coordinated');
    });

    it('derives originType consistently for revised rows', async () => {
      const { dataSource } = makeDataSource({
        RevisedProjectGroup: [
          baseRow('rpg-agency', {
            creator_amphoe_id: '3001',
            creator_lao_id: '3001027',
          }),
        ],
      });
      const out = await svc(dataSource).listUnifiedProjects({
        scope: ['revised'],
      });
      expect(out[0].originType).toBe('agency-normal');
    });

    it('derives originType consistently for supplement rows', async () => {
      const { dataSource } = makeDataSource({
        SupplementProjectGroup: [
          baseRow('spg-lao', {
            creator_amphoe_id: '3009',
            creator_lao_id: '3001099',
          }),
        ],
      });
      const out = await svc(dataSource).listUnifiedProjects({
        scope: ['supplement'],
      });
      expect(out[0].originType).toBe('lao-coordinated');
    });
  });

  describe('immutability / determinism (§5)', () => {
    it('produces identical originType on repeated invocations', async () => {
      const makeFixtureDataSource = () =>
        makeDataSource({
          ProjectGroup: [
            baseRow('pg-agency', {
              creator_amphoe_id: '3001',
              creator_lao_id: '3001027',
            }),
            baseRow('pg-lao', {
              creator_amphoe_id: '3009',
              creator_lao_id: '3001015',
            }),
          ],
        });
      const first = await svc(makeFixtureDataSource().dataSource)
        .listUnifiedProjects({ scope: ['main'] });
      const second = await svc(makeFixtureDataSource().dataSource)
        .listUnifiedProjects({ scope: ['main'] });
      expect(first.map((r) => [r.projectId, r.originType])).toEqual(
        second.map((r) => [r.projectId, r.originType]),
      );
      // Explicitly confirm the mapped pair.
      expect(first.find((r) => r.projectId === 'pg-agency')?.originType).toBe(
        'agency-normal',
      );
      expect(first.find((r) => r.projectId === 'pg-lao')?.originType).toBe(
        'lao-coordinated',
      );
    });
  });

  describe('filter routing (applyFilters)', () => {
    it('attaches the agency sentinel predicate for [agency-normal]', async () => {
      const { dataSource, calls } = makeDataSource({
        ProjectGroup: [],
      });
      await svc(dataSource).listUnifiedProjects({
        scope: ['main'],
        filters: { originType: ['agency-normal'] },
      });
      const mainCall = calls.find((c) => c.repositoryName === 'ProjectGroup');
      expect(mainCall).toBeDefined();
      const hit = mainCall!.whereChain.some(
        (w) =>
          /wh_amp\.id = :originAgencyAmphoeId/.test(w) &&
          /wh_lao\.id = :originAgencyLaoId/.test(w),
      );
      expect(hit).toBe(true);
      expect(mainCall!.params.originAgencyAmphoeId).toBe('3001');
      expect(mainCall!.params.originAgencyLaoId).toBe('3001027');
    });

    it('attaches the negated NULL-tolerant predicate for [lao-coordinated]', async () => {
      const { dataSource, calls } = makeDataSource({
        ProjectGroup: [],
      });
      await svc(dataSource).listUnifiedProjects({
        scope: ['main'],
        filters: { originType: ['lao-coordinated'] },
      });
      const mainCall = calls.find((c) => c.repositoryName === 'ProjectGroup');
      expect(mainCall).toBeDefined();
      const hit = mainCall!.whereChain.some(
        (w) =>
          /wh_amp\.id IS NULL/.test(w) &&
          /wh_lao\.id IS NULL/.test(w) &&
          /wh_amp\.id <> :originAgencyAmphoeId/.test(w) &&
          /wh_lao\.id <> :originAgencyLaoId/.test(w),
      );
      expect(hit).toBe(true);
    });

    it('is a no-op when both origins are requested', async () => {
      const { dataSource, calls } = makeDataSource({
        ProjectGroup: [],
      });
      await svc(dataSource).listUnifiedProjects({
        scope: ['main'],
        filters: { originType: ['agency-normal', 'lao-coordinated'] },
      });
      const mainCall = calls.find((c) => c.repositoryName === 'ProjectGroup');
      expect(mainCall).toBeDefined();
      expect(
        mainCall!.whereChain.some((w) =>
          /originAgencyAmphoeId/.test(w),
        ),
      ).toBe(false);
    });

    it('maps all-unknown values to no-match', async () => {
      const { dataSource, calls } = makeDataSource({
        ProjectGroup: [],
      });
      await svc(dataSource).listUnifiedProjects({
        scope: ['main'],
        // Cast via `as never` — the DTO forbids these values but the
        // service MUST still handle the malformed case defensively.
        filters: { originType: ['garbage' as never] },
      });
      const mainCall = calls.find((c) => c.repositoryName === 'ProjectGroup');
      expect(mainCall).toBeDefined();
      expect(mainCall!.whereChain.some((w) => /1 = 0/.test(w))).toBe(true);
    });

    it('in-memory grouping on originType returns per-bucket counts', async () => {
      // Simulate a groupBy consumer: run the aggregator unfiltered, then
      // bucket in memory (mirrors the handler-layer loop). The raw
      // filter mechanics are exercised above; this case confirms the
      // per-row originType drives correct counts.
      const { dataSource } = makeDataSource({
        ProjectGroup: [
          baseRow('pg-1', {
            creator_amphoe_id: '3001',
            creator_lao_id: '3001027',
          }),
          baseRow('pg-2', {
            creator_amphoe_id: '3001',
            creator_lao_id: '3001027',
          }),
          baseRow('pg-3', {
            creator_amphoe_id: '3009',
            creator_lao_id: '3001015',
          }),
        ],
      });
      const rows = await svc(dataSource).listUnifiedProjects({
        scope: ['main'],
      });
      const counts = new Map<string, number>();
      for (const r of rows) {
        counts.set(r.originType, (counts.get(r.originType) ?? 0) + 1);
      }
      expect(counts.get('agency-normal')).toBe(2);
      expect(counts.get('lao-coordinated')).toBe(1);
    });
  });
});
