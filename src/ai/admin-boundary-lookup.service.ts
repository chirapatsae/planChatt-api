/**
 * AdminBoundaryLookupService — Wave 31 N2
 *
 * Deterministic reverse-geocoder that resolves an arbitrary (lat, lng)
 * pin inside Nakhon Ratchasima to its tambon + amphoe + changwat
 * triple. Used by the ISSUE_BASED LAO AddProject AI generate pipeline
 * to anchor the LLM to real administrative names and prevent
 * hallucinated tambon / amphoe references.
 *
 * Contract (mirrors Wave 29 `GeoFeatureLookupService`):
 *   - Loads `backend/geojson/nakhon-ratchasima-tambons.json` at boot
 *   - Fails OPEN on read / parse errors — logs a warning, keeps the
 *     index empty, and `resolveAdminBoundary` returns `null` for all
 *     subsequent calls. The request path MUST NEVER throw because of
 *     this service (§17.2 advisory-only).
 *   - Inline ray-casting point-in-polygon (matches
 *     `GeoFeatureLookupService` convention — no new npm deps).
 *   - MultiPolygon supported; holes respected.
 *   - Read-only; no mutation paths; no FK into project tables
 *     (§17.3 audit separation).
 *
 * Scope gate: the caller (AiService.generateProjectDetail) is
 * responsible for restricting this lookup to the ISSUE_BASED LAO
 * path. This service is surface-agnostic.
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

export interface ResolvedAdminBoundary {
  tambonCode: string;
  tambonName: string;
  amphoeCode: string;
  amphoeName: string;
  changwatCode: string;
  changwatName: string;
}

type PolygonGeometry =
  | {
      type: 'Polygon';
      coordinates: number[][][];
    }
  | {
      type: 'MultiPolygon';
      coordinates: number[][][][];
    };

interface IndexedBoundary {
  resolved: ResolvedAdminBoundary;
  geometry: PolygonGeometry;
}

interface RawFeature {
  type?: string;
  geometry?: PolygonGeometry | null;
  properties?: Record<string, unknown>;
}

interface RawFeatureCollection {
  type?: string;
  features?: RawFeature[];
}

@Injectable()
export class AdminBoundaryLookupService implements OnModuleInit {
  private readonly logger = new Logger(AdminBoundaryLookupService.name);
  private index: IndexedBoundary[] = [];

  onModuleInit(): void {
    this.loadBoundaryData();
  }

  private loadBoundaryData(): void {
    try {
      const geoJsonPath = path.resolve(
        process.cwd(),
        'geojson',
        'nakhon-ratchasima-tambons.json',
      );
      const raw = fs.readFileSync(geoJsonPath, 'utf-8');
      const parsed = JSON.parse(raw) as RawFeatureCollection;

      if (!parsed || !Array.isArray(parsed.features)) {
        this.logger.warn(
          'Admin-boundary GeoJSON has no features[]; fail-open with empty index',
        );
        return;
      }

      const next: IndexedBoundary[] = [];
      for (const feature of parsed.features) {
        const entry = this.toIndexedBoundary(feature);
        if (entry) {
          next.push(entry);
        }
      }
      this.index = next;
      this.logger.log(
        `Loaded admin-boundary GeoJSON. Tambons indexed: ${this.index.length}`,
      );
    } catch (error) {
      // Fail-open: empty index, all lookups return null.
      this.logger.warn(
        `Cannot load admin-boundary GeoJSON (fail-open): ${error instanceof Error ? error.message : error}`,
      );
      this.index = [];
    }
  }

  private toIndexedBoundary(
    feature: RawFeature | null,
  ): IndexedBoundary | null {
    if (!feature || !feature.geometry) {
      return null;
    }
    const geometry = feature.geometry;
    if (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon') {
      return null;
    }

    const props = feature.properties ?? {};
    const tambonCode = this.asNonEmptyString(props.tam_code);
    const tambonName = this.asNonEmptyString(props.tam_th);
    const amphoeCode = this.asNonEmptyString(props.amp_code);
    const amphoeName = this.asNonEmptyString(props.amp_th);
    const changwatCode = this.asNonEmptyString(props.pro_code);
    const changwatName = this.asNonEmptyString(props.pro_th);

    if (
      !tambonCode ||
      !tambonName ||
      !amphoeCode ||
      !amphoeName ||
      !changwatCode ||
      !changwatName
    ) {
      return null;
    }

    return {
      geometry,
      resolved: {
        tambonCode,
        tambonName,
        amphoeCode,
        amphoeName,
        changwatCode,
        changwatName,
      },
    };
  }

  private asNonEmptyString(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  /**
   * Resolve which tambon polygon contains the given lat/lng.
   *
   * Returns the first matching tambon (tambons should not overlap in
   * the source data, but first-match-wins is defensive). Returns
   * `null` on:
   *   - missing / malformed GeoJSON (fail-open)
   *   - non-finite coordinates
   *   - no polygon contains the point (e.g. pin outside NR)
   */
  resolveAdminBoundary(
    lat: number,
    lng: number,
  ): ResolvedAdminBoundary | null {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return null;
    }
    if (this.index.length === 0) {
      return null;
    }
    for (const entry of this.index) {
      if (this.isPointInsideGeometry(lng, lat, entry.geometry)) {
        return entry.resolved;
      }
    }
    return null;
  }

  private isPointInsideGeometry(
    lon: number,
    lat: number,
    geometry: PolygonGeometry,
  ): boolean {
    if (geometry.type === 'Polygon') {
      return this.isPointInPolygon(lon, lat, geometry.coordinates);
    }
    if (geometry.type === 'MultiPolygon') {
      return geometry.coordinates.some((polygon) =>
        this.isPointInPolygon(lon, lat, polygon),
      );
    }
    return false;
  }

  private isPointInPolygon(
    lon: number,
    lat: number,
    polygon: number[][][],
  ): boolean {
    if (!polygon.length) return false;
    const [outerRing, ...holes] = polygon;
    if (!this.isPointInRing(lon, lat, outerRing)) return false;
    return holes.every((hole) => !this.isPointInRing(lon, lat, hole));
  }

  private isPointInRing(
    lon: number,
    lat: number,
    ring: number[][],
  ): boolean {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i]?.[0];
      const yi = ring[i]?.[1];
      const xj = ring[j]?.[0];
      const yj = ring[j]?.[1];

      if (
        xi === undefined ||
        yi === undefined ||
        xj === undefined ||
        yj === undefined
      ) {
        continue;
      }

      const denominator = yj - yi;
      if (denominator === 0) continue;

      const intersect =
        yi > lat !== yj > lat &&
        lon < ((xj - xi) * (lat - yi)) / denominator + xi;

      if (intersect) inside = !inside;
    }
    return inside;
  }

  /**
   * Test-only helper: inject a preloaded feature set (bypasses fs).
   * Same pattern as Wave 29 `GeoFeatureLookupService._setIndexForTest`.
   */
  _setIndexForTest(features: RawFeature[]): void {
    const next: IndexedBoundary[] = [];
    for (const f of features) {
      const e = this.toIndexedBoundary(f);
      if (e) next.push(e);
    }
    this.index = next;
  }
}
