import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { GeoBoundaryService } from './geo-boundary.service';

export interface NearbyProject {
  title: string;
  distanceKm: number;
}

/**
 * Canonical area-type enum emitted by CoordinateContextService.
 *
 * Migration from legacy values:
 *   - 'empty'     -> 'other'
 *   - 'rural'     -> 'agricultural'
 *   - 'community' -> 'community' (unchanged)
 *
 * Added canonical values:
 *   - 'urban'     — high-density built-up areas / municipal cores
 *   - 'water'     — rivers / lakes / canals / reservoirs
 *   - 'forest'    — forested / protected forest zones
 *
 * Per CLAUDE.md §13, this is a SOFT signal — MUST NOT block save / submit.
 */
export type InferredAreaType =
  | 'agricultural'
  | 'urban'
  | 'water'
  | 'forest'
  | 'community'
  | 'other'
  | null;

export interface CoordinateContext {
  isInsideBoundary: boolean | null;
  nearbyProjects: NearbyProject[];
  densityCounts: {
    within1km: number;
    within3km: number;
    within10km: number;
  };
  nearestProjectDistanceKm: number | null;
  isLikelyEmptyArea: boolean;
  inferredAreaType: InferredAreaType;
}

// --- Internal GeoJSON typings (minimal; mirrors GeoBoundaryService) -----

type PolygonGeometry =
  | { type: 'Polygon'; coordinates: number[][][] }
  | { type: 'MultiPolygon'; coordinates: number[][][][] };

type LandUseFeature = {
  type: 'Feature';
  geometry: PolygonGeometry | null;
  properties?: Record<string, any>;
};

type LandUseFeatureCollection = {
  type: 'FeatureCollection';
  features: LandUseFeature[];
};

/**
 * Canonical land-use classes we care about for this classifier.
 * Other tags collapse to `other` via {@link normalizeLanduse}.
 */
type LandUseClass = 'agricultural' | 'urban' | 'water' | 'forest' | 'other';

interface LandUseEntry {
  cls: LandUseClass;
  geometry: PolygonGeometry;
}

/**
 * CoordinateContextService — extracts local-area context for a lat/lng from
 * our own project database + optional in-memory land-use overlays.
 *
 * Used by the AI advisory pipeline per
 * docs/tasks/AI_COORDINATE_CONTEXT_AWARENESS.md and
 * docs/tasks/AI_COORDINATE_AREA_TYPE_ENRICHMENT.md.
 *
 * Classification fallback chain:
 *   Layer A — land-use GeoJSON PIP (if any *.geojson present under
 *             backend/geojson/land-use/) — yields urban / water / forest /
 *             agricultural directly.
 *   Layer B — density heuristic against our own project rows
 *             (community if >5 nearby, else agricultural if inside amphoe).
 *   Layer C — 'other' fallback.
 *
 * CLAUDE.md §13 compliance:
 *   - This is a *soft* signal for advisory only.
 *   - MUST NOT block save / submit.
 *   - Errors are caught and logged at warn level; callers fall back gracefully.
 *   - No external HTTP calls at request time — all data is in-memory.
 */
@Injectable()
export class CoordinateContextService {
  private readonly logger = new Logger(CoordinateContextService.name);

  // Bounding-box prefilter: ~0.1° ≈ 11km square around the point.
  private readonly BBOX_DELTA_DEG = 0.1;

  // Earth radius in km for Haversine.
  private readonly EARTH_RADIUS_KM = 6371;

  // In-memory land-use overlay (Layer A). Empty when no files shipped.
  private readonly landUseFeatures: LandUseEntry[] = [];

  constructor(
    @InjectRepository(ProjectGroup)
    private readonly projectRepo: Repository<ProjectGroup>,
    private readonly geoBoundaryService: GeoBoundaryService,
  ) {
    this.loadLandUseLayers();
  }

