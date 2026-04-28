/**
 * @deprecated W67 — DB `status.th_name` is now the source of truth for
 * Thai status display labels. This static map remains in place for
 * legacy callers but MUST NOT be referenced by NEW code. Wave 68 follow-
 * up: enumerate remaining callers and migrate them to consume
 * `envelope.statusTh` (DB-derived) directly. Then this module can be
 * removed entirely.
 *
 * NEW CALLERS: use `envelope.statusTh` (DB-derived per W67-BE-AGG-01)
 * and / or `envelope.executiveStatus` + `executiveStatusGroupLabelTh()`
 * (per W67-BE-CONST-01) instead.
 */

/**
 * Executive AI Chat — Thai status label helper.
 *
 * BE-W48-02 (Wave 48): tool handlers previously emitted raw canonical
 * English status names (e.g. `Pending`, `Pending_Approval`, `Approved`)
 * which the LLM then quoted verbatim inside Thai replies. This helper
 * provides a sibling Thai label for display.
 *
 * Mirror of `frontend/src/utils/statusUtils.ts` STATUS_MAPPINGS_EN, plus
 * the canonical statuses defined in CLAUDE.md that the FE map omits
 * (`Ready`, `Pending_Approval`, `Pull_Back`). Keys align with the
 * canonical English status names stored in the `status` table.
 *
 * CLAUDE.md references:
 *   - §17.2 Advisory only — `statusTh` is display-sibling data; it MUST
 *     NOT be used for any gating decision.
 *   - §17.11 No role exemption — Thai labels apply uniformly.
 *   - §12 Audit Rule — this helper is pure; no TrackingStatus writes.
 *
 * Keep in lock-step with the FE map; any drift is a QA-W48-01 grep-gate
 * failure.
 */
export const STATUS_TH_MAP = {
  Draft: 'ร่าง',
  // W67-QA-01 L-1/L-2 cleanup: aligned to canonical Thai labels per
  // CLAUDE.md "Wave 67 label decisions" (Ready → 'รอนำส่ง',
  // Verified → 'ตรวจสอบผ่าน'). The map is @deprecated; runtime callers
  // read DB status.th_name. Drift fixed for documentation hygiene only.
  Ready: 'รอนำส่ง',
  // W67: synced to new DB seed value ("รอตรวจสอบ"). Legacy callers reading
  // the static map during the transition will now show the correct label.
  Pending: 'รอตรวจสอบ',
  Verified: 'ตรวจสอบผ่าน',
  Pending_Approval: 'รออนุมัติ',
  Approved: 'อนุมัติ',
  Returned_For_Revision: 'รอแก้ไข',
  // DEPRECATED: legacy alias retained for FE-map parity. Kept during
  // canonical-status rollout so stale server responses still translate.
  Revision: 'รอแก้ไข',
  Pull_Back: 'ดึงกลับ',
  Rejected: 'เกินศักยภาพ',
} as const;

/**
 * Translate a canonical English status name to its Thai display label.
 *
 * Safe fallback: if the input is null/undefined/empty, returns an empty
 * string. If the input is a string that does not match a known key, the
 * input itself is returned unchanged — callers that care about unknown
 * statuses can compare against the input.
 */
export function toThaiStatus(name: string | null | undefined): string {
  if (!name) return '';
  return (STATUS_TH_MAP as Record<string, string>)[name] ?? name;
}
