/**
 * extract-nr-tambons.ts — Wave 31 N2
 *
 * One-shot extractor that filters the repo-committed
 * `frontend/src/OpenGISData-Thailand-master/subdistricts.geojson`
 * down to Nakhon Ratchasima tambons (`pro_code === "30"`) and writes
 * the result to `backend/geojson/nakhon-ratchasima-tambons.json`.
 *
 * Rationale: the AI admin-boundary lookup (`AdminBoundaryLookupService`)
 * is NR-scoped for Wave 31, so we ship a trimmed artifact to keep
 * resident memory small and boot time fast.
 *
 * Run: `npx tsx backend/scripts/extract-nr-tambons.ts`
 *  (or) `npx ts-node backend/scripts/extract-nr-tambons.ts`
 *
 * Contract:
 *  - Source file MUST exist at the expected path.
 *  - Filtered feature count MUST be >= 200 (NR has ~287 tambons);
 *    otherwise the script fails loud — this is the canary that the
 *    filter or source schema changed unexpectedly.
 *  - Output is a FeatureCollection with ONLY the required properties
 *    (`tam_code, tam_th, amp_code, amp_th, pro_code, pro_th`) so the
 *    artifact stays lean.
 */
import * as fs from 'fs';
import * as path from 'path';

interface RawFeature {
  type?: string;
  properties?: {
    tam_code?: string;
    tam_th?: string;
    amp_code?: string;
    amp_th?: string;
    pro_code?: string;
    pro_th?: string;
    [k: string]: unknown;
  };
  geometry?: unknown;
}

interface RawFC {
  type?: string;
  features?: RawFeature[];
}

function main(): void {
  const SRC = path.resolve(
    __dirname,
    '../../frontend/src/OpenGISData-Thailand-master/subdistricts.geojson',
  );
  const OUT_DIR = path.resolve(__dirname, '../geojson');
  const OUT = path.resolve(OUT_DIR, 'nakhon-ratchasima-tambons.json');

  if (!fs.existsSync(SRC)) {
    throw new Error(`Source file not found: ${SRC}`);
  }

  const raw = JSON.parse(fs.readFileSync(SRC, 'utf8')) as RawFC;
  const all = Array.isArray(raw?.features) ? raw.features : [];

  const nr = all
    .filter((f) => f?.properties?.pro_code === '30')
    .map((f) => ({
      type: 'Feature',
      properties: {
        tam_code: f.properties?.tam_code,
        tam_th: f.properties?.tam_th,
        amp_code: f.properties?.amp_code,
        amp_th: f.properties?.amp_th,
        pro_code: f.properties?.pro_code,
        pro_th: f.properties?.pro_th,
      },
      geometry: f.geometry,
    }));

  if (nr.length < 200) {
    throw new Error(
      `Expected >= 200 NR tambons, got ${nr.length}. ` +
        `Filter pro_code === "30" may be broken, or source data changed.`,
    );
  }

  if (!fs.existsSync(OUT_DIR)) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
  }

  const payload = { type: 'FeatureCollection', features: nr };
  fs.writeFileSync(OUT, JSON.stringify(payload) + '\n', 'utf8');

  console.log(`Wrote ${nr.length} tambons to ${OUT}`);
}

main();
