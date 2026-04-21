/**
 * Feasibility rules — Wave 33.6 N1
 *
 * Explicit BLOCK table for physically-impossible (geoFeature, projectType)
 * combos. First-match-wins. Mirrors the Wave 24 / Wave 30 registry pattern:
 * an immutable, versioned, exported table scanned at request time.
 *
 * Invariants:
 *   - Only block rules live here. Pass / warn verdicts come from absence
 *     of a matching block rule.
 *   - Reasons / recommendations are PRE-AUTHORED Thai literals (≤ 240
 *     chars each, ≤ 6 recommendations per rule). User text never flows
 *     into these strings (§17.9).
 *   - Sea entries are reserved for forward-compat — current data has no
 *     sea polygons, but the rules are present so behavior is defined the
 *     moment such data is added.
 *   - First match wins; the registry order matches feature-type then
 *     project-type for grep-friendliness.
 */
import type { FeasibilityInput } from './feasibility.types';

export { FEASIBILITY_RULESET_VERSION } from './feasibility.types';

export interface FeasibilityBlockRule {
  /** kebab-case unique identifier. */
  id: string;
  /** geoFeature.featureType to match, or '*' for any. */
  featureType: string;
  /** Wave 30 ProjectTypeCode to match, or '*' for any. */
  projectType: string;
  /** Pre-authored Thai prose. `{nameTh}` placeholder is substituted at emit. */
  reason: string;
  /** Pre-authored Thai prose, ≥ 2 entries, ≤ 6 entries. */
  recommendations: string[];
}

/**
 * Water-body feature types eligible to trigger a feasibility block.
 * Must mirror — but does NOT modify — the Wave 29 `ResolvedFeatureType`
 * union. Sea is reserved for forward-compat (no current data).
 */
export const WATER_BODY_FEATURE_TYPES: ReadonlySet<string> = new Set([
  'reservoir',
  'river',
  'canal',
  'sea',
]);

/**
 * Land-construction project types eligible to trigger a feasibility block.
 * Mirrors a strict subset of Wave 30 `ProjectTypeCode`. Soft / spatial-
 * agnostic project types (e.g. `agriculture-support`, `irrigation-like`,
 * `water-supply`, `environmental`) are intentionally excluded — those
 * combos are surfaced by Wave 30 `[CONFLICT_ASSESSMENT]` instead.
 */
export const LAND_CONSTRUCTION_PROJECT_TYPES: ReadonlySet<string> = new Set([
  'road-like',
  'building-like',
  'public-facility',
]);

/**
 * Block table. First-match-wins. Entries are intentionally explicit (no
 * wildcard rules in this initial wave) so the registry doubles as
 * documentation of the impossible combos.
 */
