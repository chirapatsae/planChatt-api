/**
 * Wave Equipment Sidebar Counts — BE-01 (2026-05-28).
 *
 * Response envelope for `GET /v1/equipment-project-group/counts-by-status`.
 *
 * Powers the 4 sidebar badges under "การจัดการครุภัณฑ์":
 *   - รอนำส่ง         → `ready`               (latest status = 'Ready')
 *   - กำลังตรวจสอบ    → `pending + verified`  (aggregated on FE per Q1 lock)
 *   - รอแก้ไข         → `returnedForRevision` (latest status = 'Returned_For_Revision')
 *   - ดึงกลับ         → `pullBack`            (latest status = 'Pull_Back')
 *
 * All five fields are non-negative integers. Every field is ALWAYS
 * present (never omit a zero).
 *
 * # Authority
 *
 * - §4 ownership filter via `currentWorkHistory.id` (NOT raw `userId`).
 * - §1 / §5.3 classification gate — LAO callers receive all-zero
 *   envelope at HTTP 200 (not 403); equipment is agency-only by
 *   construction so LAO counts are vacuous.
 * - §17.11 no role bypass — super-admin LAO also receives zeros.
 *
 * # Compliance
 *
 * - §17.2 advisory-only — counts MUST NOT gate any workflow.
 * - §17.3 audit separation — endpoint is READ-ONLY. NO
 *   `TrackingStatus` writes.
 *
 * # Sibling pattern
 *
 * Mirrors `GET /v1/supplement-project-group/me/counts`
 * (`supplement-project-group.service.ts` `findMineCounts`). Equipment
 * envelope keeps the 5 sidebar-relevant statuses separated so the FE
 * can aggregate `pending + verified` per Q1; SPG already merges them
 * server-side. Statuses outside the 5 (`Pending_Approval`, `Approved`,
 * `Rejected`) are intentionally NOT surfaced — no consuming surface.
 */
export class EquipmentCountsByStatusDto {
  ready: number;
  pending: number;
  verified: number;
  returnedForRevision: number;
  pullBack: number;
}
