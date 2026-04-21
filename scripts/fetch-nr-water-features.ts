/**
 * fetch-nr-water-features.ts — Wave 33.7 N1
 *
 * One-shot extractor that queries the OpenStreetMap Overpass API for
 * water bodies within Nakhon Ratchasima province (ISO3166-2="TH-30")
 * and rewrites `backend/geojson/nakhon-ratchasima-features.json` with
 * comprehensive coverage. Replaces the hand-seeded Wave 29 starter set
 * (5 reservoirs) so `GeoFeatureLookupService.resolveFeatureForPoint`
 * can answer correctly for pins like 14.9040, 101.9950.
 *
 * Contract (mirrors `extract-nr-tambons.ts`):
 *  - Script is idempotent: re-running overwrites the JSON in place.
 *  - Fails LOUD on:
 *      - network / HTTP error,
 *      - empty Overpass response,
 *      - post-transform feature count < MIN_FEATURES,
 *      - malformed JSON.
 *  - Output schema matches the shape consumed by
 *    `GeoFeatureLookupService.toIndexedFeature`:
 *      properties = { featureId, nameTh, featureType, categoryLabel, sourceRef }
 *      geometry   = Polygon | MultiPolygon
 *    `featureType` is restricted to 'reservoir' | 'river' | 'canal'
 *    (D2: OSM `water=lake` folds into 'reservoir').
 *  - ODbL attribution preserved in the FeatureCollection `description`
 *    (legal requirement for consuming OSM data).
 *
 * Linear geometry policy:
 *  - Overpass returns many ways/relations with open (unclosed) rings
 *    representing rivers and canals as LineStrings. Point-in-polygon
 *    cannot match LineStrings directly. This wave SKIPS pure linear
 *    unclosed geometries (documented in JSON description). Wave 30
 *    conflict rules focus on water-body-vs-road which is dominated by
 *    polygons; linear buffer generation is deferred to a future wave.
 *
 * Security (§17.9):
 *  - OSM tag values are NFC-normalized, stripped of control chars,
 *    and capped at 120 chars before emission.
 *  - No user input reaches the Overpass body; query is hard-coded.
 *  - No npm deps added; uses native Node 18+ `fetch`.
 *
 * Run: `npx tsx backend/scripts/fetch-nr-water-features.ts`
 *  (or) `npx ts-node backend/scripts/fetch-nr-water-features.ts`
 */
import * as fs from 'fs';
import * as path from 'path';

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const OUT_DIR = path.resolve(__dirname, '../geojson');
const OUT = path.resolve(OUT_DIR, 'nakhon-ratchasima-features.json');
const MIN_FEATURES = 20;
const SOURCE_REF = 'osm-overpass-wave33-7';
const MAX_NAME_LEN = 120;

const QUERY = `[out:json][timeout:180];
area["ISO3166-2"="TH-30"]->.nkrm;
(
  way["natural"="water"](area.nkrm);
  way["water"="reservoir"](area.nkrm);
  way["water"="lake"](area.nkrm);
  way["waterway"="canal"](area.nkrm);
  way["waterway"="river"](area.nkrm);
  relation["natural"="water"](area.nkrm);
  relation["water"="reservoir"](area.nkrm);
  relation["water"="lake"](area.nkrm);
);
out geom;`;

type FeatureType = 'reservoir' | 'river' | 'canal';

interface OverpassNode {
  lat: number;
  lon: number;
}

interface OverpassMember {
  type: string;
  role?: string;
  geometry?: OverpassNode[];
}

interface OverpassElement {
  type: 'way' | 'relation' | string;
  id: number;
  geometry?: OverpassNode[];
  members?: OverpassMember[];
  tags?: Record<string, string>;
}

interface OverpassResponse {
  elements?: OverpassElement[];
}

interface Properties {
  featureId: string;
  nameTh: string;
  featureType: FeatureType;
  categoryLabel: string;
  sourceRef: string;
}

interface PolygonGeom {
  type: 'Polygon';
  coordinates: number[][][];
}

interface MultiPolygonGeom {
  type: 'MultiPolygon';
  coordinates: number[][][][];
}

interface GeoFeature {
  type: 'Feature';
  properties: Properties;
  geometry: PolygonGeom | MultiPolygonGeom;
}

interface FeatureCollection {
  type: 'FeatureCollection';
  name: string;
  description: string;
  crs: { type: 'name'; properties: { name: string } };
  features: GeoFeature[];
}

function normalizeText(input: string | undefined, fallback: string): string {
  if (typeof input !== 'string') return fallback;
  // NFC normalize and strip control chars (C0 + DEL).
  const cleaned = input
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim();
  if (cleaned.length === 0) return fallback;
  return cleaned.length > MAX_NAME_LEN
    ? cleaned.slice(0, MAX_NAME_LEN)
    : cleaned;
}

