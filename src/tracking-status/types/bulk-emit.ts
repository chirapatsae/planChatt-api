/**
 * W105-BE-PR1 — In-transaction emit descriptor produced by `bulkSubmit`.
 *
 * Each successful Ready → Pending transition pushes ONE entry. The post-commit
 * digest dispatcher (BE-PR2) consumes the resulting array, groups by
 * `(recipientUserId × eventType)`, and enqueues ONE digest job per group.
 *
 * Constraints:
 *   - The shape carries DISPLAY data (projectName) so the digest renderer in
 *     BE-PR3 does not need to re-query.
 *   - `amphoeId` resolves staff-lead recipients for staff-side digest events.
 *   - `agencyId` is reserved for symmetry with the revision/change flow; in
 *     this owner-scoped bulk endpoint (main plan only) it is always null.
 *   - `projectKind` is fixed to `'main'` because the endpoint is restricted
 *     to ProjectGroup (main plan) Ready → Pending only.
 *   - §17.3 — this descriptor is in-memory only; it MUST NOT be persisted
 *     into any project / tracking_status / ai_* table.
 */
export type BulkSubmitEmit = {
  projectId: string;
  projectName: string;
  trackingStatusId: string;
  fromStatus: 'Ready';
  toStatus: 'Pending';
  ownerWorkHistoryId: string | null;
  amphoeId: string | null;
  agencyId: string | null;
  projectKind: 'main';
  planName: string | null;
  occurredAt: Date;
  // Wave 22 B1 actor threading — propagated to digest jobs so notification
  // audit rows can attribute the workflow actor (advisory only, §4.1).
  actorUserId: string | null;
  actorWorkHistoryId: string | null;
};

/**
 * Stable per-project error taxonomy returned by `POST /tracking-status/bulk-submit`.
 * Frontend partial-success UI maps these codes to Thai labels.
 */
export type BulkSubmitErrorCode =
  | 'PROJECT_NOT_FOUND'
  | 'OWNERSHIP_OR_SCOPE_MISMATCH'
  | 'PLAN_NOT_LATEST'
  | 'PLAN_BOOKED'
  | 'PLAN_PHASE_NOT_OPEN'
  | 'WRONG_WORKFLOW'
  | 'STATUS_NOT_READY'
  | 'PROJECT_HAS_DESCENDANT'
  | 'STATUS_LOOKUP_FAILED'
  | 'INTERNAL_ERROR';

export type BulkSubmitResultEntry =
  | { projectId: string; ok: true }
  | {
      projectId: string;
      ok: false;
      error: string;
      errorCode: BulkSubmitErrorCode;
    };

export type BulkSubmitResponse = {
  results: BulkSubmitResultEntry[];
};
