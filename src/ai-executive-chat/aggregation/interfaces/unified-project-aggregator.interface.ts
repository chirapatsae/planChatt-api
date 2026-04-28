/**
 * Wave 54 — Aggregation Layer Foundation (BE-W54-01).
 *
 * `IUnifiedProjectAggregator` composes `ProjectGroup`,
 * `RevisedProjectGroup`, and `SupplementProjectGroup` into a
 * discriminated `UnifiedProject[]` projection (design memo §3.1).
 *
 * Contract rules (enforced by BE-W54-02 implementor):
 *   - READ-only. No repo mutations.
 *   - Uses repository metadata resolution only (never raw SQL table
 *     literals). Concrete reads go through TypeORM repositories.
 *   - Resolves `planId` + `planReportFormat` by walking the owning
 *     chain (PG → DP | RPG → DPR → DP | SPG → DPS → DP).
 *   - `scope` is required and MUST contain at least one of
 *     `'main' | 'revised' | 'supplement' | 'all'`.
 *   - Caller MUST pass an already-asserted executive context
 *     (design §2 Tier B rule: "SHOULD accept an already-asserted
 *     context — never accept a raw request").
 *
 * CLAUDE.md references:
 *   - §10 Project Scope Binding — plan resolution follows the row's own
 *     chain, never a global latest lookup.
 *   - §11 Versioning — three shapes, one logical projection.
 *   - §14 / §15 — reads allowed on locked rows and frozen books.
 *   - §17.2 Advisory-only.
 */
import type { UnifiedProject } from '../types';

export interface UnifiedProjectQuery {
  /** Optional scope to a single DevelopmentPlan. */
  planId?: string;

  /**
   * REQUIRED. At least one of `main | revised | supplement | all`.
   * `'all'` is a convenience alias covering the three kinds.
   */
  scope: Array<'main' | 'revised' | 'supplement' | 'all'>;

  /**
   * Optional soft filters — shape mirrors the §4 Query DSL `filters`.
   *
   * Wave 55 W55-BE-06 / GAP-5 type-drift resolution:
   *   - `amphoeIds` / `agencyIds` accept `string[]` because the DSL
   *     schema (`tool-registry.ts` `EXECUTIVE_QUERY_SCHEMA.filters`)
   *     declares them as JSON-friendly string arrays for the LLM.
   *   - Service-boundary coercion happens inside
   *     `UnifiedProjectAggregator.applyFilters`:
   *       · Amphoe PK is a string column → pass through verbatim.
   *       · Agency PK is an integer column → coerce via `Number(x)`;
   *         NaN / non-finite entries are silently DROPPED; an all-
   *         dropped array maps to a no-match (`WHERE 1=0` via QB).
   */
  filters?: {
    status?: string[];
    amphoeIds?: string[];
    /**
     * W67-LAO-RESOLVER — string PK array filter. The aggregator binds
     * to `${alias}.local_administrative_organization_id` on PG / RPG /
     * SPG (all three carry the same column name). LAO PK is a string
     * column on the entity (`@PrimaryColumn() id: string`) so the DSL
     * value is passed through verbatim, mirroring `amphoeIds`.
     *
     * The LLM MUST resolve LAO names via the `listLaos` resolver tool
     * BEFORE sending values here — passing Thai literals like "อบต.
     * โคกกรวด" binds zero rows silently. Prompt rule #25b enforces
     * the resolve-first contract.
     */
    laoIds?: string[];
    /**
     * W67-PAO-VOCAB (2026-04-27) — exclusion-list counterpart to
     * `laoIds`. Filters out projects whose
     * `local_administrative_organization_id` is in this list (and
     * non-null). Used by prompt rule #25c to express "โครงการ อปท /
     * ประสานแผน" via `excludeLaoIds: ['3001027']` — i.e., everything
     * EXCEPT อบจ.นครราชสีมา. Mutually-exclusive partition of
     * LAO-scoped rows when paired with `laoIds`.
     */
    excludeLaoIds?: string[];
    /**
     * W67-PAO-EXEC-STAGE (2026-04-27) — execution-stage filters used by
     * prompt rule #25c v3 to express "โครงการของ อบจ" = a project that
     * has an assigned responsible agency (responsible_agency_id NOT NULL)
     * AND has been added to the plan book (isBooked=true). Used together
     * to identify projects อบจ. is actively executing, regardless of
     * original LAO origin (LAO-coordinated projects become "อบจ-owned"
     * once อบจ. accepts and books them).
     *
     * SPG: responsible_agency NOT NULL by entity constraint and has no
     * isBooked column (inherently booked when persisted), so SPG passes
     * both filters when `true` and is excluded when `false`.
     */
    hasResponsibleAgency?: boolean;
    isBooked?: boolean;
    agencyIds?: string[];
    budgetRange?: { min?: number; max?: number };
    dateRange?: { from?: string; to?: string };
    /**
     * Wave 55 W55-BE-07 — Filter by derived project-origin type
     * (CLAUDE.md §1 + §5). Values:
     *   - `'agency-normal'`   → creator amphoe.id === '3001' AND LAO.id
     *                            === '3001027'.
     *   - `'lao-coordinated'` → all other creator classifications.
     *
     * The discriminator is computed against the row's own
     * `createdBy.workHistory` JOIN (same JOIN used for the
     * `originType` projection). When the filter is omitted the
     * aggregator returns rows of both origins.
     */
    originType?: Array<'lao-coordinated' | 'agency-normal'>;
  };

