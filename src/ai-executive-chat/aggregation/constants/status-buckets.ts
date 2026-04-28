/**
 * Wave 57 W57-BE-AGG-05 — Canonical executive status-bucket constants.
 *
 * CLAUDE.md references:
 *   - §12 — every status row written must come paired with `isLatest`
 *     bookkeeping; aggregator MUST read only `isLatest = true` rows.
 *   - §17.2 advisory only; §17.3 audit separation (no aggregator may
 *     write `tracking_status`).
 *   - §17.11 no role exemption — Ready remains hidden from default
 *     executive views regardless of caller role.
 *
 * `EXEC_VISIBLE_STATUSES` enumerates every canonical status the
 * executive surface may display by default. `Ready` is INTENTIONALLY
 * excluded per Q8: drafts (Ready) are pre-submission state and MUST
 * not appear in default exec aggregator output. A dedicated tool
 * (or explicit filter override) may surface drafts when the user
 * explicitly asks for "ยังไม่ได้ส่ง" / "ร่าง".
 *
 * `APPROVAL_PIPELINE_STATUSES` enumerates the statuses that
 * collapse into the Thai user-facing label "รออนุมัติ" under the
 * Q5 default rollup mode. In detail mode (`detailMode=true` /
 * `statusBucketMode='canonical'`) these MUST be returned individually.
 *
 * Wave 67 update (W67-BE-CONST-01, user decision 2026-04-25):
 *   - `Pending` is REMOVED from this rollup. Per the W67 4-group
 *     executive view (`executive-status-groups.ts`), `Pending` now
 *     belongs to its own bucket `pending_review` ("รอตรวจสอบ"),
 *     SEPARATE from the awaiting-approval pipeline.
 *   - The pipeline now contains only `[Verified, Pending_Approval]` —
 *     i.e. projects that have passed staff review and are awaiting
 *     formal approval.
 *   - `APPROVAL_PIPELINE_ROLLUP_LABEL` and `APPROVAL_PIPELINE_ROLLUP_KEY`
 *     are intentionally retained as `'รออนุมัติ'` / `'awaiting_approval'`
 *     — see R2 in the task file: renaming would invalidate any cached
 *     downstream consumer.
 */

/**
 * Canonical visible statuses for default executive views (Q8).
 * Excludes `Ready`.
 */
export const EXEC_VISIBLE_STATUSES = [
  'Pending',
  'Verified',
  'Pending_Approval',
  'Approved',
  'Pull_Back',
  'Returned_For_Revision',
] as const;

export type ExecVisibleStatus = (typeof EXEC_VISIBLE_STATUSES)[number];

/**
 * Approval-pipeline rollup (Q5 + W67 user decision). When the caller asks
 * "รออนุมัติ" without `detailMode`, the aggregator collapses these into a
 * single bucket.
 *
 * W67: `Pending` was dropped from this list — it now lives in its own
 * `pending_review` bucket. See `executive-status-groups.ts` for the full
 * 4-group executive rollup.
 */
export const APPROVAL_PIPELINE_STATUSES = [
  'Verified',
  'Pending_Approval',
] as const;

export type ApprovalPipelineStatus =
  (typeof APPROVAL_PIPELINE_STATUSES)[number];

/**
 * Canonical Thai label for the rollup bucket. The detail-mode response
 * uses the per-status Thai labels resolved via `toThaiStatus`.
 */
export const APPROVAL_PIPELINE_ROLLUP_LABEL = 'รออนุมัติ' as const;

/** Special bucket key surfaced in the rollup-mode response. */
export const APPROVAL_PIPELINE_ROLLUP_KEY = 'awaiting_approval' as const;

/**
 * Test if a canonical status belongs to the approval-pipeline rollup.
 */
export function isApprovalPipelineStatus(
  status: string,
): status is ApprovalPipelineStatus {
  return (APPROVAL_PIPELINE_STATUSES as readonly string[]).includes(status);
}

/**
 * Status bucket mode discriminator. `'rollup'` is the default
 * (collapses APPROVAL_PIPELINE_STATUSES into one bucket); `'canonical'`
 * returns each status individually.
 */
export type StatusBucketMode = 'rollup' | 'canonical';

/**
 * Resolve the bucket-mode flag from a tool-input parameter object.
 * Accepts either `detailMode: boolean` (truthy → 'canonical') or
 * `statusBucketMode: 'rollup' | 'canonical'`. Defaults to `'rollup'`.
 *
 * Per the operator's note in the harness brief, the API surface for
 * the discriminator is at our discretion. We accept BOTH names to
 * minimise prompt-engineering load on the LLM.
 */
export function resolveStatusBucketMode(
  params: Record<string, unknown> | undefined,
): StatusBucketMode {
  if (!params) return 'rollup';
  if (params.detailMode === true) return 'canonical';
  if (params.statusBucketMode === 'canonical') return 'canonical';
  return 'rollup';
}
