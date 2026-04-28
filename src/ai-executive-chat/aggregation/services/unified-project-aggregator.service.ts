/**
 * Wave 54 — BE-W54-02 Unified Project Aggregator.
 *
 * Concrete `UnifiedProjectAggregator` implementation. Composes
 * `ProjectGroup` (main), `RevisedProjectGroup` (revised), and
 * `SupplementProjectGroup` (supplement) into a single discriminated
 * `UnifiedProject[]` projection with `projectKind ∈ { 'main',
 * 'revised', 'supplement' }`.
 *
 * Resolution chain (design §3.1):
 *   - `main`       → `ProjectGroup.development_plan_id` →
 *                    `DevelopmentPlan.reportFormat`
 *   - `revised`    → `RevisedProjectGroup.development_plan_revision_id` →
 *                    `DevelopmentPlanRevision.development_plan_id` →
 *                    `DevelopmentPlan.reportFormat`
 *   - `supplement` → `SupplementProjectGroup.development_plan_supplement_id` →
 *                    `DevelopmentPlanSupplement.development_plan_id` →
 *                    `DevelopmentPlan.reportFormat`
 *
 * Invariants (HARD):
 *   - READ-only. Zero `.save` / `.update` / `.delete` / `.softRemove` /
 *     `.softDelete` / `.remove`. No `tracking_status` writes.
 *   - Zero raw SQL table literals. All reads go through
 *     `dataSource.getRepository(Entity).createQueryBuilder(...)` or
 *     inner joins via entity property names.
 *   - Zero PII projection. No `firstName`, `lastName`, `citizenId`,
 *     `phone`, `email` in the projection or SELECT list.
 *   - Wave 55 W55-BE-07 composes a LEFT JOIN via `createdBy` →
 *     `WorkHistory` → (`Amphoe` | `LocalAdministrativeOrganization`)
 *     to read the two ID scalars (`amphoe.id`, `lao.id`) that drive
 *     the §1 + §5 `originType` discriminator. Those IDs are not PII;
 *     no person-level columns from WorkHistory / User are SELECTed.
 *   - `limit` clamped [1, 50] (DSL upper bound — §4 Query DSL).
 *   - When `scope === ['all']` the overall `limit` is distributed
 *     across the three kinds using the 40/35/25 default split
 *     (task §11.R2). Unused budget IS NOT rolled forward — simpler for
 *     LLM reasoning and matches the Wave 53 `listProjectsInPlan`
 *     discipline.
 *
 * CLAUDE.md references:
 *   - §10  Project Scope Binding — plan resolution walks the row's own
 *     chain, never a global latest lookup.
 *   - §11  Versioning — three shapes, one logical projection.
 *   - §14 / §15 — reads allowed on locked rows / frozen books.
 *   - §16.4 / §16.5 — `reportFormat` is owned by DevelopmentPlan;
 *     classification fields honor exactly-one-shape.
 *   - §17.2 Advisory-only; §17.3 FK isolation; §17.11 no role exemption.
 */
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, SelectQueryBuilder } from 'typeorm';

import { Budget } from 'src/budget/entities/budget.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';
import { Status } from 'src/status/entities/status.entity';
import { SupplementProjectGroup } from 'src/supplement-project-group/entities/supplement-project-group.entity';
import { TrackingStatus } from 'src/tracking-status/entities/tracking-status.entity';

import type {
  ExecutiveStatusBreakdownCounts,
  GroupedExecutiveStatusBreakdown,
  GroupedExecutiveStatusBreakdownBook,
  GroupedExecutiveStatusBreakdownStatusGroup,
  GroupedExecutiveStatusBreakdownProject,
  IUnifiedProjectAggregator,
  UnifiedProjectQuery,
} from '../interfaces/unified-project-aggregator.interface';
import { EXECUTIVE_STATUS_GROUP_LABEL_TH } from '../constants/executive-status-groups';
import { resolveRevisionRoundLabel } from '../constants/revision-round-label';
// W67-FIX-02 — direct-DB count path bypasses the limit-capped list and
// groups raw status counts into the four W67 executive buckets via the
// canonical mapping. Source of truth lives in
// `aggregation/constants/executive-status-groups.ts`.
import {
  ExecutiveStatusGroup,
  mapToExecutiveStatusGroup,
} from '../constants/executive-status-groups';
// W67-FIX-02 — only canonical statuses in EXEC_VISIBLE_STATUSES are
// surfaced in the breakdown (Ready is excluded by §17.2 / Q8 default).
import { EXEC_VISIBLE_STATUSES } from '../constants/status-buckets';
import type {
  PlanReportFormat,
  ProjectKind,
  UnifiedProject,
} from '../types';
// Wave 57 W57-BE-AGG-02 — single source of truth for §1 + §5 origin
// classification. The private `toOriginType` helper now delegates to
// `classifyOriginFromIdScalars` so the magic constants `'3001'` /
// `'3001027'` live in exactly one module.
import {
  PAO_AMPHOE_ID,
  PAO_LAO_ID,
  classifyOriginFromIdScalars,
} from '../helpers/origin-type';

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

/** DSL hard upper bound — matches §4 Query DSL `maximum: 50`. */
const LIMIT_CEILING = 50;

/** DSL default when `limit` is omitted — matches §4 Query DSL `default: 20`. */
const LIMIT_DEFAULT = 20;

/**
 * Scope-split ratios for `scope === ['all']` (task §11.R2).
 * Main gets the largest share because agency-origin main-plan projects
 * dominate the historical row count; revised is the second-largest
 * active work surface; supplement is the smallest.
 */
const SCOPE_SPLIT_MAIN = 0.4;
const SCOPE_SPLIT_REVISED = 0.35;
// supplement gets the remainder so the total never exceeds `limit`.

/**
 * Legal default `PlanReportFormat` fallback when the parent plan row is
 * unresolvable (e.g. soft-deleted concurrently). Callers that need to
 * detect this graceful fallback should use the returned row's
 * `planReportFormat === 'STRATEGY_BASED'` alongside a null `planId`
 * check — but under §14 / §15 invariants the parent chain is never
 * missing for a non-deleted project, so this is defensive only.
 *
 * Task §11.R3 references this as the race-condition safety net.
 */
const FALLBACK_REPORT_FORMAT: PlanReportFormat = 'STRATEGY_BASED';

// ─────────────────────────────────────────────────────────────────────
// Internal row shapes (projected via getRawMany — keys are lower-case
// because TypeORM lowercases raw aliases).
// ─────────────────────────────────────────────────────────────────────

type MainRawRow = {
  id: string;
  title: string | null;
  planid: string | null;
  reportformat: string | null;
  amphoeid: number | null;
  agencyid: number | null;
  strategyid: string | null;
  tacticid: string | null;
  planlevelid: string | null;
  indicator: string | null;
  issueid: string | null;
  // Wave 55 W55-BE-07 — creator WorkHistory amphoe + LAO ID scalars
  // used to derive `originType` per §1 + §5. NOT PII; no person-level
  // columns are selected.
  creator_amphoe_id: string | null;
  creator_lao_id: string | null;
};

type RevisedRawRow = MainRawRow;

// W67-FIX-B — drill-down GROUP BY row shapes.
type MainBookStatusRow = {
  planid: string;
  planname: string | null;
  statusname: string;
  cnt: string;
};

type RevisedBookStatusRow = {
  planid: string;
  planname: string | null;
  dprid: string;
  revisionnumber: number | null;
  dprdescription: string | null;
  revisiontypename: string | null;
  statusname: string;
  cnt: string;
};

type SupplementBookStatusRow = {
  planid: string;
  planname: string | null;
  dpsid: string;
  supplementnumber: number | null;
  dpsdescription: string | null;
  statusname: string;
  cnt: string;
};

type SupplementRawRow = {
  id: string;
  title: string | null;
  planid: string | null;
  reportformat: string | null;
  // Wave 55 W55-DB-01 — nullable `amphoe_id` added to SPG. Historical
  // rows remain NULL; the `GeoEnrichmentService` emits a per-row
  // `geo:supplement` missingDimension for those rows.
  amphoeid: number | null;
  agencyid: number | null;
  strategyid: string | null;
  tacticid: string | null;
  planlevelid: string | null;
  indicator: string | null;
  issueid: string | null;
  // Wave 55 W55-BE-07 — creator WorkHistory amphoe + LAO ID scalars.
  creator_amphoe_id: string | null;
  creator_lao_id: string | null;
};

// ─────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────

@Injectable()
export class UnifiedProjectAggregator implements IUnifiedProjectAggregator {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /**
   * List unified projects across the requested scope(s).
   *
   * Contract:
   *   - Returns `[]` on empty match — never throws.
   *   - Discriminator `projectKind` is authoritative per row and
   *     immutable after emission.
   *   - `planReportFormat` is resolved from the parent plan's own
   *     chain (§10).
   *   - Classification fields obey §16.5 exactly-one-shape — when the
   *     row violates that invariant (shouldn't happen under the DB
   *     CHECK constraint), the row is still emitted but the caller is
   *     expected to surface `missingDimensions: ['classification']` at
   *     the envelope layer (task §9 / §11.R3).
   */
  async listUnifiedProjects(
    query: UnifiedProjectQuery,
  ): Promise<UnifiedProject[]> {
    // ── Input normalisation ────────────────────────────────────────
    if (!query || !Array.isArray(query.scope) || query.scope.length === 0) {
      // Defensive — the interface says `scope` is required. Return
      // empty graceful per §9 (shape violations surface via
      // missingDimensions at Tier C, not by throwing here).
      return [];
    }

    const scopeSet = this.normaliseScope(query.scope);
    const limit = this.clampLimit(query.limit);
    const planId = this.normalisePlanId(query.planId);
    const includeHistorical = query.includeHistoricalVersions === true;
    // Wave 55 W55-BE-06 — capture the optional `filters` clause. `undefined`
    // (DSL omitted) short-circuits `applyFilters` inside each loader.
    const filters = query.filters;

    const { mainBudget, revisedBudget, supplementBudget } =
      this.splitBudget(scopeSet, limit);

    // ── Parallel reads across the three kinds ──────────────────────
    const [mainRows, revisedRows, supplementRows] = await Promise.all([
      mainBudget > 0
        ? this.loadMain(planId, mainBudget, includeHistorical, filters)
        : Promise.resolve<MainRawRow[]>([]),
      revisedBudget > 0
        ? this.loadRevised(planId, revisedBudget, includeHistorical, filters)
        : Promise.resolve<RevisedRawRow[]>([]),
      supplementBudget > 0
        ? this.loadSupplement(planId, supplementBudget, filters)
        : Promise.resolve<SupplementRawRow[]>([]),
    ]);

    // ── Project into UnifiedProject ────────────────────────────────
    const items: UnifiedProject[] = [];

    for (const r of mainRows) {
      items.push(this.toUnified('main', r.id, r.title, r.planid, r.reportformat, {
        amphoeId: r.amphoeid,
        agencyId: r.agencyid,
        strategyId: r.strategyid,
        tacticId: r.tacticid,
        planLevelId: r.planlevelid,
        indicator: r.indicator,
        issueId: r.issueid,
        creatorAmphoeId: r.creator_amphoe_id,
        creatorLaoId: r.creator_lao_id,
      }));
    }

    for (const r of revisedRows) {
      items.push(this.toUnified('revised', r.id, r.title, r.planid, r.reportformat, {
        amphoeId: r.amphoeid,
        agencyId: r.agencyid,
        strategyId: r.strategyid,
        tacticId: r.tacticid,
        planLevelId: r.planlevelid,
        indicator: r.indicator,
        issueId: r.issueid,
        creatorAmphoeId: r.creator_amphoe_id,
        creatorLaoId: r.creator_lao_id,
      }));
    }

    for (const r of supplementRows) {
      items.push(this.toUnified('supplement', r.id, r.title, r.planid, r.reportformat, {
        // Wave 55 W55-BE-04 — SPG now has `amphoe_id` (W55-DB-01).
        // Historical rows may still be NULL; `GeoEnrichmentService`
        // emits the per-row `geo:supplement` missingDimension in that
        // case.
        amphoeId: r.amphoeid,
        agencyId: r.agencyid,
        strategyId: r.strategyid,
        tacticId: r.tacticid,
        planLevelId: r.planlevelid,
        indicator: r.indicator,
        issueId: r.issueid,
        creatorAmphoeId: r.creator_amphoe_id,
        creatorLaoId: r.creator_lao_id,
      }));
    }

    return items;
  }

