/**
 * SUPP_AGG_BE_01b — Enriched unified project shape for FE consumers.
 *
 * The Wave 54 `UnifiedProject` shape (defined in
 * `src/ai-executive-chat/aggregation/types/unified-project.ts`) is the
 * AI-executive-chat-scoped projection — intentionally narrow, PII-bound,
 * and FK-isolated per §17.3.
 *
 * The `/project` owner dashboard and the 5 executive surfaces consumed
 * via `/v1/unified-projects/{owner-list,executive-list}` need a richer
 * envelope (structured `status` object, executive 4-group rollup,
 * lineage-lock flag, parent-book metadata, per-year budgets, owner
 * WorkHistory id). To avoid widening the aggregator's shape — which
 * would risk breaking AI executive chat callers and §17 PII discipline
 * scoping — the enrichment happens AT THE HTTP SERVICE LAYER
 * (`UnifiedProjectsService`) AFTER the aggregator returns its lean rows.
 *
 * PII discipline (§17 + §17.13): the §17 PII rule is AI-surface-scoped
 * (the aggregator feeds an LLM context window). This HTTP-facing
 * envelope is consumed by user-facing dashboards (`/project` + 5
 * executive surfaces) which ALREADY display creator name + amphoe +
 * LAO via the legacy `/v1/project-groups/*` endpoints for PG rows.
 * To restore parity (Phase-1 ship had blank values for SPG rows on
 * /project), the enricher surfaces creator + amphoe + LAO names here
 * — these fields are NOT considered PII at the user-facing dashboard
 * layer (the same data is shown to the same caller in the same UI).
 * Strict PII fields (`citizenId`, `phone`, `email`, `profileImageUrl`)
 * remain prohibited. `createdByWorkHistoryId` UUID is also preserved
 * so the FE can do row-ownership filtering.
 *
 * CLAUDE.md references:
 *   - §12   Audit Rule — `status.statusAt` reads from the latest
 *           `TrackingStatus.createAt`; this module never writes.
 *   - §14.10 Lineage lock — `hasDescendant` flag drives the FE
 *           "เวอร์ชันเก่า (ถูกล็อก)" badge and disables edit/delete.
 *   - §15   Book lineage — parent-book `isLatest` / `isBooked` /
 *           `isOpen` are surfaced for the FE to gate authoring actions.
 *   - §16   Multi-format reporting — `developmentPlan.reportFormat` is
 *           the single source of truth driving classification-shape
 *           branching in the FE.
 *   - §17   PII discipline — no person-level fields; only the UUID id
 *           of the creator WorkHistory.
 *   - §3 / W67 — `executiveStatusGroup` mirrors
 *           `mapToExecutiveStatusGroup` (null for in-flight states).
 */
import type { UnifiedProject } from 'src/ai-executive-chat/aggregation/types';
import type { ExecutiveStatusGroup } from 'src/ai-executive-chat/aggregation/constants/executive-status-groups';

/** Structured §12 status block — canonical English name + Thai display + ISO timestamp. */
export interface EnrichedStatus {
  /** Canonical English status name (e.g. 'Approved') — workflow logic only. */
  name: string;
  /** `status.th_name` — W67 single source of truth for Thai display. */
  thName: string;
  /** ISO timestamp of the latest `TrackingStatus.createAt`. */
  statusAt: string;
}

/** Parent DevelopmentPlan metadata — common across all three project kinds. */
export interface EnrichedDevelopmentPlan {
  id: string;
  name: string;
  startYear: number;
  endYear: number;
  isLatest: boolean;
  isBooked: boolean;
  reportFormat: 'STRATEGY_BASED' | 'ISSUE_BASED';
}

/** Parent revision-round metadata — RPG-only. */
export interface EnrichedDevelopmentPlanRevision {
  id: string;
  revisionNumber: number;
  /** e.g. 'แก้ไข' | 'เปลี่ยนแปลง' — from `revision_type.name`. */
  revisionTypeName: string;
  description: string | null;
  isLatest: boolean;
  isBooked: boolean;
  isOpen: boolean;
}