  /** Hard upper bound — BE-W54-02 clamps to <= 50 (DSL constraint). */
  limit?: number;

  /**
   * Wave 55 BE-W55-05 — Lineage-aware unified aggregation (§14.2
   * head-of-lineage rule).
   *
   * When `false` (default), the aggregator returns ONLY head-of-lineage
   * rows for `main` and `revised` kinds: a `ProjectGroup` or
   * `RevisedProjectGroup` P is emitted iff NO non-soft-deleted
   * `RevisedProjectGroup` references P via
   * `(prev_project_id = P.id AND prev_project_type = <kind>)`. This
   * prevents the GAP-3 double-count where an approved PG and its
   * derived RPG are both summed into "งบรวมของแผน X".
   *
   * When `true`, the HEAD filter is SHORT-CIRCUITED and every non-soft-
   * deleted row is emitted (the legacy pre-Wave-55 behavior). This flag
   * exists for audit/debug only — executive tools MUST leave it
   * `false` to avoid double-counting.
   *
   * `SupplementProjectGroup` is unaffected either way: SPG is not part
   * of the PG / RPG revision chain (§14.1), and its aggregate is
   * already correct.
   */
  includeHistoricalVersions?: boolean;
}

/**
 * W67-FIX-02 — direct-DB count contract for the executive 4-group rollup.
 *
 * `countExecutiveStatusBreakdown` answers the question "how many projects
 * sit in each of the four W67 executive buckets, INDEPENDENT of the
 * `listUnifiedProjects` limit / split-budget?".
 *
 * Why this lives next to `listUnifiedProjects`:
 *   - The two queries MUST honor the SAME §10 plan-scope binding, the
 *     SAME §14.2 head-of-lineage filter, and the SAME `filters` clause —
 *     keeping them in one service guarantees the two read predicates
 *     never drift.
 *   - The list path is intentionally limit-bound (token budget for the
 *     LLM); the count path is intentionally limit-FREE (it must not lie
 *     about totals when the list was truncated).
 *
 * §17.2 advisory only — the breakdown is a presentation aggregation; it
 * MUST NOT gate any workflow transition. §17.3 read-only — zero
 * `tracking_status` writes.
 */
export interface ExecutiveStatusBreakdownCounts {
  pendingReviewCount: number;
  awaitingApprovalCount: number;
  approvedCount: number;
  rejectedCount: number;
}

/**
 * W67-FIX-B (status drill-down) — hierarchical envelope for the
 * AI-executive chat answer "สรุปสถานะ ... แยกเล่ม / รายโครงการ".
 *
 * Contract (User Q1-Q6 locked 2026-04-26):
 *   - Hierarchy: total → book → status group → numbered project list.
 *   - Truncation policy (Q2 hybrid): when `count <= 10` ALL projects are
 *     emitted; when `count > 10` only the first 5 (created_at DESC) are
 *     emitted and `truncatedRemainder = count - 5` (otherwise 0).
 *   - Sub-book label (Q3 combo): `bookLabel` for `bookKind='main'` is the
 *     plan name only; for `'revised' | 'supplement'` it is
 *     `${planLabel} / ${roundLabel}`.
 *   - Empty buckets (Q6): status groups with `count === 0` are dropped;
 *     books whose status array becomes empty are also dropped.
 *   - planId-narrowed (Q5): when `planId` is present the helper still
 *     produces the 2-level hierarchy (main + DPR rounds + supplement
 *     rounds within that plan).
 *
 * §14.2 head-of-lineage anti-join MUST match `countExecutiveStatusBreakdown`.
 * §17.2 advisory only — drill does NOT gate any workflow transition.
 */
