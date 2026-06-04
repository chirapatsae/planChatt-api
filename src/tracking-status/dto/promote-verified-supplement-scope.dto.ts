import { IsUUID } from 'class-validator';

/**
 * Wave wave-print-merge-scale-statuschange / BE-03 (2026-06-04).
 *
 * Request DTO for the scope-driven promote-verified endpoint at
 * `POST /api/v1/tracking-status/promote-verified/supplement-project-group`.
 *
 * SCOPE KEYS ONLY. This is a SET operation, not a page: every
 * `SupplementProjectGroup` whose latest status is `Verified` under the
 * supplied (developmentPlanId + developmentPlanSupplementId) scope is
 * promoted to `Pending_Approval` in ONE transaction. There is therefore
 * NO `page` / `limit` and NO `@ArrayMaxSize` cap — the existing capped
 * bulk endpoint (`POST /tracking-status/bulk/supplement-project-group`,
 * hard-cap 200 → `BULK_TOO_LARGE`) is the page-based path and is left
 * intact; this endpoint is unbounded by design.
 *
 * Source of truth: CLAUDE.md §3 / §4.1 (staff authority, ownership not
 * the gate), §10 (scope binding to the supplied supplement, never a
 * global open round), §12 (one TrackingStatus per row), §15.4 (honor the
 * supplement book lock).
 */
export class PromoteVerifiedSupplementScopeDto {
  @IsUUID('4', { message: 'developmentPlanId ต้องเป็น UUID' })
  developmentPlanId: string;

  @IsUUID('4', {
    message: 'developmentPlanSupplementId ต้องเป็น UUID',
  })
  developmentPlanSupplementId: string;
}
