/**
 * BE-W54-07 — ResilienceEnvelope unit spec.
 *
 * Covers:
 *   1. Happy path — all dimensions succeed → `partial: false`,
 *      `missingDimensions: []`, `advisories: []`.
 *   2. Single-dimension failure → `partial: true`, `missingDimensions`
 *      contains the failed dim, `advisories[]` carries the matching
 *      Thai string; error message is NOT leaked into `advisories[]`.
 *   3. Multiple simultaneous failures → advisories accumulate
 *      (one per failed dimension, no overwrite, no dedupe).
 *   4. Dimension timeout — a promise that never resolves within the
 *      configured timeout is treated as a failure and the appropriate
 *      advisory is emitted.
 *   5. `ForbiddenException` raised inside a dimension thunk propagates
 *      UNCAUGHT — it is NOT turned into a missingDimension.
 *   6. `asOf` is a valid ISO-8601 timestamp.
 *   7. Byte-identity of the eight advisory constants vs CLAUDE.md §7.
 *
 * CLAUDE.md §17.2 / §17.9 / §17.11 — the envelope is an advisory-only
 * mechanism, strings are server-authored static literals, and no role
 * check is re-asserted by this service.
 */
import { ForbiddenException, Logger } from '@nestjs/common';

import {
  AGENCY_UNAVAILABLE,
  BUDGET_UNAVAILABLE,
  CLASSIFICATION_SHAPE_ISSUE,
  CLASSIFICATION_SHAPE_STRATEGY,
  CLASSIFICATION_UNAVAILABLE,
  GEO_SUPPLEMENT_EXCLUDED,
  GEO_UNAVAILABLE,
  STATUS_UNAVAILABLE,
} from '../advisory-copy';
import {
  DimensionTimeoutError,
  ResilienceEnvelopeService,
} from '../resilience-envelope.service';
import type { DimensionTask } from '../interfaces';

// Silence the Nest logger for deterministic test output. We use
// per-test spies (re-created in each `beforeEach`) so that individual
// tests can `.mockRestore()` or inspect call history without clobbering
// the global silencers for subsequent tests.
let warnSilencer: jest.SpyInstance;
let errorSilencer: jest.SpyInstance;
beforeEach(() => {
  warnSilencer = jest
    .spyOn(Logger.prototype, 'warn')
    .mockImplementation(() => undefined);
  errorSilencer = jest
    .spyOn(Logger.prototype, 'error')
    .mockImplementation(() => undefined);
});
afterEach(() => {
  warnSilencer.mockRestore();
  errorSilencer.mockRestore();
});

// Short test-scale timeout so the "timeout" case doesn't wait 3 real
// seconds. The service honours the supplied timeout verbatim when a
// caller passes `perDimensionTimeoutMs` in `ResilienceRunOptions`.
const FAST_TIMEOUT_MS = 40;

function svc(): ResilienceEnvelopeService {
  return new ResilienceEnvelopeService();
}

function ok<T>(dim: DimensionTask['dimension'], value: T): DimensionTask {
  return { dimension: dim, run: async () => value };
}

function rejects(dim: DimensionTask['dimension'], err: unknown): DimensionTask {
  return {
    dimension: dim,
    run: async () => {
      throw err;
    },
  };
}

function timesOut(dim: DimensionTask['dimension']): DimensionTask {
  return {
    dimension: dim,
    // Never resolves — the service's internal timeout wins.
    run: () =>
      new Promise<unknown>(() => {
        /* intentional */
      }),
  };
}

