/**
 * GeoFeatureLookupService — Wave 29 N1
 *
 * Deterministic ground-truth land-use resolver used by the LAO
 * ISSUE_BASED AddProject AI generate pipeline to avoid hallucinated
 * narration (e.g. "พื้นที่เกษตรกรรม" when the pin is actually on a
 * reservoir).
 *
 * Contract:
 *   - Loads `backend/geojson/nakhon-ratchasima-features.json` at boot
 *   - Fails OPEN on read / parse errors — logs a warning, keeps the
 *     index empty, and `resolveFeatureForPoint` returns `null` for all
 *     subsequent calls. The request path MUST NEVER throw because of
 *     this service (§17.2 advisory-only).
 *   - Inline ray-casting point-in-polygon (matches
 *     `GeoBoundaryService` convention — no new npm deps).
 *   - Read-only; no mutation paths; no FK into project tables
 *     (§17.3 audit separation).
 *
 * Scope gate: the caller (AiService.buildIssueBasedPrompt) is
 * responsible for restricting this lookup to the ISSUE_BASED LAO
 * path. This service is surface-agnostic.
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

export type ResolvedFeatureType = 'reservoir' | 'river' | 'canal';

export interface ResolvedFeature {
  featureId: string;
  nameTh: string;
  featureType: ResolvedFeatureType;
  categoryLabel: string;
  sourceRef?: string;
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

interface IndexedFeature {
  resolved: ResolvedFeature;
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

const VALID_FEATURE_TYPES: ReadonlySet<ResolvedFeatureType> = new Set([
  'reservoir',
  'river',
  'canal',
]);

@Injectable()
export class GeoFeatureLookupService implements OnModuleInit {
  private readonly logger = new Logger(GeoFeatureLookupService.name);
  private index: IndexedFeature[] = [];

  onModuleInit(): void {
    this.loadFeatureData();
  }

  private loadFeatureData(): void {
    try {
      const geoJsonPath = path.resolve(
        process.cwd(),
        'geojson',
        'nakhon-ratchasima-features.json',
      );
      const raw = fs.readFileSync(geoJsonPath, 'utf-8');
      const parsed = JSON.parse(raw) as RawFeatureCollection;

      if (!parsed || !Array.isArray(parsed.features)) {
        this.logger.warn(
          'Feature GeoJSON has no features[]; fail-open with empty index',
        );
        return;
      }

      const next: IndexedFeature[] = [];
      for (const feature of parsed.features) {
        const entry = this.toIndexedFeature(feature);
        if (entry) {
          next.push(entry);
        }
      }
      this.index = next;
      this.logger.log(
        `Loaded feature GeoJSON. Features indexed: ${this.index.length}`,
      );
    } catch (error) {
      // Fail-open: empty index, all lookups return null.
      this.logger.warn(
        `Cannot load feature GeoJSON (fail-open): ${error instanceof Error ? error.message : error}`,
      );
      this.index = [];
    }
  }

  private toIndexedFeature(feature: RawFeature | null): IndexedFeature | null {
    if (!feature || !feature.geometry) {
      return null;
    }
    const geometry = feature.geometry;
    if (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon') {
      return null;
    }

    const props = feature.properties ?? {};
    const featureId = this.asNonEmptyString(props.featureId);
    const nameTh = this.asNonEmptyString(props.nameTh);
    const rawType = this.asNonEmptyString(props.featureType);
    const categoryLabel = this.asNonEmptyString(props.categoryLabel);

    if (!featureId || !nameTh || !rawType || !categoryLabel) {
      return null;
    }
    if (!VALID_FEATURE_TYPES.has(rawType as ResolvedFeatureType)) {
      return null;
    }

    const sourceRef = this.asNonEmptyString(props.sourceRef);

    return {
      geometry,
      resolved: {
        featureId,
        nameTh,
        featureType: rawType as ResolvedFeatureType,
        categoryLabel,
        ...(sourceRef ? { sourceRef } : {}),
      },
    };
  }

  private asNonEmptyString(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  /**
   * Resolve which indexed feature polygon contains a given lat/lng.
   *
   * Returns the first matching feature (linear scan — index is small,
   * < 100 rows for Wave 29). Returns `null` on:
   *   - missing / malformed GeoJSON (fail-open)
   *   - non-finite coordinates
   *   - no polygon contains the point
   */
  resolveFeatureForPoint(lat: number, lng: number): ResolvedFeature | null {
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
   * Not exported from the module public API; spec files import the
   * class directly. Kept package-private-by-convention.
   */
  _setIndexForTest(features: RawFeature[]): void {
    const next: IndexedFeature[] = [];
    for (const f of features) {
      const e = this.toIndexedFeature(f);
      if (e) next.push(e);
    }
    this.index = next;
  }
}
