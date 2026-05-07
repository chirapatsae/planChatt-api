/**
 * W67-PAO-EXEC-STAGE — `applyFilters({ hasResponsibleAgency, isBooked })`
 * clause spec.
 *
 * Coverage:
 *   - `hasResponsibleAgency` on PG / RPG → emits IS NOT NULL or IS NULL
 *     against `${alias}.responsible_agency_id` per boolean.
 *   - `hasResponsibleAgency` on SPG → entity-constraint short-circuit
 *     (`true` no-clause; `false` → `1 = 0`).
 *   - `isBooked` on PG / RPG → emits `${alias}.isBooked = :bind` with
 *     bind value tracking the boolean.
 *   - `isBooked` on SPG → no-column short-circuit (`true` no-clause;
 *     `false` → `1 = 0`).
 *   - Combined `hasResponsibleAgency=true + isBooked=true` on PG / RPG
 *     emits both clauses (AND-composition).
 *   - Filter omitted (undefined) → no clause emitted.
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
  // touch the DataSource on the exec-stage path (only QB.andWhere is
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

type ApplyFiltersFn = (qb: unknown, filters: unknown, kind: Kind) => void;

function callApplyFilters(
  svc: UnifiedProjectAggregator,
  qb: unknown,
  filters: unknown,
  kind: Kind,
): void {
  (svc as unknown as { applyFilters: ApplyFiltersFn }).applyFilters(
    qb,
    filters,
    kind,
  );
}

describe('W67-PAO-EXEC-STAGE / applyFilters({ hasResponsibleAgency, isBooked })', () => {
  describe('filters.hasResponsibleAgency', () => {
    it.each<Kind>(['main', 'revised'])(
      'kind=%s + hasResponsibleAgency=true → emits IS NOT NULL on responsible_agency_id',
      (kind) => {
        const svc = makeService();
        const { qb, calls } = makeFakeQb();
        callApplyFilters(svc, qb, { hasResponsibleAgency: true }, kind);

        const alias = ALIAS_BY_KIND[kind];
        const match = calls.find(
          (c) => c.clause === `${alias}.responsible_agency_id IS NOT NULL`,
        );
        expect(match).toBeDefined();
      },
    );

    it.each<Kind>(['main', 'revised'])(
      'kind=%s + hasResponsibleAgency=false → emits IS NULL on responsible_agency_id',
      (kind) => {
        const svc = makeService();
        const { qb, calls } = makeFakeQb();
        callApplyFilters(svc, qb, { hasResponsibleAgency: false }, kind);

        const alias = ALIAS_BY_KIND[kind];
        const match = calls.find(
          (c) => c.clause === `${alias}.responsible_agency_id IS NULL`,
        );
        expect(match).toBeDefined();
      },
    );

    it('kind=supplement + hasResponsibleAgency=true → no clause emitted (entity NOT NULL constraint)', () => {
      const svc = makeService();
      const { qb, calls } = makeFakeQb();
      callApplyFilters(svc, qb, { hasResponsibleAgency: true }, 'supplement');

      // No clause referencing responsible_agency_id; no `1 = 0` either.
      const agencyClause = calls.find((c) =>
        c.clause.includes('responsible_agency_id'),
      );
      expect(agencyClause).toBeUndefined();
      const noMatch = calls.find((c) => c.clause === '1 = 0');
      expect(noMatch).toBeUndefined();
    });

    it('kind=supplement + hasResponsibleAgency=false → 1 = 0 (SPG always has responsibleAgency)', () => {
      const svc = makeService();
      const { qb, calls } = makeFakeQb();
      callApplyFilters(svc, qb, { hasResponsibleAgency: false }, 'supplement');

      const noMatch = calls.find((c) => c.clause === '1 = 0');
      expect(noMatch).toBeDefined();
      const agencyClause = calls.find((c) =>
        c.clause.includes('responsible_agency_id'),
      );
      expect(agencyClause).toBeUndefined();
    });

    it('omitted hasResponsibleAgency → no clause for the predicate', () => {
      const svc = makeService();
      const { qb, calls } = makeFakeQb();
      callApplyFilters(svc, qb, {}, 'main');

      const agencyClause = calls.find((c) =>
        c.clause.includes('responsible_agency_id IS'),
      );
      expect(agencyClause).toBeUndefined();
    });
  });

  describe('filters.isBooked', () => {
    it.each<Kind>(['main', 'revised'])(
      'kind=%s + isBooked=true → emits %s.isBooked = true via bind param',
      (kind) => {
        const svc = makeService();
        const { qb, calls } = makeFakeQb();
        callApplyFilters(svc, qb, { isBooked: true }, kind);

        const alias = ALIAS_BY_KIND[kind];
        const match = calls.find((c) => c.clause.includes(`${alias}.isBooked`));
        expect(match).toBeDefined();
        expect(match!.clause).toBe(`${alias}.isBooked = :isBookedFilter`);
        expect(match!.params).toEqual({ isBookedFilter: true });
      },
    );

    it.each<Kind>(['main', 'revised'])(
      'kind=%s + isBooked=false → emits %s.isBooked = false via bind param',
      (kind) => {
        const svc = makeService();
        const { qb, calls } = makeFakeQb();
        callApplyFilters(svc, qb, { isBooked: false }, kind);

        const alias = ALIAS_BY_KIND[kind];
        const match = calls.find((c) => c.clause.includes(`${alias}.isBooked`));
        expect(match).toBeDefined();
        expect(match!.clause).toBe(`${alias}.isBooked = :isBookedFilter`);
        expect(match!.params).toEqual({ isBookedFilter: false });
      },
    );

    it('kind=supplement + isBooked=true → no clause emitted (SPG inherently booked)', () => {
      const svc = makeService();
      const { qb, calls } = makeFakeQb();
      callApplyFilters(svc, qb, { isBooked: true }, 'supplement');

      const bookedClause = calls.find((c) => c.clause.includes('isBooked'));
      expect(bookedClause).toBeUndefined();
      const noMatch = calls.find((c) => c.clause === '1 = 0');
      expect(noMatch).toBeUndefined();
    });

    it('kind=supplement + isBooked=false → 1 = 0 (SPG has no isBooked column)', () => {
      const svc = makeService();
      const { qb, calls } = makeFakeQb();
      callApplyFilters(svc, qb, { isBooked: false }, 'supplement');

      const noMatch = calls.find((c) => c.clause === '1 = 0');
      expect(noMatch).toBeDefined();
      const bookedClause = calls.find((c) => c.clause.includes('isBooked'));
      expect(bookedClause).toBeUndefined();
    });

    it('omitted isBooked → no clause for the predicate', () => {
      const svc = makeService();
      const { qb, calls } = makeFakeQb();
      callApplyFilters(svc, qb, {}, 'main');

      const bookedClause = calls.find((c) => c.clause.includes('isBooked'));
      expect(bookedClause).toBeUndefined();
    });
  });

  describe('combined hasResponsibleAgency=true + isBooked=true (rule #25c v3 อบจ-bucket payload)', () => {
    it.each<Kind>(['main', 'revised'])(
      'kind=%s emits BOTH clauses (AND composition) on the same QB',
      (kind) => {
        const svc = makeService();
        const { qb, calls } = makeFakeQb();
        callApplyFilters(
          svc,
          qb,
          { hasResponsibleAgency: true, isBooked: true },
          kind,
        );

        const alias = ALIAS_BY_KIND[kind];
        const agencyMatch = calls.find(
          (c) => c.clause === `${alias}.responsible_agency_id IS NOT NULL`,
        );
        const bookedMatch = calls.find(
          (c) => c.clause === `${alias}.isBooked = :isBookedFilter`,
        );
        expect(agencyMatch).toBeDefined();
        expect(bookedMatch).toBeDefined();
        expect(bookedMatch!.params).toEqual({ isBookedFilter: true });
      },
    );

    it('kind=supplement passes both filters (no clauses emitted; SPG always satisfies the predicate)', () => {
      const svc = makeService();
      const { qb, calls } = makeFakeQb();
      callApplyFilters(
        svc,
        qb,
        { hasResponsibleAgency: true, isBooked: true },
        'supplement',
      );

      // SPG short-circuit: neither clause should be emitted, and no
      // accidental no-match should be added.
      const agencyClause = calls.find((c) =>
        c.clause.includes('responsible_agency_id'),
      );
      const bookedClause = calls.find((c) => c.clause.includes('isBooked'));
      const noMatch = calls.find((c) => c.clause === '1 = 0');
      expect(agencyClause).toBeUndefined();
      expect(bookedClause).toBeUndefined();
      expect(noMatch).toBeUndefined();
    });
  });
});