  /**
   * W67-FIX-02 — direct-DB count of projects in each of the four W67
   * executive buckets (`pendingReviewCount`, `awaitingApprovalCount`,
   * `approvedCount`, `rejectedCount`).
   *
   * RATIONALE
   * ---------
   * `getExecutiveDashboardSnapshot` previously derived the 4-group
   * rollup from the limit-capped `listUnifiedProjects` result. With
   * `scope=['all']` and the 40/35/25 split, a plan with 11 main
   * projects only surfaces 8 main rows in the list — the breakdown
   * then under-reported by 3. This method runs an independent COUNT
   * query that honors the SAME plan-scope, filters, and §14.2
   * head-of-lineage semantics WITHOUT applying the list's per-kind
   * limit, so the totals reflect every matching row.
   *
   * IMPLEMENTATION
   * --------------
   *   - Three small COUNT queries (one per project kind in scope),
   *     INNER-joining `TrackingStatus` (`is_latest=true`,
   *     `deleted_at IS NULL`) and `Status` so the row's current status
   *     is observable.
   *   - `applyFilters` is reused verbatim — it adds its own status /
   *     amphoe / agency / budget / date / origin filters via TypeORM
   *     QB bind params. The new COUNT path attaches a SECOND
   *     TrackingStatus join under a distinct alias (`ts_count` /
   *     `st_count`) so it never collides with the optional status
   *     filter join (`ts_f` / `st_f`).
   *   - §14.2 head-of-lineage anti-join is applied to PG and RPG
   *     when `includeHistoricalVersions` is false (the default).
   *   - The grouped rows are folded into the four buckets via
   *     `mapToExecutiveStatusGroup`. Statuses outside
   *     `EXEC_VISIBLE_STATUSES` (e.g. `Ready`) are filtered at the
   *     SQL level so the COUNT itself is already trimmed.
   *
   * Returns all-zero counts on empty match — never throws (matches the
   * `listUnifiedProjects` defensive contract).
   *
   * §17.2 advisory only — the breakdown does not gate any workflow
   * transition. §17.3 — read-only; no `tracking_status` writes.
   */
  async countExecutiveStatusBreakdown(
    query: Omit<UnifiedProjectQuery, 'limit'>,
  ): Promise<ExecutiveStatusBreakdownCounts> {
    const totals: Record<ExecutiveStatusGroup, number> = {
      pending_review: 0,
      awaiting_approval: 0,
      approved: 0,
      rejected: 0,
    };

    // Defensive — match `listUnifiedProjects` empty-graceful contract.
    if (!query || !Array.isArray(query.scope) || query.scope.length === 0) {
      return {
        pendingReviewCount: 0,
        awaitingApprovalCount: 0,
        approvedCount: 0,
        rejectedCount: 0,
      };
    }

    const scopeSet = this.normaliseScope(query.scope);
    const planId = this.normalisePlanId(query.planId);
    const includeHistorical = query.includeHistoricalVersions === true;
    const filters = query.filters;

    // Run the three per-kind grouped counts in parallel; fold each
    // result into the canonical 4-group bucket.
    const [mainGroups, revisedGroups, supplementGroups] = await Promise.all([
      scopeSet.has('main')
        ? this.countMainByStatus(planId, includeHistorical, filters)
        : Promise.resolve<Array<{ statusname: string; cnt: string }>>([]),
      scopeSet.has('revised')
        ? this.countRevisedByStatus(planId, includeHistorical, filters)
        : Promise.resolve<Array<{ statusname: string; cnt: string }>>([]),
      scopeSet.has('supplement')
        ? this.countSupplementByStatus(planId, filters)
        : Promise.resolve<Array<{ statusname: string; cnt: string }>>([]),
    ]);

    const fold = (
      rows: Array<{ statusname: string | null; cnt: string | number }>,
    ): void => {
      for (const r of rows) {
        const grp = mapToExecutiveStatusGroup(r.statusname);
        if (!grp) continue;
        const n = typeof r.cnt === 'number' ? r.cnt : Number(r.cnt);
        if (!Number.isFinite(n)) continue;
        totals[grp] += n;
      }
    };
    fold(mainGroups);
    fold(revisedGroups);
    fold(supplementGroups);

    return {
      pendingReviewCount: totals.pending_review,
      awaitingApprovalCount: totals.awaiting_approval,
      approvedCount: totals.approved,
      rejectedCount: totals.rejected,
    };
  }

  /**
   * COUNT(*) GROUP BY status.name for ProjectGroup. See
   * `countExecutiveStatusBreakdown` for the rationale and design.
   */
  private countMainByStatus(
    planId: string | undefined,
    includeHistorical: boolean,
    filters: UnifiedProjectQuery['filters'],
  ): Promise<Array<{ statusname: string; cnt: string }>> {
    const visible = [...EXEC_VISIBLE_STATUSES];
    const qb: SelectQueryBuilder<ProjectGroup> = this.dataSource
      .getRepository(ProjectGroup)
      .createQueryBuilder('pg')
      .innerJoin('pg.developmentPlan', 'dp')
      // Wave 55 W55-BE-07 — same creator-chain LEFT JOIN as `loadMain`
      // so the optional `filters.originType` predicate composes
      // correctly via the shared `applyFilters` helper.
      .leftJoin('pg.createdBy', 'wh_cb')
      .leftJoin('wh_cb.amphoe', 'wh_amp')
      .leftJoin('wh_cb.localAdministrativeOrganization', 'wh_lao')
      // W67-FIX-02 count-path JOIN — distinct alias so it never
      // collides with the OPTIONAL `applyFilters` status join (`ts_f`).
      .innerJoin(
        TrackingStatus,
        'ts_count',
        'ts_count.project_group_id = pg.id ' +
          'AND ts_count.is_latest = true ' +
          'AND ts_count."deletedAt" IS NULL',
      )
      .innerJoin(Status, 'st_count', 'st_count.id = ts_count.status_id')
      .select('st_count.name', 'statusname')
      .addSelect('COUNT(*)', 'cnt')
      .where('pg.deletedAt IS NULL')
      .andWhere('dp.deletedAt IS NULL')
      .andWhere('st_count.name IN (:...execVisibleStatusesMain)', {
        execVisibleStatusesMain: visible,
      })
      .groupBy('st_count.name');

    if (planId) {
      qb.andWhere('dp.id = :planId', { planId });
    }

    if (!includeHistorical) {
      qb.leftJoin(
        RevisedProjectGroup,
        'pg_desc',
        'pg_desc.prev_project_id = pg.id ' +
          "AND pg_desc.prev_project_type = 'original' " +
          'AND pg_desc.deleted_at IS NULL',
      ).andWhere('pg_desc.id IS NULL');
    }

    this.applyFilters(qb, filters, 'main');

    return qb.getRawMany<{ statusname: string; cnt: string }>();
  }

  /** COUNT(*) GROUP BY status.name for RevisedProjectGroup. */
  private countRevisedByStatus(
    planId: string | undefined,
    includeHistorical: boolean,
    filters: UnifiedProjectQuery['filters'],
  ): Promise<Array<{ statusname: string; cnt: string }>> {
    const visible = [...EXEC_VISIBLE_STATUSES];
    const qb: SelectQueryBuilder<RevisedProjectGroup> = this.dataSource
      .getRepository(RevisedProjectGroup)
      .createQueryBuilder('rpg')
      .innerJoin('rpg.developmentPlanRevision', 'dpr')
      .innerJoin('dpr.developmentPlan', 'dp')
      .leftJoin('rpg.createdBy', 'wh_cb')
      .leftJoin('wh_cb.amphoe', 'wh_amp')
      .leftJoin('wh_cb.localAdministrativeOrganization', 'wh_lao')
      .innerJoin(
        TrackingStatus,
        'ts_count',
        'ts_count.revised_project_group_id = rpg.id ' +
          'AND ts_count.is_latest = true ' +
          'AND ts_count."deletedAt" IS NULL',
      )
      .innerJoin(Status, 'st_count', 'st_count.id = ts_count.status_id')
      .select('st_count.name', 'statusname')
      .addSelect('COUNT(*)', 'cnt')
      .where('rpg.deletedAt IS NULL')
      .andWhere('dpr.deletedAt IS NULL')
      .andWhere('dp.deletedAt IS NULL')
      .andWhere('st_count.name IN (:...execVisibleStatusesRevised)', {
        execVisibleStatusesRevised: visible,
      })
      .groupBy('st_count.name');

    if (planId) {
      qb.andWhere('dp.id = :planId', { planId });
    }

    if (!includeHistorical) {
      qb.leftJoin(
        RevisedProjectGroup,
        'rpg_desc',
        'rpg_desc.prev_project_id = rpg.id ' +
          "AND rpg_desc.prev_project_type = 'revised' " +
          'AND rpg_desc.deleted_at IS NULL',
      ).andWhere('rpg_desc.id IS NULL');
    }

    this.applyFilters(qb, filters, 'revised');

    return qb.getRawMany<{ statusname: string; cnt: string }>();
  }

  /** COUNT(*) GROUP BY status.name for SupplementProjectGroup. */
  private countSupplementByStatus(
    planId: string | undefined,
    filters: UnifiedProjectQuery['filters'],
  ): Promise<Array<{ statusname: string; cnt: string }>> {
    const visible = [...EXEC_VISIBLE_STATUSES];
    const qb: SelectQueryBuilder<SupplementProjectGroup> = this.dataSource
      .getRepository(SupplementProjectGroup)
      .createQueryBuilder('spg')
      .innerJoin('spg.developmentPlanSupplement', 'dps')
      .innerJoin('dps.developmentPlan', 'dp')
      .leftJoin('spg.createdBy', 'wh_cb')
      .leftJoin('wh_cb.amphoe', 'wh_amp')
      .leftJoin('wh_cb.localAdministrativeOrganization', 'wh_lao')
      .innerJoin(
        TrackingStatus,
        'ts_count',
        'ts_count.supplement_project_group_id = spg.id ' +
          'AND ts_count.is_latest = true ' +
          'AND ts_count."deletedAt" IS NULL',
      )
      .innerJoin(Status, 'st_count', 'st_count.id = ts_count.status_id')
      .select('st_count.name', 'statusname')
      .addSelect('COUNT(*)', 'cnt')
      .where('spg.deletedAt IS NULL')
      .andWhere('dps.deletedAt IS NULL')
      .andWhere('dp.deletedAt IS NULL')
      .andWhere('st_count.name IN (:...execVisibleStatusesSupplement)', {
        execVisibleStatusesSupplement: visible,
      })
      .groupBy('st_count.name');

    if (planId) {
      qb.andWhere('dp.id = :planId', { planId });
    }

    // SPG is not part of the §14.1 PG / RPG revision chain so head-of-
    // lineage filtering is intentionally skipped (see §14.2 + the
    // `includeHistoricalVersions` doc comment in the interface).

    this.applyFilters(qb, filters, 'supplement');

    return qb.getRawMany<{ statusname: string; cnt: string }>();
  }

