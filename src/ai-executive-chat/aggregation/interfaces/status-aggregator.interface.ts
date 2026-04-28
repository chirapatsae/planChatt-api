/**
 * Wave 54 — Aggregation Layer Foundation (BE-W54-01).
 *
 * `IStatusAggregator` composes `TrackingStatus` reads across its three
 * explicit FK columns (`project_group_id`,
 * `revised_project_group_id`, `supplement_project_group_id`) into a
 * single logical `(projectKind, projectId) → LatestStatus` map.
 *
 * Contract rules (BE-W54-04 implementor):
 *   - READ-only. NEVER writes to `tracking_status` (§12 audit
 *     ownership — §12 belongs exclusively to workflow transitions,
 *     §17.2 advisory-only).
 *   - Issues three parallel queries, each `WHERE isLatest = true` on
 *     one FK column.
 *   - Application-layer merge by `ProjectKey` — NO DB UNION.
 *   - W67-FIX-01: `statusName` carries the canonical ENGLISH name from
 *     `status.name`; the Thai display label is projected onto a sibling
 *     `statusNameTh` field via the existing
 *     `src/ai-executive-chat/tools/status-th.ts` constants (BE-W54-04
 *     task wiring; W68 will migrate the Thai source to a runtime JOIN
 *     against `status.th_name`).
 *   - Projects ONLY `{ statusName, statusNameTh, createdAt, isLatest }`
 *     — NO PII.
 *
 * CLAUDE.md references:
 *   - §12 Audit Rule.
 *   - §14 / §15 — locked rows and frozen books remain readable.
 *   - §17.2 / §17.11 Advisory-only, no role exemption.
 *   - §17 PII discipline — NO `createdBy`, actor, or updater fields.
 */
import type { ProjectKey, UnifiedProject } from '../types';

export interface LatestStatus {
  /**
   * Canonical ENGLISH status name as stored in the `status.name` column
   * (e.g. `'Pending'`, `'Verified'`, `'Pending_Approval'`, `'Approved'`,
   * `'Rejected'`).
   *
   * W67-FIX-01 contract restoration: this field MUST carry the canonical
   * English name so downstream logic that switches on canonical statuses
   * (e.g. `mapToExecutiveStatusGroup` for the executive 4-group rollup)
   * works correctly. Display sites MUST use `statusNameTh` instead.
   *
   * Pre-W67-FIX-01 the aggregator pre-translated this field to Thai via
   * `toThaiStatus()`, which silently broke every English-keyed mapper
   * downstream (the CTO-confirmed H1 fingerprint of the all-zero
   * `executiveStatusBreakdown` bug).
   */
  statusName: string;
  /**
   * Thai display label for `statusName`.
   *
   * Currently sourced from the deprecated `toThaiStatus()` helper (which
   * mirrors the CLAUDE.md "Thai Display Label Source of Truth (W67)"
   * mapping). W68 follow-up will migrate this field to a runtime DB
   * JOIN against `status.th_name` so the static `STATUS_TH_MAP` can be
   * removed; until then the helper is the runtime fallback for callers
   * that need a Thai label without an extra DB round-trip.
   *
   * Marked OPTIONAL on the type so legacy fixtures and pre-W67 callers
   * compile without modification; production aggregator output ALWAYS
   * sets this field. Display call sites that read this field MUST guard
   * against undefined and fall back to `statusName` (English) for safety.
   */
  statusNameTh?: string;
  /** ISO timestamp of the latest tracking row. */
  createdAt: string;
  /** Always `true` — StatusAggregator filters by `isLatest = true`. */
  isLatest: true;
}

export interface IStatusAggregator {
  /**
   * Returns the latest status per `UnifiedProject`. Projects without any
   * `isLatest = true` row are absent from the result Map.
   */
  latestStatusFor(
    projects: UnifiedProject[],
  ): Promise<Map<ProjectKey, LatestStatus>>;
}
