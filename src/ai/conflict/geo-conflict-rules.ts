/**
 * GeoConflict rules — Wave 30 N1
 *
 * Data-driven, deterministic conflict matrix + sub-type mapping.
 * Mirrors the Wave 24 criteria registry extensibility pattern
 * (`nakhon-ratchasima-issue-rules.ts`): an exported, versioned,
 * immutable table scanned at request time by `GeoConflictService`.
 *
 * Invariants:
 *   - First match wins (specific before wildcard).
 *   - Thai reasons/recommendations are ≤ 240 chars each (service
 *     applies a defensive trim/cap — see §17.9).
 *   - No role exemption (§17.11). Advisory only (§17.2).
 */
import type {
  ConflictLevel,
  GeoAnalysisInput,
  GeoAnalysisResult,
  GeoFeatureType,
  ProjectTypeCode,
} from './geo-conflict.types';

export const GEO_CONFLICT_RULESET_VERSION = '2026-04-20';

/**
 * Sub-type code → project-type mapping.
 *
 * Source: sub-type `code` fields from
 * `backend/src/ai/criteria/nakhon-ratchasima-issue-rules.ts`
 * (21 sub-types across 6 issues). Unmapped codes default to
 * `'unknown'` at call sites (conservative — see
 * `GeoConflictService.resolveProjectType`).
 *
 * Mapping decisions:
 *   - 1.1 ปรับปรุง/พัฒนาแหล่งน้ำตามแนวทางพระราชดำริ → irrigation-like
 *     (royal-initiated water-body improvement, typically canal/weir).
 *   - 1.2 เศรษฐกิจพอเพียง → agriculture-support (ambiguous;
 *     conservative soft-mapping to agriculture-support).
 *   - 2.1 การศึกษา → building-like (classrooms / school buildings).
 *   - 2.2 กีฬา/นันทนาการ → public-facility (sports fields, parks).
 *   - 2.3 สาธารณสุข → public-facility (clinics, health posts).
 *   - 2.4 คุณภาพชีวิต (ผู้สูงอายุ/ผู้พิการ) → public-facility (centers).
 *   - 2.5 ยาเสพติด → public-facility (awareness / program facility).
 *   - 3.1.1 เกษตร → agriculture-support.
 *   - 3.1.2 อุตสาหกรรม/SMEs → building-like (factories / SME sheds).
 *   - 3.1.3 ท่องเที่ยว → public-facility (tourist amenities).
 *   - 3.1.4 ยกระดับมาตรฐานผลิตภัณฑ์ → unknown (program-level, not
 *     spatial).
 *   - 3.1.5 SOFT POWER → unknown (program-level, not spatial).
 *   - 3.2.1 ขุดลอก/พัฒนาแหล่งน้ำเพื่อการเกษตร → irrigation-like.
 *   - 4.1 ก่อสร้าง/ซ่อมถนน → road-like.
 *   - 4.2 ถนนถ่ายโอน → road-like.
 *   - 4.3 สะพาน → road-like (bridge is road infrastructure).
 *   - 4.4 ไฟฟ้าแสงสว่าง → public-facility (roadside street-lighting
 *     is NOT a road-construction conflict; map to public-facility).
 *   - 4.5 สาธารณภัย → drainage (flood-control is the dominant
 *     spatial concern; conservative).
 *   - 4.6 ฟื้นฟูทรัพยากรธรรมชาติ/สิ่งแวดล้อม → environmental.
 */
export const SUBTYPE_TO_PROJECT_TYPE: Readonly<Record<string, ProjectTypeCode>> =
  Object.freeze({
    '1.1': 'irrigation-like',
    '1.2': 'agriculture-support',
    '2.1': 'building-like',
    '2.2': 'public-facility',
    '2.3': 'public-facility',
    '2.4': 'public-facility',
    '2.5': 'public-facility',
    '3.1.1': 'agriculture-support',
    '3.1.2': 'building-like',
    '3.1.3': 'public-facility',
    '3.1.4': 'unknown',
    '3.1.5': 'unknown',
    '3.2.1': 'irrigation-like',
    '4.1': 'road-like',
    '4.2': 'road-like',
    '4.3': 'road-like',
    '4.4': 'public-facility',
    '4.5': 'drainage',
    '4.6': 'environmental',
  });