function classifyTags(
  tags: Record<string, string> | undefined,
): { type: FeatureType; label: string } | null {
  if (!tags) return null;
  // Order matters: waterway overrides more general natural=water.
  if (tags.waterway === 'river') {
    return { type: 'river', label: 'แม่น้ำ' };
  }
  if (tags.waterway === 'canal') {
    return { type: 'canal', label: 'คลอง' };
  }
  if (tags.water === 'reservoir') {
    return { type: 'reservoir', label: 'แหล่งน้ำผิวดิน' };
  }
  if (tags.water === 'lake') {
    // D2: fold lake into reservoir.
    return { type: 'reservoir', label: 'แหล่งน้ำผิวดิน' };
  }
  if (tags.natural === 'water') {
    return { type: 'reservoir', label: 'แหล่งน้ำผิวดิน' };
  }
  return null;
}

function pickName(tags: Record<string, string> | undefined): string {
  const nameTh = tags?.['name:th'];
  const name = tags?.['name'];
  return normalizeText(nameTh || name, 'แหล่งน้ำ');
}

function isRingClosed(nodes: OverpassNode[]): boolean {
  if (!Array.isArray(nodes) || nodes.length < 4) return false;
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (!first || !last) return false;
  return first.lat === last.lat && first.lon === last.lon;
}

function nodesToRing(nodes: OverpassNode[]): number[][] | null {
  if (!isRingClosed(nodes)) return null;
  const ring: number[][] = [];
  for (const n of nodes) {
    if (
      typeof n?.lat !== 'number' ||
      typeof n?.lon !== 'number' ||
      !Number.isFinite(n.lat) ||
      !Number.isFinite(n.lon)
    ) {
      return null;
    }
    ring.push([n.lon, n.lat]);
  }
  return ring.length >= 4 ? ring : null;
}

function wayToPolygon(el: OverpassElement): PolygonGeom | null {
  const ring = nodesToRing(el.geometry ?? []);
  if (!ring) return null;
  return { type: 'Polygon', coordinates: [ring] };
}

/**
 * Relations may carry multiple outer rings (MultiPolygon) and inner
 * rings (holes). We group by role: each `outer` becomes its own polygon,
 * `inner` members attach as holes to the polygon they fall inside.
 *
 * For simplicity and to avoid bringing in a geometry lib, we attach
 * every inner ring to the first outer. This is a conservative
 * approximation — point-in-polygon still works correctly because
 * `GeoFeatureLookupService` uses outer-ring containment with hole
 * exclusion. Worst case: a point over a hole in a secondary outer
 * still resolves to the feature, which is acceptable for advisory
 * ground-truth lookup (§17.2).
 */
function relationToMultiPolygon(
  el: OverpassElement,
): PolygonGeom | MultiPolygonGeom | null {
  const members = el.members ?? [];
  const outers: number[][][][] = [];
  const inners: number[][][] = [];
  for (const m of members) {
    if (m.type !== 'way' || !Array.isArray(m.geometry)) continue;
    const ring = nodesToRing(m.geometry);
    if (!ring) continue;
    if (m.role === 'inner') {
      inners.push(ring);
    } else {
      // Default / 'outer'.
      outers.push([ring]);
    }
  }
  if (outers.length === 0) return null;
  if (inners.length > 0 && outers[0]) {
    for (const hole of inners) outers[0].push(hole);
  }
  if (outers.length === 1 && outers[0]) {
    return { type: 'Polygon', coordinates: outers[0] };
  }
  return { type: 'MultiPolygon', coordinates: outers };
}

function sampleCoord(
  geom: PolygonGeom | MultiPolygonGeom,
): [number, number] | null {
  if (geom.type === 'Polygon') {
    const pt = geom.coordinates?.[0]?.[0];
    if (!pt || pt.length < 2) return null;
    const [lng, lat] = pt as [number, number];
    return [lng, lat];
  }
  const pt = geom.coordinates?.[0]?.[0]?.[0];
  if (!pt || pt.length < 2) return null;
  const [lng, lat] = pt as [number, number];
  return [lng, lat];
}

function coordsWithinThailand(lng: number, lat: number): boolean {
  return lat >= 5 && lat <= 21 && lng >= 96 && lng <= 106;
}

