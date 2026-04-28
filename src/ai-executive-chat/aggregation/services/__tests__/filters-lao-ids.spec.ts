/**
 * W67-LAO-RESOLVER — `applyFilters({ laoIds })` clause spec.
 *
 * Coverage:
 *   - Calls QB.andWhere with `${alias}.local_administrative_organization_id IN (...)`
 *     for each project kind (`main` → pg, `revised` → rpg, `supplement` → spg)
 *   - Bind param key is `laoIdsFilter` (matches the alias used in the predicate)
 *   - Trims whitespace + drops blank entries
 *   - All-blank input array maps to a no-match (`1 = 0`)
 *
 * §17.2 advisory only — no workflow gating. §17.3 read-only — pure
 * QueryBuilder shaping, no DB hit.
 */

import type { DataSource } from 'typeorm';
import { UnifiedProjectAggregator } from '../unified-project-aggregator.service';

interface CapturedAndWhere {
  clause: string;
  params: Record<string, unknown>;
}

function makeFakeQb() {
  const calls: CapturedAndWhere[] = [];
  const qb: Record<string, unknown> = {};
  qb.innerJoin = () => qb;
  qb.leftJoin = () => qb;
  qb.andWhere = (clause: string, params?: Record<string, unknown>) => {
    calls.push({ clause, params: params ?? {} });
    return qb;
  };
  qb.where = () => qb;
  return { qb, calls };
}

function makeService(): UnifiedProjectAggregator {
  // Construct with a placeholder DataSource — applyFilters does not
  // touch the DataSource on the laoIds path (only QB.andWhere is
  // exercised). The metadata-driven Budget table lookup runs only on
  // the budgetRange path, which is not exercised here.
  const ds = {} as DataSource;
  return new UnifiedProjectAggregator(ds);
}

type Kind = 'main' | 'revised' | 'supplement';
const ALIAS_BY_KIND: Record<Kind, string> = {
  main: 'pg',
  revised: 'rpg',
  supplement: 'spg',
};

describe('W67-LAO-RESOLVER / applyFilters({ laoIds })', () => {
  describe('emits IN-clause keyed on local_administrative_organization_id per project kind', () => {
    it.each<Kind>(['main', 'revised'])(
      'kind=%s emits %s.local_administrative_organization_id IN (...)',
      (kind) => {
        const svc = makeService();
        const { qb, calls } = makeFakeQb();
        const filters = { laoIds: ['3001027', '3007001'] };
        (svc as unknown as {
          applyFilters: (qb: unknown, filters: unknown, kind: Kind) => void;
        }).applyFilters(qb, filters, kind);

        const alias = ALIAS_BY_KIND[kind];
        const laoCall = calls.find((c) =>
          c.clause.includes(`${alias}.local_administrative_organization_id IN`),
        );
        expect(laoCall).toBeDefined();
        expect(laoCall!.clause).toBe(
          `${alias}.local_administrative_organization_id IN (:...laoIdsFilter)`,
        );
        expect(laoCall!.params).toEqual({
          laoIdsFilter: ['3001027', '3007001'],
        });
      },
    );

    // SPG has no `local_administrative_organization_id` column; the
    // filter MUST collapse to no-match (1 = 0) instead of emitting an
    // IN-clause (which would be a runtime "column does not exist"
    // error).
    it('kind=supplement → 1 = 0 (no IN-clause emitted)', () => {
      const svc = makeService();
      const { qb, calls } = makeFakeQb();
      const filters = { laoIds: ['3001027'] };
      (svc as unknown as {
        applyFilters: (qb: unknown, filters: unknown, kind: Kind) => void;
      }).applyFilters(qb, filters, 'supplement');

      const noMatch = calls.find((c) => c.clause === '1 = 0');
      expect(noMatch).toBeDefined();
      const laoCall = calls.find((c) =>
        c.clause.includes('local_administrative_organization_id IN'),
      );
      expect(laoCall).toBeUndefined();
    });
  });

  describe('value normalization', () => {
    it('trims whitespace + drops blank entries', () => {
      const svc = makeService();
      const { qb, calls } = makeFakeQb();
      const filters = {
        laoIds: ['  3001027 ', '', '3007001', '   '],
      };
      (svc as unknown as {
        applyFilters: (qb: unknown, filters: unknown, kind: Kind) => void;
      }).applyFilters(qb, filters, 'main');

      const laoCall = calls.find((c) =>
        c.clause.includes('local_administrative_organization_id IN'),
      );
      expect(laoCall).toBeDefined();
      expect(laoCall!.params.laoIdsFilter).toEqual(['3001027', '3007001']);
    });

    it('all-blank array → no-match (1 = 0)', () => {
      const svc = makeService();
      const { qb, calls } = makeFakeQb();
      const filters = { laoIds: ['', '   ', '\t'] };
      (svc as unknown as {
        applyFilters: (qb: unknown, filters: unknown, kind: Kind) => void;
      }).applyFilters(qb, filters, 'main');

      // The all-blank branch emits `1 = 0` and DOES NOT emit the IN-clause.
      const noMatch = calls.find((c) => c.clause === '1 = 0');
      expect(noMatch).toBeDefined();
      const laoCall = calls.find((c) =>
        c.clause.includes('local_administrative_organization_id IN'),
      );
      expect(laoCall).toBeUndefined();
    });

    it('omitted laoIds → no andWhere call for the LAO predicate', () => {
      const svc = makeService();
      const { qb, calls } = makeFakeQb();
      const filters = {};
      (svc as unknown as {
        applyFilters: (qb: unknown, filters: unknown, kind: Kind) => void;
      }).applyFilters(qb, filters, 'main');

      const laoCall = calls.find((c) =>
        c.clause.includes('local_administrative_organization_id IN'),
      );
      expect(laoCall).toBeUndefined();
    });
  });
});