export interface ConflictRule {
  featureType: GeoFeatureType | '*';
  projectType: ProjectTypeCode | '*';
  level: ConflictLevel;
  reasons: string[];
  recommendations: string[];
}

/**
 * Conflict matrix — first match wins. Ordered with specific rules
 * before wildcards.
 *
 * Thai strings are kept concise (each ≤ 240 chars) to bound token
 * footprint for the N2 prompt injection.
 */
export const CONFLICT_MATRIX: ReadonlyArray<ConflictRule> = Object.freeze([
  // ---------------------------------------------------------------
  // RESERVOIR (อ่างเก็บน้ำ)
  // ---------------------------------------------------------------
  {
    featureType: 'reservoir',
    projectType: 'road-like',
    level: 'high',
    reasons: [
      'พิกัดโครงการตั้งอยู่ภายในแนวอ่างเก็บน้ำ การก่อสร้างถนนในพื้นที่เก็บกักน้ำมีความเสี่ยงน้ำท่วมสูงและไม่สามารถดำเนินการได้ในเชิงวิศวกรรม',
      'เป็นการรุกล้ำแหล่งน้ำสาธารณะ ขัดกับระเบียบการใช้พื้นที่แหล่งน้ำและอาจขัดต่อหลักเกณฑ์การใช้ประโยชน์พื้นที่ชลประทาน',
    ],
    recommendations: [
      'ย้ายแนวถนนออกนอกขอบเขตอ่างเก็บน้ำและตรวจสอบแผนที่แนวขอบอ่างกับหน่วยงานเจ้าของพื้นที่',
      'ประสานกรมชลประทาน (RID) เพื่อขอข้อมูลแนวเขตและเงื่อนไขการใช้ประโยชน์พื้นที่',
      'พิจารณาทางเลือกสะพานข้ามอ่างแทนการถมถนนในพื้นที่เก็บกักน้ำ',
    ],
  },
  {
    featureType: 'reservoir',
    projectType: 'building-like',
    level: 'high',
    reasons: [
      'พิกัดอาคารอยู่ภายในแนวอ่างเก็บน้ำ เป็นการรุกล้ำแหล่งน้ำสาธารณะและเสี่ยงต่อความเสียหายจากการเปลี่ยนแปลงระดับน้ำ',
      'ไม่สามารถขออนุญาตก่อสร้างอาคารถาวรในพื้นที่เก็บกักน้ำได้ตามระเบียบการใช้พื้นที่ของหน่วยงานเจ้าของพื้นที่',
    ],
    recommendations: [
      'ย้ายที่ตั้งอาคารออกนอกขอบเขตอ่างเก็บน้ำให้พ้นระดับน้ำสูงสุด',
      'ประสานหน่วยงานเจ้าของพื้นที่ (กรมชลประทานหรือหน่วยงานท้องถิ่น) เพื่อยืนยันแนวเขต',
    ],
  },
  {
    featureType: 'reservoir',
    projectType: 'irrigation-like',
    level: 'low',
    reasons: [
      'โครงการชลประทานสอดคล้องกับวัตถุประสงค์ของอ่างเก็บน้ำ เป็นการใช้แหล่งน้ำร่วมกันในลักษณะเสริมกัน',
    ],
    recommendations: [
      'ประสานกรมชลประทานเพื่อยืนยันความจุอ่างและแผนการปล่อยน้ำ ก่อนออกแบบระบบส่งน้ำ',
    ],
  },
  {
    featureType: 'reservoir',
    projectType: 'water-supply',
    level: 'low',
    reasons: [
      'โครงการประปา/ระบบน้ำดื่มใช้อ่างเก็บน้ำเป็นแหล่งน้ำต้นทุน เป็นการใช้ประโยชน์แหล่งน้ำในลักษณะเสริมกัน',
    ],
    recommendations: [
      'ประสานหน่วยงานเจ้าของอ่างเพื่อขอจัดสรรน้ำและตรวจคุณภาพน้ำต้นทุนก่อนผลิต',
    ],
  },
  {
    featureType: 'reservoir',
    projectType: 'drainage',
    level: 'medium',
    reasons: [
      'โครงการระบายน้ำ/ป้องกันน้ำท่วมในพื้นที่อ่างเก็บน้ำต้องพิจารณาทิศทางต้นน้ำ-ท้ายน้ำ เพราะอาจกระทบระดับน้ำในอ่างและพื้นที่รับน้ำ',
    ],
    recommendations: [
      'ตรวจสอบว่าโครงการอยู่ต้นน้ำหรือท้ายน้ำของอ่าง และประสานกรมชลประทานเพื่อวิเคราะห์ผลกระทบก่อนออกแบบ',
    ],
  },
  {
    featureType: 'reservoir',
    projectType: 'agriculture-support',
    level: 'low',
    reasons: [
      'โครงการส่งเสริมการเกษตรรอบอ่างเก็บน้ำใช้ประโยชน์จากแหล่งน้ำโดยตรง เป็นการใช้พื้นที่ในลักษณะเสริมกัน',
    ],
    recommendations: [
      'ตรวจสอบแนวเขตที่ดินของเกษตรกรให้อยู่นอกแนวอ่างและประสานกรมชลประทานเรื่องการจัดสรรน้ำ',
    ],
  },
  {
    featureType: 'reservoir',
    projectType: 'environmental',
    level: 'low',
    reasons: [
      'โครงการฟื้นฟูทรัพยากรธรรมชาติในพื้นที่อ่างเก็บน้ำมักสอดคล้องกับการอนุรักษ์แหล่งน้ำ',
    ],
    recommendations: [
      'ประสานหน่วยงานเจ้าของอ่างเพื่อร่วมกำหนดแนวทางฟื้นฟูที่ไม่กระทบการเก็บกักน้ำ',
    ],
  },

  // ---------------------------------------------------------------
  // RIVER (แม่น้ำ / ลำน้ำหลัก)
  // ---------------------------------------------------------------
  {
    featureType: 'river',
    projectType: 'road-like',
    level: 'medium',
    reasons: [
      'พิกัดโครงการอยู่บนแนวแม่น้ำ ต้องออกแบบเป็นสะพานข้ามแม่น้ำและตรวจสอบแนวการจัดผังการไหลของน้ำอย่างรอบคอบ',
    ],
    recommendations: [
      'ออกแบบเป็นสะพานพร้อมระยะร่นและความสูงเหนือระดับน้ำสูงสุด (Q100)',
      'ประสานกรมเจ้าท่า/กรมชลประทานเพื่อขออนุญาตสิ่งล่วงล้ำลำน้ำ',
    ],
  },
  {
    featureType: 'river',
    projectType: 'building-like',
    level: 'medium',
    reasons: [
      'พิกัดอาคารอยู่บนหรือใกล้แนวแม่น้ำ ต้องเว้นระยะร่น (setback) จากริมฝั่งและอยู่พ้นแนวน้ำท่วมถึง',
    ],
    recommendations: [
      'ตรวจสอบแนวน้ำท่วมสูงสุด (Q100) และกำหนดระยะร่นอย่างน้อยตามข้อบัญญัติท้องถิ่น',
      'ประสานกรมเจ้าท่าเพื่อยืนยันแนวเขตลำน้ำ',
    ],
  },
  {
    featureType: 'river',
    projectType: 'drainage',
    level: 'low',
    reasons: [
      'โครงการระบายน้ำลงแม่น้ำเป็นการใช้แม่น้ำเป็นพื้นที่รับน้ำหลักตามธรรมชาติ',
    ],
    recommendations: [
      'ออกแบบทางระบายและบ่อดักตะกอนก่อนปล่อยลงแม่น้ำ และประสานกรมเจ้าท่าเรื่องการปล่อยน้ำ',
    ],
  },

  // ---------------------------------------------------------------
  // CANAL (คลอง / ลำน้ำย่อย / ลำเหมือง)
  // ---------------------------------------------------------------
  {
    featureType: 'canal',
    projectType: 'road-like',
    level: 'medium',
    reasons: [
      'พิกัดถนนตัดผ่านแนวคลอง ต้องออกแบบท่อลอดหรือสะพานข้ามและขออนุญาตล่วงล้ำลำน้ำ',
    ],
    recommendations: [
      'ออกแบบท่อลอด/สะพานข้ามให้สอดคล้องกับขนาดหน้าตัดคลองและอัตราการไหลสูงสุด',
      'ประสานเจ้าของคลอง (กรมชลประทานหรือท้องถิ่น) เพื่อขออนุญาตสิ่งล่วงล้ำ',
    ],
  },
  {
    featureType: 'canal',
    projectType: 'irrigation-like',
    level: 'low',
    reasons: [
      'โครงการปรับปรุงคลองส่งน้ำสอดคล้องกับฟังก์ชันของคลองโดยตรง เป็นการพัฒนาแหล่งน้ำเพื่อการเกษตร',
    ],
    recommendations: [
      'ประสานกรมชลประทานเพื่อสอบแนวคลองเดิมและยืนยันแผนส่งน้ำก่อนขุดลอก/ปรับปรุง',
    ],
  },
  {
    featureType: 'canal',
    projectType: 'drainage',
    level: 'low',
    reasons: [
      'โครงการระบายน้ำผ่านคลองเป็นการใช้คลองตามฟังก์ชันระบายน้ำตามธรรมชาติ',
    ],
    recommendations: [
      'ตรวจสอบความจุคลองและสภาพการไหลก่อนออกแบบ และประสานเจ้าของคลองเรื่องการระบาย',
    ],
  },
  {
    featureType: 'canal',
    projectType: 'building-like',
    level: 'medium',
    reasons: [
      'พิกัดอาคารอยู่บนหรือใกล้แนวคลอง ต้องเว้นระยะร่นและไม่รุกล้ำแนวคลอง',
    ],
    recommendations: [
      'เว้นระยะร่นจากริมคลองตามข้อบัญญัติท้องถิ่น และประสานเจ้าของคลองเพื่อยืนยันแนวเขต',
    ],
  },

  // ---------------------------------------------------------------
  // Fallbacks (order matters — most-specific first)
  // ---------------------------------------------------------------
  {
    // Any feature + unknown project-type → NONE (conservative: do not
    // claim conflict without project-type context).
    featureType: '*',
    projectType: 'unknown',
    level: 'none',
    reasons: [
      'ยังไม่สามารถระบุประเภทโครงการที่เพียงพอต่อการประเมินความขัดแย้งเชิงพื้นที่ กรุณาเลือกประเภทย่อยโครงการให้ครบถ้วน',
    ],
    recommendations: [],
  },
  {
    // Universal fallback.
    featureType: '*',
    projectType: '*',
    level: 'none',
    reasons: ['ไม่พบความขัดแย้งที่ชัดเจนจากกฎที่กำหนดไว้'],
    recommendations: [],
  },
]);