async function fetchOverpass(): Promise<OverpassResponse> {
  if (typeof fetch !== 'function') {
    throw new Error(
      'Global fetch() unavailable — Node 18+ required. No new npm deps allowed.',
    );
  }
  const body = `data=${encodeURIComponent(QUERY)}`;
  const res = await fetch(OVERPASS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'project-bank-wave33.7/fetch-nr-water-features',
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `Overpass HTTP ${res.status} ${res.statusText}: ${text.slice(0, 500)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch (err) {
    throw new Error(
      `Overpass returned non-JSON body: ${(err as Error).message}`,
    );
  }
  return parsed as OverpassResponse;
}

async function main(): Promise<void> {
  console.log('Fetching NR water features from Overpass API...');
  const data = await fetchOverpass();
  const elements = Array.isArray(data.elements) ? data.elements : [];
  console.log(`Received ${elements.length} raw OSM elements`);
  if (elements.length === 0) {
    throw new Error(
      'Overpass returned zero elements; query or network is broken',
    );
  }

  const features: GeoFeature[] = [];
  const seenIds = new Set<string>();
  const counters = {
    droppedNoTags: 0,
    droppedLinear: 0,
    droppedNoGeom: 0,
    droppedOutsideBounds: 0,
    duplicateCollisions: 0,
  };

  for (const el of elements) {
    const cls = classifyTags(el.tags);
    if (!cls) {
      counters.droppedNoTags++;
      continue;
    }

    let geometry: PolygonGeom | MultiPolygonGeom | null = null;
    if (el.type === 'way') {
      const asPoly = wayToPolygon(el);
      if (asPoly) {
        geometry = asPoly;
      } else {
        // Linear / unclosed way — skip per JSDoc policy.
        counters.droppedLinear++;
        continue;
      }
    } else if (el.type === 'relation') {
      geometry = relationToMultiPolygon(el);
      if (!geometry) {
        counters.droppedNoGeom++;
        continue;
      }
    } else {
      counters.droppedNoGeom++;
      continue;
    }

    const sample = sampleCoord(geometry);
    if (!sample || !coordsWithinThailand(sample[0], sample[1])) {
      counters.droppedOutsideBounds++;
      continue;
    }

    // Unique featureId: `osm-<type>-<id>`, collision-free by OSM id.
    let featureId = `osm-${el.type}-${el.id}`;
    if (seenIds.has(featureId)) {
      counters.duplicateCollisions++;
      featureId = `${featureId}-${features.length}`;
    }
    seenIds.add(featureId);

    features.push({
      type: 'Feature',
      properties: {
        featureId,
        nameTh: pickName(el.tags),
        featureType: cls.type,
        categoryLabel: cls.label,
        sourceRef: SOURCE_REF,
      },
      geometry,
    });
  }

  const byType = features.reduce<Record<string, number>>((acc, f) => {
    acc[f.properties.featureType] = (acc[f.properties.featureType] || 0) + 1;
    return acc;
  }, {});

  console.log(
    `Transformed ${features.length} features ` +
      `(reservoir=${byType.reservoir ?? 0}, river=${byType.river ?? 0}, canal=${byType.canal ?? 0}). ` +
      `Dropped: ${counters.droppedNoTags} no-tags, ${counters.droppedLinear} linear, ` +
      `${counters.droppedNoGeom} no-geom, ${counters.droppedOutsideBounds} out-of-bounds, ` +
      `${counters.duplicateCollisions} id-collisions-renamed.`,
  );

  if (features.length < MIN_FEATURES) {
    throw new Error(
      `Expected >= ${MIN_FEATURES} water-body polygons; got ${features.length}`,
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const collection: FeatureCollection = {
    type: 'FeatureCollection',
    name: 'nakhon-ratchasima-features',
    description:
      `Wave 33.7 comprehensive Nakhon Ratchasima water-body layer. ` +
      `Source: OpenStreetMap via Overpass API. ` +
      `License: ODbL — © OpenStreetMap contributors. ` +
      `See https://www.openstreetmap.org/copyright. ` +
      `Covers reservoirs, lakes (folded into 'reservoir' featureType), rivers, ` +
      `and canals within ISO3166-2=TH-30. Geometries preserved as-is from OSM; ` +
      `linear unclosed waterways were skipped for this wave. ` +
      `Generated by backend/scripts/fetch-nr-water-features.ts on ${today}.`,
    crs: {
      type: 'name',
      properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' },
    },
    features,
  };

  if (!fs.existsSync(OUT_DIR)) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
  }
  fs.writeFileSync(OUT, JSON.stringify(collection, null, 2) + '\n', 'utf8');
  console.log(
    `Wrote ${features.length} water-body features ` +
      `(reservoir=${byType.reservoir ?? 0}, river=${byType.river ?? 0}, canal=${byType.canal ?? 0}) ` +
      `to ${OUT}`,
  );
}

main().catch((err) => {
  console.error('FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
