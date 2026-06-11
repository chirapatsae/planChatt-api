/**
 * Wave wave-supplement-equipment-por03 — counts-by-status (2026-06-09).
 *
 * Response envelope for
 * `GET /v1/supplement-equipment-project-group/counts-by-status`.
 *
 * Mirrors `EquipmentCountsByStatusDto` EXACTLY:
 *   - รอนำส่ง         → `ready`               (latest status = 'Ready')
 *   - กำลังตรวจสอบ    → `pending + verified`  (aggregated on FE)
 *   - รอแก้ไข         → `returnedForRevision` (latest = 'Returned_For_Revision')
 *   - ดึงกลับ         → `pullBack`            (latest = 'Pull_Back')
 *
 * All five fields are non-negative integers, ALWAYS present.
 *
 * # Authority
 *
 * - §4 ownership filter via `currentWorkHistory.id` (NOT raw `userId`).
 * - §1 / §5.3 classification gate — LAO callers receive all-zero
 *   envelope at HTTP 200 (not 403); supplement-equipment is agency-only
 *   by construction so LAO counts are vacuous.
 * - §17.11 no role bypass — super-admin LAO also receives zeros.
 *
 * # Compliance
 *
 * - §17.2 advisory-only — counts MUST NOT gate any workflow.
 * - §17.3 audit separation — endpoint is READ-ONLY. NO
 *   `TrackingStatus` writes.
 */
export class SupplementEquipmentCountsByStatusDto {
  ready: number;
  pending: number;
  verified: number;
  returnedForRevision: number;
  pullBack: number;
}