/**
 * Deterministic resolver: scans `CONFLICT_MATRIX` top-down and
 * returns the first matching rule. Always returns a non-null result
 * (fallback rule guarantees a match). Pure — no I/O, no side effects.
 */
export function resolveConflict(input: GeoAnalysisInput): GeoAnalysisResult {
  const { geoFeature, projectType } = input;
  const featureType = geoFeature.featureType;

  for (const rule of CONFLICT_MATRIX) {
    const featureMatch =
      rule.featureType === '*' || rule.featureType === featureType;
    const projectMatch =
      rule.projectType === '*' || rule.projectType === projectType;
    if (featureMatch && projectMatch) {
      return {
        featureType,
        projectType,
        conflictLevel: rule.level,
        reasons: [...rule.reasons],
        recommendations: [...rule.recommendations],
        rulesetVersion: GEO_CONFLICT_RULESET_VERSION,
      };
    }
  }

  // Unreachable — the universal `* + *` fallback above always matches.
  // Kept as a belt-and-braces default for type safety.
  return {
    featureType,
    projectType,
    conflictLevel: 'none',
    reasons: ['ไม่พบความขัดแย้งที่ชัดเจนจากกฎที่กำหนดไว้'],
    recommendations: [],
    rulesetVersion: GEO_CONFLICT_RULESET_VERSION,
  };
}
