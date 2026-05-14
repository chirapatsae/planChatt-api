/**
 * SUPP_AGG_BE_01 — Query DTOs for the two unified-projects endpoints.
 *
 * Both endpoints share the optional `developmentPlanId` (UUID) +
 * `countOnly` (boolean) query parameters; the executive endpoint
 * additionally honours the existing `?statusGroup`, `?amphoeId`, and
 * `?agencyId` shape declared in the task spec but only `countOnly` +
 * `developmentPlanId` are implemented in this wave (others are
 * deferred — see the report's "deviations" section).
 *
 * Per CLAUDE.md §17.9 every UUID param is validated by `ParseUUIDPipe`
 * at the controller level. The DTO carries no business logic — strings
 * arriving from `@Query()` are normalised here so the service receives
 * plain typed primitives.
 */

/** Shared shape for both endpoints. */
export interface UnifiedProjectsListQuery {
  /** Optional plan-scope filter (UUID). */
  developmentPlanId?: string;
  /** When `true`, return the W67 4-group rollup envelope. */
  countOnly: boolean;
}

/** W67 4-group rollup envelope returned when `countOnly=true`. */
export interface UnifiedProjectsCountEnvelope {
  /** Pending review group — `Pending`. */
  pending_review: number;
  /** Awaiting approval group — `Verified` + `Pending_Approval`. */
  awaiting_approval: number;
  /** Approved group — `Approved`. */
  approved: number;
  /** Rejected group — `Rejected` (W67 — "เกินศักยภาพ"). */
  rejected: number;
}

/**
 * Coerce a `?countOnly=...` query-string value into a strict boolean.
 *
 * Accepts the case-insensitive literals `'true' | '1' | 'yes' | 'on'`
 * as truthy; every other value (including missing / `undefined`) maps
 * to `false`. This mirrors the convention used elsewhere in the
 * codebase for boolean query parameters.
 */
export function parseCountOnly(raw: unknown): boolean {
  if (raw === true) return true;
  if (typeof raw !== 'string') return false;
  const normalised = raw.trim().toLowerCase();
  return (
    normalised === 'true' ||
    normalised === '1' ||
    normalised === 'yes' ||
    normalised === 'on'
  );
}