export const FEASIBILITY_BLOCK_TABLE: ReadonlyArray<FeasibilityBlockRule> =
  Object.freeze([
    // ---------------------------------------------------------------
    // RESERVOIR (อ่างเก็บน้ำ)
    // ---------------------------------------------------------------
    {
      id: 'reservoir-vs-road-like',
      featureType: 'reservoir',
      projectType: 'road-like',
      reason:
        'พิกัดที่เลือกอยู่ในแหล่งน้ำ ({nameTh}) ซึ่งเป็นพื้นที่เก็บกักน้ำ ไม่เหมาะสมสำหรับการก่อสร้างถนนหรือโครงสร้างพื้นฐานบนบก',
      recommendations: [
        'ย้ายตำแหน่งพิกัดไปพื้นที่บนบกที่อยู่นอกขอบเขตแหล่งน้ำ',
        'พิจารณาเป็นถนนรอบอ่างเก็บน้ำหรือทางสัญจรเลียบขอบน้ำแทน',
        'หากต้องการเชื่อมข้ามแหล่งน้ำ ให้พิจารณาโครงการสะพานเป็นทางเลือก',
      ],
    },
    {
      id: 'reservoir-vs-building-like',
      featureType: 'reservoir',
      projectType: 'building-like',
      reason:
        'พิกัดที่เลือกอยู่ในแหล่งน้ำ ({nameTh}) ไม่สามารถก่อสร้างอาคารหรือสิ่งปลูกสร้างถาวรในแหล่งน้ำได้',
      recommendations: [
        'ย้ายตำแหน่งพิกัดไปพื้นที่บนบกที่อยู่นอกขอบเขตแหล่งน้ำ',
        'หากต้องการพัฒนาพื้นที่น้ำ กรุณาเลือกประเภทโครงการให้สอดคล้อง เช่น ระบบชลประทาน การปรับปรุงแหล่งน้ำ',
      ],
    },
    {
      id: 'reservoir-vs-public-facility',
      featureType: 'reservoir',
      projectType: 'public-facility',
      reason:
        'พิกัดที่เลือกอยู่ในแหล่งน้ำ ({nameTh}) ไม่เหมาะสมสำหรับการก่อสร้างสาธารณูปโภคบนบกในพื้นที่เก็บกักน้ำ',
      recommendations: [
        'ย้ายตำแหน่งพิกัดไปพื้นที่บนบกที่อยู่นอกขอบเขตแหล่งน้ำ',
        'พิจารณาประเภทโครงการอื่นที่สอดคล้องกับลักษณะแหล่งน้ำ',
      ],
    },
    // ---------------------------------------------------------------
    // RIVER (แม่น้ำ)
    // ---------------------------------------------------------------
    {
      id: 'river-vs-road-like',
      featureType: 'river',
      projectType: 'road-like',
      reason:
        'พิกัดที่เลือกอยู่บนแม่น้ำ ({nameTh}) ไม่สามารถก่อสร้างถนนบนทางน้ำได้',
      recommendations: [
        'ย้ายตำแหน่งพิกัดไปฝั่งแม่น้ำหรือพื้นที่บนบก',
        'หากต้องการเชื่อมข้ามแม่น้ำ ให้พิจารณาโครงการสะพานเป็นทางเลือก',
      ],
    },
    {
      id: 'river-vs-building-like',
      featureType: 'river',
      projectType: 'building-like',
      reason:
        'พิกัดที่เลือกอยู่บนแม่น้ำ ({nameTh}) ไม่สามารถก่อสร้างอาคารบนทางน้ำได้',
      recommendations: [
        'ย้ายตำแหน่งพิกัดไปฝั่งแม่น้ำหรือพื้นที่บนบก',
        'พิจารณาโครงการเขื่อนป้องกันตลิ่งหรือสะพานแทน',
      ],
    },
    // ---------------------------------------------------------------
    // CANAL (คลอง)
    // ---------------------------------------------------------------
    {
      id: 'canal-vs-road-like',
      featureType: 'canal',
      projectType: 'road-like',
      reason:
        'พิกัดที่เลือกอยู่บนคลอง ({nameTh}) ไม่สามารถก่อสร้างถนนบนทางน้ำได้',
      recommendations: [
        'ย้ายตำแหน่งพิกัดไปฝั่งคลองหรือพื้นที่บนบก',
        'หากต้องการเชื่อมข้ามคลอง ให้พิจารณาโครงการสะพานเป็นทางเลือก',
      ],
    },
    {
      id: 'canal-vs-building-like',
      featureType: 'canal',
      projectType: 'building-like',
      reason:
        'พิกัดที่เลือกอยู่บนคลอง ({nameTh}) ไม่สามารถก่อสร้างอาคารบนทางน้ำได้',
      recommendations: [
        'ย้ายตำแหน่งพิกัดไปฝั่งคลองหรือพื้นที่บนบก',
        'หากต้องการพัฒนาพื้นที่น้ำ กรุณาเลือกประเภทโครงการให้สอดคล้อง เช่น ระบบชลประทาน',
      ],
    },
    // ---------------------------------------------------------------
    // SEA (ทะเล) — reserved for forward-compatibility. Current GeoJSON
    // dataset has no sea polygons, but rules are present so behavior is
    // defined the moment such data is added.
    // ---------------------------------------------------------------
    {
      id: 'sea-vs-road-like',
      featureType: 'sea',
      projectType: 'road-like',
      reason:
        'พิกัดที่เลือกอยู่ในทะเล ({nameTh}) ไม่สามารถก่อสร้างถนนในทะเลได้',
      recommendations: [
        'ย้ายตำแหน่งพิกัดไปพื้นที่บนบก',
        'หากต้องการพัฒนาพื้นที่ชายฝั่ง พิจารณาโครงการสะพานหรือท่าเทียบเรือ',
      ],
    },
    {
      id: 'sea-vs-building-like',
      featureType: 'sea',
      projectType: 'building-like',
      reason:
        'พิกัดที่เลือกอยู่ในทะเล ({nameTh}) ไม่สามารถก่อสร้างอาคารถาวรในทะเลได้',
      recommendations: [
        'ย้ายตำแหน่งพิกัดไปพื้นที่บนบก',
        'พิจารณาโครงการประเภทอื่นที่สอดคล้องกับลักษณะพื้นที่',
      ],
    },
  ]);

/**
 * First-match-wins lookup. Returns null when no explicit rule matches the
 * (featureType, projectType) pair. Wildcard `*` is accepted on either
 * column for forward extensibility — none of the v1 entries use it.
 */
export function resolveBlockRule(
  featureType: string,
  projectType: string,
): FeasibilityBlockRule | null {
  for (const rule of FEASIBILITY_BLOCK_TABLE) {
    if (rule.featureType !== '*' && rule.featureType !== featureType) continue;
    if (rule.projectType !== '*' && rule.projectType !== projectType) continue;
    return rule;
  }
  return null;
}

/**
 * Convenience predicate — first-line gate used by the service before
 * descending into the rule table. Matches the explicit allowlists above.
 */
export function isWaterBodyVsLandConstruction(input: FeasibilityInput): boolean {
  if (!input.geoFeature) return false;
  if (!WATER_BODY_FEATURE_TYPES.has(input.geoFeature.featureType)) return false;
  if (!LAND_CONSTRUCTION_PROJECT_TYPES.has(input.projectType)) return false;
  return true;
}
