/**
 * Wave 54 — BE-W54-07 — Single source of truth for server-authored
 * Thai advisory strings consumed by the ResilienceEnvelope service and
 * the three Tier C executive handlers.
 *
 * §17.9 prompt-injection defense: NO string interpolation with user
 * data, DB row content, or raw error output. These constants are
 * static module-level literals and MUST remain so.
 *
 * §17.2 advisory-only: advisories are LLM-surfaced hints. They NEVER
 * gate a workflow transition.
 *
 * Byte-identity with the task spec §7 table is enforced by the
 * `resilience-envelope.spec.ts` suite.
 */
import type { MissingDimension } from './types/missing-dimension';

export const BUDGET_UNAVAILABLE =
  'ข้อมูลงบประมาณไม่สามารถดึงได้ขณะนี้' as const;

export const STATUS_UNAVAILABLE =
  'ข้อมูลสถานะไม่สามารถดึงได้ขณะนี้' as const;

export const GEO_UNAVAILABLE =
  'ข้อมูลพื้นที่ไม่สามารถดึงได้ขณะนี้' as const;

export const GEO_SUPPLEMENT_EXCLUDED =
  'ข้อมูลพื้นที่ของเล่มเพิ่มเติมยังไม่พร้อมใช้งาน (ไม่มีคอลัมน์ amphoe_id)' as const;

export const AGENCY_UNAVAILABLE =
  'ข้อมูลหน่วยงานผู้รับผิดชอบไม่สามารถดึงได้ขณะนี้' as const;

export const CLASSIFICATION_UNAVAILABLE =
  'ข้อมูลการจำแนกประเภทโครงการไม่สามารถดึงได้ขณะนี้' as const;

export const CLASSIFICATION_SHAPE_STRATEGY =
  'แผนนี้เป็น STRATEGY_BASED (ยุทธศาสตร์) จึงไม่มีการจำแนกตามประเด็นการพัฒนา' as const;

export const CLASSIFICATION_SHAPE_ISSUE =
  'แผนนี้เป็น ISSUE_BASED (ประเด็นการพัฒนา) จึงไม่มีการจำแนกตามยุทธศาสตร์/กลยุทธ์' as const;

/**
 * Dimension → advisory lookup used by `ResilienceEnvelopeService` to
 * resolve the advisory string for a failed dimension in O(1). The
 * `geo:supplement` entry maps to the documented-partial advisory; it is
 * NOT an error-path advisory but a design-expected partial (§5.3).
 */
export const DIMENSION_ADVISORY: Record<MissingDimension, string> = {
  budget: BUDGET_UNAVAILABLE,
  status: STATUS_UNAVAILABLE,
  geo: GEO_UNAVAILABLE,
  'geo:supplement': GEO_SUPPLEMENT_EXCLUDED,
  agency: AGENCY_UNAVAILABLE,
  classification: CLASSIFICATION_UNAVAILABLE,
};
