/**
 * Rules-table unit tests — Wave 30 N1.
 * Covers registry drift (SUBTYPE_TO_PROJECT_TYPE keys) and the
 * minimum required conflict-matrix combinations.
 */
import {
  CONFLICT_MATRIX,
  GEO_CONFLICT_RULESET_VERSION,
  SUBTYPE_TO_PROJECT_TYPE,
  resolveConflict,
} from './geo-conflict-rules';
import { NAKHON_RATCHASIMA_ISSUE_RULES } from '../criteria/nakhon-ratchasima-issue-rules';

describe('geo-conflict-rules', () => {
  it('exposes the expected ruleset version', () => {
    expect(GEO_CONFLICT_RULESET_VERSION).toBe('2026-04-20');
  });

  it('contains at least 12 rules including required reservoir combos', () => {
    expect(CONFLICT_MATRIX.length).toBeGreaterThanOrEqual(12);

    const requiredCombos: Array<{
      featureType: 'reservoir' | 'river' | 'canal';
      projectType:
        | 'road-like'
        | 'building-like'
        | 'irrigation-like'
        | 'water-supply'
        | 'drainage'
        | 'agriculture-support';
    }> = [
      { featureType: 'reservoir', projectType: 'road-like' },
      { featureType: 'reservoir', projectType: 'building-like' },
      { featureType: 'reservoir', projectType: 'irrigation-like' },
      { featureType: 'reservoir', projectType: 'water-supply' },
      { featureType: 'reservoir', projectType: 'drainage' },
      { featureType: 'reservoir', projectType: 'agriculture-support' },
      { featureType: 'river', projectType: 'road-like' },
      { featureType: 'river', projectType: 'building-like' },
      { featureType: 'river', projectType: 'drainage' },
      { featureType: 'canal', projectType: 'road-like' },
      { featureType: 'canal', projectType: 'irrigation-like' },
      { featureType: 'canal', projectType: 'drainage' },
    ];

    for (const combo of requiredCombos) {
      const match = CONFLICT_MATRIX.find(
        (r) =>
          r.featureType === combo.featureType &&
          r.projectType === combo.projectType,
      );
      expect(match).toBeDefined();
    }
  });

  describe('resolveConflict — minimum required cases', () => {
    const baseFeature = {
      featureId: 'test-1',
      nameTh: 'อ่างเก็บน้ำทดสอบ',
    };

    it('A: reservoir + road-like → HIGH with reasons present', () => {
      const r = resolveConflict({
        geoFeature: { ...baseFeature, featureType: 'reservoir' },
        projectType: 'road-like',
      });
      expect(r.conflictLevel).toBe('high');
      expect(r.reasons.length).toBeGreaterThanOrEqual(1);
      expect(r.recommendations.length).toBeGreaterThanOrEqual(1);
      expect(r.rulesetVersion).toBe(GEO_CONFLICT_RULESET_VERSION);
    });

    it('B: reservoir + irrigation-like → LOW', () => {
      const r = resolveConflict({
        geoFeature: { ...baseFeature, featureType: 'reservoir' },
        projectType: 'irrigation-like',
      });
      expect(r.conflictLevel).toBe('low');
    });

    it('C: reservoir + unknown → NONE (conservative fallback)', () => {
      const r = resolveConflict({
        geoFeature: { ...baseFeature, featureType: 'reservoir' },
        projectType: 'unknown',
      });
      expect(r.conflictLevel).toBe('none');
    });

    it('D: river + building-like → MEDIUM', () => {
      const r = resolveConflict({
        geoFeature: {
          featureId: 'river-1',
          nameTh: 'แม่น้ำทดสอบ',
          featureType: 'river',
        },
        projectType: 'building-like',
      });
      expect(r.conflictLevel).toBe('medium');
    });

    it('E: unmatched specific combo (canal + environmental) → NONE with fallback reason', () => {
      const r = resolveConflict({
        geoFeature: {
          featureId: 'canal-1',
          nameTh: 'คลองทดสอบ',
          featureType: 'canal',
        },
        projectType: 'environmental',
      });
      expect(r.conflictLevel).toBe('none');
      expect(r.reasons.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('F: every key in SUBTYPE_TO_PROJECT_TYPE exists in NAKHON_RATCHASIMA_ISSUE_RULES', () => {
    // Collect every sub-type `code` present in the Wave 24 registry.
    const registryCodes = new Set<string>();
    for (const entry of NAKHON_RATCHASIMA_ISSUE_RULES) {
      for (const sub of entry.subTypes ?? []) {
        if (typeof sub.code === 'string' && sub.code.length > 0) {
          registryCodes.add(sub.code);
        }
      }
    }

    // Sanity: registry must be non-empty.
    expect(registryCodes.size).toBeGreaterThan(0);

    for (const mappedCode of Object.keys(SUBTYPE_TO_PROJECT_TYPE)) {
      expect(registryCodes.has(mappedCode)).toBe(true);
    }
  });
});
