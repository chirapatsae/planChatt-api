/**
 * W67 — Executive view status grouping (4-group rollup over 8 canonical statuses).
 *
 * User decision (Wave 67): executive AI chat surfaces status counts using a
 * 4-group rollup (pending_review / awaiting_approval / approved / rejected),
 * NOT the full 8-status workflow vocabulary. The mapping below is the SOLE
 * source of truth for backend-computed `executiveStatus` field on every
 * project envelope row.
 *
 * §17.9: Thai labels are static literals; no interpolation. Per W67
 * architectural decision, runtime status display TEXT comes from DB
 * `status.th_name` (W67-BE-AGG-01 wires the JOIN); this module owns only
 * the GROUP-key + group-label mapping.
 *
 * §16.5: not classification-shape-dependent; applies uniformly to PG / RPG / SPG.
 */

export type ExecutiveStatusGroup =
  | 'pending_review'
  | 'awaiting_approval'
  | 'approved'
  | 'rejected';

export const EXECUTIVE_STATUS_GROUP_LABEL_TH: Readonly<
  Record<ExecutiveStatusGroup, string>
> = Object.freeze({
  pending_review: 'รอตรวจสอบ',
  awaiting_approval: 'รออนุมัติ',
  approved: 'อนุมัติ',
  rejected: 'เกินศักยภาพ',
});

/**
 * Map canonical workflow status name → executive view group.
 *
 * Returns null for non-mapped statuses (Ready, Pull_Back, Returned_For_Revision)
 * — these are workflow-internal states the executive view does not surface as
 * primary buckets. Caller decides whether to omit / show under "อื่น ๆ" / etc.
 */
export function mapToExecutiveStatusGroup(
  canonicalStatus: string | null | undefined,
): ExecutiveStatusGroup | null {
  if (!canonicalStatus) return null;
  switch (canonicalStatus) {
    case 'Pending':
      return 'pending_review';
    case 'Verified':
    case 'Pending_Approval':
      return 'awaiting_approval';
    case 'Approved':
      return 'approved';
    case 'Rejected':
      return 'rejected';
    // Ready / Pull_Back / Returned_For_Revision → null (not in executive view)
    default:
      return null;
  }
}

/**
 * Get the Thai label for an executive status group, or null for non-mapped.
 */
export function executiveStatusGroupLabelTh(
  group: ExecutiveStatusGroup | null | undefined,
): string | null {
  if (!group) return null;
  return EXECUTIVE_STATUS_GROUP_LABEL_TH[group] ?? null;
}
