/**
 * Wave Equipment Revision Management — BE-01 (Phase 3).
 *
 * Response envelope for
 * `GET /v1/revised-equipment-project-group/counts-by-status`.
 *
 * Per-status owner-scoped counts powering FE-03 sidebar badges for the
 * equipment-revision flow. All 8 canonical §3 statuses are surfaced
 * (camelCase keys); every field is ALWAYS present (never omit a zero).
 *
 * # Authority
 *
 * - §4 ownership filter via `currentWorkHistory.id` (NOT raw `userId`).
 * - §1 / §5.3 classification gate — LAO callers receive the all-zero
 *   envelope at HTTP 200 (NOT 403); equipment is agency-only by
 *   construction so LAO RELPG counts are vacuous.
 * - §17.11 no role bypass — super-admin LAO also receives zeros.
 *
 * # Compliance
 *
 * - §17.2 advisory-only — counts MUST NOT gate any workflow.
 * - §17.3 audit separation — endpoint is READ-ONLY. NO `TrackingStatus`
 *   writes.
 */
export class RevisedEquipmentCountsByStatusDto {
  ready: number;
  pending: number;
  verified: number;
  pendingApproval: number;
  approved: number;
  pullBack: number;
  returnedForRevision: number;
  rejected: number;
}