/**
 * W67-FIX-C — per-project context annotation + cross-lineage trail.
 *
 * `pageNumber` / `bookLabel` give the executive enough context to find
 * the project in the system without a follow-up tool call (Q1=yes,
 * 2026-04-26).
 *
 * `linkedRelated` is the cross-lineage "see also" pointer:
 *   - FK-chain (`matchType: 'fk-chain'`): walks forward through
 *     `prev_project_id` to the leaf descendant. Activates only when
 *     the caller opted into `includeHistoricalVersions: true`, because
 *     under the §14.2 default head-of-lineage filter the projects in
 *     the drill have NO descendant.
 *   - Name-exact (`matchType: 'name-exact'`): falls back to a
 *     normalized-exact name match across the SAME drill window
 *     (§14.2 honored on the candidate side too — hidden ancestors
 *     are excluded). When multiple candidates share a name, the
 *     most-recent (latest createdAt) is selected (Q2=C, 2026-04-26).
 *   - `null`: no related row found.
 *
 * §14.2 head-of-lineage MUST be honored throughout (FK-match must NOT
 * point to a hidden ancestor; name-match candidates must be head-of-
 * lineage themselves). §17.2 advisory only.
 */
export type GroupedExecutiveStatusBreakdownProject = {
  projectId: string;
  projectKind: 'main' | 'revised' | 'supplement';
  name: string;
  /** W67-FIX-C — page number from the project entity (`pageNumber`). */
  pageNumber: number | null;
  /** W67-FIX-C — full book path: planLabel for main; `${planLabel} / ${roundLabel}` for revised/supplement. */
  bookLabel: string;
  /** W67-FIX-C — cross-lineage related-version pointer; null when no match. */
  linkedRelated: {
    bookLabel: string;
    pageNumber: number | null;
    matchType: 'fk-chain' | 'name-exact';
  } | null;
  /**
   * W67-COORDINATOR-LAO (2026-04-27) — name of the LAO that coordinated
   * this project to อบจ.นครราชสีมา for execution. NULL when the project's
   * own LAO is `'3001027'` (อบจ.นม itself, no coordination — direct
   * project) OR when the project has no LAO FK (SPG). Sourced from
   * `local_administrative_organizations.name` via JOIN on
   * `project.local_administrative_organization_id`.
   *
   * Used by prompt rule #39 to render "ประสานจาก: {coordinatorLaoName}"
   * inline annotation per project. The LLM emits this sub-annotation
   * verbatim from the envelope (W66 anti-prose-translation lock).
   */
  coordinatorLaoName: string | null;
};

export type GroupedExecutiveStatusBreakdownStatusGroup = {
  group: 'pending_review' | 'awaiting_approval' | 'approved' | 'rejected';
  groupLabel: string;
  count: number;
  projects: GroupedExecutiveStatusBreakdownProject[];
  truncatedRemainder: number;
};

export type GroupedExecutiveStatusBreakdownBook = {
  bookKey: string;
  bookKind: 'main' | 'revised' | 'supplement';
  bookLabel: string;
  planLabel: string;
  roundLabel: string | null;
  statuses: GroupedExecutiveStatusBreakdownStatusGroup[];
};

export interface GroupedExecutiveStatusBreakdown {
  books: GroupedExecutiveStatusBreakdownBook[];
}

export interface IUnifiedProjectAggregator {
  /**
   * Returns the unified projection for the requested scope. Implementors
   * MUST return `[]` (never throw) when nothing matches.
   */
  listUnifiedProjects(query: UnifiedProjectQuery): Promise<UnifiedProject[]>;

  /**
   * W67-FIX-02 — direct-DB count of projects in each of the four W67
   * executive buckets. Honors the SAME `planId`, `scope`, `filters`,
   * and §14.2 head-of-lineage semantics as `listUnifiedProjects`, but
   * IS NOT limit-bound — every matching row is counted.
   *
   * Counts use the latest `TrackingStatus` row per project
   * (`is_latest = true`, `deleted_at IS NULL`) and the
   * `EXEC_VISIBLE_STATUSES` whitelist (Ready is excluded by design).
   *
   * Implementors MUST return all-zero counts (never throw) when nothing
   * matches.
   */
  countExecutiveStatusBreakdown(
    query: Omit<UnifiedProjectQuery, 'limit'>,
  ): Promise<ExecutiveStatusBreakdownCounts>;

  /**
   * W67-FIX-B — hierarchical drill-down for the executive status answer.
   * Honors the SAME `planId`, `scope`, `filters`, and §14.2 head-of-lineage
   * semantics as `countExecutiveStatusBreakdown`, additionally grouping
   * each project under its owning book (DevelopmentPlan for main; DPR
   * for revised; DPS for supplement) AND its 4-group executive status.
   *
   * Implementors MUST return `{ books: [] }` (never throw) on empty
   * match and MUST drop empty buckets per Q6.
   */
  groupedExecutiveStatusBreakdown(
    query: Omit<UnifiedProjectQuery, 'limit'>,
  ): Promise<GroupedExecutiveStatusBreakdown>;
}
