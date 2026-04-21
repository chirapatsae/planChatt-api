/**
 * GeoFeatureLookupService spec — Wave 29 N1
 *
 * Covers:
 *   - pin inside อ่างห้วยย่าง polygon resolves to that feature
 *   - pin at (0,0) / outside any polygon returns null
 *   - malformed GeoJSON path fails open (service boots, returns null)
 *   - non-finite coordinates return null
 *
 * Uses `_setIndexForTest` to bypass fs so tests are hermetic.
 */
import { GeoFeatureLookupService } from './geo-feature-lookup.service';

function huaiYangFeature() {
  return {
    type: 'Feature',
    properties: {
      featureId: 'reservoir-huai-yang',
      nameTh: 'อ่างเก็บน้ำห้วยย่าง',
      featureType: 'reservoir',
      categoryLabel: 'แหล่งน้ำผิวดิน',
      sourceRef: 'manual-seed-wave29',
    },
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [101.87, 14.44],
          [101.895, 14.44],
          [101.895, 14.46],
          [101.87, 14.46],
          [101.87, 14.44],
        ],
      ],
    },
  };
}

describe('GeoFeatureLookupService', () => {
  it('resolves a pin inside อ่างห้วยย่าง', () => {
    const svc = new GeoFeatureLookupService();
    svc._setIndexForTest([huaiYangFeature() as any]);

    const result = svc.resolveFeatureForPoint(14.45, 101.88);
    expect(result).not.toBeNull();
    expect(result?.featureId).toBe('reservoir-huai-yang');
    expect(result?.nameTh).toBe('อ่างเก็บน้ำห้วยย่าง');
    expect(result?.featureType).toBe('reservoir');
    expect(result?.categoryLabel).toBe('แหล่งน้ำผิวดิน');
  });

  it('returns null for a pin outside any polygon', () => {
    const svc = new GeoFeatureLookupService();
    svc._setIndexForTest([huaiYangFeature() as any]);
    expect(svc.resolveFeatureForPoint(0, 0)).toBeNull();
    // Just outside the east edge of the seeded polygon:
    expect(svc.resolveFeatureForPoint(14.45, 101.9)).toBeNull();
  });

  it('returns null for non-finite coordinates', () => {
    const svc = new GeoFeatureLookupService();
    svc._setIndexForTest([huaiYangFeature() as any]);
    expect(svc.resolveFeatureForPoint(Number.NaN, 101.88)).toBeNull();
    expect(svc.resolveFeatureForPoint(14.45, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('drops features with missing required properties (fail-open per-feature)', () => {
    const svc = new GeoFeatureLookupService();
    svc._setIndexForTest([
      {
        type: 'Feature',
        properties: {
          // featureId missing
          nameTh: 'ไม่สมบูรณ์',
          featureType: 'reservoir',
          categoryLabel: 'แหล่งน้ำผิวดิน',
        },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [101.87, 14.44],
              [101.895, 14.44],
              [101.895, 14.46],
              [101.87, 14.46],
              [101.87, 14.44],
            ],
          ],
        },
      } as any,
    ]);
    expect(svc.resolveFeatureForPoint(14.45, 101.88)).toBeNull();
  });

  it('drops features with disallowed featureType', () => {
    const svc = new GeoFeatureLookupService();
    svc._setIndexForTest([
      {
        ...huaiYangFeature(),
        properties: {
          ...huaiYangFeature().properties,
          featureType: 'forest',
        },
      } as any,
    ]);
    expect(svc.resolveFeatureForPoint(14.45, 101.88)).toBeNull();
  });

  it('boots cleanly when GeoJSON file is missing (fail-open)', () => {
    // Force cwd to a directory that has no geojson/nakhon-ratchasima-features.json
    const origCwd = process.cwd;
    process.cwd = () => '/tmp/__non_existent_geojson_root__';
    try {
      const svc = new GeoFeatureLookupService();
      svc.onModuleInit();
      expect(svc.resolveFeatureForPoint(14.45, 101.88)).toBeNull();
    } finally {
      process.cwd = origCwd;
    }
  });
});
