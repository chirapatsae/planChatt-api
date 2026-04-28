/**
 * Wave 57 W57-BE-AGG-03 — Project-own attribution lock-in spec.
 *
 * CLAUDE.md references:
 *   - §1 (User classification — does NOT define project amphoe)
 *   - §5.1 / §5.2 (Agency vs LAO project rules)
 *
 * Locks the contract that amphoe / อปท. / responsibleAgency rollups
 * read the PROJECT's own column, not the creator's WorkHistory.
 *
 * The full integration coverage lives in `getProjectLocationBreakdown`
 * tests (location-breakdown.spec.ts). This spec exercises the
 * UnifiedProjectAggregator projection to lock the per-row attribution
 * via `amphoeId` / `responsibleAgencyId` keys on the unified row.
 */
import { UnifiedProjectAggregator } from '../services/unified-project-aggregator.service';

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

function makeDataSource(rowsByRepo: Record<string, RawRow[]> = {}) {
  function qbFactory(repositoryName: string) {
    const qb: Record<string, unknown> = {};
    const self = () => qb;
    Object.assign(qb, {
      innerJoin: self,
      leftJoin: self,
      select: self,
      addSelect: self,
      where: self,
      andWhere: self,
      orderBy: self,
      limit: self,
      getRawMany: async () => rowsByRepo[repositoryName] ?? [],
    });
    return qb;
  }
  return {
    getRepository: (target: unknown) => {
      const n =
        typeof target === 'function'
          ? (target as { name?: string }).name ?? 'Unknown'
          : 'Unknown';
      return { createQueryBuilder: () => qbFactory(n) };
    },
    getMetadata: () => ({ tableName: 'budget' }),
  };
}

function svc(ds: unknown): UnifiedProjectAggregator {
  return new UnifiedProjectAggregator(ds as never);
}

function row(id: string, overrides: Partial<RawRow> = {}): RawRow {
  return {
    id,
    title: id,
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

describe('W57-BE-AGG-03 / project-own attribution', () => {
  it('project amphoeId wins over creator amphoe (case 1: PG)', async () => {
    // Project lives in amphoe 3007 (its own column); creator's WH is
    // amphoe 3001 (PAO/อบจ.). The unified row MUST surface 3007.
    const ds = makeDataSource({
      ProjectGroup: [
        row('pg-A', {
          amphoeid: 3007,
          creator_amphoe_id: '3001',
          creator_lao_id: '3001027',
        }),
      ],
    });
    const out = await svc(ds).listUnifiedProjects({ scope: ['main'] });
    expect(out).toHaveLength(1);
    expect(out[0].amphoeId).toBe(3007);
    // originType is correctly derived from the creator chain.
    expect(out[0].originType).toBe('agency-normal');
  });

  it('Agency-origin project from อบจ. with project.amphoe_id=3007 → bucket 3007 (locks legacy bug)', async () => {
    // The bug: legacy code that joined wh_amp (creator amphoe = 3001)
    // would bucket this project under 3001 instead of 3007. The new
    // contract surfaces 3007 (the project's own amphoe).
    const ds = makeDataSource({
      ProjectGroup: [
        row('pg-pao', {
          amphoeid: 3007,
          creator_amphoe_id: '3001', // อบจ. requester
          creator_lao_id: '3001027',
        }),
      ],
    });
    const out = await svc(ds).listUnifiedProjects({ scope: ['main'] });
    // In-memory bucket the same way an aggregator would.
    const buckets = new Map<string, number>();
    for (const p of out) {
      const key = p.amphoeId == null ? '__province_level__' : String(p.amphoeId);
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }
    expect(buckets.get('3007')).toBe(1);
    expect(buckets.get('3001')).toBeUndefined();
  });

  it('null project.amphoe_id → bucket sentinel __province_level__', async () => {
    const ds = makeDataSource({
      ProjectGroup: [row('pg-null', { amphoeid: null })],
    });
    const out = await svc(ds).listUnifiedProjects({ scope: ['main'] });
    expect(out[0].amphoeId).toBeNull();
  });

  it('responsibleAgencyId is sourced from the project column', async () => {
    const ds = makeDataSource({
      ProjectGroup: [row('pg-agy', { agencyid: 12345 })],
      RevisedProjectGroup: [row('rpg-agy', { agencyid: 67890 })],
    });
    const main = await svc(ds).listUnifiedProjects({ scope: ['main'] });
    const rev = await svc(ds).listUnifiedProjects({ scope: ['revised'] });
    expect(main[0].responsibleAgencyId).toBe(12345);
    expect(rev[0].responsibleAgencyId).toBe(67890);
  });

  it('null responsibleAgencyId is preserved (LAO-origin pre-assignment per §5.2)', async () => {
    const ds = makeDataSource({
      ProjectGroup: [row('pg-lao-pre', { agencyid: null })],
    });
    const out = await svc(ds).listUnifiedProjects({ scope: ['main'] });
    expect(out[0].responsibleAgencyId).toBeNull();
  });
});
