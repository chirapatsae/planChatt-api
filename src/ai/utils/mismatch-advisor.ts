import { ClassifiedProjectType } from './project-type-classifier';
import {
  CoordinateContext,
  InferredAreaType,
} from '../coordinate-context.service';

/**
 * Thai display labels for the canonical InferredAreaType values.
 *
 * Canonical vocabulary (see CoordinateContextService):
 *   agricultural | urban | water | forest | community | other | null
 *
 * Legacy values ('rural', 'empty') are NO LONGER emitted by the backend.
 * They are intentionally omitted from this map; any stale upstream string
 * falls through the `?? code` branch in translateInferredAreaType.
 */
export const AREA_TYPE_LABELS_TH: Record<
  Exclude<InferredAreaType, null>,
  string
> = {
  agricultural: 'พื้นที่เกษตรกรรม',
  urban: 'พื้นที่เมือง',
  water: 'แหล่งน้ำ',
  forest: 'พื้นที่ป่า',
  community: 'พื้นที่ชุมชน',
  other: 'อื่น ๆ',
};

/**
 * Translate a canonical InferredAreaType code into its Thai display label.
 *
 * Behavior per F2.B2 prompt enrichment:
 *   - null / undefined        -> null (caller suppresses the line)
 *   - 'other'                 -> 'อื่น ๆ / ไม่ระบุ' (rendered but semantically neutral)
 *   - any recognised canonical code -> its Thai label from AREA_TYPE_LABELS_TH
 *   - any stale/unknown string -> pass-through (defensive)
 *
 * Exported so prompt assembly (ai.service.ts) can render the label directly
 * on the "ลักษณะพื้นที่" context line.
 */
export function translateInferredAreaType(
  code: InferredAreaType | string | null | undefined,
): string | null {
  if (!code) return null;
  if (code === 'other') return 'อื่น ๆ / ไม่ระบุ';
  return (
    (AREA_TYPE_LABELS_TH as Record<string, string>)[code as string] ??
    (code as string)
  );
}

/**
 * CoordinateAdvisory is a SOFT signal per CLAUDE.md §13.
 *
 * Status values:
 *   - 'pass'    — no issue detected
 *   - 'info'    — informational, insufficient data to judge
 *   - 'warning' — potential mismatch worth reviewing
 *
 * The advisory MUST NEVER have a 'fail' status. This pipeline does not
 * block workflow transitions under any circumstance.
 */
export interface CoordinateAdvisory {
  status: 'pass' | 'info' | 'warning';
  message: string;
  inferredType: string | null;
  suggestedContext: string[];
}

/**
 * Compare a classified project type against the coordinate's area context
 * and produce an advisory message.
 */
export function evaluateMismatch(
  projectType: ClassifiedProjectType | null,
  coordContext: CoordinateContext | null,
): CoordinateAdvisory {
  const suggestedContext: string[] = [];

  // 1) No coordinate context available at all.
  if (!coordContext) {
    return {
      status: 'info',
      message: 'ไม่มีข้อมูลพิกัดสำหรับการประเมินความสอดคล้องของพื้นที่',
      inferredType: null,
      suggestedContext,
    };
  }

  // Collect supporting context strings for prompt enrichment.
  if (coordContext.inferredAreaType) {
    suggestedContext.push(
      `ลักษณะพื้นที่ที่คาดการณ์: ${translateInferredAreaType(coordContext.inferredAreaType)}`,
    );
  }
  suggestedContext.push(
    `จำนวนโครงการในรัศมี 3 กม.: ${coordContext.densityCounts.within3km} โครงการ`,
  );
  if (coordContext.nearestProjectDistanceKm !== null) {
    suggestedContext.push(
      `โครงการใกล้สุด: ${coordContext.nearestProjectDistanceKm.toFixed(2)} กม.`,
    );
  }

  // 2) Project type could not be classified — info only.
  if (!projectType) {
    return {
      status: 'info',
      message:
        'ไม่สามารถระบุประเภทโครงการได้อย่างชัดเจน จึงยังไม่สามารถประเมินความสอดคล้องกับพื้นที่ได้',
      inferredType: translateInferredAreaType(coordContext.inferredAreaType),
      suggestedContext,
    };
  }

  const isCommunityLike =
    projectType.code === 'community' ||
    projectType.code === 'education' ||
    projectType.code === 'public_facility';

  // 3) Community-oriented project pinned in a remote/empty area.
  if (coordContext.isLikelyEmptyArea && isCommunityLike) {
    return {
      status: 'warning',
      message:
        'โครงการชุมชนถูกปักหมุดในพื้นที่ห่างไกล (ไม่พบโครงการอื่นในรัศมี 5 กม.) อาจต้องทบทวนความเหมาะสมของพิกัด',
      inferredType: translateInferredAreaType(coordContext.inferredAreaType),
      suggestedContext,
    };
  }

  // 4) Inferred area type explicitly listed as suspicious for this project type.
  if (
    coordContext.inferredAreaType &&
    projectType.suspiciousAreaTypes.includes(coordContext.inferredAreaType)
  ) {
    return {
      status: 'warning',
      message: `ประเภทโครงการ "${projectType.label}" อาจไม่เหมาะกับลักษณะพื้นที่ "${translateInferredAreaType(coordContext.inferredAreaType)}" โปรดตรวจสอบพิกัดอีกครั้ง`,
      inferredType: translateInferredAreaType(coordContext.inferredAreaType),
      suggestedContext,
    };
  }

  // 5) Coordinate outside the selected amphoe boundary — informational note
  //    (the LAO-only blocking/warning is handled elsewhere per §13).
  if (coordContext.isInsideBoundary === false) {
    return {
      status: 'info',
      message:
        'พิกัดที่เลือกอยู่นอกเขตอำเภอที่ระบุ ระบบยังไม่บล็อก แต่แนะนำให้ตรวจสอบ',
      inferredType: translateInferredAreaType(coordContext.inferredAreaType),
      suggestedContext,
    };
  }

  // 6) Default — consistent.
  return {
    status: 'pass',
    message: 'โครงการและพิกัดสอดคล้องกัน',
    inferredType: translateInferredAreaType(coordContext.inferredAreaType),
    suggestedContext,
  };
}