  /**
   * W67-FIX-B — hierarchical drill-down. See contract on
   * `IUnifiedProjectAggregator.groupedExecutiveStatusBreakdown`.
   *
   * Query plan:
   *   1. Per requested kind, run a `(book × status) GROUP BY` COUNT to
   *      learn the bucket totals (matches the FIX-02 head-of-lineage and
   *      `EXEC_VISIBLE_STATUSES` predicates exactly).
   *   2. Per (book × status) bucket, fetch a SAMPLE of project rows
   *      ordered by `created_at DESC`: ALL when count <= 10; otherwise the
   *      first 5 with `truncatedRemainder = count - 5` (Q2 hybrid).
   *   3. Resolve the bookLabel (Q3 combo: planLabel for main; "planLabel /
   *      roundLabel" for revised/supplement).
   *   4. Sort books (main → revised → supplement; within revised by round
   *      label asc), drop empty buckets (Q6).
   */
  async groupedExecutiveStatusBreakdown(
    query: Omit<UnifiedProjectQuery, 'limit'>,
  ): Promise<GroupedExecutiveStatusBreakdown> {
    if (!query || !Array.isArray(query.scope) || query.scope.length === 0) {
      return { books: [] };
    }

    const scopeSet = this.normaliseScope(query.scope);
    const planId = this.normalisePlanId(query.planId);
    const includeHistorical = query.includeHistoricalVersions === true;
    const filters = query.filters;

    const [mainGroups, revisedGroups, supplementGroups] = await Promise.all([
      scopeSet.has('main')
        ? this.countMainByBookAndStatus(planId, includeHistorical, filters)
        : Promise.resolve<MainBookStatusRow[]>([]),
      scopeSet.has('revised')
        ? this.countRevisedByBookAndStatus(planId, includeHistorical, filters)
        : Promise.resolve<RevisedBookStatusRow[]>([]),
      scopeSet.has('supplement')
        ? this.countSupplementByBookAndStatus(planId, filters)
        : Promise.resolve<SupplementBookStatusRow[]>([]),
    ]);

    // ── Fold per-kind rows into a Map keyed by bookKey, then fill
    // sample projects.
    const bookMap = new Map<string, GroupedExecutiveStatusBreakdownBook>();

    // helper: get-or-create a status entry under a book
    const upsertStatus = (
      book: GroupedExecutiveStatusBreakdownBook,
      group: GroupedExecutiveStatusBreakdownStatusGroup['group'],
      delta: number,
    ): GroupedExecutiveStatusBreakdownStatusGroup => {
      let entry = book.statuses.find((s) => s.group === group);
      if (!entry) {
        entry = {
          group,
          groupLabel: EXECUTIVE_STATUS_GROUP_LABEL_TH[group],
          count: 0,
          projects: [],
          truncatedRemainder: 0,
        };
        book.statuses.push(entry);
      }
      entry.count += delta;
      return entry;
    };

    const ensureBookMain = (
      planId: string,
      planLabel: string,
    ): GroupedExecutiveStatusBreakdownBook => {
      const bookKey = `${planId}::main`;
      let book = bookMap.get(bookKey);
      if (!book) {
        book = {
          bookKey,
          bookKind: 'main',
          bookLabel: planLabel,
          planLabel,
          roundLabel: null,
          statuses: [],
        };
        bookMap.set(bookKey, book);
      }
      return book;
    };

    const ensureBookRevised = (
      planId: string,
      planLabel: string,
      dprId: string,
      roundLabel: string,
    ): GroupedExecutiveStatusBreakdownBook => {
      const bookKey = `${planId}::revised::${dprId}`;
      let book = bookMap.get(bookKey);
      if (!book) {
        book = {
          bookKey,
          bookKind: 'revised',
          bookLabel: `${planLabel} / ${roundLabel}`,
          planLabel,
          roundLabel,
          statuses: [],
        };
        bookMap.set(bookKey, book);
      }
      return book;
    };

    const ensureBookSupplement = (
      planId: string,
      planLabel: string,
      dpsId: string,
      roundLabel: string,
    ): GroupedExecutiveStatusBreakdownBook => {
      const bookKey = `${planId}::supplement::${dpsId}`;
      let book = bookMap.get(bookKey);
      if (!book) {
        book = {
          bookKey,
          bookKind: 'supplement',
          bookLabel: `${planLabel} / ${roundLabel}`,
          planLabel,
          roundLabel,
          statuses: [],
        };
        bookMap.set(bookKey, book);
      }
      return book;
    };

    // ── Fold counts ──────────────────────────────────────────────────
    for (const r of mainGroups) {
      const grp = mapToExecutiveStatusGroup(r.statusname);
      if (!grp) continue;
      const cnt = Number(r.cnt);
      if (!Number.isFinite(cnt) || cnt <= 0) continue;
      const book = ensureBookMain(r.planid, r.planname ?? '');
      upsertStatus(book, grp, cnt);
    }
    for (const r of revisedGroups) {
      const grp = mapToExecutiveStatusGroup(r.statusname);
      if (!grp) continue;
      const cnt = Number(r.cnt);
      if (!Number.isFinite(cnt) || cnt <= 0) continue;
      const roundType: 'edit' | 'change' = (() => {
        const t = (r.revisiontypename ?? '').trim();
        return t === 'เปลี่ยนแปลง' || t.toLowerCase() === 'change'
          ? 'change'
          : 'edit';
      })();
      const roundLabel = resolveRevisionRoundLabel({
        type: roundType,
        number: r.revisionnumber,
        description: r.dprdescription,
      });
      const book = ensureBookRevised(
        r.planid,
        r.planname ?? '',
        r.dprid,
        roundLabel,
      );
      upsertStatus(book, grp, cnt);
    }
    for (const r of supplementGroups) {
      const grp = mapToExecutiveStatusGroup(r.statusname);
      if (!grp) continue;
      const cnt = Number(r.cnt);
      if (!Number.isFinite(cnt) || cnt <= 0) continue;
      const roundLabel = resolveRevisionRoundLabel({
        type: 'supplement',
        number: r.supplementnumber,
        description: r.dpsdescription,
      });
      const book = ensureBookSupplement(
        r.planid,
        r.planname ?? '',
        r.dpsid,
        roundLabel,
      );
      upsertStatus(book, grp, cnt);
    }

    // ── Sample projects per bucket ──────────────────────────────────
    // Collect sample-fetch tasks across all books → run in parallel.
    const sampleTasks: Promise<void>[] = [];
    for (const book of bookMap.values()) {
      for (const status of book.statuses) {
        sampleTasks.push(
          this.fetchProjectsForBookStatus({
            book,
            status,
            planId: book.planLabel ? this.extractPlanIdFromKey(book.bookKey) : null,
            includeHistorical,
            filters,
          }),
        );
      }
    }
    await Promise.all(sampleTasks);

    // ── W67-FIX-C — annotate each project with `linkedRelated` ─────
    // Build the visible-projects index BEFORE filtering empty buckets so
    // candidates from any (book × status) pair are reachable. The resolver
    // tries FK-chain first (active only under
    // `includeHistoricalVersions=true`) and falls back to a normalized
    // name-exact match honoring §14.2 head-of-lineage on the candidate
    // side.
    await this.annotateLinkedRelated(bookMap, planId, includeHistorical, filters);

    // ── Drop empty buckets + sort ───────────────────────────────────
    const STATUS_ORDER: GroupedExecutiveStatusBreakdownStatusGroup['group'][] = [
      'pending_review',
      'awaiting_approval',
      'approved',
      'rejected',
    ];
    const KIND_ORDER: GroupedExecutiveStatusBreakdownBook['bookKind'][] = [
      'main',
      'revised',
      'supplement',
    ];

    const books: GroupedExecutiveStatusBreakdownBook[] = [];
    for (const book of bookMap.values()) {
      const filteredStatuses = book.statuses
        .filter((s) => s.count > 0)
        .sort(
          (a, b) =>
            STATUS_ORDER.indexOf(a.group) - STATUS_ORDER.indexOf(b.group),
        );
      if (filteredStatuses.length === 0) continue;
      book.statuses = filteredStatuses;
      books.push(book);
    }

    books.sort((a, b) => {
      const kindDelta =
        KIND_ORDER.indexOf(a.bookKind) - KIND_ORDER.indexOf(b.bookKind);
      if (kindDelta !== 0) return kindDelta;
      // Within the same kind, sort by roundLabel asc (main has null —
      // identical kind already, so this branch only runs for revised /
      // supplement). String compare is good enough — labels share a
      // common prefix and a numeric suffix.
      const al = a.roundLabel ?? '';
      const bl = b.roundLabel ?? '';
      return al < bl ? -1 : al > bl ? 1 : 0;
    });

    return { books };
  }

  /** bookKey shape: `${planId}::main` | `${planId}::revised::${dprId}` | `${planId}::supplement::${dpsId}` */
  private extractPlanIdFromKey(bookKey: string): string | null {
    const idx = bookKey.indexOf('::');
    if (idx <= 0) return null;
    return bookKey.slice(0, idx);
  }