/** Parent supplement-round metadata — SPG-only. */
export interface EnrichedDevelopmentPlanSupplement {
  id: string;
  supplementNumber: number;
  description: string | null;
  isLatest: boolean;
  isBooked: boolean;
  isOpen: boolean;
}

/** Per-year budget row projected from `budget` table for a single project. */
export interface EnrichedBudget {
  year: number;
  quantity: number;
}

/**
 * Creator-side metadata surfaced for user-facing dashboards.
 *
 * - `firstName` / `lastName` — user's display name (read from `User`
 *   relation via WorkHistory). Already shown on `/project` for PG rows;
 *   surfaced here for parity with SPG/RPG rows.
 * - `amphoe.name` / `localAdministrativeOrganization.name` — creator's
 *   org context at the time of project creation. NOT PII; required for
 *   the existing "อำเภอ / อปท" column.
 * - `profileImageUrl` — public avatar URL (absolute). Surfaced so the
 *   browse-table creator column renders the same photo the owner
 *   `/project` list and the unified-equipment browse already show. This
 *   is a display avatar, not contact PII; consistent with those
 *   surfaces (added 2026-07-16).
 * - `email` — MASKED creator email (e.g. `te****@example.com`), surfaced
 *   so the browse-table avatar hover card matches `/project` (which also
 *   shows a masked creator email). Produced by the same decrypt-then-mask
 *   pipeline (`maskCreatedByUserOnProjects` → `maskEmail`) used on the
 *   `/project` list, so NO raw email ever leaves the service. Phone /
 *   citizenId stay forbidden. Added 2026-07-26 per owner direction to
 *   surface on BOTH staff-list and executive-list.
 *
 * Strict contact PII (`citizenId`, `phone`, and RAW `email`) is NEVER
 * surfaced — only a masked email is exposed, matching `/project`. The §17
 * intent is to prevent person-level identifiers from leaking into AI
 * surfaces; a masked email preserves that contract while giving the
 * user-facing dashboards parity with the long-standing `/project` card.
 */
export interface EnrichedCreator {
  workHistoryId: string;
  firstName: string | null;
  lastName: string | null;
  amphoe: { id: string; name: string } | null;
  localAdministrativeOrganization: { id: string; name: string } | null;
  /** Public avatar URL (absolute) — powers the browse-table creator avatar. */
  profileImageUrl: string | null;
  /** MASKED creator email (never raw) — matches the `/project` hover card. */
  email: string | null;
  /** Creator's account-creation date (ISO) — powers the "Member Since" line. Not PII. */
  joinDate: string | null;
}

/**
 * Full enriched envelope returned by both unified-projects endpoints
 * when `countOnly=false`.
 *
 * Extends the aggregator's `UnifiedProject` (keeping `projectKind`,
 * `projectId`, `name`, `planId`, `planReportFormat`, classification
 * fields, `originType`, etc.) and adds the FE-facing fields documented
 * above.
 *
 * Field-level overrides:
 *   - `status` widens the aggregator's optional `latestStatus` /
 *     `latestStatusAt` pair into a single structured block with
 *     canonical English + Thai display + ISO timestamp. The lean
 *     optional fields on `UnifiedProject` are still present (and may
 *     be `undefined` — the canonical truth flows through the structured
 *     `status` block on the enriched shape).
 *
 * RPG-only and SPG-only blocks are typed optional but the enricher
 * populates them deterministically per `projectKind`:
 *   - main      → developmentPlanRevision  = undefined,
 *                 developmentPlanSupplement = undefined
 *   - revised   → developmentPlanRevision  = <populated>,
 *                 developmentPlanSupplement = undefined
 *   - supplement→ developmentPlanRevision  = undefined,
 *                 developmentPlanSupplement = <populated>
 */
export interface EnrichedUnifiedProject extends UnifiedProject {
  /** §12 structured status block (English name + Thai display + ISO ts). */
  status: EnrichedStatus;