describe('BE-W54-07 / ResilienceEnvelope', () => {
  describe('advisory-copy byte-identity (§7)', () => {
    test('BUDGET_UNAVAILABLE matches spec verbatim', () => {
      expect(BUDGET_UNAVAILABLE).toBe('ข้อมูลงบประมาณไม่สามารถดึงได้ขณะนี้');
    });
    test('STATUS_UNAVAILABLE matches spec verbatim', () => {
      expect(STATUS_UNAVAILABLE).toBe('ข้อมูลสถานะไม่สามารถดึงได้ขณะนี้');
    });
    test('GEO_UNAVAILABLE matches spec verbatim', () => {
      expect(GEO_UNAVAILABLE).toBe('ข้อมูลพื้นที่ไม่สามารถดึงได้ขณะนี้');
    });
    test('GEO_SUPPLEMENT_EXCLUDED matches spec verbatim', () => {
      expect(GEO_SUPPLEMENT_EXCLUDED).toBe(
        'ข้อมูลพื้นที่ของเล่มเพิ่มเติมยังไม่พร้อมใช้งาน (ไม่มีคอลัมน์ amphoe_id)',
      );
    });
    test('AGENCY_UNAVAILABLE matches spec verbatim', () => {
      expect(AGENCY_UNAVAILABLE).toBe(
        'ข้อมูลหน่วยงานผู้รับผิดชอบไม่สามารถดึงได้ขณะนี้',
      );
    });
    test('CLASSIFICATION_UNAVAILABLE matches spec verbatim', () => {
      expect(CLASSIFICATION_UNAVAILABLE).toBe(
        'ข้อมูลการจำแนกประเภทโครงการไม่สามารถดึงได้ขณะนี้',
      );
    });
    test('CLASSIFICATION_SHAPE_STRATEGY matches spec verbatim', () => {
      expect(CLASSIFICATION_SHAPE_STRATEGY).toBe(
        'แผนนี้เป็น STRATEGY_BASED (ยุทธศาสตร์) จึงไม่มีการจำแนกตามประเด็นการพัฒนา',
      );
    });
    test('CLASSIFICATION_SHAPE_ISSUE matches spec verbatim', () => {
      expect(CLASSIFICATION_SHAPE_ISSUE).toBe(
        'แผนนี้เป็น ISSUE_BASED (ประเด็นการพัฒนา) จึงไม่มีการจำแนกตามยุทธศาสตร์/กลยุทธ์',
      );
    });
  });

  test('case 1 — happy path: no missing dims, empty advisories', async () => {
    const env = await svc().runDimensions(
      [ok('budget', new Map([['main:p1', 100]])), ok('status', new Map())],
      (results) => {
        expect(results.every((r) => r.ok)).toBe(true);
        return { total: 100 };
      },
      { shape: 'planOverview' },
    );

    expect(env.shape).toBe('planOverview');
    expect(env.data).toEqual({ total: 100 });
    expect(env.partial).toBe(false);
    expect(env.missingDimensions).toEqual([]);
    expect(env.advisories).toEqual([]);
    // asOf must be a valid ISO string.
    expect(new Date(env.asOf).toISOString()).toBe(env.asOf);
  });

  test('case 2 — single failure: advisory matches dim, no raw error leak', async () => {
    const secretMessage = 'ER_NO_SUCH_TABLE "project_groups"';
    const env = await svc().runDimensions(
      [ok('status', new Map()), rejects('budget', new Error(secretMessage))],
      (results) => ({ okCount: results.filter((r) => r.ok).length }),
      { shape: 'planOverview' },
    );

    expect(env.partial).toBe(true);
    expect(env.missingDimensions).toEqual(['budget']);
    expect(env.advisories).toEqual([BUDGET_UNAVAILABLE]);
    // Raw error text MUST NOT leak into any advisory.
    for (const adv of env.advisories) {
      expect(adv).not.toContain(secretMessage);
      expect(adv).not.toContain('ER_NO_SUCH_TABLE');
    }
  });

  test('case 3 — multiple failures: advisories accumulate, no overwrite', async () => {
    const env = await svc().runDimensions(
      [
        rejects('budget', new Error('db down')),
        rejects('status', new Error('timeout-ish')),
        rejects('geo', new Error('amphoe')),
        ok('agency', {
          labels: new Map(),
          missingDimensions: [],
          advisories: [],
        }),
      ],
      () => ({}),
      { shape: 'dashboardSnapshot' },
    );

    expect(env.partial).toBe(true);
    expect(env.missingDimensions).toHaveLength(3);
    expect(new Set(env.missingDimensions)).toEqual(
      new Set(['budget', 'status', 'geo']),
    );
    expect(env.advisories).toHaveLength(3);
    expect(new Set(env.advisories)).toEqual(
      new Set([BUDGET_UNAVAILABLE, STATUS_UNAVAILABLE, GEO_UNAVAILABLE]),
    );
  });

  test('case 4 — dimension timeout is treated as a failure', async () => {
    const env = await svc().runDimensions(
      [timesOut('geo'), ok('status', new Map())],
      () => ({}),
      {
        shape: 'crossPlanInsights',
        perDimensionTimeoutMs: FAST_TIMEOUT_MS,
      },
    );

    expect(env.partial).toBe(true);
    expect(env.missingDimensions).toEqual(['geo']);
    expect(env.advisories).toEqual([GEO_UNAVAILABLE]);
  });

  test('case 4b — telemetry is emitted at WARN for DimensionTimeoutError', async () => {
    await svc().runDimensions([timesOut('budget')], () => ({}), {
      shape: 'planOverview',
      perDimensionTimeoutMs: FAST_TIMEOUT_MS,
    });

    expect(warnSilencer).toHaveBeenCalled();
    const payload = warnSilencer.mock.calls[0]?.[0];
    expect(typeof payload).toBe('string');
    expect(payload as string).toContain('BE-W54-07');
    expect(payload as string).toContain('budget');
  });

  test('case 5 — ForbiddenException propagates UNCAUGHT (not a dimension)', async () => {
    const s = svc();
    await expect(
      s.runDimensions(
        [
          ok('status', new Map()),
          rejects('agency', new ForbiddenException('EXECUTIVE_ROLE_REQUIRED')),
        ],
        () => ({}),
        { shape: 'planOverview' },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  test('case 6 — asOf is a valid ISO-8601 timestamp', async () => {
    const env = await svc().runDimensions(
      [ok('budget', new Map())],
      () => ({}),
      { shape: 'planOverview' },
    );
    // Reparsing must reproduce the same string.
    const parsed = new Date(env.asOf);
    expect(Number.isNaN(parsed.valueOf())).toBe(false);
    expect(parsed.toISOString()).toBe(env.asOf);
    // Also structurally match the ISO-8601 "Z" form.
    expect(env.asOf).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/,
    );
  });

  test('case 7 — error-carried advisory (ClassificationShapeError-like) wins over default', async () => {
    // Mirrors the Tier C handler contract: a ShapeMismatch error carries
    // its own advisory string which MUST be preferred over the generic
    // CLASSIFICATION_UNAVAILABLE default.
    class ShapeErr extends Error {
      advisory = CLASSIFICATION_SHAPE_STRATEGY;
      constructor() {
        super('CLASSIFICATION_SHAPE_MISMATCH');
      }
    }
    const env = await svc().runDimensions(
      [rejects('classification', new ShapeErr())],
      () => ({}),
      { shape: 'planOverview' },
    );
    expect(env.missingDimensions).toEqual(['classification']);
    expect(env.advisories).toEqual([CLASSIFICATION_SHAPE_STRATEGY]);
  });

  test('DimensionTimeoutError is exported and carries the dimension name', () => {
    const err = new DimensionTimeoutError('budget', 3000);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('DimensionTimeoutError');
    expect(err.dimension).toBe('budget');
  });
});