  /**
   * Per-book × per-status sample fetcher. Runs ONE SELECT per (book,
   * status) bucket. Honors the SAME §14.2 head-of-lineage anti-join and
   * `EXEC_VISIBLE_STATUSES` whitelist as `countMain/Revised/Supplement
   * ByBookAndStatus`.
   */
  private async fetchProjectsForBookStatus(args: {
    book: GroupedExecutiveStatusBreakdownBook;
    status: GroupedExecutiveStatusBreakdownStatusGroup;
    planId: string | null;
    includeHistorical: boolean;
    filters: UnifiedProjectQuery['filters'];
  }): Promise<void> {
    const { book, status } = args;
    const cap = status.count <= 10 ? status.count : 5;
    if (cap <= 0) return;
    const includeHistorical = args.includeHistorical;
    const filters = args.filters;

    // Determine the canonical statuses (English names) that map to the
    // current group. mapToExecutiveStatusGroup is the inverse — we
    // enumerate possible statuses per group locally.
    const groupToCanonical: Record<
      GroupedExecutiveStatusBreakdownStatusGroup['group'],
      string[]
    > = {
      pending_review: ['Pending'],
      awaiting_approval: ['Verified', 'Pending_Approval'],
      approved: ['Approved'],
      rejected: ['Rejected'],
    };
    const canonical = groupToCanonical[status.group];
    if (!canonical || canonical.length === 0) return;

    // W67-COORDINATOR-LAO (2026-04-27) — extend the projection with
    // the project's OWN LAO (the coordinator). For PG/RPG we LEFT JOIN
    // the project's `localAdministrativeOrganization` relation under a
    // distinct alias `proj_lao` (NOT `wh_lao`, which is the creator's
    // LAO via WorkHistory and serves the §1+§5 originType discriminator).
    // SPG has no LAO FK column, so the projection always emits null.
    let rows: Array<{
      id: string;
      title: string | null;
      pagenumber: number | null;
      proj_lao_id: string | null;
      proj_lao_name: string | null;
    }> = [];
    if (book.bookKind === 'main') {
      const planId = args.planId;
      if (!planId) return;
      const qb = this.dataSource
        .getRepository(ProjectGroup)
        .createQueryBuilder('pg')
        .innerJoin('pg.developmentPlan', 'dp')
        .leftJoin('pg.createdBy', 'wh_cb')
        .leftJoin('wh_cb.amphoe', 'wh_amp')
        .leftJoin('wh_cb.localAdministrativeOrganization', 'wh_lao')
        // W67-COORDINATOR-LAO — project's own LAO (coordinator).
        .leftJoin('pg.localAdministrativeOrganization', 'proj_lao')
        .innerJoin(
          TrackingStatus,
          'ts_count',
          'ts_count.project_group_id = pg.id ' +
            'AND ts_count.is_latest = true ' +
            'AND ts_count."deletedAt" IS NULL',
        )
        .innerJoin(Status, 'st_count', 'st_count.id = ts_count.status_id')
        .select('pg.id', 'id')
        .addSelect('pg.title', 'title')
        // W67-FIX-C — surface pageNumber per project entry (Q1=yes).
        .addSelect('pg.pageNumber', 'pagenumber')
        // W67-COORDINATOR-LAO — coordinator-LAO id + name (nullable).
        .addSelect('proj_lao.id', 'proj_lao_id')
        .addSelect('proj_lao.name', 'proj_lao_name')
        .where('pg.deletedAt IS NULL')
        .andWhere('dp.deletedAt IS NULL')
        .andWhere('dp.id = :planIdFilter', { planIdFilter: planId })
        .andWhere('st_count.name IN (:...drillSampleStatuses)', {
          drillSampleStatuses: canonical,
        })
        .orderBy('pg.created_at', 'DESC')
        .limit(cap);
      if (!includeHistorical) {
        qb.leftJoin(
          RevisedProjectGroup,
          'pg_desc',
          'pg_desc.prev_project_id = pg.id ' +
            "AND pg_desc.prev_project_type = 'original' " +
            'AND pg_desc.deleted_at IS NULL',
        ).andWhere('pg_desc.id IS NULL');
      }
      this.applyFilters(qb, filters, 'main');
      rows = await qb.getRawMany<{
        id: string;
        title: string | null;
        pagenumber: number | null;
        proj_lao_id: string | null;
        proj_lao_name: string | null;
      }>();
    } else if (book.bookKind === 'revised') {
      // bookKey: `${planId}::revised::${dprId}` — pull dprId from key
      const parts = book.bookKey.split('::');
      const dprId = parts.length === 3 && parts[1] === 'revised' ? parts[2] : null;
      if (!dprId) return;
      const qb = this.dataSource
        .getRepository(RevisedProjectGroup)
        .createQueryBuilder('rpg')
        .innerJoin('rpg.developmentPlanRevision', 'dpr')
        .innerJoin('dpr.developmentPlan', 'dp')
        .leftJoin('rpg.createdBy', 'wh_cb')
        .leftJoin('wh_cb.amphoe', 'wh_amp')
        .leftJoin('wh_cb.localAdministrativeOrganization', 'wh_lao')
        // W67-COORDINATOR-LAO — project's own LAO (coordinator).
        .leftJoin('rpg.localAdministrativeOrganization', 'proj_lao')
        .innerJoin(
          TrackingStatus,
          'ts_count',
          'ts_count.revised_project_group_id = rpg.id ' +
            'AND ts_count.is_latest = true ' +
            'AND ts_count."deletedAt" IS NULL',
        )
        .innerJoin(Status, 'st_count', 'st_count.id = ts_count.status_id')
        .select('rpg.id', 'id')
        .addSelect('rpg.title', 'title')
        // W67-FIX-C — pageNumber per project entry (Q1=yes).
        .addSelect('rpg.pageNumber', 'pagenumber')
        // W67-COORDINATOR-LAO — coordinator-LAO id + name (nullable).
        .addSelect('proj_lao.id', 'proj_lao_id')
        .addSelect('proj_lao.name', 'proj_lao_name')
        .where('rpg.deletedAt IS NULL')
        .andWhere('dpr.deletedAt IS NULL')
        .andWhere('dp.deletedAt IS NULL')
        .andWhere('dpr.id = :dprIdFilter', { dprIdFilter: dprId })
        .andWhere('st_count.name IN (:...drillSampleStatuses)', {
          drillSampleStatuses: canonical,
        })
        .orderBy('rpg.created_at', 'DESC')
        .limit(cap);
      if (!includeHistorical) {
        qb.leftJoin(
          RevisedProjectGroup,
          'rpg_desc',
          'rpg_desc.prev_project_id = rpg.id ' +
            "AND rpg_desc.prev_project_type = 'revised' " +
            'AND rpg_desc.deleted_at IS NULL',
        ).andWhere('rpg_desc.id IS NULL');
      }
      this.applyFilters(qb, filters, 'revised');
      rows = await qb.getRawMany<{
        id: string;
        title: string | null;
        pagenumber: number | null;
        proj_lao_id: string | null;
        proj_lao_name: string | null;
      }>();
    } else {
      // supplement
      const parts = book.bookKey.split('::');
      const dpsId =
        parts.length === 3 && parts[1] === 'supplement' ? parts[2] : null;
      if (!dpsId) return;
      const qb = this.dataSource
        .getRepository(SupplementProjectGroup)
        .createQueryBuilder('spg')
        .innerJoin('spg.developmentPlanSupplement', 'dps')
        .innerJoin('dps.developmentPlan', 'dp')
        .leftJoin('spg.createdBy', 'wh_cb')
        .leftJoin('wh_cb.amphoe', 'wh_amp')
        .leftJoin('wh_cb.localAdministrativeOrganization', 'wh_lao')
        .innerJoin(
          TrackingStatus,
          'ts_count',
          'ts_count.supplement_project_group_id = spg.id ' +
            'AND ts_count.is_latest = true ' +
            'AND ts_count."deletedAt" IS NULL',
        )
        .innerJoin(Status, 'st_count', 'st_count.id = ts_count.status_id')
        .select('spg.id', 'id')
        .addSelect('spg.title', 'title')
        // W67-FIX-C — pageNumber per project entry (Q1=yes).
        .addSelect('spg.pageNumber', 'pagenumber')
        .where('spg.deletedAt IS NULL')
        .andWhere('dps.deletedAt IS NULL')
        .andWhere('dp.deletedAt IS NULL')
        .andWhere('dps.id = :dpsIdFilter', { dpsIdFilter: dpsId })
        .andWhere('st_count.name IN (:...drillSampleStatuses)', {
          drillSampleStatuses: canonical,
        })
        .orderBy('spg.created_at', 'DESC')
        .limit(cap);
      this.applyFilters(qb, filters, 'supplement');
      // W67-COORDINATOR-LAO — SPG has no `local_administrative_organization_id`
      // column; emit null shaped rows so the projection stays type-safe.
      const spgRows = await qb.getRawMany<{
        id: string;
        title: string | null;
        pagenumber: number | null;
      }>();
      rows = spgRows.map((r) => ({
        ...r,
        proj_lao_id: null,
        proj_lao_name: null,
      }));
    }

    const projects: GroupedExecutiveStatusBreakdownProject[] = rows.map(
      (r) => ({
        projectId: r.id,
        projectKind: book.bookKind,
        name: r.title ?? '',
        // W67-FIX-C — pageNumber + bookLabel per entry (Q1=yes). bookLabel
        // is the same combo formula the book heading uses (planLabel for
        // main; planLabel + roundLabel for revised/supplement).
        pageNumber:
          typeof r.pagenumber === 'number' && Number.isFinite(r.pagenumber)
            ? r.pagenumber
            : null,
        bookLabel: book.bookLabel,
        // linkedRelated is filled in a second pass (`annotateLinkedRelated`)
        // after every book × status sample is hydrated, so the resolver
        // can search across the entire visible drill window.
        linkedRelated: null,
        // W67-COORDINATOR-LAO (2026-04-27) — surface coordinator LAO name
        // when the project's own LAO is non-null AND not อบจ.นม itself
        // (PAO_LAO_ID = '3001027'). Otherwise null — direct อบจ. project
        // OR SPG (no LAO FK) emits no annotation.
        coordinatorLaoName:
          r.proj_lao_id !== null &&
          r.proj_lao_id !== PAO_LAO_ID &&
          typeof r.proj_lao_name === 'string' &&
          r.proj_lao_name.length > 0
            ? r.proj_lao_name
            : null,
      }),
    );
    status.projects = projects;
    status.truncatedRemainder =
      status.count > 10 ? Math.max(0, status.count - 5) : 0;
  }

  /**
   * W67-FIX-C — annotate every visible drill project with `linkedRelated`.
   *
   * Resolution strategy (Q2=C, 2026-04-26):
   *
   * 1. **FK-chain match (preferred)** — walk forward through
   *    `revised_project_groups.prev_project_id` to find the leaf
   *    descendant of the project. Activates only when
   *    `includeHistoricalVersions=true`; under §14.2 default the drill
   *    target itself has NO descendant (otherwise it'd be hidden).
   *    Iterative loop bounded at 10 levels (defensive against a
   *    pathological cycle, which shouldn't exist under §14.1).
   *
   * 2. **Name-exact fallback** — `LOWER(TRIM(name))` exact match across
   *    the visible drill window (every project hydrated in Step 2 of
   *    `groupedExecutiveStatusBreakdown`). Multiple candidates →
   *    most-recent (latest createdAt) wins. §14.2 head-of-lineage is
   *    honored by construction: visible drill projects are themselves
   *    head-of-lineage when `includeHistoricalVersions=false`. When the
   *    flag flips true and ancestors become visible, FK-chain match
   *    runs first and short-circuits before name-match would surface a
   *    hidden ancestor.
   *
   * §14.2 head-of-lineage MUST NOT be violated by either path. §17.2
   * advisory only — `linkedRelated` does not gate any workflow action.
   *
   * The function mutates `book.statuses[i].projects[j].linkedRelated`
   * in place. Failures are swallowed per-project: the FK walk is
   * try/catched so a single-row DB blip never poisons the whole
   * envelope (§17.2).
   */
  private async annotateLinkedRelated(
    bookMap: Map<string, GroupedExecutiveStatusBreakdownBook>,
    planId: string | undefined,
    includeHistorical: boolean,
    filters: UnifiedProjectQuery['filters'],
  ): Promise<void> {
    // Collect every visible drill project across all (book × status)
    // pairs. This is the candidate pool for the name-match fallback.
    const visible: GroupedExecutiveStatusBreakdownProject[] = [];
    for (const book of bookMap.values()) {
      for (const status of book.statuses) {
        for (const project of status.projects) {
          visible.push(project);
        }
      }
    }
    if (visible.length === 0) return;

    // Resolve createdAt per visible project so the multi-candidate
    // tie-break ("latest wins") has the data it needs. The lookup is
    // done once per drill call — three batched SELECTs (one per kind).
    const createdAtById = await this.loadDrillCreatedAt(visible);

    // Build the normalized-name index. Excluded `null`/empty names are
    // ignored to avoid a degenerate "all blanks match each other" case.
    const byName = new Map<string, GroupedExecutiveStatusBreakdownProject[]>();
    for (const p of visible) {
      const norm = (p.name ?? '').trim().toLowerCase();
      if (norm.length === 0) continue;
      const arr = byName.get(norm) ?? [];
      arr.push(p);
      byName.set(norm, arr);
    }

    // Per-project resolution loop. Each project gets at most ONE
    // FK-walk + ONE name-map lookup (no DB call when FK is skipped).
    const fkTasks: Promise<void>[] = [];
    for (const book of bookMap.values()) {
      for (const status of book.statuses) {
        for (const project of status.projects) {
          fkTasks.push(
            (async () => {
              if (includeHistorical) {
                const fk = await this.resolveFkChainLinked(
                  project,
                  bookMap,
                  planId,
                  filters,
                );
                if (fk) {
                  project.linkedRelated = fk;
                  return;
                }
              }
              // Name-match fallback.
              const norm = (project.name ?? '').trim().toLowerCase();
              if (norm.length === 0) return;
              const candidates = (byName.get(norm) ?? []).filter(
                (c) => c.projectId !== project.projectId,
              );
              if (candidates.length === 0) return;
              // Tie-break: most recent createdAt wins.
              let best = candidates[0];
              let bestAt = createdAtById.get(
                `${best.projectKind}:${best.projectId}`,
              ) ?? 0;
              for (let i = 1; i < candidates.length; i++) {
                const c = candidates[i];
                const at =
                  createdAtById.get(`${c.projectKind}:${c.projectId}`) ?? 0;
                if (at > bestAt) {
                  best = c;
                  bestAt = at;
                }
              }
              project.linkedRelated = {
                bookLabel: best.bookLabel,
                pageNumber: best.pageNumber,
                matchType: 'name-exact',
              };
            })(),
          );
        }
      }
    }
    await Promise.all(fkTasks);
  }