  /**
   * W67 4-group executive rollup per
   * `aggregation/constants/executive-status-groups.ts`.
   * `null` for in-flight states (`Ready`, `Pull_Back`,
   * `Returned_For_Revision`).
   */
  executiveStatusGroup: ExecutiveStatusGroup | null;

  /**
   * §14.10 lineage-lock flag. `true` when this row has at least one
   * non-soft-deleted descendant in its own category. For SPG: always
   * `false` until Wave SUPP-4 introduces SPG→RPG lineage.
   */
  hasDescendant: boolean;

  /** Parent DevelopmentPlan metadata — resolved per `projectKind`. */
  developmentPlan: EnrichedDevelopmentPlan;

  /** RPG-only — revision-round metadata. */
  developmentPlanRevision?: EnrichedDevelopmentPlanRevision;

  /** SPG-only — supplement-round metadata. */
  developmentPlanSupplement?: EnrichedDevelopmentPlanSupplement;

  /** Per-year budget breakdown (replaces the aggregator's scalar `totalBudget`). */
  budgets: EnrichedBudget[];

  /**
   * ISO timestamp of the project row's own `createdAt`. Surfaced for
   * timeline-sort on `/project` (newest first) so SPG rows order on
   * true creation time — same semantic as the legacy PG/RPG endpoints,
   * not the `status.statusAt` proxy.
   */
  createdAt: string;

  /**
   * Creator WorkHistory id — required for FE row-ownership filtering on
   * the `/project` dashboard. Not PII (UUID scalar only, no
   * person-level fields flow out).
   */
  createdByWorkHistoryId: string;

  /**
   * Creator-side display metadata (firstName/lastName + amphoe + LAO).
   * Surfaced for the `/project` "ผู้สร้าง" + "อำเภอ / อปท" columns
   * to maintain parity with the legacy PG-only endpoint. Strict PII
   * (`citizenId`, `email`, `phone`, `profileImageUrl`) remain excluded.
   */
  createdBy: EnrichedCreator;

  /**
   * Per-row booked-state flag — §20 parity with PG/RPG.
   *
   * Sources:
   *   - main      → `ProjectGroup.isBooked`
   *   - revised   → `RevisedProjectGroup.isBooked`
   *   - supplement→ `SupplementProjectGroup.isBooked` (Wave wave-
   *                 supplement-convergence-milestone-2-spg-booked-
   *                 fields / DB-01 + BE-01, 2026-05-25 — replaces the
   *                 legacy Wave-A-lite "always-booked-when-persisted"
   *                 shortcut so SPG matches the PG/RPG semantic of
   *                 "only true after the row is finalized into its
   *                 published book").
   *
   * Read-side metadata only — no workflow gate per §17.2.
   */
  isBooked: boolean;

  /**
   * ISO timestamp of the moment the row was finalized into its book.
   * `null` while the row is still in flight (not yet booked). Mirrors
   * `ProjectGroup.bookedAt` / `RevisedProjectGroup.bookedAt` semantics
   * and is set by the same merge() path that flips `isBooked = true`.
   */
  bookedAt: string | null;

  /**
   * Page number in the published book PDF; `null` on legacy / not-yet-
   * booked rows. Mirrors `ProjectGroup.pageNumber` /
   * `RevisedProjectGroup.pageNumber` / `SupplementProjectGroup.pageNumber`.
   */
  pageNumber: number | null;

  /**
   * Free-form content fields (วัตถุประสงค์ / เป้าหมาย / ผลที่คาดหวัง),
   * forwarded from the owning entity so the executive Excel export can
   * render them. Empty string when unset.
   */
  objective: string;
  goal: string;
  expected: string;

  /**
   * Classification display names, resolved from the owning entity's
   * strategy / tactic / plan / developmentIssue relations. Surfaced so the
   * executive Excel export can group by ยุทธศาสตร์ / กลยุทธ์ / แผนงาน
   * (the lean aggregator row carries only ids). `null` when unset.
   */
  strategyName: string | null;
  tacticName: string | null;
  planName: string | null;
  developmentIssueName: string | null;
}
