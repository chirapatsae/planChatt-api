import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

type PolygonGeometry =
  | {
      type: 'Polygon';
      coordinates: number[][][];
    }
  | {
      type: 'MultiPolygon';
      coordinates: number[][][][];
    };

type DistrictFeature = {
  type: 'Feature';
  geometry: PolygonGeometry | null;
  properties?: Record<string, any>;
};

type DistrictFeatureCollection = {
  type: 'FeatureCollection';
  features: DistrictFeature[];
};

@Injectable()
export class GeoBoundaryService {
  private readonly logger = new Logger(GeoBoundaryService.name);
  private readonly featuresByAmphoe = new Map<string, DistrictFeature[]>();

  constructor() {
    this.loadBoundaryData();
  }

  private loadBoundaryData(): void {
    try {
      const geoJsonPath = path.resolve(
        process.cwd(),
        'geojson',
        'nakhon-ratchasima-districts.json',
      );
      const raw = fs.readFileSync(geoJsonPath, 'utf-8');
      const parsed = JSON.parse(raw) as DistrictFeatureCollection;

      if (!Array.isArray(parsed.features)) {
        this.logger.warn('GeoJSON file does not contain a features array');
        return;
      }

      parsed.features.forEach((feature) => {
        if (!feature || !feature.geometry) {
          return;
        }

        const properties = feature.properties ?? {};
        const amphoeCode =
          properties.AMPHOE_CODE ??
          properties.AMP_CODE ??
          properties.DISTRICT_ID ??
          properties.district_id;

        if (!amphoeCode) {
          return;
        }

        const key = String(amphoeCode).trim();
        if (!key) {
          return;
        }

        if (!this.featuresByAmphoe.has(key)) {
          this.featuresByAmphoe.set(key, []);
        }
        this.featuresByAmphoe.get(key)!.push(feature as DistrictFeature);
      });

      this.logger.log(
        `Loaded GeoJSON boundary data. Amphoes indexed: ${this.featuresByAmphoe.size}`,
      );
    } catch (error) {
      this.logger.error(
        `Cannot load geo boundary data: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  /**
   * @returns true  - จุดอยู่ในอำเภอ
   *          false - จุดอยู่นอกอำเภอ
   *          null  - ไม่พบข้อมูลอำเภอหรือพิกัดไม่ถูกต้อง
   */
  isPointInsideAmphoe(
    lat: number,
    lng: number,
    amphoeId?: number | string,
  ): boolean | null {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return null;
    }
    if (amphoeId === undefined || amphoeId === null) {
      return null;
    }

    const key = String(amphoeId).trim();
    if (!key) {
      return null;
    }

    const features = this.featuresByAmphoe.get(key);
    if (!features || features.length === 0) {
      return null;
    }

    const lon = lng;

    for (const feature of features) {
      if (!feature.geometry) {
        continue;
      }
      if (this.isPointInsideGeometry(lon, lat, feature.geometry)) {
        return true;
      }
    }

    return false;
  }

  private isPointInsideGeometry(
    lon: number,
    lat: number,
    geometry: PolygonGeometry | null,
  ): boolean {
    if (!geometry) {
      return false;
    }
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
    if (!polygon.length) {
      return false;
    }

    const [outerRing, ...holes] = polygon;

    if (!this.isPointInRing(lon, lat, outerRing)) {
      return false;
    }

    // ถ้าจุดอยู่ในรู (hole) ให้ถือว่านอกพื้นที่
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
      if (denominator === 0) {
        continue;
      }

      const intersect =
        yi > lat !== yj > lat &&
        lon < ((xj - xi) * (lat - yi)) / denominator + xi;

      if (intersect) {
        inside = !inside;
      }
    }

    return inside;
  }
}