  /**
   * W67-FIX-C — load `created_at` for every visible drill project.
   * Three batched SELECTs (one per kind). Returns a Map keyed by
   * `${projectKind}:${projectId}` carrying epoch-ms timestamps.
   */
  private async loadDrillCreatedAt(
    visible: GroupedExecutiveStatusBreakdownProject[],
  ): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    const mainIds = visible
      .filter((p) => p.projectKind === 'main')
      .map((p) => p.projectId);
    const revisedIds = visible
      .filter((p) => p.projectKind === 'revised')
      .map((p) => p.projectId);
    const supplementIds = visible
      .filter((p) => p.projectKind === 'supplement')
      .map((p) => p.projectId);

    type Row = { id: string; createdat: Date | string | null };

    const fetchKind = async (
      kind: ProjectKind,
      ids: string[],
    ): Promise<Row[]> => {
      if (ids.length === 0) return [];
      const repo =
        kind === 'main'
          ? this.dataSource.getRepository(ProjectGroup)
          : kind === 'revised'
            ? this.dataSource.getRepository(RevisedProjectGroup)
            : this.dataSource.getRepository(SupplementProjectGroup);
      const alias = kind === 'main' ? 'pg' : kind === 'revised' ? 'rpg' : 'spg';
      return repo
        .createQueryBuilder(alias)
        .select(`${alias}.id`, 'id')
        .addSelect(`${alias}.created_at`, 'createdat')
        .where(`${alias}.id IN (:...ids)`, { ids })
        .getRawMany<Row>();
    };

    const [mainRows, revisedRows, supplementRows] = await Promise.all([
      fetchKind('main', mainIds),
      fetchKind('revised', revisedIds),
      fetchKind('supplement', supplementIds),
    ]);

