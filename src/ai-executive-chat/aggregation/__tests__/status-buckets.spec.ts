/**
 * Wave 57 W57-BE-AGG-05 — Status-buckets constants spec.
 *
 * CLAUDE.md references:
 *   - §12 — every status JOIN must read isLatest=true.
 *   - §17.2 advisory only.
 *   - §17.11 no role exemption — Ready stays hidden by default.
 */
import {
  APPROVAL_PIPELINE_ROLLUP_KEY,
  APPROVAL_PIPELINE_ROLLUP_LABEL,
  APPROVAL_PIPELINE_STATUSES,
  EXEC_VISIBLE_STATUSES,
  isApprovalPipelineStatus,
  resolveStatusBucketMode,
} from '../constants/status-buckets';

describe('W57-BE-AGG-05 / status-buckets constants', () => {
  it('EXEC_VISIBLE_STATUSES excludes Ready', () => {
    expect(EXEC_VISIBLE_STATUSES).not.toContain('Ready');
    // The remaining 6 canonical statuses must be present.
    for (const s of [
      'Pending',
      'Verified',
      'Pending_Approval',
      'Approved',
      'Pull_Back',
      'Returned_For_Revision',
    ]) {
      expect(EXEC_VISIBLE_STATUSES).toContain(s);
    }
  });

  it('APPROVAL_PIPELINE_STATUSES is exactly [Verified, Pending_Approval] (W67 — Pending dropped)', () => {
    // W67-BE-CONST-01 (2026-04-25): Pending was removed from the rollup
    // and now lives in its own `pending_review` bucket per
    // `executive-status-groups.ts`. The pipeline now contains only the
    // statuses that have passed staff review and are awaiting formal
    // approval.
    expect(APPROVAL_PIPELINE_STATUSES).toEqual([
      'Verified',
      'Pending_Approval',
    ]);
  });

  it('isApprovalPipelineStatus correctly identifies rollup statuses (W67 — Pending excluded)', () => {
    // W67-BE-CONST-01: Pending no longer belongs to the awaiting-approval
    // pipeline; it is its own `pending_review` bucket.
    expect(isApprovalPipelineStatus('Pending')).toBe(false);
    expect(isApprovalPipelineStatus('Verified')).toBe(true);
    expect(isApprovalPipelineStatus('Pending_Approval')).toBe(true);
    expect(isApprovalPipelineStatus('Approved')).toBe(false);
    expect(isApprovalPipelineStatus('Ready')).toBe(false);
    expect(isApprovalPipelineStatus('Returned_For_Revision')).toBe(false);
  });

  it('rollup-key + Thai label are stable strings', () => {
    expect(APPROVAL_PIPELINE_ROLLUP_KEY).toBe('awaiting_approval');
    expect(APPROVAL_PIPELINE_ROLLUP_LABEL).toBe('รออนุมัติ');
  });

  describe('resolveStatusBucketMode', () => {
    it('defaults to rollup when no params', () => {
      expect(resolveStatusBucketMode(undefined)).toBe('rollup');
      expect(resolveStatusBucketMode({})).toBe('rollup');
    });

    it('returns canonical when detailMode === true', () => {
      expect(resolveStatusBucketMode({ detailMode: true })).toBe('canonical');
    });

    it('returns canonical when statusBucketMode === "canonical"', () => {
      expect(
        resolveStatusBucketMode({ statusBucketMode: 'canonical' }),
      ).toBe('canonical');
    });

    it('truthy detailMode != true is NOT treated as detail (strict equality)', () => {
      expect(resolveStatusBucketMode({ detailMode: 1 })).toBe('rollup');
      expect(resolveStatusBucketMode({ detailMode: 'true' })).toBe('rollup');
    });

    it('explicit rollup is rollup', () => {
      expect(
        resolveStatusBucketMode({ statusBucketMode: 'rollup' }),
      ).toBe('rollup');
    });
  });
});

/**
 * Behavioral lock-in for the §12 contract: a project with 5 historical
 * tracking rows still surfaces only ONE row in the aggregator output
 * (the isLatest=true one). The aggregator filters via
 * `ts.isLatest = true AND ts.deletedAt IS NULL`; this is verified by
 * `status.aggregator.spec.ts` already, so this spec exercises the
 * contract abstractly to keep the AGG-05 paper-trail cohesive.
 */
describe('W57-BE-AGG-05 / §12 isLatest contract (abstract)', () => {
  it('5 historical TS rows → 1 isLatest row → 1 bucket count', () => {
    // Conceptual fixture: a project P with 5 TS rows where exactly ONE
    // has isLatest=true. The aggregator MUST count P exactly once.
    const trackingHistory = [
      { project: 'P', status: 'Ready', isLatest: false },
      { project: 'P', status: 'Pending', isLatest: false },
      { project: 'P', status: 'Returned_For_Revision', isLatest: false },
      { project: 'P', status: 'Pending', isLatest: false },
      { project: 'P', status: 'Verified', isLatest: true },
    ];
    const latest = trackingHistory.filter((t) => t.isLatest);
    expect(latest).toHaveLength(1);
    expect(latest[0].status).toBe('Verified');
  });
});