  /**
   * Cold-load all land-use GeoJSON files from backend/geojson/land-use/.
   * Missing directory is non-fatal — classifier falls through to Layer B/C.
   */
  private loadLandUseLayers(): void {
    const started = Date.now();
    try {
      const dir = path.resolve(process.cwd(), 'geojson', 'land-use');
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        this.logger.log(
          'Land-use overlay directory not found; area-type classifier will use density fallback only.',
        );
        return;
      }

      const entries = fs.readdirSync(dir);
      for (const entry of entries) {
        if (!entry.toLowerCase().endsWith('.geojson')) continue;
        const full = path.join(dir, entry);
        try {
          const raw = fs.readFileSync(full, 'utf-8');
          const parsed = JSON.parse(raw) as LandUseFeatureCollection;
          if (!parsed || !Array.isArray(parsed.features)) continue;

          for (const feature of parsed.features) {
            if (!feature || !feature.geometry) continue;
            const cls = this.normalizeLanduse(feature.properties);
            if (!cls || cls === 'other') continue;
            this.landUseFeatures.push({ cls, geometry: feature.geometry });
          }
        } catch (fileError) {
          this.logger.warn(
            `Failed to parse land-use file ${entry}: ${fileError instanceof Error ? fileError.message : fileError}`,
          );
        }
      }

      this.logger.log(
        `Loaded ${this.landUseFeatures.length} land-use polygons in ${Date.now() - started}ms`,
      );
    } catch (error) {
      this.logger.warn(
        `Cannot load land-use overlays: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  /**
   * Map common GeoJSON tags (OSM / GISTDA style) to canonical area classes.
   */
  private normalizeLanduse(
    properties: Record<string, any> | undefined,
  ): LandUseClass | null {
    if (!properties) return null;
    const raw = (
      properties.landuse ??
      properties.LANDUSE ??
      properties.area_type ??
      properties.AREA_TYPE ??
      properties.class ??
      properties.CLASS ??
      ''
    )
      .toString()
      .trim()
      .toLowerCase();
    if (!raw) return null;

    if (
      raw === 'agricultural' ||
      raw === 'agriculture' ||
      raw === 'farmland' ||
      raw === 'farm' ||
      raw === 'orchard' ||
      raw === 'paddy'
    ) {
      return 'agricultural';
    }
    if (
      raw === 'urban' ||
      raw === 'residential' ||
      raw === 'commercial' ||
      raw === 'industrial' ||
      raw === 'municipality' ||
      raw === 'built_up' ||
      raw === 'builtup'
    ) {
      return 'urban';
    }
    if (
      raw === 'water' ||
      raw === 'reservoir' ||
      raw === 'river' ||
      raw === 'lake' ||
      raw === 'canal' ||
      raw === 'pond'
    ) {
      return 'water';
    }
    if (
      raw === 'forest' ||
      raw === 'wood' ||
      raw === 'national_park' ||
      raw === 'protected_forest'
    ) {
      return 'forest';
    }
    return 'other';
  }

  async getCoordinateContext(
    lat: number,
    lng: number,
    amphoeId?: string,
  ): Promise<CoordinateContext> {
    const empty: CoordinateContext = {
      isInsideBoundary: null,
      nearbyProjects: [],
      densityCounts: { within1km: 0, within3km: 0, within10km: 0 },
      nearestProjectDistanceKm: null,
      isLikelyEmptyArea: false,
      inferredAreaType: null,
    };

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return empty;
    }

    try {
      // Boundary check (amphoe polygon lookup, optional).
      if (amphoeId) {
        empty.isInsideBoundary = this.geoBoundaryService.isPointInsideAmphoe(
          lat,
          lng,
          amphoeId,
        );
      }

      // Bounding-box prefilter: pull candidate rows in a ~11km box.
      const minLat = lat - this.BBOX_DELTA_DEG;
      const maxLat = lat + this.BBOX_DELTA_DEG;
      const minLng = lng - this.BBOX_DELTA_DEG;
      const maxLng = lng + this.BBOX_DELTA_DEG;

      const candidates = await this.projectRepo
        .createQueryBuilder('pg')
        .select(['pg.id', 'pg.title', 'pg.startLat', 'pg.startLng'])
        .where('pg.deletedAt IS NULL')
        .andWhere('pg.startLat IS NOT NULL')
        .andWhere('pg.startLng IS NOT NULL')
        .andWhere('pg.startLat BETWEEN :minLat AND :maxLat', { minLat, maxLat })
        .andWhere('pg.startLng BETWEEN :minLng AND :maxLng', { minLng, maxLng })
        .limit(500)
        .getMany();

      const scored: NearbyProject[] = [];
      let within1km = 0;
      let within3km = 0;
      let within10km = 0;
      let nearest: number | null = null;

      for (const candidate of candidates) {
        const cLat =
          candidate.startLat !== null && candidate.startLat !== undefined
            ? Number(candidate.startLat)
            : NaN;
        const cLng =
          candidate.startLng !== null && candidate.startLng !== undefined
            ? Number(candidate.startLng)
            : NaN;
        if (!Number.isFinite(cLat) || !Number.isFinite(cLng)) continue;

        const distanceKm = this.haversineKm(lat, lng, cLat, cLng);
        if (nearest === null || distanceKm < nearest) nearest = distanceKm;
        if (distanceKm <= 1) within1km += 1;
        if (distanceKm <= 3) within3km += 1;
        if (distanceKm <= 10) within10km += 1;

        scored.push({ title: candidate.title, distanceKm });
      }

      scored.sort((a, b) => a.distanceKm - b.distanceKm);
      const nearbyProjects = scored.slice(0, 5);

      const isLikelyEmptyArea = nearest === null || nearest > 5;

      const inferredAreaType = this.classifyAreaType({
        lat,
        lng,
        amphoeId,
        within3km,
        isLikelyEmptyArea,
        isInsideBoundary: empty.isInsideBoundary,
      });

      return {
        isInsideBoundary: empty.isInsideBoundary,
        nearbyProjects,
        densityCounts: { within1km, within3km, within10km },
        nearestProjectDistanceKm: nearest,
        isLikelyEmptyArea,
        inferredAreaType,
      };
    } catch (error) {
      this.logger.warn(
        `Failed to compute coordinate context: ${error instanceof Error ? error.message : error}`,
      );
      return empty;
    }
  }

  /**
   * Run the layered classification strategy.
   *
   *   Layer A — land-use overlay PIP (if any polygons loaded).
   *   Layer B — density heuristic + amphoe boundary (existing signal).
   *   Layer C — 'other' fallback.
   *
   * Returns `null` only when classification raises unexpectedly (caller
   * already wraps in try/catch, so this path is defensive).
   */
  private classifyAreaType(input: {
    lat: number;
    lng: number;
    amphoeId?: string;
    within3km: number;
    isLikelyEmptyArea: boolean;
    isInsideBoundary: boolean | null;
  }): InferredAreaType {
    try {
      // Layer A — land-use polygon hit.
      const landuseHit = this.classifyByLandUse(input.lat, input.lng);
      if (landuseHit) return landuseHit;

      // Layer B — density / boundary heuristic.
      if (input.within3km > 5) {
        return 'community';
      }
      if (input.isInsideBoundary === true) {
        return 'agricultural';
      }
      if (input.within3km >= 1) {
        // Sparse but some activity — treat as agricultural default.
        return 'agricultural';
      }

      // Layer C — nothing to go on.
      return 'other';
    } catch (error) {
      this.logger.warn(
        `Area-type classification failed: ${error instanceof Error ? error.message : error}`,
      );
      return 'other';
    }
  }

  /**
   * Layer A — point-in-polygon over loaded land-use overlays.
   * Priority order: water > forest > urban > agricultural
   * (water trumps everything so a lake inside a forest resolves to 'water').
   */
  private classifyByLandUse(
    lat: number,
    lng: number,
  ): Exclude<InferredAreaType, null | 'community' | 'other'> | null {
    if (this.landUseFeatures.length === 0) return null;

    const priority: Record<LandUseClass, number> = {
      water: 4,
      forest: 3,
      urban: 2,
      agricultural: 1,
      other: 0,
    };

    let winner: LandUseClass | null = null;
    for (const feature of this.landUseFeatures) {
      if (!this.isPointInsideGeometry(lng, lat, feature.geometry)) continue;
      if (winner === null || priority[feature.cls] > priority[winner]) {
        winner = feature.cls;
      }
    }

    if (!winner || winner === 'other') return null;
    return winner;
  }

  /**
   * Haversine great-circle distance in kilometres.
   */
  private haversineKm(
    lat1: number,
    lng1: number,
    lat2: number,
    lng2: number,
  ): number {
    const toRad = (deg: number): number => (deg * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return this.EARTH_RADIUS_KM * c;
  }

  // --- Local PIP helpers (kept in-sync with GeoBoundaryService ring parity) ---

  private isPointInsideGeometry(
    lon: number,
    lat: number,
    geometry: PolygonGeometry | null,
  ): boolean {
    if (!geometry) return false;
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
    // Point inside a hole counts as outside the polygon.
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
}