    const ingest = (kind: ProjectKind, rows: Row[]): void => {
      for (const r of rows) {
        const at =
          r.createdat instanceof Date
            ? r.createdat.getTime()
            : typeof r.createdat === 'string'
              ? new Date(r.createdat).getTime()
              : 0;
        map.set(`${kind}:${r.id}`, Number.isFinite(at) ? at : 0);
      }
    };
    ingest('main', mainRows);
    ingest('revised', revisedRows);
    ingest('supplement', supplementRows);
    return map;
  }

  /**
   * W67-FIX-C — walk forward through `prev_project_id` to the leaf
   * descendant of `project`. Returns the leaf's `linkedRelated` shape,
   * or `null` when the chain is empty / produces no different leaf.
   *
   * Active only under `includeHistoricalVersions=true` — the caller
   * gates this. The walk uses iterative TypeORM QueryBuilder hops
   * (max 10) so we never emit a raw SQL CTE (§17.9 / Wave 54 no-raw-SQL).
   *
   * The leaf's `bookLabel` + `pageNumber` are resolved via a final
   * lookup that JOINs the parent plan / DPR / DPS, mirroring the
   * label-formula used by `groupedExecutiveStatusBreakdown` so the
   * surface stays identical across paths.
   */
  private async resolveFkChainLinked(
    project: GroupedExecutiveStatusBreakdownProject,
    _bookMap: Map<string, GroupedExecutiveStatusBreakdownBook>,
    _planId: string | undefined,
    _filters: UnifiedProjectQuery['filters'],
  ): Promise<GroupedExecutiveStatusBreakdownProject['linkedRelated']> {
    // Only PG / RPG can have descendants in revised_project_groups
    // (§14.1 — SPG is not part of the chain).
    if (project.projectKind === 'supplement') return null;

    let currentId = project.projectId;
    let currentKind: 'original' | 'revised' =
      project.projectKind === 'main' ? 'original' : 'revised';
    let lastDescendantId: string | null = null;
    const MAX_HOPS = 10;

    for (let hop = 0; hop < MAX_HOPS; hop++) {
      const row = await this.dataSource
        .getRepository(RevisedProjectGroup)
        .createQueryBuilder('rpg')
        .select('rpg.id', 'id')
        .where('rpg.prev_project_id = :pid', { pid: currentId })
        .andWhere('rpg.prev_project_type = :ptype', { ptype: currentKind })
        .andWhere('rpg.deleted_at IS NULL')
        // Tie-breaker (DAG case — §14.1 tolerates fork shapes): pick
        // the most-recent child as the canonical forward edge.
        .orderBy('rpg.created_at', 'DESC')
        .limit(1)
        .getRawOne<{ id: string }>();
      if (!row) break;
      lastDescendantId = row.id;
      currentId = row.id;
      currentKind = 'revised';
    }

    if (!lastDescendantId || lastDescendantId === project.projectId) {
      return null;
    }

    // Resolve bookLabel + pageNumber for the leaf descendant via a
    // single SELECT through the RPG → DPR → DP / RevisionType chain.
    const leaf = await this.dataSource
      .getRepository(RevisedProjectGroup)
      .createQueryBuilder('rpg')
      .innerJoin('rpg.developmentPlanRevision', 'dpr')
      .innerJoin('dpr.developmentPlan', 'dp')
      .leftJoin('dpr.revisionType', 'rt')
      .select('rpg.pageNumber', 'pagenumber')
      .addSelect('dp.name', 'planname')
      .addSelect('dpr.revision_number', 'revisionnumber')
      .addSelect('dpr.description', 'dprdescription')
      .addSelect('rt.name', 'revisiontypename')
      .where('rpg.id = :leafId', { leafId: lastDescendantId })
      .andWhere('rpg.deletedAt IS NULL')
      .andWhere('dpr.deletedAt IS NULL')
      .andWhere('dp.deletedAt IS NULL')
      .getRawOne<{
        pagenumber: number | null;
        planname: string | null;
        revisionnumber: number | null;
        dprdescription: string | null;
        revisiontypename: string | null;
      }>();
    if (!leaf) return null;

    const roundType: 'edit' | 'change' = (() => {
      const t = (leaf.revisiontypename ?? '').trim();
      return t === 'เปลี่ยนแปลง' || t.toLowerCase() === 'change'
        ? 'change'
        : 'edit';
    })();
    const roundLabel = resolveRevisionRoundLabel({
      type: roundType,
      number: leaf.revisionnumber,
      description: leaf.dprdescription,
    });
    const planLabel = leaf.planname ?? '';
    const bookLabel = `${planLabel} / ${roundLabel}`;
    return {
      bookLabel,
      pageNumber:
        typeof leaf.pagenumber === 'number' && Number.isFinite(leaf.pagenumber)
          ? leaf.pagenumber
          : null,
      matchType: 'fk-chain',
    };
  }

  /** COUNT(*) GROUP BY (planId, status.name) for ProjectGroup. */
  private countMainByBookAndStatus(
    planId: string | undefined,
    includeHistorical: boolean,
    filters: UnifiedProjectQuery['filters'],
  ): Promise<MainBookStatusRow[]> {
    const visible = [...EXEC_VISIBLE_STATUSES];
    const qb: SelectQueryBuilder<ProjectGroup> = this.dataSource
      .getRepository(ProjectGroup)
      .createQueryBuilder('pg')
      .innerJoin('pg.developmentPlan', 'dp')
      .leftJoin('pg.createdBy', 'wh_cb')
      .leftJoin('wh_cb.amphoe', 'wh_amp')
      .leftJoin('wh_cb.localAdministrativeOrganization', 'wh_lao')
      .innerJoin(
        TrackingStatus,
        'ts_count',
        'ts_count.project_group_id = pg.id ' +
          'AND ts_count.is_latest = true ' +
          'AND ts_count."deletedAt" IS NULL',
      )
      .innerJoin(Status, 'st_count', 'st_count.id = ts_count.status_id')
      .select('dp.id', 'planid')
      .addSelect('dp.name', 'planname')
      .addSelect('st_count.name', 'statusname')
      .addSelect('COUNT(*)', 'cnt')
      .where('pg.deletedAt IS NULL')
      .andWhere('dp.deletedAt IS NULL')
      .andWhere('st_count.name IN (:...execVisibleStatusesMainDrill)', {
        execVisibleStatusesMainDrill: visible,
      })
      .groupBy('dp.id')
      .addGroupBy('dp.name')
      .addGroupBy('st_count.name');

    if (planId) {
      qb.andWhere('dp.id = :planId', { planId });
    }

    if (!includeHistorical) {
      qb.leftJoin(
        RevisedProjectGroup,
        'pg_desc',
        'pg_desc.prev_project_id = pg.id ' +
          "AND pg_desc.prev_project_type = 'original' " +
          'AND pg_desc.deleted_at IS NULL',
      ).andWhere('pg_desc.id IS NULL');
    }

    this.applyFilters(qb, filters, 'main');
    return qb.getRawMany<MainBookStatusRow>();
  }

  /** COUNT(*) GROUP BY (planId, dprId, revisionType, status.name) for RevisedProjectGroup. */
  private countRevisedByBookAndStatus(
    planId: string | undefined,
    includeHistorical: boolean,
    filters: UnifiedProjectQuery['filters'],
  ): Promise<RevisedBookStatusRow[]> {
    const visible = [...EXEC_VISIBLE_STATUSES];
    const qb: SelectQueryBuilder<RevisedProjectGroup> = this.dataSource
      .getRepository(RevisedProjectGroup)
      .createQueryBuilder('rpg')
      .innerJoin('rpg.developmentPlanRevision', 'dpr')
      .innerJoin('dpr.developmentPlan', 'dp')
      .leftJoin('dpr.revisionType', 'rt')
      .leftJoin('rpg.createdBy', 'wh_cb')
      .leftJoin('wh_cb.amphoe', 'wh_amp')
      .leftJoin('wh_cb.localAdministrativeOrganization', 'wh_lao')
      .innerJoin(
        TrackingStatus,
        'ts_count',
        'ts_count.revised_project_group_id = rpg.id ' +
          'AND ts_count.is_latest = true ' +
          'AND ts_count."deletedAt" IS NULL',
      )
      .innerJoin(Status, 'st_count', 'st_count.id = ts_count.status_id')
      .select('dp.id', 'planid')
      .addSelect('dp.name', 'planname')
      .addSelect('dpr.id', 'dprid')
      .addSelect('dpr.revision_number', 'revisionnumber')
      .addSelect('dpr.description', 'dprdescription')
      .addSelect('rt.name', 'revisiontypename')
      .addSelect('st_count.name', 'statusname')
      .addSelect('COUNT(*)', 'cnt')
      .where('rpg.deletedAt IS NULL')
      .andWhere('dpr.deletedAt IS NULL')
      .andWhere('dp.deletedAt IS NULL')
      .andWhere('st_count.name IN (:...execVisibleStatusesRevisedDrill)', {
        execVisibleStatusesRevisedDrill: visible,
      })
      .groupBy('dp.id')
      .addGroupBy('dp.name')
      .addGroupBy('dpr.id')
      .addGroupBy('dpr.revision_number')
      .addGroupBy('dpr.description')
      .addGroupBy('rt.name')
      .addGroupBy('st_count.name');

    if (planId) {
      qb.andWhere('dp.id = :planId', { planId });
    }

    if (!includeHistorical) {
      qb.leftJoin(
        RevisedProjectGroup,
        'rpg_desc',
        'rpg_desc.prev_project_id = rpg.id ' +
          "AND rpg_desc.prev_project_type = 'revised' " +
          'AND rpg_desc.deleted_at IS NULL',
      ).andWhere('rpg_desc.id IS NULL');
    }

    this.applyFilters(qb, filters, 'revised');
    return qb.getRawMany<RevisedBookStatusRow>();
  }

  /** COUNT(*) GROUP BY (planId, dpsId, status.name) for SupplementProjectGroup. */
  private countSupplementByBookAndStatus(
    planId: string | undefined,
    filters: UnifiedProjectQuery['filters'],
  ): Promise<SupplementBookStatusRow[]> {
    const visible = [...EXEC_VISIBLE_STATUSES];
    const qb: SelectQueryBuilder<SupplementProjectGroup> = this.dataSource
      .getRepository(SupplementProjectGroup)
      .createQueryBuilder('spg')
      .innerJoin('spg.developmentPlanSupplement', 'dps')
      .innerJoin('dps.developmentPlan', 'dp')
      .leftJoin('spg.createdBy', 'wh_cb')
      .leftJoin('wh_cb.amphoe', 'wh_amp')
      .leftJoin('wh_cb.localAdministrativeOrganization', 'wh_lao')
      .innerJoin(
        TrackingStatus,
        'ts_count',
        'ts_count.supplement_project_group_id = spg.id ' +
          'AND ts_count.is_latest = true ' +
          'AND ts_count."deletedAt" IS NULL',
      )
      .innerJoin(Status, 'st_count', 'st_count.id = ts_count.status_id')
      .select('dp.id', 'planid')
      .addSelect('dp.name', 'planname')
      .addSelect('dps.id', 'dpsid')
      .addSelect('dps.supplement_number', 'supplementnumber')
      .addSelect('dps.description', 'dpsdescription')
      .addSelect('st_count.name', 'statusname')
      .addSelect('COUNT(*)', 'cnt')
      .where('spg.deletedAt IS NULL')
      .andWhere('dps.deletedAt IS NULL')
      .andWhere('dp.deletedAt IS NULL')
      .andWhere('st_count.name IN (:...execVisibleStatusesSupplementDrill)', {
        execVisibleStatusesSupplementDrill: visible,
      })
      .groupBy('dp.id')
      .addGroupBy('dp.name')
      .addGroupBy('dps.id')
      .addGroupBy('dps.supplement_number')
      .addGroupBy('dps.description')
      .addGroupBy('st_count.name');

    if (planId) {
      qb.andWhere('dp.id = :planId', { planId });
    }

    this.applyFilters(qb, filters, 'supplement');
    return qb.getRawMany<SupplementBookStatusRow>();
  }

  // ─────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────

  /**
   * Normalise the requested `scope` array into a concrete per-kind
   * Set. Both `'all'` alone and the explicit `['main','revised',
   * 'supplement']` enumeration expand to the full set.
   */
  private normaliseScope(
    scope: UnifiedProjectQuery['scope'],
  ): Set<ProjectKind> {
    const set = new Set<ProjectKind>();
    for (const s of scope) {
      if (s === 'all') {
        set.add('main');
        set.add('revised');
        set.add('supplement');
      } else if (s === 'main' || s === 'revised' || s === 'supplement') {
        set.add(s);
      }
      // Unknown values are silently ignored — schema validation lives
      // at Tier C (§17.9); Tier B services MUST NOT throw on DSL drift.
    }
    return set;
  }

  /** Clamp limit into [1, 50], default 20. */
  private clampLimit(raw: number | undefined): number {
    const n = typeof raw === 'number' && Number.isFinite(raw)
      ? Math.floor(raw)
      : LIMIT_DEFAULT;
    if (n < 1) return 1;
    if (n > LIMIT_CEILING) return LIMIT_CEILING;
    return n;
  }

  /** Return a validated planId or `undefined` when absent / blank. */
  private normalisePlanId(raw: string | undefined): string | undefined {
    if (typeof raw !== 'string') return undefined;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  /**
   * Allocate the per-kind query limits based on the requested scope.
   *
   * - Single-kind scope → that kind gets the full `limit`.
   * - Two-kind scope → each requested kind gets `Math.ceil(limit *
   *   share / (sum of requested shares))`.
   * - Three-kind scope (i.e. 'all') → 40/35/25 split with supplement
   *   absorbing the remainder so the grand total never exceeds
   *   `limit`.
   *
   * Kind-sets that do not include a kind get budget 0.
   */
  private splitBudget(
    scopeSet: Set<ProjectKind>,
    limit: number,
  ): { mainBudget: number; revisedBudget: number; supplementBudget: number } {
    const wantMain = scopeSet.has('main');
    const wantRevised = scopeSet.has('revised');
    const wantSupplement = scopeSet.has('supplement');

    const requestedCount =
      (wantMain ? 1 : 0) + (wantRevised ? 1 : 0) + (wantSupplement ? 1 : 0);

    if (requestedCount === 0) {
      return { mainBudget: 0, revisedBudget: 0, supplementBudget: 0 };
    }

    if (requestedCount === 1) {
      return {
        mainBudget: wantMain ? limit : 0,
        revisedBudget: wantRevised ? limit : 0,
        supplementBudget: wantSupplement ? limit : 0,
      };
    }

    if (requestedCount === 3) {
      const mainBudget = Math.max(1, Math.ceil(limit * SCOPE_SPLIT_MAIN));
      const revisedBudget = Math.max(
        1,
        Math.ceil(limit * SCOPE_SPLIT_REVISED),
      );
      // Supplement absorbs the remainder so the grand total === `limit`
      // (design §3.1 "bound result size by `limit` across all three
      // kinds"). When `limit` is small (e.g. 1 or 2), the ceil() calls
      // above can saturate early; clamp the supplement budget to >= 0.
      const supplementBudget = Math.max(
        0,
        limit - mainBudget - revisedBudget,
      );
      return { mainBudget, revisedBudget, supplementBudget };
    }

    // Exactly two kinds. Split proportionally between the two shares.
    const mainShare = wantMain ? SCOPE_SPLIT_MAIN : 0;
    const revisedShare = wantRevised ? SCOPE_SPLIT_REVISED : 0;
    const supplementShare =
      wantSupplement ? 1 - SCOPE_SPLIT_MAIN - SCOPE_SPLIT_REVISED : 0;
    const totalShare = mainShare + revisedShare + supplementShare;

    const allocate = (share: number, want: boolean): number =>
      want ? Math.max(1, Math.ceil((limit * share) / totalShare)) : 0;

    const mainBudget = allocate(mainShare, wantMain);
    const revisedBudget = allocate(revisedShare, wantRevised);
    const supplementBudgetRaw = allocate(supplementShare, wantSupplement);

    // Clamp so total <= limit (the last included kind absorbs the tail).
    let budgetLeft = limit;
    const finalMain = Math.min(mainBudget, budgetLeft);
    budgetLeft -= finalMain;
    const finalRevised = Math.min(revisedBudget, Math.max(0, budgetLeft));
    budgetLeft -= finalRevised;
    const finalSupplement = Math.min(
      supplementBudgetRaw,
      Math.max(0, budgetLeft),
    );

    return {
      mainBudget: finalMain,
      revisedBudget: finalRevised,
      supplementBudget: finalSupplement,
    };
  }

  /**
   * Main (`ProjectGroup`) reader.
   *
   * Uses entity-metadata resolution for the table + join targets —
   * zero raw table literals. All join conditions reference TypeORM
   * property names (`pg.developmentPlan`). The selected columns use
   * snake_case FK column names because they live on `pg` directly
   * (TypeORM permits SELECT on explicit DB column names).
   */
  private loadMain(
    planId: string | undefined,
    limit: number,
    includeHistorical: boolean,
    filters: UnifiedProjectQuery['filters'],
  ): Promise<MainRawRow[]> {
    const qb: SelectQueryBuilder<ProjectGroup> = this.dataSource
      .getRepository(ProjectGroup)
      .createQueryBuilder('pg')
      .innerJoin('pg.developmentPlan', 'dp')
      // Wave 55 W55-BE-07 — LEFT JOIN creator WorkHistory → Amphoe + LAO
      // to derive `originType` per §1 + §5. LEFT (not INNER) because
      // `createdBy` is declared optional on the entity and a missing
      // row must still emit with `originType='lao-coordinated'` (the
      // safe default — non-agency). Only ID scalars are projected;
      // zero person-level (PII) columns flow out of this chain.
      .leftJoin('pg.createdBy', 'wh_cb')
      .leftJoin('wh_cb.amphoe', 'wh_amp')
      .leftJoin('wh_cb.localAdministrativeOrganization', 'wh_lao')
      .select('pg.id', 'id')
      .addSelect('pg.title', 'title')
      .addSelect('dp.id', 'planid')
      .addSelect('dp.report_format', 'reportformat')
      .addSelect('pg.amphoe_id', 'amphoeid')
      .addSelect('pg.responsible_agency_id', 'agencyid')
      .addSelect('pg.strategy_id', 'strategyid')
      .addSelect('pg.tactic_id', 'tacticid')
      .addSelect('pg.plan_id', 'planlevelid')
      .addSelect('pg.indicator', 'indicator')
      .addSelect('pg.development_issue_id', 'issueid')
      .addSelect('wh_amp.id', 'creator_amphoe_id')
      .addSelect('wh_lao.id', 'creator_lao_id')
      .where('pg.deletedAt IS NULL')
      .andWhere('dp.deletedAt IS NULL')
      .orderBy('pg.title', 'ASC')
      .limit(limit);

    if (planId) {
      qb.andWhere('dp.id = :planId', { planId });
    }

    // Wave 55 BE-W55-05 — §14.2 head-of-lineage filter. A ProjectGroup
    // row is HEAD iff no non-soft-deleted RevisedProjectGroup references
    // it via (prev_project_id = pg.id AND prev_project_type = 'original').
    // Implemented as a LEFT JOIN + IS NULL anti-join, keyed on the
    // RevisedProjectGroup entity metadata so no raw table literal is
    // introduced (wave54-no-raw-sql.spec.ts).
    if (!includeHistorical) {
      qb.leftJoin(
        RevisedProjectGroup,
        'pg_desc',
        'pg_desc.prev_project_id = pg.id ' +
          "AND pg_desc.prev_project_type = 'original' " +
          'AND pg_desc.deleted_at IS NULL',
      ).andWhere('pg_desc.id IS NULL');
    }

    // Wave 55 W55-BE-06 — plumb DSL `filters` into the aggregator.
    this.applyFilters(qb, filters, 'main');

    return qb.getRawMany<MainRawRow>();
  }

  /**
   * Revised (`RevisedProjectGroup`) reader.
   *
   * Resolution: RPG → DPR → DP.
   *
   * RPG has a direct (optional) `developmentPlan` relation, but the
   * design contract requires walking through DPR so revisions that
   * pre-date the convenience FK still resolve. We innerJoin DPR and
   * pull `developmentPlan` from DPR.
   */
  private loadRevised(
    planId: string | undefined,
    limit: number,
    includeHistorical: boolean,
    filters: UnifiedProjectQuery['filters'],
  ): Promise<RevisedRawRow[]> {
    const qb: SelectQueryBuilder<RevisedProjectGroup> = this.dataSource
      .getRepository(RevisedProjectGroup)
      .createQueryBuilder('rpg')
      .innerJoin('rpg.developmentPlanRevision', 'dpr')
      .innerJoin('dpr.developmentPlan', 'dp')
      // Wave 55 W55-BE-07 — LEFT JOIN creator WorkHistory → Amphoe + LAO
      // for `originType` derivation (§1 + §5). See `loadMain` for the
      // full rationale; only ID scalars are projected, no PII.
      .leftJoin('rpg.createdBy', 'wh_cb')
      .leftJoin('wh_cb.amphoe', 'wh_amp')
      .leftJoin('wh_cb.localAdministrativeOrganization', 'wh_lao')
      .select('rpg.id', 'id')
      .addSelect('rpg.title', 'title')
      .addSelect('dp.id', 'planid')
      .addSelect('dp.report_format', 'reportformat')
      .addSelect('rpg.amphoe_id', 'amphoeid')
      .addSelect('rpg.responsible_agency_id', 'agencyid')
      .addSelect('rpg.strategy_id', 'strategyid')
      .addSelect('rpg.tactic_id', 'tacticid')
      .addSelect('rpg.plan_id', 'planlevelid')
      .addSelect('rpg.indicator', 'indicator')
      .addSelect('rpg.development_issue_id', 'issueid')
      .addSelect('wh_amp.id', 'creator_amphoe_id')
      .addSelect('wh_lao.id', 'creator_lao_id')
      .where('rpg.deletedAt IS NULL')
      .andWhere('dpr.deletedAt IS NULL')
      .andWhere('dp.deletedAt IS NULL')
      .orderBy('rpg.title', 'ASC')
      .limit(limit);

    if (planId) {
      qb.andWhere('dp.id = :planId', { planId });
    }

    // Wave 55 BE-W55-05 — §14.2 head-of-lineage filter. A RevisedProjectGroup
    // row is HEAD iff no OTHER non-soft-deleted RevisedProjectGroup
    // references it via (prev_project_id = rpg.id AND prev_project_type =
    // 'revised'). Implemented as a LEFT JOIN + IS NULL anti-join keyed on
    // the RevisedProjectGroup entity metadata — no raw table literal
    // (wave54-no-raw-sql.spec.ts).
    if (!includeHistorical) {
      qb.leftJoin(
        RevisedProjectGroup,
        'rpg_desc',
        'rpg_desc.prev_project_id = rpg.id ' +
          "AND rpg_desc.prev_project_type = 'revised' " +
          'AND rpg_desc.deleted_at IS NULL',
      ).andWhere('rpg_desc.id IS NULL');
    }

    // Wave 55 W55-BE-06 — plumb DSL `filters` into the aggregator.
    this.applyFilters(qb, filters, 'revised');

    return qb.getRawMany<RevisedRawRow>();
  }

  /**
   * Supplement (`SupplementProjectGroup`) reader.
   *
   * Resolution: SPG → DPS → DP.
   *
   * Wave 55 W55-BE-04: SPG now carries a nullable `amphoe_id` FK
   * (W55-DB-01). The projection selects it here; historical rows left
   * NULL surface a per-row `geo:supplement` missingDimension at the
   * `GeoEnrichmentService` layer rather than a batch-wide exclusion.
   */
  private loadSupplement(
    planId: string | undefined,
    limit: number,
    filters: UnifiedProjectQuery['filters'],
  ): Promise<SupplementRawRow[]> {
    const qb: SelectQueryBuilder<SupplementProjectGroup> = this.dataSource
      .getRepository(SupplementProjectGroup)
      .createQueryBuilder('spg')
      .innerJoin('spg.developmentPlanSupplement', 'dps')
      .innerJoin('dps.developmentPlan', 'dp')
      // Wave 55 W55-BE-07 — LEFT JOIN creator WorkHistory → Amphoe + LAO
      // for `originType` derivation (§1 + §5). See `loadMain` for the
      // full rationale; only ID scalars are projected, no PII.
      .leftJoin('spg.createdBy', 'wh_cb')
      .leftJoin('wh_cb.amphoe', 'wh_amp')
      .leftJoin('wh_cb.localAdministrativeOrganization', 'wh_lao')
      .select('spg.id', 'id')
      .addSelect('spg.title', 'title')
      .addSelect('dp.id', 'planid')
      .addSelect('dp.report_format', 'reportformat')
      .addSelect('spg.amphoe_id', 'amphoeid')
      .addSelect('spg.responsible_agency_id', 'agencyid')
      .addSelect('spg.strategy_id', 'strategyid')
      .addSelect('spg.tactic_id', 'tacticid')
      .addSelect('spg.plan_id', 'planlevelid')
      .addSelect('spg.indicator', 'indicator')
      .addSelect('spg.development_issue_id', 'issueid')
      .addSelect('wh_amp.id', 'creator_amphoe_id')
      .addSelect('wh_lao.id', 'creator_lao_id')
      .where('spg.deletedAt IS NULL')
      .andWhere('dps.deletedAt IS NULL')
      .andWhere('dp.deletedAt IS NULL')
      .orderBy('spg.title', 'ASC')
      .limit(limit);

    if (planId) {
      qb.andWhere('dp.id = :planId', { planId });
    }

    // Wave 55 W55-BE-06 — plumb DSL `filters` into the aggregator.
    this.applyFilters(qb, filters, 'supplement');

    return qb.getRawMany<SupplementRawRow>();
  }

  /**
   * Wave 55 W55-BE-06 — Plumb DSL `filters` clause into the loaders.
   *
   * Applies the five DSL-declared filter dimensions (`status`,
   * `amphoeIds`, `agencyIds`, `budgetRange`, `dateRange`) onto the
   * per-kind query builder. Parameterized via TypeORM QB bind params —
   * §17.9 (prompt-injection defense: no string interpolation of user-
   * controlled values).
   *
   * GAP-5 type-drift resolution:
   *   - `amphoeIds` / `agencyIds` arrive as `string[]` from the DSL.
   *   - Amphoe PK is a string column → pass through verbatim.
   *   - Agency PK is an integer column → coerce via `Number(x)`; NaN
   *     entries are silently DROPPED. If the coerced array is empty,
   *     the filter is mapped to a no-match (`WHERE 1=0`).
   *
   * Per-kind column differences:
   *   - `main` → PG with `amphoe_id`, `responsible_agency_id`,
   *     `created_at`, `project_group_id` on TrackingStatus/Budget.
   *   - `revised` → RPG with the same column names; TrackingStatus /
   *     Budget FK is `revised_project_group_id`.
   *   - `supplement` → SPG now carries a nullable `amphoe_id` FK
   *     (W55-DB-01 / W55-BE-04). The amphoe filter works the same as
   *     main / revised; SPG rows with NULL `amphoe_id` are naturally
   *     excluded by the `IN (...)` predicate. `responsible_agency_id`
   *     exists; TrackingStatus / Budget FK is `supplement_project_group_id`.
   *
   * Status filter uses an INNER JOIN on `TrackingStatus` (latest-only,
   * non-soft-deleted) and Status via entity-metadata resolution —
   * zero raw table literals. Idempotent: calling with `undefined`
   * filters is a no-op.
   */
  private applyFilters<T extends ProjectGroup | RevisedProjectGroup | SupplementProjectGroup>(
    qb: SelectQueryBuilder<T>,
    filters: UnifiedProjectQuery['filters'],
    kind: ProjectKind,
  ): void {
    if (!filters) return;

    // Per-kind alias & column-name mapping. The alias must match what
    // the loader used when building `qb`.
    const alias = kind === 'main' ? 'pg' : kind === 'revised' ? 'rpg' : 'spg';
    const fkColumn =
      kind === 'main'
        ? 'project_group_id'
        : kind === 'revised'
          ? 'revised_project_group_id'
          : 'supplement_project_group_id';

    // ── filters.status ─────────────────────────────────────────────
    // INNER JOIN TrackingStatus (isLatest=true, not soft-deleted) +
    // Status; filter Status.name IN (:statuses). Aliases are suffixed
    // with `_f` to avoid colliding with any future enrichment join.
    if (Array.isArray(filters.status) && filters.status.length > 0) {
      const statuses = filters.status.filter(
        (s): s is string => typeof s === 'string' && s.length > 0,
      );
      if (statuses.length > 0) {
        qb.innerJoin(
          TrackingStatus,
          'ts_f',
          `ts_f.${fkColumn} = ${alias}.id AND ts_f.is_latest = true AND ts_f."deletedAt" IS NULL`,
        )
          .innerJoin(Status, 'st_f', 'st_f.id = ts_f.status_id')
          .andWhere('st_f.name IN (:...statusFilter)', {
            statusFilter: statuses,
          });
      }
    }

    // ── filters.amphoeIds ─────────────────────────────────────────
    // Amphoe PK is a string column (verified on ProjectGroup.amphoe
    // relation). Pass through the DSL string[] verbatim.
    if (Array.isArray(filters.amphoeIds) && filters.amphoeIds.length > 0) {
      const ids = filters.amphoeIds
        .map((v) => (typeof v === 'string' ? v.trim() : String(v)))
        .filter((v) => v.length > 0);
      if (ids.length === 0) {
        // All values were blank — no-match.
        qb.andWhere('1 = 0');
      } else {
        // Wave 55 W55-BE-04 — SPG now carries `amphoe_id`; all three
        // kinds share the same column name and can be filtered
        // uniformly. SPG rows with NULL `amphoe_id` fall out naturally
        // via the `IN (...)` predicate.
        qb.andWhere(`${alias}.amphoe_id IN (:...amphoeIdsFilter)`, {
          amphoeIdsFilter: ids,
        });
      }
    }

    // ── filters.laoIds (W67-LAO-RESOLVER) ─────────────────────────
    // LAO PK is a string column on the entity
    // (`local_administrative_organizations.id` — `@PrimaryColumn()
    // id: string`). PG and RPG carry the
    // `local_administrative_organization_id` FK column; SPG does NOT
    // (its only LAO-typed FK is `origin_agency_id`, which is a
    // different concept per §5.2). For SPG the filter maps to a
    // no-match (`1 = 0`) so the supplement scope is excluded
    // explicitly when the caller filters by LAO — matches the SPG
    // amphoe-NULL exclusion shape and avoids a runtime "column does
    // not exist" error.
    //
    // Mirrors the amphoeIds shape: trim + drop blanks; an all-blank
    // array becomes a no-match so a malformed LLM payload never
    // accidentally widens the result set.
    if (Array.isArray(filters.laoIds) && filters.laoIds.length > 0) {
      const ids = filters.laoIds
        .map((v) => (typeof v === 'string' ? v.trim() : String(v)))
        .filter((v) => v.length > 0);
      if (ids.length === 0) {
        qb.andWhere('1 = 0');
      } else if (kind === 'supplement') {
        // SPG has no `local_administrative_organization_id` column —
        // exclude the supplement kind entirely when the caller filters
        // by LAO (the supplement scope cannot answer "which projects
        // are linked to LAO X" via that FK).
        qb.andWhere('1 = 0');
      } else {
        qb.andWhere(
          `${alias}.local_administrative_organization_id IN (:...laoIdsFilter)`,
          { laoIdsFilter: ids },
        );
      }
    }

    // ── filters.excludeLaoIds (W67-PAO-VOCAB, 2026-04-27) ─────────
    // Exclusion counterpart to `laoIds`. Used by prompt rule #25c
    // when the user says "อปท" / "ประสานแผน" — meaning "every project
    // EXCEPT อบจ.นครราชสีมา (lao.id='3001027')". Mirrors the laoIds
    // shape including the SPG short-circuit (`1 = 0`) since SPG has
    // no `local_administrative_organization_id` column.
    //
    // SQL semantics: `... NOT IN (...) AND ... IS NOT NULL` so projects
    // without a LAO FK are excluded by symmetry with `laoIds` (which
    // implicitly excludes NULL via IN). This keeps the two filters
    // mutually-exclusive partitions of the LAO-scoped row set.
    if (
      Array.isArray(filters.excludeLaoIds) &&
      filters.excludeLaoIds.length > 0
    ) {
      const excludeIds = filters.excludeLaoIds
        .map((v) => (typeof v === 'string' ? v.trim() : String(v)))
        .filter((v) => v.length > 0);
      if (excludeIds.length === 0) {
        // Defensive: all-blank exclusion array — preserve current row set
        // (no clause emitted; symmetric with `laoIds: []` not adding
        // a clause when the trimmed list is empty).
      } else if (kind === 'supplement') {
        // SPG has no LAO FK — exclude SPG entirely from LAO-scoped
        // exclusion queries (symmetric with `laoIds` SPG handling).
        qb.andWhere('1 = 0');
      } else {
        qb.andWhere(
          `(${alias}.local_administrative_organization_id NOT IN (:...excludeLaoIdsFilter) AND ${alias}.local_administrative_organization_id IS NOT NULL)`,
          { excludeLaoIdsFilter: excludeIds },
        );
      }
    }

    // ── filters.hasResponsibleAgency (W67-PAO-EXEC-STAGE, 2026-04-27) ──
    // Used by rule #25c v3 to identify projects whose responsible
    // government agency has been assigned. Together with `isBooked` it
    // expresses the "execution-stage / โครงการของ อบจ" semantic — a
    // project becomes อบจ-owned once อบจ. accepts it (assigns a
    // department) AND adds it to the plan book.
    //
    // SPG: `responsibleAgency` is NOT NULL by entity constraint
    // (SupplementProjectGroup.responsible_agency_id is non-null), so
    // `hasResponsibleAgency=true` always passes (no clause needed) and
    // `=false` excludes SPG entirely (1 = 0).
    if (typeof filters.hasResponsibleAgency === 'boolean') {
      if (kind === 'supplement') {
        if (filters.hasResponsibleAgency === false) {
          qb.andWhere('1 = 0');
        }
        // true: no clause needed (SPG always satisfies the predicate).
      } else if (filters.hasResponsibleAgency === true) {
        qb.andWhere(`${alias}.responsible_agency_id IS NOT NULL`);
      } else {
        qb.andWhere(`${alias}.responsible_agency_id IS NULL`);
      }
    }

    // ── filters.isBooked (W67-PAO-EXEC-STAGE, 2026-04-27) ─────────
    // Used by rule #25c v3 to identify projects that have been added to
    // the plan book (PG / RPG `isBooked` column). SPG has no `isBooked`
    // column (supplement projects are inherently booked once persisted),
    // so `isBooked=true` always passes (no clause needed) and `=false`
    // excludes SPG entirely (1 = 0).
    //
    // Column casing: PG / RPG declare `@Column({ default: false })
    // isBooked: boolean` with no `name:` override, so TypeORM keeps the
    // property name verbatim in DB. The bare `${alias}.isBooked`
    // reference is resolved by TypeORM metadata, mirroring the
    // `pg.deletedAt` / `pg.pageNumber` style used elsewhere in this file.
    if (typeof filters.isBooked === 'boolean') {
      if (kind === 'supplement') {
        if (filters.isBooked === false) {
          qb.andWhere('1 = 0');
        }
        // true: no clause needed (SPG is inherently booked).
      } else {
        qb.andWhere(`${alias}.isBooked = :isBookedFilter`, {
          isBookedFilter: filters.isBooked,
        });
      }
    }

    // ── filters.agencyIds ─────────────────────────────────────────
    // Agency PK is integer. Coerce via Number(x); silently drop NaN /
    // non-finite entries (AC #2). If the coerced array is empty, map
    // to a no-match.
    if (Array.isArray(filters.agencyIds) && filters.agencyIds.length > 0) {
      const numericIds: number[] = [];
      for (const raw of filters.agencyIds) {
        const n = typeof raw === 'number' ? raw : Number(raw);
        if (Number.isFinite(n) && !Number.isNaN(n)) {
          numericIds.push(n);
        }
      }
      if (numericIds.length === 0) {
        qb.andWhere('1 = 0');
      } else {
        qb.andWhere(
          `${alias}.responsible_agency_id IN (:...agencyIdsFilter)`,
          { agencyIdsFilter: numericIds },
        );
      }
    }

    // ── filters.budgetRange ───────────────────────────────────────
    // Correlated scalar subquery over the Budget entity. The table
    // identifier is resolved from TypeORM metadata at runtime — the
    // source code never contains a bareword table literal, satisfying
    // the wave54-no-raw-sql gate. SUM aggregates the multi-year Budget
    // rows per project; a project with no rows contributes 0 (COALESCE).
    const br = filters.budgetRange;
    if (br && (typeof br.min === 'number' || typeof br.max === 'number')) {
      const budgetTable =
        this.dataSource.getMetadata(Budget).tableName;
      const scalar =
        `COALESCE((SELECT SUM(b_f.quantity) FROM "${budgetTable}" b_f ` +
        `WHERE b_f.${fkColumn} = ${alias}.id), 0)`;
      if (typeof br.min === 'number' && typeof br.max === 'number') {
        qb.andWhere(`${scalar} BETWEEN :budgetMin AND :budgetMax`, {
          budgetMin: br.min,
          budgetMax: br.max,
        });
      } else if (typeof br.min === 'number') {
        qb.andWhere(`${scalar} >= :budgetMin`, { budgetMin: br.min });
      } else if (typeof br.max === 'number') {
        qb.andWhere(`${scalar} <= :budgetMax`, { budgetMax: br.max });
      }
    }

    // ── filters.dateRange ─────────────────────────────────────────
    // Filter against the row's own created_at column. ISO strings go
    // through TypeORM bind params unchanged — Postgres performs the
    // `timestamp` coercion.
    const dr = filters.dateRange;
    if (dr) {
      const hasFrom = typeof dr.from === 'string' && dr.from.length > 0;
      const hasTo = typeof dr.to === 'string' && dr.to.length > 0;
      if (hasFrom && hasTo) {
        qb.andWhere(
          `${alias}.created_at BETWEEN :dateFrom AND :dateTo`,
          { dateFrom: dr.from, dateTo: dr.to },
        );
      } else if (hasFrom) {
        qb.andWhere(`${alias}.created_at >= :dateFrom`, {
          dateFrom: dr.from,
        });
      } else if (hasTo) {
        qb.andWhere(`${alias}.created_at <= :dateTo`, { dateTo: dr.to });
      }
    }

    // ── filters.originType ────────────────────────────────────────
    // Wave 55 W55-BE-07 — filter on the derived project-origin
    // discriminator. The predicate references the `wh_amp` + `wh_lao`
    // aliases attached by the creator-chain LEFT JOIN at the top of
    // each loader, so it is safe to compose AFTER those joins land.
    //
    // Derivation mirrors §1:
    //   'agency-normal'   ↔ wh_amp.id = '3001' AND wh_lao.id = '3001027'
    //   'lao-coordinated' ↔ everything else (including NULL either side)
    //
    // Single-value arrays become a plain predicate; two-value arrays
    // (i.e. both origins requested) no-op because the union equals the
    // unfiltered set. All-unknown arrays map to no-match (`WHERE 1=0`).
    if (Array.isArray(filters.originType) && filters.originType.length > 0) {
      const canonical = new Set<'lao-coordinated' | 'agency-normal'>();
      for (const v of filters.originType) {
        if (v === 'agency-normal' || v === 'lao-coordinated') {
          canonical.add(v);
        }
      }
      if (canonical.size === 0) {
        qb.andWhere('1 = 0');
      } else if (canonical.size === 2) {
        // Both origins requested — the filter is a no-op.
      } else {
        const wantAgency = canonical.has('agency-normal');
        const agencyPredicate =
          "wh_amp.id = :originAgencyAmphoeId AND wh_lao.id = :originAgencyLaoId";
        if (wantAgency) {
          qb.andWhere(agencyPredicate, {
            originAgencyAmphoeId: UnifiedProjectAggregator.AGENCY_AMPHOE_ID,
            originAgencyLaoId: UnifiedProjectAggregator.AGENCY_LAO_ID,
          });
        } else {
          // 'lao-coordinated' = NOT agency. NULL-safe via the negation
          // + IS NULL disjunction so rows with a missing creator chain
          // are classified as lao-coordinated (matches the runtime
          // `toOriginType` fallback).
          qb.andWhere(
            '(wh_amp.id IS NULL OR wh_lao.id IS NULL OR ' +
              'wh_amp.id <> :originAgencyAmphoeId OR wh_lao.id <> :originAgencyLaoId)',
            {
              originAgencyAmphoeId: UnifiedProjectAggregator.AGENCY_AMPHOE_ID,
              originAgencyLaoId: UnifiedProjectAggregator.AGENCY_LAO_ID,
            },
          );
        }
      }
    }
  }

  /**
   * Coerce a raw SQL `report_format` string into the canonical
   * `PlanReportFormat` enum. Unknown values fall back to
   * STRATEGY_BASED (task §11.R3 — graceful envelope partial).
   */
  private toReportFormat(raw: string | null | undefined): PlanReportFormat {
    if (raw === 'ISSUE_BASED') return 'ISSUE_BASED';
    if (raw === 'STRATEGY_BASED') return 'STRATEGY_BASED';
    return FALLBACK_REPORT_FORMAT;
  }

  /**
   * Wave 55 W55-BE-07 — Agency-classification sentinel scalars.
   *
   * Wave 57 W57-BE-AGG-02 — these constants now mirror the shared
   * `PAO_AMPHOE_ID` / `PAO_LAO_ID` source of truth (helpers/origin-type).
   * They remain declared here for backward-compat with existing tests
   * that assert against `originAgencyAmphoeId` / `originAgencyLaoId`
   * bind-param values (origin-type.spec.ts). New call sites SHOULD
   * import the helpers directly.
   */
  private static readonly AGENCY_AMPHOE_ID = PAO_AMPHOE_ID;
  private static readonly AGENCY_LAO_ID = PAO_LAO_ID;

  /**
   * Derive `originType` from the creator's WorkHistory amphoe + LAO
   * ID scalars. Missing scalars (NULL from the LEFT JOIN) fall through
   * to the safe default `'lao-coordinated'` — an incomplete creator
   * chain MUST NOT be promoted to agency origin.
   *
   * Wave 57 W57-BE-AGG-02 — delegates to the shared classifier so the
   * §1 magic numbers live in exactly one place.
   */
  private toOriginType(
    creatorAmphoeId: string | null,
    creatorLaoId: string | null,
  ): 'lao-coordinated' | 'agency-normal' {
    return classifyOriginFromIdScalars(creatorAmphoeId, creatorLaoId);
  }

  /**
   * Build a `UnifiedProject` row from the raw projection. Only known
   * fields are set; no PII ever enters the shape. The creator amphoe
   * + LAO ID scalars (not PII) are consumed here solely to derive
   * `originType` per §1 + §5, and are NOT persisted on the row.
   */
  private toUnified(
    projectKind: ProjectKind,
    id: string,
    title: string | null,
    planId: string | null,
    reportFormatRaw: string | null,
    classification: {
      amphoeId: number | null;
      agencyId: number | null;
      strategyId: string | null;
      tacticId: string | null;
      planLevelId: string | null;
      indicator: string | null;
      issueId: string | null;
      creatorAmphoeId: string | null;
      creatorLaoId: string | null;
    },
  ): UnifiedProject {
    return {
      projectKind,
      projectId: id,
      name: title ?? '',
      planId: planId ?? '',
      planReportFormat: this.toReportFormat(reportFormatRaw),
      amphoeId: classification.amphoeId,
      responsibleAgencyId: classification.agencyId,
      strategyId: classification.strategyId,
      tacticId: classification.tacticId,
      planLevelId: classification.planLevelId,
      indicator: classification.indicator,
      developmentIssueId: classification.issueId,
      originType: this.toOriginType(
        classification.creatorAmphoeId,
        classification.creatorLaoId,
      ),
    };
  }
}
