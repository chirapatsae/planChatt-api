/**
 * FeasibilityGateService unit tests — Wave 33.6 N1
 *
 * Pure deterministic gate. No DB, no HTTP, no NestJS test bed needed.
 */
import { FeasibilityGateService } from './feasibility-gate.service';
import {
  FEASIBILITY_BLOCK_TABLE,
  LAND_CONSTRUCTION_PROJECT_TYPES,
  WATER_BODY_FEATURE_TYPES,
  resolveBlockRule,
} from './feasibility-rules';
import {
  FEASIBILITY_RULESET_VERSION,
  type FeasibilityInput,
} from './feasibility.types';

describe('FeasibilityGateService', () => {
  let service: FeasibilityGateService;

  beforeEach(() => {
    service = new FeasibilityGateService();
  });

  const reservoirFeature = {
    featureType: 'reservoir',
    nameTh: 'อ่างเก็บน้ำลำตะคอง',
    featureId: 'rsv-1',
  };
  const riverFeature = {
    featureType: 'river',
    nameTh: 'แม่น้ำมูล',
    featureId: 'riv-1',
  };

  it('blocks reservoir + road-like at HIGH conflict and substitutes nameTh', () => {
    const input: FeasibilityInput = {
      geoFeature: reservoirFeature,
      projectType: 'road-like',
      conflictLevel: 'high',
    };
    const verdict = service.evaluate(input);
    expect(verdict.severity).toBe('block');
    expect(verdict.isFeasible).toBe(false);
    expect(verdict.triggeredRule).toBe('reservoir-vs-road-like');
    expect(verdict.reason).toContain('อ่างเก็บน้ำลำตะคอง');
    expect(verdict.reason).not.toContain('{nameTh}');
    expect(verdict.recommendations).toBeDefined();
    expect((verdict.recommendations ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('passes reservoir + irrigation-like at LOW conflict (no rule, soft combo)', () => {
    const verdict = service.evaluate({
      geoFeature: reservoirFeature,
      projectType: 'irrigation-like',
      conflictLevel: 'low',
    });
    expect(verdict.severity).toBe('pass');
    expect(verdict.isFeasible).toBe(true);
    expect(verdict.triggeredRule).toBeUndefined();
  });

  it('passes reservoir + road-like at LOW conflict (gate requires HIGH)', () => {
    // Defensive — Wave 30 may classify some reservoir+road combos as low/medium
    // for nuanced reasons (e.g. clearly outside the polygon edge); we MUST NOT
    // block unless Wave 30 is also confident (HIGH).
    const verdict = service.evaluate({
      geoFeature: reservoirFeature,
      projectType: 'road-like',
      conflictLevel: 'low',
    });
    expect(verdict.severity).toBe('pass');
  });

  it('blocks river + building-like at HIGH conflict', () => {
    const verdict = service.evaluate({
      geoFeature: riverFeature,
      projectType: 'building-like',
      conflictLevel: 'high',
    });
    expect(verdict.severity).toBe('block');
    expect(verdict.triggeredRule).toBe('river-vs-building-like');
    expect(verdict.reason).toContain('แม่น้ำมูล');
  });

  it('passes when geoFeature is null', () => {
    const verdict = service.evaluate({
      geoFeature: null,
      projectType: 'road-like',
      conflictLevel: 'high',
    });
    expect(verdict.severity).toBe('pass');
  });

  it('passes when projectType is "unknown" (unmapped sub-type)', () => {
    const verdict = service.evaluate({
      geoFeature: reservoirFeature,
      projectType: 'unknown',
      conflictLevel: 'high',
    });
    expect(verdict.severity).toBe('pass');
  });

  it('emits warn at MEDIUM conflict (Wave 30 [CONFLICT_ASSESSMENT] still active)', () => {
    const verdict = service.evaluate({
      geoFeature: reservoirFeature,
      projectType: 'road-like',
      conflictLevel: 'medium',
    });
    expect(verdict.severity).toBe('warn');
    expect(verdict.isFeasible).toBe(true);
    expect(verdict.triggeredRule).toBeUndefined();
  });

  it('passes at NONE conflict regardless of combo', () => {
    const verdict = service.evaluate({
      geoFeature: reservoirFeature,
      projectType: 'road-like',
      conflictLevel: 'none',
    });
    expect(verdict.severity).toBe('pass');
  });

  it('passes at UNKNOWN conflict (never escalate without Wave 30 confidence)', () => {
    const verdict = service.evaluate({
      geoFeature: reservoirFeature,
      projectType: 'road-like',
      conflictLevel: 'unknown',
    });
    expect(verdict.severity).toBe('pass');
  });

  it('passes when featureType is not a water body (e.g. unknown polygon type)', () => {
    const verdict = service.evaluate({
      geoFeature: { featureType: 'forest', nameTh: 'ป่าสงวน' },
      projectType: 'road-like',
      conflictLevel: 'high',
    });
    expect(verdict.severity).toBe('pass');
  });

  it('fails open to pass when evaluator throws unexpectedly', () => {
    // Force a throw by passing a frozen geoFeature whose featureType getter
    // throws when read. The service MUST NOT surface the throw.
    const evilFeature: FeasibilityInput['geoFeature'] = Object.create(null, {
      featureType: {
        get() {
          throw new Error('synthetic boom');
        },
        enumerable: true,
      },
      nameTh: { value: 'x', enumerable: true },
    });
    const verdict = service.evaluate({
      geoFeature: evilFeature,
      projectType: 'road-like',
      conflictLevel: 'high',
    });
    expect(verdict.severity).toBe('pass');
    expect(verdict.isFeasible).toBe(true);
  });

  it('rule registry integrity: ids unique, allowlists honored, ≥ 5 entries', () => {
    expect(FEASIBILITY_BLOCK_TABLE.length).toBeGreaterThanOrEqual(5);
    const ids = FEASIBILITY_BLOCK_TABLE.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of FEASIBILITY_BLOCK_TABLE) {
      // featureType must be in allowlist OR wildcard
      if (rule.featureType !== '*') {
        expect(WATER_BODY_FEATURE_TYPES.has(rule.featureType)).toBe(true);
      }
      // projectType must be in allowlist OR wildcard
      if (rule.projectType !== '*') {
        expect(LAND_CONSTRUCTION_PROJECT_TYPES.has(rule.projectType)).toBe(
          true,
        );
      }
      expect(rule.recommendations.length).toBeGreaterThanOrEqual(2);
      expect(rule.recommendations.length).toBeLessThanOrEqual(6);
      for (const r of rule.recommendations) {
        expect(r.length).toBeLessThanOrEqual(240);
      }
      expect(rule.reason.length).toBeLessThanOrEqual(240);
    }
  });

  it('resolveBlockRule returns null on no match', () => {
    expect(resolveBlockRule('forest', 'road-like')).toBeNull();
    expect(resolveBlockRule('reservoir', 'agriculture-support')).toBeNull();
  });

  it('exposes a stable ruleset version constant', () => {
    expect(FEASIBILITY_RULESET_VERSION).toBe('wave-33.6-v1');
  });
});
