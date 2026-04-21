import { GeoConflictService } from './geo-conflict.service';
import { GEO_CONFLICT_RULESET_VERSION } from './geo-conflict-rules';

describe('GeoConflictService', () => {
  let service: GeoConflictService;

  beforeEach(() => {
    service = new GeoConflictService();
  });

  describe('resolveProjectType', () => {
    it('G: maps a known sub-type code', () => {
      expect(service.resolveProjectType('4.1')).toBe('road-like');
      expect(service.resolveProjectType('3.2.1')).toBe('irrigation-like');
    });

    it('returns "unknown" for an unmapped code', () => {
      expect(service.resolveProjectType('bogus-code')).toBe('unknown');
    });

    it('returns "unknown" for null/undefined/empty', () => {
      expect(service.resolveProjectType(null)).toBe('unknown');
      expect(service.resolveProjectType(undefined)).toBe('unknown');
      expect(service.resolveProjectType('')).toBe('unknown');
    });
  });

  describe('analyze', () => {
    const baseFeature = {
      featureId: 'rsv-1',
      nameTh: 'อ่างเก็บน้ำทดสอบ',
    };

    it('returns deterministic verdict with rulesetVersion stamped', () => {
      const result = service.analyze({
        geoFeature: { ...baseFeature, featureType: 'reservoir' },
        projectType: 'road-like',
      });
      expect(result.rulesetVersion).toBe(GEO_CONFLICT_RULESET_VERSION);
      expect(result.featureType).toBe('reservoir');
      expect(result.projectType).toBe('road-like');
      expect(result.conflictLevel).toBe('high');
    });

    it('caps reasons[] and recommendations[] to the defensive limits', () => {
      const result = service.analyze({
        geoFeature: { ...baseFeature, featureType: 'reservoir' },
        projectType: 'road-like',
      });
      expect(result.reasons.length).toBeLessThanOrEqual(6);
      expect(result.recommendations.length).toBeLessThanOrEqual(6);
      for (const s of [...result.reasons, ...result.recommendations]) {
        expect(s.length).toBeLessThanOrEqual(240);
        expect(s).toBe(s.trim());
      }
    });

    it('produces byte-identical output for identical inputs (determinism)', () => {
      const input = {
        geoFeature: {
          featureId: 'rsv-2',
          nameTh: 'อ่างเก็บน้ำ B',
          featureType: 'reservoir' as const,
        },
        projectType: 'irrigation-like' as const,
      };
      const a = service.analyze(input);
      const b = service.analyze(input);
      expect(a).toEqual(b);
    });
  });
});
