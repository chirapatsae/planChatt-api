/**
 * AdminBoundaryLookupService spec — Wave 31 N2
 *
 * Covers:
 *   - pin inside a seeded NR tambon polygon resolves correctly
 *   - pin outside any polygon (e.g. 0,0 or Bangkok) returns null
 *   - non-finite coordinates return null
 *   - malformed / missing GeoJSON path fails open (boots, returns null)
 *   - feature with missing required property (e.g. tam_th) is dropped
 *
 * Uses `_setIndexForTest` to bypass fs so tests are hermetic.
 */
import { AdminBoundaryLookupService } from './admin-boundary-lookup.service';

function khokKruatFeature() {
  // Synthetic polygon roughly around โคกกรวด, เมืองนครราชสีมา.
  // Shape bounds are a simple rectangle — real geometry is not needed
  // to exercise point-in-polygon semantics.
  return {
    type: 'Feature',
    properties: {
      tam_code: '300107',
      tam_th: 'โคกกรวด',
      amp_code: '3001',
      amp_th: 'เมืองนครราชสีมา',
      pro_code: '30',
      pro_th: 'นครราชสีมา',
    },
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [101.94, 14.96],
          [102.02, 14.96],
          [102.02, 15.02],
          [101.94, 15.02],
          [101.94, 14.96],
        ],
      ],
    },
  };
}

describe('AdminBoundaryLookupService', () => {
  it('resolves a pin inside ตำบลโคกกรวด to the expected triple', () => {
    const svc = new AdminBoundaryLookupService();
    svc._setIndexForTest([khokKruatFeature() as any]);

    const result = svc.resolveAdminBoundary(14.99, 101.98);
    expect(result).not.toBeNull();
    expect(result?.tambonCode).toBe('300107');
    expect(result?.tambonName).toBe('โคกกรวด');
    expect(result?.amphoeCode).toBe('3001');
    expect(result?.amphoeName).toBe('เมืองนครราชสีมา');
    expect(result?.changwatCode).toBe('30');
    expect(result?.changwatName).toBe('นครราชสีมา');
  });

  it('returns null for a pin at (0, 0)', () => {
    const svc = new AdminBoundaryLookupService();
    svc._setIndexForTest([khokKruatFeature() as any]);
    expect(svc.resolveAdminBoundary(0, 0)).toBeNull();
  });

  it('returns null for a pin in Bangkok (outside NR)', () => {
    const svc = new AdminBoundaryLookupService();
    svc._setIndexForTest([khokKruatFeature() as any]);
    // Bangkok center ~13.75, 100.50 — well outside the seeded polygon.
    expect(svc.resolveAdminBoundary(13.75, 100.5)).toBeNull();
  });

  it('returns null for non-finite coordinates', () => {
    const svc = new AdminBoundaryLookupService();
    svc._setIndexForTest([khokKruatFeature() as any]);
    expect(svc.resolveAdminBoundary(Number.NaN, 101.98)).toBeNull();
    expect(
      svc.resolveAdminBoundary(14.99, Number.POSITIVE_INFINITY),
    ).toBeNull();
    expect(
      svc.resolveAdminBoundary(Number.NEGATIVE_INFINITY, 101.98),
    ).toBeNull();
  });

  it('drops features with missing required properties (fail-open per-feature)', () => {
    const svc = new AdminBoundaryLookupService();
    svc._setIndexForTest([
      {
        type: 'Feature',
        properties: {
          // tam_th missing
          tam_code: '300107',
          amp_code: '3001',
          amp_th: 'เมืองนครราชสีมา',
          pro_code: '30',
          pro_th: 'นครราชสีมา',
        },
        geometry: khokKruatFeature().geometry,
      } as any,
    ]);
    // Dropped feature means empty index => null for every lookup.
    expect(svc.resolveAdminBoundary(14.99, 101.98)).toBeNull();
  });

  it('boots cleanly when GeoJSON file is missing (fail-open)', () => {
    // Point cwd to a directory that has no geojson/ tree so the
    // service`s fs read fails and we fall into the catch branch.
    const origCwd = process.cwd;
    process.cwd = () => '/tmp/__non_existent_admin_boundary_root__';
    try {
      const svc = new AdminBoundaryLookupService();
      svc.onModuleInit();
      expect(svc.resolveAdminBoundary(14.99, 101.98)).toBeNull();
    } finally {
      process.cwd = origCwd;
    }
  });

  it('returns null when index has zero polygons', () => {
    const svc = new AdminBoundaryLookupService();
    svc._setIndexForTest([]);
    expect(svc.resolveAdminBoundary(14.99, 101.98)).toBeNull();
  });

  it('keeps first-match-wins when multiple polygons are indexed', () => {
    const svc = new AdminBoundaryLookupService();
    const second = {
      ...khokKruatFeature(),
      properties: {
        ...khokKruatFeature().properties,
        tam_code: '300199',
        tam_th: 'อื่น',
      },
    };
    svc._setIndexForTest([khokKruatFeature() as any, second as any]);
    const result = svc.resolveAdminBoundary(14.99, 101.98);
    // First inserted feature wins.
    expect(result?.tambonCode).toBe('300107');
    expect(result?.tambonName).toBe('โคกกรวด');
  });
});
