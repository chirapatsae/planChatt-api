/**
 * BE-W54-08 — Fallback envelope spec.
 *
 * Exercises the real `ResilienceEnvelopeService` (BE-W54-07 landed) against
 * all SIX `MissingDimension` literals:
 *   - 'budget'           → BUDGET_UNAVAILABLE
 *   - 'status'           → STATUS_UNAVAILABLE
 *   - 'geo'              → GEO_UNAVAILABLE
 *   - 'geo:supplement'   → GEO_SUPPLEMENT_EXCLUDED
 *   - 'agency'           → AGENCY_UNAVAILABLE
 *   - 'classification'   → CLASSIFICATION_UNAVAILABLE
 *
 * For each dimension the spec:
 *   1. Forces a failing thunk (rejects with `new Error('secret DB error')`).
 *   2. Asserts `partial: true` (missingDimensions.length > 0 ⇒ partial).
 *   3. Asserts `missingDimensions` contains the failure name exactly once.
 *   4. Asserts `advisories` contains the byte-identical Thai string from
 *      `advisory-copy.ts`.
 *   5. Asserts the raw error message NEVER leaks into `advisories[]`
 *      (§17.9 prompt-injection defense).
 *
 * Also covers:
 *   - Multi-dimension failure: 2 failing dims → 2 entries in both arrays,
 *     no dedupe, order matches input order.
 */
import { Logger } from '@nestjs/common';

import {
  AGENCY_UNAVAILABLE,
  BUDGET_UNAVAILABLE,
  CLASSIFICATION_UNAVAILABLE,
  DIMENSION_ADVISORY,
  GEO_SUPPLEMENT_EXCLUDED,
  GEO_UNAVAILABLE,
  STATUS_UNAVAILABLE,
} from '../advisory-copy';
import { ResilienceEnvelopeService } from '../resilience-envelope.service';
import type { DimensionTask } from '../interfaces';
import type { MissingDimension } from '../types';

// Silence the Nest logger so test output stays clean.
beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  jest.restoreAllMocks();
});

const SECRET = 'secret database error — ER_NO_SUCH_TABLE "budgets"';

function failing(dim: MissingDimension): DimensionTask {
  return {
    dimension: dim,
    run: async () => {
      throw new Error(SECRET);
    },
  };
}

function ok<T>(dim: MissingDimension, value: T): DimensionTask {
  return { dimension: dim, run: async () => value };
}

describe('BE-W54-08 / fallback envelope — all 6 MissingDimension values', () => {
  const svc = () => new ResilienceEnvelopeService();

  const EXPECTED: Record<MissingDimension, string> = {
    budget: BUDGET_UNAVAILABLE,
    status: STATUS_UNAVAILABLE,
    geo: GEO_UNAVAILABLE,
    'geo:supplement': GEO_SUPPLEMENT_EXCLUDED,
    agency: AGENCY_UNAVAILABLE,
    classification: CLASSIFICATION_UNAVAILABLE,
  };

  const cases: MissingDimension[] = [
    'budget',
    'status',
    'geo',
    'geo:supplement',
    'agency',
    'classification',
  ];

  it.each(cases)(
    '%s — failure → partial:true, matching Thai advisory, no raw leak',
    async (dim) => {
      const env = await svc().runDimensions(
        [failing(dim)],
        () => ({}),
        { shape: 'planOverview' },
      );

      expect(env.partial).toBe(true);
      expect(env.missingDimensions).toHaveLength(1);
      expect(env.missingDimensions[0]).toBe(dim);
      expect(env.advisories).toHaveLength(1);
      expect(env.advisories[0]).toBe(EXPECTED[dim]);
      // DIMENSION_ADVISORY keyed-lookup matches too.
      expect(env.advisories[0]).toBe(DIMENSION_ADVISORY[dim]);
      // Raw DB error text MUST NOT leak into advisories.
      for (const adv of env.advisories) {
        expect(adv).not.toContain(SECRET);
        expect(adv).not.toContain('ER_NO_SUCH_TABLE');
      }
    },
  );

  it('multi-dim failure: 2 failures → 2 entries, no dedupe, stable order', async () => {
    const env = await svc().runDimensions(
      [failing('budget'), failing('status'), ok('geo', { x: 1 })],
      () => ({}),
      { shape: 'dashboardSnapshot' },
    );

    expect(env.partial).toBe(true);
    expect(env.missingDimensions).toHaveLength(2);
    expect(env.advisories).toHaveLength(2);
    // Order must follow input order (no re-sort, no dedupe).
    expect(env.missingDimensions).toEqual(['budget', 'status']);
    expect(env.advisories).toEqual([BUDGET_UNAVAILABLE, STATUS_UNAVAILABLE]);
  });

  it('invariant: missingDimensions.length > 0 IFF partial=true', async () => {
    const okEnv = await svc().runDimensions(
      [ok('budget', new Map())],
      () => ({}),
      { shape: 'planOverview' },
    );
    expect(okEnv.missingDimensions.length).toBe(0);
    expect(okEnv.partial).toBe(false);

    const failEnv = await svc().runDimensions(
      [failing('classification')],
      () => ({}),
      { shape: 'planOverview' },
    );
    expect(failEnv.missingDimensions.length).toBeGreaterThan(0);
    expect(failEnv.partial).toBe(true);
  });
});
