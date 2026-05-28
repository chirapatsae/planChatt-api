/**
 * Executive AI Chat — tool handler implementations (BE-W44-02 §7.3).
 *
 * Each handler:
 *   - Is a pure read aggregator. NO `.save` / `.update` / `.delete` /
 *     `.remove` / `.softRemove` / `.softDelete` on any project / plan /
 *     tracking repo (§4.1, §17.2, §17.3).
 *   - Re-checks role + workStatus via `assertExecutiveRole` (§17.11).
 *   - Branches on the parent plan's `reportFormat` when it reads
 *     classification-shape fields (§16.5 / §17.7).
 *   - Returns a plain object conforming to the corresponding registry
 *     `returnSchema`. The tool-loop adapter validates the result
 *     against the schema before feeding it back to the LLM (§17.9).
 *
 * Projection discipline (task §9): result rows strictly expose
 * `{id, name, …tool-specific fields}`. NO `createdBy`, `user`,
 * `firstName`, `lastName`, `citizenId` fields are included — the PII
 * redactor runs as a belt-and-braces in the tool loop but the
 * projection here is the primary defense.
 */

import {
  ExecutiveCallerContext,
  ExecutiveToolHandler,
  ExecutiveToolHandlerDeps,
  ExecutiveToolHandlerMap,
  assertExecutiveRole,
} from './handler-types';
import type { DimensionTask } from '../../aggregation/interfaces';
import type {
  MissingDimension,
  ResilienceDimensionResult,
} from '../../aggregation/types';
import {
  CLASSIFICATION_SHAPE_ISSUE,
  CLASSIFICATION_SHAPE_STRATEGY,
} from '../../aggregation/advisory-copy';
import type {
  AgencyEnrichmentResult,
  GeoEnrichmentResult,
  LatestStatus,
} from '../../aggregation/interfaces';
import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { DevelopmentPlanRevision } from 'src/development-plan-revision/entities/development-plan-revision.entity';
import { DevelopmentPlanSupplement } from 'src/development-plan-supplement/entities/development-plan-supplement.entity';
import { DevelopmentIssue } from 'src/development-issue/entities/development-issue.entity';
import { Strategy } from 'src/strategy/entities/strategy.entity';
import { Tactic } from 'src/tactic/entities/tactic.entity';
import { Plan } from 'src/plan/entities/plan.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';
import { SupplementProjectGroup } from 'src/supplement-project-group/entities/supplement-project-group.entity';
import { TrackingStatus } from 'src/tracking-status/entities/tracking-status.entity';
import { Budget } from 'src/budget/entities/budget.entity';
import { GovernmentAgency } from 'src/government-agencies/entities/government-agency.entity';
import { Amphoe } from 'src/amphoes/entities/amphoe.entity';
import { LocalAdministrativeOrganization } from 'src/local-administrative-organizations/entities/local-administrative-organization.entity';
import { ReportFormat } from 'src/development-plan/types/report-format.enum';
import { toThaiStatus } from '../status-th';
import { SelectQueryBuilder } from 'typeorm';
import { Status } from 'src/status/entities/status.entity';
// W67-BE-AGG-01 — executive 4-group rollup. New canonical mapping over the
// 8-status workflow vocabulary; computed envelope field `executiveStatus`
// is sourced from this helper. See CLAUDE.md "Executive View Status Groups".
import {
  ExecutiveStatusGroup,
  mapToExecutiveStatusGroup,
} from '../../aggregation/constants/executive-status-groups';
// Wave 57 W57-BE-AGG-01 — HEAD-of-lineage anti-join helpers (CLAUDE.md
// §14.2). Legacy Tier B tools that produce "current truth" rollups MUST
// filter to HEAD before summing so that an approved PG and its derived
// RPG do not double-count.
import {
  HEAD_OF_LINEAGE_ADVISORY,
  applyHeadFilterForProjectGroup,
  applyHeadFilterForRevisedProjectGroup,
  applyHeadFilterForSupplementProjectGroup,
  selectIsHeadForProjectGroup,
  selectIsHeadForRevisedProjectGroup,
} from '../../aggregation/helpers/head-of-lineage';
// Wave 57 W57-BE-AGG-05 — canonical status buckets (Q5 + Q8). `Ready`
// is hidden by default; "รออนุมัติ" rolls up Pending+Verified+
// Pending_Approval unless the caller asks for detail mode.
import {
  APPROVAL_PIPELINE_ROLLUP_KEY,
  APPROVAL_PIPELINE_ROLLUP_LABEL,
  APPROVAL_PIPELINE_STATUSES,
  EXEC_VISIBLE_STATUSES,
  isApprovalPipelineStatus,
  resolveStatusBucketMode,
} from '../../aggregation/constants/status-buckets';
// Wave 58 W58-BE-AGG-01 — paired Thai labels + lineage-round metadata
// the project / plan envelopes now carry so the LLM never has to
// translate enums or invent ### group headings (D1 / D4 / D6).
import { resolveReportFormatLabel } from '../../aggregation/constants/report-format-label';
import {
  PENDING_RESPONSIBLE_AGENCY_DISCLOSURE,
  REVISION_ROUND_LABEL_MAIN,
  resolveRevisionRoundLabel,
  type RevisionRoundType,
} from '../../aggregation/constants/revision-round-label';
import { classifyOriginFromIdScalars } from '../../aggregation/helpers/origin-type';
import { assertAgencyLabelPlaceholderFree } from '../../aggregation/constants/agency-label-guards';
// Wave 58 W58-BE-AGG-03 (D2) — Option B "two-badge layout": every plan
// envelope now carries `planActivityStatus.{freshness, freshnessLabel,
// activities[]}` so the LLM never has to invent the Thai badge copy
// from `isLatest` / `isBooked` / DPR / DPS scalars.
import {
  buildPlanActivityStatus,
  type PlanActivityStatus,
} from '../../aggregation/constants/plan-activity-status';
// Wave 59 W59-BE-AGG-01 (D-B) — objective truncation helper. Bounds the
// §17.9 prompt-injection surface for free-form user prose at the source.
import { truncateObjective } from '../../aggregation/constants/objective-truncation';
// Wave 63 W63-BE-AGG-01 — display-only normalization for inline
// numbered lists in long-text fields (`objective`, `goal`, `expected`).
// Applied BEFORE `truncateObjective()` so the cap budget includes the
// inserted newlines. §17.9 — DB content untouched; rewrite is
// envelope-time only.
import {
  normalizeDisplayText,
  formatNumberedListMarkdown,
} from '../../aggregation/constants/display-text-normalize';
import { PlanPhase } from 'src/plan-phase/entities/plan-phase.entity';
// Wave 103 PR2 — feature flag accessor for canonical agency-projects
// aggregator. Read at call time so test harnesses can flip the env var
// per test without re-importing the handler module. The aggregator
// service itself is reached via `deps.agencyProjectsCanonical`.
import { isCanonicalAgencyAggregatorEnabled } from '../../aggregation/services/agency-projects-canonical-aggregator.service';
// Wave AI-Exec-Chat-Enterprise-Output-Tone BE-01 (2026-05-28) — Phase 1
// document-centric catalog orchestrator. Imported here only so the
// handler can be wired into EXECUTIVE_TOOL_HANDLERS at file tail; the
// orchestrator body lives in the `orchestrators/` subdirectory.
import { getPlanCatalogOverview } from '../orchestrators/plan-catalog-overview.orchestrator';

function nowIso(): string {
  return new Date().toISOString();
}

// ────────────────────────────────────────────────────────────────────
// W67-BE-AGG-01 — DB-backed Thai status label loader.
//
// Per CLAUDE.md "Thai Display Label Source of Truth (W67)" the
// `status.th_name` column is the canonical source for runtime Thai
// display labels. The deprecated `STATUS_TH_MAP` remains in code for
// transitional callers only (W68 will remove it). New callers MUST go
// through this helper, which loads the table once per request and
// returns a name → th_name lookup.
//
// The function is intentionally `async` and accepts the handler `deps`
// so each tool handler can cache it within its own scope. There is no
// process-wide cache: status labels are mutable (e.g. via the migration
// that seeded W67) and the per-request load cost is a single SELECT
// over a small table.
// ────────────────────────────────────────────────────────────────────
async function loadStatusThaiLabels(
  deps: ExecutiveToolHandlerDeps,
): Promise<Map<string, string>> {
  const rows = await deps.dataSource
    .getRepository(Status)
    .createQueryBuilder('s')
    .select('s.name', 'name')
    .addSelect('s.th_name', 'th_name')
    .where('s.deleteAt IS NULL')
    .getRawMany<{ name: string; th_name: string | null }>();
  const map = new Map<string, string>();
  for (const r of rows) {
    if (typeof r.name === 'string' && r.name.length > 0) {
      map.set(r.name, (r.th_name ?? '').trim());
    }
  }
  return map;
}

/**
 * W67-BE-AGG-01 — resolve `statusTh` for a single canonical status name.
 *
 * Prefers the DB-loaded label (the W67 SOT). Falls back to an empty
 * string when the label is missing rather than to the deprecated
 * `STATUS_TH_MAP` so any drift surfaces visibly in logs/UI rather than
 * being papered over. NULL / empty input returns null (envelope nullable
 * field).
 */
function resolveStatusThFromDb(
  labels: Map<string, string>,
  canonicalStatus: string | null | undefined,
): string | null {
  if (!canonicalStatus) return null;
  const v = labels.get(canonicalStatus);
  if (typeof v === 'string' && v.length > 0) return v;
  return null;
}

/**
 * W67-BE-AGG-01 — assemble the 4-group `executiveStatusBreakdown` rollup.
 *
 * Walks a `Map<canonicalStatus, count>` once and emits the four
 * canonical executive buckets (`pendingReviewCount`,
 * `awaitingApprovalCount`, `approvedCount`, `rejectedCount`). Statuses
 * that map to `null` (Ready / Pull_Back / Returned_For_Revision) are
 * intentionally excluded — see `mapToExecutiveStatusGroup` and the
 * "Executive View Status Groups" decision in CLAUDE.md.
 *
 * §17.2 advisory only — the rollup is presentation aggregation; it MUST
 * NOT be used for any workflow gating decision.
 *
 * @deprecated W67-FIX-02 — `getExecutiveDashboardSnapshot` no longer
 * derives the rollup from the limit-capped status map. The canonical
 * breakdown now comes from
 * `IUnifiedProjectAggregator.countExecutiveStatusBreakdown`, which runs
 * a direct DB COUNT independent of the list limit. This helper is
 * retained for unit-test coverage of the canonical-English mapping
 * (W67-FIX-01 regression) and as a defense-in-depth utility for any
 * future caller that already has a status-count map in hand and wants
 * the four-bucket fold.
 */

function buildExecutiveStatusBreakdown(
  countByStatus: Map<string, number> | Iterable<[string, number]>,
): {
  pendingReviewCount: number;
  awaitingApprovalCount: number;
  approvedCount: number;
  rejectedCount: number;
} {
  const totals: Record<ExecutiveStatusGroup, number> = {
    pending_review: 0,
    awaiting_approval: 0,
    approved: 0,
    rejected: 0,
  };
  for (const [name, count] of countByStatus) {
    const grp = mapToExecutiveStatusGroup(name);
    if (!grp) continue;
    totals[grp] += Number(count) || 0;
  }
  return {
    pendingReviewCount: totals.pending_review,
    awaitingApprovalCount: totals.awaiting_approval,
    approvedCount: totals.approved,
    rejectedCount: totals.rejected,
  };
}

// ────────────────────────────────────────────────────────────────────
// 1. listActivePlans
// ────────────────────────────────────────────────────────────────────

const listActivePlans: ExecutiveToolHandler = async (params, ctx, deps) => {
  assertExecutiveRole(ctx);
  // Wave 59 W59-BE-AGG-01 (D-A) — DEFAULT FLIP. Pre-W59 the handler
  // defaulted to `isLatest=true` (returning a single row) and only
  // widened to all plans when `includeClosed=true` was passed. Users
  // asking "เล่มไหนบ้าง" therefore only saw one row. The new default
  // returns ALL non-soft-deleted DevelopmentPlan rows; opting back in
  // to the historical "latest only" view requires `latestOnly: true`.
  // CONTRACT CHANGE — Wave 58 callers that omitted `includeClosed`
  // will now see additional historical rows. The legacy
  // `includeClosed` param has been removed from the schema; runtime
  // payloads carrying it are silently ignored (additionalProperties
  // strips them at the tool-loop adapter).
  const latestOnly = Boolean(params.latestOnly);
  const limit = Math.min(Math.max(Number(params.limit ?? 20), 1), 50);

  const qb = deps.dataSource
    .getRepository(DevelopmentPlan)
    .createQueryBuilder('p')
    .where('p.deletedAt IS NULL')
    .orderBy('p.createAt', 'DESC')
    .take(limit);

  if (latestOnly) {
    qb.andWhere('p.isLatest = :isLatest', { isLatest: true });
  }

  const plans = await qb.getMany();

  // Count projects per plan in a single grouped query.
  const planIds = plans.map((p) => p.id);
  const countRows: Array<{ planid: string; cnt: string }> = planIds.length
    ? await deps.dataSource
        .getRepository(ProjectGroup)
        .createQueryBuilder('pg')
        .select('pg.development_plan_id', 'planid')
        .addSelect('COUNT(*)', 'cnt')
        .where('pg.deletedAt IS NULL')
        .andWhere('pg.development_plan_id IN (:...ids)', { ids: planIds })
        .groupBy('pg.development_plan_id')
        .getRawMany()
    : [];
  const countByPlan = new Map<string, number>(
    countRows.map((r) => [String(r.planid), Number(r.cnt) || 0]),
  );

  // Wave 58 W58-BE-AGG-03 (D2 — Option B) — honest derivation of the
  // four open-state signals per plan via TypeORM query builder + entity
  // metadata (Wave 54 no-raw-SQL gate). Each query returns the set of
  // planIds for which AT LEAST ONE matching row exists; the four sets
  // are then joined into the per-plan structured envelope. §15.7 / §17.3
  // — soft-delete filter on every arm; PlanPhase has no soft-delete
  // column (intentional), only `isOpen=true` predicate applies.
  const activitySignals = await resolvePlanActivitySignals(deps, planIds);

  return {
    items: plans.map((p) => {
      const fmt = p.reportFormat ?? ReportFormat.STRATEGY_BASED;
      const planActivityStatus: PlanActivityStatus = buildPlanActivityStatus({
        isLatest: !!p.isLatest,
        hasOpenPlanPhase: activitySignals.openPlanPhasePlanIds.has(p.id),
        hasOpenEditDpr: activitySignals.openEditDprPlanIds.has(p.id),
        hasOpenChangeDpr: activitySignals.openChangeDprPlanIds.has(p.id),
        hasOpenSupplement: activitySignals.openSupplementPlanIds.has(p.id),
      });
      return {
        planId: p.id,
        name: p.name,
        reportFormat: fmt,
        // Wave 58 W58-BE-AGG-01 (D1) — paired Thai display label so the
        // LLM never has to translate the enum itself.
        reportFormatLabel: resolveReportFormatLabel(String(fmt)),
        isLatest: !!p.isLatest,
        isBooked: !!p.isBooked,
        projectCount: countByPlan.get(p.id) ?? 0,
        // Wave 58 W58-BE-AGG-03 (D2) — structured two-badge envelope
        // (freshness + activities[]) so the LLM never has to invent the
        // Thai phrase from raw booleans.
        planActivityStatus,
      };
    }),
    asOf: nowIso(),
  };
};

// ────────────────────────────────────────────────────────────────────
// Wave 58 W58-BE-AGG-03 (D2) — plan open-state derivation.
//
// Four EXISTS-equivalent grouped queries (one per signal):
//   - submit-open    → PlanPhase where development_plan_id IN ids AND
//                      isOpen=true. PlanPhase has no soft-delete column.
//   - edit-open      → DevelopmentPlanRevision where dpr.isOpen=true
//                      AND rt.name maps to 'edit' (Thai 'แก้ไข') AND
//                      dpr.deletedAt IS NULL.
//   - change-open    → same shape, rt.name maps to 'change'
//                      (Thai 'เปลี่ยนแปลง').
//   - supplement-open → DevelopmentPlanSupplement where dps.isOpen=true
//                      AND dps.deletedAt IS NULL.
//
// Each query returns DISTINCT development_plan_id values; the result
// is materialized into a Set<string> for O(1) per-plan lookup. The
// builder pattern preserves the Wave 54 no-raw-SQL gate.
// ────────────────────────────────────────────────────────────────────

interface PlanActivitySignals {
  openPlanPhasePlanIds: Set<string>;
  openEditDprPlanIds: Set<string>;
  openChangeDprPlanIds: Set<string>;
  openSupplementPlanIds: Set<string>;
}

async function resolvePlanActivitySignals(
  deps: ExecutiveToolHandlerDeps,
  planIds: string[],
): Promise<PlanActivitySignals> {
  if (!planIds.length) {
    return {
      openPlanPhasePlanIds: new Set(),
      openEditDprPlanIds: new Set(),
      openChangeDprPlanIds: new Set(),
      openSupplementPlanIds: new Set(),
    };
  }

  // submit-open — open PlanPhase (agency or LAO), §8 plan activation.
  // PlanPhase has no soft-delete column on purpose (audit history is
  // preserved by the surrounding DevelopmentPlan lifecycle).
  const planPhaseRows: Array<{ planid: string }> = await deps.dataSource
    .getRepository(PlanPhase)
    .createQueryBuilder('pp')
    .select('pp.development_plan_id', 'planid')
    .where('pp.development_plan_id IN (:...ids)', { ids: planIds })
    .andWhere('pp.isOpen = :open', { open: true })
    .groupBy('pp.development_plan_id')
    .getRawMany();
  const openPlanPhasePlanIds = new Set<string>(
    planPhaseRows.map((r) => String(r.planid)),
  );

  // edit-open / change-open — DPR with isOpen=true, soft-delete-filtered,
  // discriminated by RevisionType.name (Thai literal table — same
  // mapping rule used in W58-BE-AGG-01 listProjectsInPlan revised
  // branch).
  const dprRows: Array<{ planid: string; rtname: string | null }> =
    await deps.dataSource
      .getRepository(DevelopmentPlanRevision)
      .createQueryBuilder('dpr')
      .leftJoin('dpr.revisionType', 'rt')
      .select('dpr.development_plan_id', 'planid')
      .addSelect('rt.name', 'rtname')
      .where('dpr.development_plan_id IN (:...ids)', { ids: planIds })
      .andWhere('dpr.isOpen = :open', { open: true })
      .andWhere('dpr.deletedAt IS NULL')
      .groupBy('dpr.development_plan_id')
      .addGroupBy('rt.name')
      .getRawMany();
  const openEditDprPlanIds = new Set<string>();
  const openChangeDprPlanIds = new Set<string>();
  for (const r of dprRows) {
    const lower = (r.rtname ?? '').toLowerCase();
    if (lower === 'change' || (r.rtname ?? '').includes('เปลี่ยนแปลง')) {
      openChangeDprPlanIds.add(String(r.planid));
    } else {
      // Default to `edit` for unknown / Thai 'แก้ไข' — same fallback as
      // W58-BE-AGG-01.
      openEditDprPlanIds.add(String(r.planid));
    }
  }

  // supplement-open — DPS with isOpen=true, soft-delete-filtered.
  const dpsRows: Array<{ planid: string }> = await deps.dataSource
    .getRepository(DevelopmentPlanSupplement)
    .createQueryBuilder('dps')
    .select('dps.development_plan_id', 'planid')
    .where('dps.development_plan_id IN (:...ids)', { ids: planIds })
    .andWhere('dps.isOpen = :open', { open: true })
    .andWhere('dps.deletedAt IS NULL')
    .groupBy('dps.development_plan_id')
    .getRawMany();
  const openSupplementPlanIds = new Set<string>(
    dpsRows.map((r) => String(r.planid)),
  );

  return {
    openPlanPhasePlanIds,
    openEditDprPlanIds,
    openChangeDprPlanIds,
    openSupplementPlanIds,
  };
}

// ────────────────────────────────────────────────────────────────────
// 2. getDevelopmentIssues
// ────────────────────────────────────────────────────────────────────

const getDevelopmentIssues: ExecutiveToolHandler = async (
  params,
  ctx,
  deps,
) => {
  assertExecutiveRole(ctx);
  const planId = String(params.planId);

  const plan = await deps.dataSource
    .getRepository(DevelopmentPlan)
    .findOne({ where: { id: planId } });

  if (!plan) {
    return {
      planId,
      reportFormat: ReportFormat.STRATEGY_BASED,
      items: [],
      message: 'ไม่พบแผนที่ระบุ',
    };
  }

  if (plan.reportFormat === ReportFormat.STRATEGY_BASED) {
    // §16.5 branching — STRATEGY_BASED plans have no DevelopmentIssue list.
    return {
      planId,
      reportFormat: plan.reportFormat,
      items: [],
      message: 'แผนนี้เป็นแบบยุทธศาสตร์ ไม่มีประเด็นการพัฒนา',
    };
  }

  const issues = await deps.dataSource
    .getRepository(DevelopmentIssue)
    .createQueryBuilder('i')
    .where('i.deletedAt IS NULL')
    .andWhere('i.development_plan_id = :planId', { planId })
    .orderBy('i.sort_order', 'ASC')
    .addOrderBy('i.created_at', 'ASC')
    .getMany();

  // Count projects per issue (main-plan PG only — revisions/supplements
  // reference the same plan-level DevelopmentIssue).
  const issueIds = issues.map((i) => i.id);
  const countRows: Array<{ issueid: string; cnt: string }> = issueIds.length
    ? await deps.dataSource
        .getRepository(ProjectGroup)
        .createQueryBuilder('pg')
        .select('pg.development_issue_id', 'issueid')
        .addSelect('COUNT(*)', 'cnt')
        .where('pg.deletedAt IS NULL')
        .andWhere('pg.development_issue_id IN (:...ids)', { ids: issueIds })
        .groupBy('pg.development_issue_id')
        .getRawMany()
    : [];
  const countByIssue = new Map<string, number>(
    countRows.map((r) => [String(r.issueid), Number(r.cnt) || 0]),
  );

  return {
    planId,
    reportFormat: plan.reportFormat,
    items: issues.map((i) => ({
      issueId: i.id,
      name: i.name ?? '',
      projectCount: countByIssue.get(i.id) ?? 0,
    })),
  };
};

// ────────────────────────────────────────────────────────────────────
// 3. getPendingCountsByScope
// ────────────────────────────────────────────────────────────────────

async function countLatestStatus(
  deps: ExecutiveToolHandlerDeps,
  table: 'project_group_id' | 'revised_project_group_id',
  statusNames: string[],
): Promise<Array<{ status: string; count: number }>> {
  const rows: Array<{ status: string; cnt: string }> = await deps.dataSource
    .getRepository(TrackingStatus)
    .createQueryBuilder('ts')
    .select('status.name', 'status')
    .addSelect('COUNT(*)', 'cnt')
    .innerJoin('ts.statusId', 'status')
    .where('ts.isLatest = :latest', { latest: true })
    .andWhere('ts.deletedAt IS NULL')
    .andWhere(`ts.${table} IS NOT NULL`)
    .andWhere('status.name IN (:...names)', { names: statusNames })
    .groupBy('status.name')
    .getRawMany();
  return rows.map((r) => ({ status: r.status, count: Number(r.cnt) || 0 }));
}

const getPendingCountsByScope: ExecutiveToolHandler = async (
  params,
  ctx,
  deps,
) => {
  assertExecutiveRole(ctx);
  const scope = String(params.scope ?? 'all');
  // Wave 57 W57-BE-AGG-05 — Q5: extend the default rollup to ALL three
  // pipeline statuses (Pending + Verified + Pending_Approval). Detail
  // mode preserves them individually.
  const bucketMode = resolveStatusBucketMode(params);
  const statuses = [...APPROVAL_PIPELINE_STATUSES];

  const items: Array<{
    scope: string;
    status: string;
    statusTh: string;
    count: number;
  }> = [];

  // W67-BE-AGG-01 — DB-loaded Thai labels (status.th_name SOT).
  const statusLabels = await loadStatusThaiLabels(deps);
  const resolveTh = (name: string): string =>
    resolveStatusThFromDb(statusLabels, name) ?? toThaiStatus(name);

  if (scope === 'all' || scope === 'main') {
    const mainCounts = await countLatestStatus(
      deps,
      'project_group_id',
      statuses,
    );
    if (bucketMode === 'rollup') {
      const total = mainCounts.reduce((s, r) => s + r.count, 0);
      if (total > 0) {
        items.push({
          scope: 'main',
          status: APPROVAL_PIPELINE_ROLLUP_KEY,
          statusTh: APPROVAL_PIPELINE_ROLLUP_LABEL,
          count: total,
        });
      }
    } else {
      for (const row of mainCounts) {
        items.push({
          scope: 'main',
          status: row.status,
          statusTh: resolveTh(row.status),
          count: row.count,
        });
      }
    }
  }
  if (scope === 'all' || scope === 'revision' || scope === 'change') {
    const revisedCounts = await countLatestStatus(
      deps,
      'revised_project_group_id',
      statuses,
    );
    const targetScope = scope === 'change' ? 'change' : 'revision';
    if (bucketMode === 'rollup') {
      const total = revisedCounts.reduce((s, r) => s + r.count, 0);
      if (total > 0) {
        items.push({
          scope: targetScope,
          status: APPROVAL_PIPELINE_ROLLUP_KEY,
          statusTh: APPROVAL_PIPELINE_ROLLUP_LABEL,
          count: total,
        });
      }
    } else {
      for (const row of revisedCounts) {
        items.push({
          scope: targetScope,
          status: row.status,
          statusTh: resolveTh(row.status),
          count: row.count,
        });
      }
    }
  }

  const advisories =
    bucketMode === 'rollup' ? ['approval-pipeline-rollup-applied'] : [];
  return { items, advisories, asOf: nowIso() };
};

// ────────────────────────────────────────────────────────────────────
// 4. getTeamWorkloadSummary
// ────────────────────────────────────────────────────────────────────

const getTeamWorkloadSummary: ExecutiveToolHandler = async (
  params,
  ctx,
  deps,
) => {
  assertExecutiveRole(ctx);
  const limit = Math.min(Math.max(Number(params.limit ?? 10), 1), 50);

  // Aggregate workload counts by responsible_agency_id from ProjectGroup.
  // Keeps the handler self-contained; executive.service.getTeamDashboard
  // returns a heavy UI-shaped object we don't want the LLM to see.
  //
  // BE-W53-02 — LEFT JOIN GovernmentAgency so the `assigneeLabel` is the
  // actual หน่วยงานรับผิดชอบ name instead of the opaque legacy
  // `agency#<id>` surrogate.  `ga.name` is projected alongside the
  // aggregate so the LLM can cite the agency by its Thai title.
  const rows: Array<{
    agencyid: string | null;
    agencyname: string | null;
    pending: string;
    inreview: string;
    approved: string;
  }> = await deps.dataSource
    .getRepository(ProjectGroup)
    .createQueryBuilder('pg')
    .select('pg.responsible_agency_id', 'agencyid')
    .addSelect('ga.name', 'agencyname')
    .addSelect(
      `SUM(CASE WHEN status.name = 'Pending' THEN 1 ELSE 0 END)`,
      'pending',
    )
    .addSelect(
      `SUM(CASE WHEN status.name IN ('Verified','Pending_Approval') THEN 1 ELSE 0 END)`,
      'inreview',
    )
    .addSelect(
      `SUM(CASE WHEN status.name = 'Approved' THEN 1 ELSE 0 END)`,
      'approved',
    )
    .innerJoin('pg.trackingStatus', 'ts', 'ts.isLatest = true')
    .innerJoin('ts.statusId', 'status')
    .leftJoin(GovernmentAgency, 'ga', 'ga.id = pg.responsible_agency_id')
    .where('pg.deletedAt IS NULL')
    .groupBy('pg.responsible_agency_id')
    .addGroupBy('ga.name')
    .limit(limit)
    .getRawMany();

  // W66-BE-AGG-02 — paired Thai-label fields per counter so the LLM
  // never has to translate `inReviewCount` to a Thai status name on its
  // own (the prior shape misled it into "รอแก้ไข", which is
  // Returned_For_Revision and is NOT counted here).
  //
  // W67-BE-AGG-01 — Thai labels are now sourced from the DB
  // `status.th_name` column (W67 SOT) instead of the deprecated static
  // `STATUS_TH_MAP`. The composite rollup labels (`pendingLabelTh`,
  // `inReviewLabelTh`, `approvedLabelTh`) are composed from the per-
  // status DB values; field NAMES + the human meaning are unchanged.
  // §17.9 — labels remain static-resolution-only (no user input
  // interpolated); a missing DB row falls back to the canonical English
  // status name to make drift visible rather than papering over it.
  //
  // NULL responsible_agency_id rows continue to emit the W57 rule #26
  // disclosure instead of the bland "ไม่ระบุ" sentinel that hid the
  // "รอ staff กำหนด" semantics.
  const statusLabels = await loadStatusThaiLabels(deps);
  const pendingTh = resolveStatusThFromDb(statusLabels, 'Pending') ?? 'Pending';
  // W67 keeps `pendingLabelTh` semantics — the field counts ONLY the
  // canonical `Pending` status; W67 renamed the DB label to "รอตรวจสอบ".
  // Pre-W67 callers expected "รอการอนุมัติ"; the rename is intentional
  // (canonical 8-status alignment) and the field NAME is unchanged.
  const pendingLabelTh = pendingTh;
  const verifiedTh =
    resolveStatusThFromDb(statusLabels, 'Verified') ?? 'Verified';
  const pendingApprovalTh =
    resolveStatusThFromDb(statusLabels, 'Pending_Approval') ??
    'Pending_Approval';
  const inReviewLabelTh = `${verifiedTh} + ${pendingApprovalTh}`;
  const approvedLabelTh =
    resolveStatusThFromDb(statusLabels, 'Approved') ?? 'Approved';

  // W67-BE-AGG-01 — top-level 4-group rollup, summed across all rows in
  // the workload result. `pendingReviewCount` = Pending; `awaitingApprovalCount`
  // = Verified + Pending_Approval; `approvedCount` = Approved; `rejectedCount`
  // = Rejected. The per-agency `*Count` fields above are unchanged.
  let totalPending = 0;
  let totalInReview = 0;
  let totalApproved = 0;
  for (const r of rows) {
    totalPending += Number(r.pending) || 0;
    totalInReview += Number(r.inreview) || 0;
    totalApproved += Number(r.approved) || 0;
  }
  const executiveStatusBreakdown = {
    pendingReviewCount: totalPending,
    awaitingApprovalCount: totalInReview,
    approvedCount: totalApproved,
    // Rejected is not summed in this handler's underlying query. Surfaced
    // as 0 to keep the envelope shape stable; getProjectStatusBreakdown
    // is the right place to count Rejected.
    rejectedCount: 0,
  };

  return {
    items: rows.map((r) => {
      const hasAgency =
        typeof r.agencyname === 'string' && r.agencyname.trim().length > 0;
      const assigneeId = r.agencyid ?? null;
      const assigneeLabel = hasAgency
        ? (r.agencyname as string)
        : PENDING_RESPONSIBLE_AGENCY_DISCLOSURE;
      const assigneeDisclosure = hasAgency
        ? null
        : PENDING_RESPONSIBLE_AGENCY_DISCLOSURE;
      return {
        assigneeId,
        assigneeLabel,
        assigneeDisclosure,
        pendingCount: Number(r.pending) || 0,
        pendingLabelTh,
        inReviewCount: Number(r.inreview) || 0,
        // ⚠️ inReviewCount = Verified + Pending_Approval ONLY.
        // Returned_For_Revision ("รอแก้ไข") is a SEPARATE status and is
        // NOT included. The Thai label below is the LLM's ground truth.
        inReviewLabelTh,
        approvedCount: Number(r.approved) || 0,
        approvedLabelTh,
      };
    }),
    executiveStatusBreakdown,
    asOf: nowIso(),
  };
};

// ────────────────────────────────────────────────────────────────────
// 5. getBudgetSummaryByPlan
// ────────────────────────────────────────────────────────────────────

const getBudgetSummaryByPlan: ExecutiveToolHandler = async (
  params,
  ctx,
  deps,
) => {
  assertExecutiveRole(ctx);
  const planId = String(params.planId);

  // BE-W53-02 — three-scope budget sum.
  //
  // Each scope is an independent correlated aggregate, bound to the plan
  // via the entity-level anchor:
  //   - main       → Budget.project_group_id → PG.development_plan_id
  //   - revised    → Budget.revised_project_group_id → RPG.developmentPlanRevision.development_plan_id
  //   - supplement → Budget.supplement_project_group_id → SPG.developmentPlanSupplement.development_plan_id
  //
  // `getRawOne` returns `T | undefined`; an empty aggregate still yields
  // `{ sum: '0', cnt: '0' }` from Postgres, but a deterministic fallback
  // guards against unexpected `undefined` in the downstream math.

  const emptyAgg: { sum: string | null; cnt: string } = { sum: null, cnt: '0' };

  // Wave 57 W57-BE-AGG-01 — HEAD-of-lineage filter (CLAUDE.md §14.2).
  // Without dedup, a PG that has been forked into an RPG would be summed
  // alongside its RPG descendant, double-counting the same conceptual
  // project. The anti-join below ensures the parent PG is excluded once
  // a non-soft-deleted RPG references it via prev_project_id.
  const mainQb = deps.dataSource
    .getRepository(Budget)
    .createQueryBuilder('b')
    .innerJoin('b.projectGroupId', 'pg')
    .select('COALESCE(SUM(b.quantity), 0)', 'sum')
    .addSelect('COUNT(DISTINCT pg.id)', 'cnt')
    .where('pg.deletedAt IS NULL')
    .andWhere('pg.development_plan_id = :planId', { planId });
  applyHeadFilterForProjectGroup(mainQb, 'pg');
  const mainRow =
    (await mainQb.getRawOne<{ sum: string | null; cnt: string }>()) ?? emptyAgg;

  const revisedQb = deps.dataSource
    .getRepository(Budget)
    .createQueryBuilder('b')
    .innerJoin('b.revisedProjectGroupId', 'rpg')
    .innerJoin('rpg.developmentPlanRevision', 'dpr')
    .select('COALESCE(SUM(b.quantity), 0)', 'sum')
    .addSelect('COUNT(DISTINCT rpg.id)', 'cnt')
    .where('rpg.deletedAt IS NULL')
    .andWhere('dpr.deletedAt IS NULL')
    .andWhere('dpr.development_plan_id = :planId', { planId });
  applyHeadFilterForRevisedProjectGroup(revisedQb, 'rpg');
  const revisedRow =
    (await revisedQb.getRawOne<{ sum: string | null; cnt: string }>()) ??
    emptyAgg;

  const supplementRow =
    (await deps.dataSource
      .getRepository(Budget)
      .createQueryBuilder('b')
      .innerJoin('b.supplementProjectGroupId', 'spg')
      .innerJoin('spg.developmentPlanSupplement', 'dps')
      .select('COALESCE(SUM(b.quantity), 0)', 'sum')
      .addSelect('COUNT(DISTINCT spg.id)', 'cnt')
      .where('spg.deletedAt IS NULL')
      .andWhere('dps.deletedAt IS NULL')
      .andWhere('dps.development_plan_id = :planId', { planId })
      .getRawOne<{ sum: string | null; cnt: string }>()) ?? emptyAgg;

  const mainTotal = Number(mainRow.sum ?? 0) || 0;
  const mainCount = Number(mainRow.cnt ?? 0) || 0;
  const revisedTotal = Number(revisedRow.sum ?? 0) || 0;
  const revisedCount = Number(revisedRow.cnt ?? 0) || 0;
  const supplementTotal = Number(supplementRow.sum ?? 0) || 0;
  const supplementCount = Number(supplementRow.cnt ?? 0) || 0;

  const totalBudget = mainTotal + revisedTotal + supplementTotal;
  const projectCount = mainCount + revisedCount + supplementCount;
  const averageBudget = projectCount > 0 ? totalBudget / projectCount : 0;

  return {
    planId,
    totalBudget,
    projectCount,
    averageBudget,
    breakdown: {
      main: { totalBudget: mainTotal, projectCount: mainCount },
      revised: { totalBudget: revisedTotal, projectCount: revisedCount },
      supplement: {
        totalBudget: supplementTotal,
        projectCount: supplementCount,
      },
    },
    advisories: [HEAD_OF_LINEAGE_ADVISORY],
    asOf: nowIso(),
  };
};

// ────────────────────────────────────────────────────────────────────
// 6. searchProjectsByKeyword
// ────────────────────────────────────────────────────────────────────

const searchProjectsByKeyword: ExecutiveToolHandler = async (
  params,
  ctx,
  deps,
) => {
  assertExecutiveRole(ctx);
  const keyword = String(params.keyword ?? '').trim();
  const scope = String(params.scope ?? 'all');
  const limit = Math.min(Math.max(Number(params.limit ?? 10), 1), 10);

  // BE-W53-02 — optional planId filter.  The `keyword` remains the sole
  // free-text param; prompt-injection delimiters and schema validation
  // shape are unchanged per §17.9.  Each scope branch anchors to the
  // plan via the same entity chain used by `getBudgetSummaryByPlan`.
  const planIdRaw = params.planId != null ? String(params.planId) : null;
  const planId = planIdRaw && UUID_RX.test(planIdRaw) ? planIdRaw : null;

  if (keyword.length === 0) {
    return { items: [], asOf: nowIso() };
  }
  const pattern = `%${keyword}%`;

  // W60c (2026-04-25 — round 5) — enrich envelope with the same rich
  // fields that `listProjectsInPlan` emits. Earlier rounds depended on
  // prompt rule #35 to redirect the LLM to `listProjectsInPlan` after
  // searching by keyword, but the LLM kept routing through the lineage
  // tools (sparse) and rendering "ไม่ระบุ" for half the columns. Pulling
  // the rich shape into the search envelope guarantees the data is in
  // the LLM's context regardless of which tool it picks.
  const items: Array<Record<string, unknown>> = [];

  if (scope === 'all' || scope === 'main') {
    const qb = deps.dataSource
      .getRepository(ProjectGroup)
      .createQueryBuilder('pg')
      .select('pg.id', 'pgid')
      .addSelect('pg.title', 'title')
      .addSelect('pg.development_plan_id', 'planid')
      .addSelect('status.name', 'statusname')
      .addSelect('pg.amphoe_id', 'amphoeid')
      .addSelect('pg.responsible_agency_id', 'agencyid')
      .addSelect('ga.name', 'agencyname')
      .addSelect('pg.pageNumber', 'pagenumber')
      .addSelect('pg.objective', 'objective')
      .addSelect('pg_amp.name', 'amphoename')
      .addSelect('pg_lao.name', 'laoname')
      .addSelect('pg.startLat', 'startlat')
      .addSelect('pg.startLng', 'startlng')
      .addSelect('pg.endLat', 'endlat')
      .addSelect('pg.endLng', 'endlng')
      // Wave 62 W62-BE-AGG-02 — extended classification fields. `goal`,
      // `expected`, `indicator` are scalar columns on PG. `dp.report_format`
      // drives the §17.7 branching at the handler. `di.name` is the Thai
      // label for the developmentIssue (ISSUE_BASED rows only — null for
      // STRATEGY_BASED). LEFT JOIN — `developmentIssue` is nullable per
      // §16.5 invariant; soft-delete filter prevents stale issue labels
      // from §16.6.
      .addSelect('pg.goal', 'goal')
      .addSelect('pg.expected', 'expected')
      .addSelect('pg.indicator', 'indicator')
      .addSelect('di.name', 'developmentissuename')
      .addSelect('dp.report_format', 'reportformat')
      .addSelect(
        (subQb: SelectQueryBuilder<Budget>) =>
          subQb
            .select('COALESCE(SUM(b.quantity), 0)')
            .from(Budget, 'b')
            .where('b.project_group_id = pg.id'),
        'budget',
      )
      .leftJoin('pg.trackingStatus', 'ts', 'ts.isLatest = true')
      .leftJoin('ts.statusId', 'status')
      .leftJoin(GovernmentAgency, 'ga', 'ga.id = pg.responsible_agency_id')
      .leftJoin('pg.amphoe', 'pg_amp')
      .leftJoin('pg.localAdministrativeOrganization', 'pg_lao')
      // Wave 62 W62-BE-AGG-02 — entity-property paths only (Wave 54
      // no-raw-SQL gate). `pg.developmentIssue` resolves to the
      // `development_issues` table via the `@ManyToOne` decorator on
      // `ProjectGroup.developmentIssue`. Soft-delete filter applied per
      // §16.6 (a soft-deleted issue MUST NOT surface as a stale label).
      .leftJoin('pg.developmentIssue', 'di', 'di.deletedAt IS NULL')
      .leftJoin('pg.developmentPlan', 'dp')
      .where('pg.deletedAt IS NULL')
      .andWhere('pg.title ILIKE :pattern', { pattern });
    if (planId) {
      qb.andWhere('pg.development_plan_id = :planId', { planId });
    }
    const mainRows: Array<{
      pgid: string;
      title: string;
      planid: string | null;
      statusname: string | null;
      amphoeid: number | null;
      agencyid: number | null;
      agencyname: string | null;
      pagenumber: number | null;
      objective: string | null;
      amphoename: string | null;
      laoname: string | null;
      startlat: number | string | null;
      startlng: number | string | null;
      endlat: number | string | null;
      endlng: number | string | null;
      budget: string | null;
      goal: string | null;
      expected: string | null;
      indicator: string | null;
      developmentissuename: string | null;
      reportformat: string | null;
    }> = await qb.limit(limit).getRawMany();
    for (const r of mainRows) {
      const entry = buildProjectEntry({
        projectId: r.pgid,
        projectKind: 'original',
        title: r.title,
        statusname: r.statusname,
        planId: r.planid ?? null,
        budget: r.budget,
        amphoeId: r.amphoeid,
        agencyId: r.agencyid,
        agencyName: r.agencyname,
        creatorAmphoeId: null,
        creatorLaoId: null,
        revisionRoundType: 'main',
        revisionRoundId: null,
        revisionDescription: null,
        revisionNumber: null,
        pageNumber: r.pagenumber,
        objectiveRaw: r.objective,
        amphoeName: r.amphoename,
        laoName: r.laoname,
        startLat: r.startlat,
        startLng: r.startlng,
        endLat: r.endlat,
        endLng: r.endlng,
        goalRaw: r.goal,
        expectedRaw: r.expected,
        indicatorRaw: r.indicator,
        developmentIssueLabel: r.developmentissuename,
        reportFormat: coerceReportFormat(r.reportformat),
      });
      items.push(entry);
    }
  }
  if ((scope === 'all' || scope === 'revision') && items.length < limit) {
    const qb = deps.dataSource
      .getRepository(RevisedProjectGroup)
      .createQueryBuilder('rpg')
      .select('rpg.id', 'rpgid')
      .addSelect('rpg.title', 'title')
      .addSelect('status.name', 'statusname')
      .addSelect('rpg.amphoe_id', 'amphoeid')
      .addSelect('rpg.responsible_agency_id', 'agencyid')
      .addSelect('ga.name', 'agencyname')
      .addSelect('dpr.id', 'dprid')
      .addSelect('dpr.revision_number', 'revisionnumber')
      .addSelect('dpr.description', 'dprdescription')
      .addSelect('rt.name', 'revisiontypename')
      .addSelect('rpg.pageNumber', 'pagenumber')
      .addSelect('rpg.objective', 'objective')
      .addSelect('rpg_amp.name', 'amphoename')
      .addSelect('rpg_lao.name', 'laoname')
      .addSelect('rpg.startLat', 'startlat')
      .addSelect('rpg.startLng', 'startlng')
      .addSelect('rpg.endLat', 'endlat')
      .addSelect('rpg.endLng', 'endlng')
      // Wave 62 W62-BE-AGG-02 — extended classification fields. RPG has
      // its own `developmentPlan` direct relation (entity line 40) — we
      // JOIN it directly rather than via DPR for the reportFormat lookup.
      .addSelect('rpg.goal', 'goal')
      .addSelect('rpg.expected', 'expected')
      .addSelect('rpg.indicator', 'indicator')
      .addSelect('di.name', 'developmentissuename')
      .addSelect('dp.report_format', 'reportformat')
      .addSelect(
        (subQb: SelectQueryBuilder<Budget>) =>
          subQb
            .select('COALESCE(SUM(b.quantity), 0)')
            .from(Budget, 'b')
            .where('b.revised_project_group_id = rpg.id'),
        'budget',
      )
      .innerJoin('rpg.developmentPlanRevision', 'dpr')
      .leftJoin('dpr.revisionType', 'rt')
      .leftJoin('rpg.trackingStatus', 'ts', 'ts.isLatest = true')
      .leftJoin('ts.statusId', 'status')
      .leftJoin(GovernmentAgency, 'ga', 'ga.id = rpg.responsible_agency_id')
      .leftJoin('rpg.amphoe', 'rpg_amp')
      .leftJoin('rpg.localAdministrativeOrganization', 'rpg_lao')
      // Wave 62 — developmentIssue (LEFT JOIN, soft-delete filter per
      // §16.6) and developmentPlan (LEFT JOIN; the RPG entity declares
      // it as `developmentPlan?` — nullable in some legacy paths but
      // populated for all post-§16 rows).
      .leftJoin('rpg.developmentIssue', 'di', 'di.deletedAt IS NULL')
      .leftJoin('rpg.developmentPlan', 'dp')
      .where('rpg.deletedAt IS NULL')
      .andWhere('dpr.deletedAt IS NULL')
      .andWhere('rpg.title ILIKE :pattern', { pattern });
    if (planId) {
      qb.andWhere('dpr.development_plan_id = :planId', { planId });
    }
    const revRows: Array<{
      rpgid: string;
      title: string;
      statusname: string | null;
      amphoeid: number | null;
      agencyid: number | null;
      agencyname: string | null;
      dprid: string | null;
      revisionnumber: number | null;
      dprdescription: string | null;
      revisiontypename: string | null;
      pagenumber: number | null;
      objective: string | null;
      amphoename: string | null;
      laoname: string | null;
      startlat: number | string | null;
      startlng: number | string | null;
      endlat: number | string | null;
      endlng: number | string | null;
      budget: string | null;
      goal: string | null;
      expected: string | null;
      indicator: string | null;
      developmentissuename: string | null;
      reportformat: string | null;
    }> = await qb.limit(limit - items.length).getRawMany();
    for (const r of revRows) {
      const rtName = (r.revisiontypename ?? '').trim();
      const roundType: RevisionRoundType =
        rtName === 'เปลี่ยนแปลง' || rtName.toLowerCase() === 'change'
          ? 'change'
          : 'edit';
      const entry = buildProjectEntry({
        projectId: r.rpgid,
        projectKind: 'revised',
        title: r.title,
        statusname: r.statusname,
        planId: planId ?? null,
        budget: r.budget,
        amphoeId: r.amphoeid,
        agencyId: r.agencyid,
        agencyName: r.agencyname,
        creatorAmphoeId: null,
        creatorLaoId: null,
        revisionRoundType: roundType,
        revisionRoundId: r.dprid ?? null,
        revisionDescription: r.dprdescription ?? null,
        revisionNumber: r.revisionnumber ?? null,
        pageNumber: r.pagenumber,
        objectiveRaw: r.objective,
        amphoeName: r.amphoename,
        laoName: r.laoname,
        startLat: r.startlat,
        startLng: r.startlng,
        endLat: r.endlat,
        endLng: r.endlng,
        goalRaw: r.goal,
        expectedRaw: r.expected,
        indicatorRaw: r.indicator,
        developmentIssueLabel: r.developmentissuename,
        reportFormat: coerceReportFormat(r.reportformat),
      });
      items.push(entry);
    }
  }
  if ((scope === 'all' || scope === 'supplement') && items.length < limit) {
    const qb = deps.dataSource
      .getRepository(SupplementProjectGroup)
      .createQueryBuilder('spg')
      .select('spg.id', 'spgid')
      .addSelect('spg.title', 'title')
      .addSelect('status.name', 'statusname')
      .addSelect('spg.amphoe_id', 'amphoeid')
      .addSelect('spg.responsible_agency_id', 'agencyid')
      .addSelect('ga.name', 'agencyname')
      .addSelect('dps.id', 'dpsid')
      .addSelect('dps.description', 'dpsdescription')
      .addSelect('spg.pageNumber', 'pagenumber')
      .addSelect('spg.objective', 'objective')
      .addSelect('spg_amp.name', 'amphoename')
      .addSelect('spg.startLat', 'startlat')
      .addSelect('spg.startLng', 'startlng')
      .addSelect('spg.endLat', 'endlat')
      .addSelect('spg.endLng', 'endlng')
      // Wave 62 W62-BE-AGG-02 — extended classification fields. SPG has
      // no direct `developmentPlan` relation; reportFormat is JOINed
      // through `developmentPlanSupplement.developmentPlan` (entity
      // line 22).
      .addSelect('spg.goal', 'goal')
      .addSelect('spg.expected', 'expected')
      .addSelect('spg.indicator', 'indicator')
      .addSelect('di.name', 'developmentissuename')
      .addSelect('dp.report_format', 'reportformat')
      .addSelect(
        (subQb: SelectQueryBuilder<Budget>) =>
          subQb
            .select('COALESCE(SUM(b.quantity), 0)')
            .from(Budget, 'b')
            .where('b.supplement_project_group_id = spg.id'),
        'budget',
      )
      .innerJoin('spg.developmentPlanSupplement', 'dps')
      .leftJoin('spg.trackingStatus', 'ts', 'ts.isLatest = true')
      .leftJoin('ts.statusId', 'status')
      .leftJoin(GovernmentAgency, 'ga', 'ga.id = spg.responsible_agency_id')
      .leftJoin('spg.amphoe', 'spg_amp')
      // Wave 62 — developmentIssue (LEFT JOIN, soft-delete filter per
      // §16.6) and dps.developmentPlan (LEFT JOIN; reportFormat lookup).
      .leftJoin('spg.developmentIssue', 'di', 'di.deletedAt IS NULL')
      .leftJoin('dps.developmentPlan', 'dp')
      .where('spg.deletedAt IS NULL')
      .andWhere('dps.deletedAt IS NULL')
      .andWhere('spg.title ILIKE :pattern', { pattern });
    if (planId) {
      qb.andWhere('dps.development_plan_id = :planId', { planId });
    }
    const supRows: Array<{
      spgid: string;
      title: string;
      statusname: string | null;
      amphoeid: number | null;
      agencyid: number | null;
      agencyname: string | null;
      dpsid: string | null;
      dpsdescription: string | null;
      pagenumber: number | null;
      objective: string | null;
      amphoename: string | null;
      startlat: number | string | null;
      startlng: number | string | null;
      endlat: number | string | null;
      endlng: number | string | null;
      budget: string | null;
      goal: string | null;
      expected: string | null;
      indicator: string | null;
      developmentissuename: string | null;
      reportformat: string | null;
    }> = await qb.limit(limit - items.length).getRawMany();
    for (const r of supRows) {
      const entry = buildProjectEntry({
        projectId: r.spgid,
        projectKind: 'supplement',
        title: r.title,
        statusname: r.statusname,
        planId: planId ?? null,
        budget: r.budget,
        amphoeId: r.amphoeid,
        agencyId: r.agencyid,
        agencyName: r.agencyname,
        creatorAmphoeId: null,
        creatorLaoId: null,
        revisionRoundType: 'supplement',
        revisionRoundId: r.dpsid ?? null,
        revisionDescription: r.dpsdescription ?? null,
        revisionNumber: null,
        pageNumber: r.pagenumber,
        objectiveRaw: r.objective,
        amphoeName: r.amphoename,
        laoName: null,
        startLat: r.startlat,
        startLng: r.startlng,
        endLat: r.endlat,
        endLng: r.endlng,
        goalRaw: r.goal,
        expectedRaw: r.expected,
        indicatorRaw: r.indicator,
        developmentIssueLabel: r.developmentissuename,
        reportFormat: coerceReportFormat(r.reportformat),
      });
      items.push(entry);
    }
  }

  return { items, asOf: nowIso() };
};

// ────────────────────────────────────────────────────────────────────
// 7. getProjectStatusBreakdown
// ────────────────────────────────────────────────────────────────────

const getProjectStatusBreakdown: ExecutiveToolHandler = async (
  params,
  ctx,
  deps,
) => {
  assertExecutiveRole(ctx);
  const planId = params.planId ? String(params.planId) : null;
  const scope = String(params.scope ?? 'all');
  // Wave 57 W57-BE-AGG-05 — Q5 dual-mode + Q8 Ready hidden.
  const bucketMode = resolveStatusBucketMode(params);
  // Default: hide Ready. Caller may opt in via `includeReady: true`.
  const includeReady = params.includeReady === true;
  const visibleStatuses = includeReady
    ? [...EXEC_VISIBLE_STATUSES, 'Ready']
    : [...EXEC_VISIBLE_STATUSES];

  // BE-W53-02 — honour scope.  Aggregate each scope with its own
  // subquery (status-name GROUP BY) then merge into a single
  // status → count map.  `revision` covers edit+change together; the
  // per-type split is surfaced via `listDevelopmentPlanRevisions`.
  //
  // `main | revision | supplement` each attach to the matching ts.*
  // FK; `all` UNIONs all three.  planId filter applies only to the
  // scopes whose target entity carries a plan anchor:
  //   - main       → pg.development_plan_id
  //   - revision   → rpg → dpr.development_plan_id
  //   - supplement → spg → dps.development_plan_id
  type Scope = 'main' | 'revision' | 'supplement';
  const requestedScopes: Scope[] =
    scope === 'all'
      ? ['main', 'revision', 'supplement']
      : scope === 'revision'
        ? ['revision']
        : scope === 'supplement'
          ? ['supplement']
          : ['main'];

  const countByStatus = new Map<string, number>();

  for (const s of requestedScopes) {
    let qb = deps.dataSource
      .getRepository(TrackingStatus)
      .createQueryBuilder('ts')
      .select('status.name', 'status')
      .addSelect('COUNT(*)', 'cnt')
      .innerJoin('ts.statusId', 'status')
      .where('ts.isLatest = :latest', { latest: true })
      .andWhere('ts.deletedAt IS NULL')
      // Wave 57 W57-BE-AGG-05 — Q8 Ready hidden in default exec views.
      .andWhere('status.name IN (:...visibleStatuses)', { visibleStatuses })
      .groupBy('status.name');

    if (s === 'main') {
      qb = qb
        .innerJoin('ts.projectGroupId', 'pg')
        .andWhere('pg.deletedAt IS NULL');
      if (planId) {
        qb = qb.andWhere('pg.development_plan_id = :planId', { planId });
      }
    } else if (s === 'revision') {
      qb = qb
        .innerJoin('ts.revisedProjectGroupId', 'rpg')
        .andWhere('rpg.deletedAt IS NULL');
      if (planId) {
        qb = qb
          .innerJoin('rpg.developmentPlanRevision', 'dpr')
          .andWhere('dpr.deletedAt IS NULL')
          .andWhere('dpr.development_plan_id = :planId', { planId });
      }
    } else {
      qb = qb
        .innerJoin('ts.supplementProjectGroupId', 'spg')
        .andWhere('spg.deletedAt IS NULL');
      if (planId) {
        qb = qb
          .innerJoin('spg.developmentPlanSupplement', 'dps')
          .andWhere('dps.deletedAt IS NULL')
          .andWhere('dps.development_plan_id = :planId', { planId });
      }
    }

    const rows: Array<{ status: string; cnt: string }> = await qb.getRawMany();
    for (const r of rows) {
      const prev = countByStatus.get(r.status) ?? 0;
      countByStatus.set(r.status, prev + (Number(r.cnt) || 0));
    }
  }

  // Wave 57 W57-BE-AGG-05 — Q5 dual-mode "รออนุมัติ" rollup.
  let items: Array<{ status: string; statusTh: string; count: number }>;
  const advisories: string[] = [];
  // W67-BE-AGG-01 — DB-loaded Thai labels (status.th_name SOT). New
  // callers MUST consume `statusTh` from the DB; the deprecated static
  // `STATUS_TH_MAP` continues to back the legacy `toThaiStatus()` for
  // back-compat in case the DB row is missing.
  const statusLabels = await loadStatusThaiLabels(deps);
  const resolveTh = (name: string): string =>
    resolveStatusThFromDb(statusLabels, name) ?? toThaiStatus(name);

  if (bucketMode === 'rollup') {
    let pipelineTotal = 0;
    items = [];
    for (const [status, count] of countByStatus.entries()) {
      if (isApprovalPipelineStatus(status)) {
        pipelineTotal += count;
        continue;
      }
      items.push({
        status,
        statusTh: resolveTh(status),
        count,
      });
    }
    if (pipelineTotal > 0) {
      items.push({
        status: APPROVAL_PIPELINE_ROLLUP_KEY,
        statusTh: APPROVAL_PIPELINE_ROLLUP_LABEL,
        count: pipelineTotal,
      });
    }
    advisories.push('approval-pipeline-rollup-applied');
  } else {
    items = [...countByStatus.entries()].map(([status, count]) => ({
      status,
      statusTh: resolveTh(status),
      count,
    }));
  }

  // W67-BE-AGG-01 — parallel 4-group executive rollup section. Always
  // emitted alongside the existing per-status `items[]` (additive only;
  // does NOT replace the canonical 7-status counts).
  const executiveStatusBreakdown = buildExecutiveStatusBreakdown(countByStatus);

  return { items, executiveStatusBreakdown, advisories, asOf: nowIso() };
};

// ────────────────────────────────────────────────────────────────────
// 8. getApprovalPipelineSnapshot
// ────────────────────────────────────────────────────────────────────

const getApprovalPipelineSnapshot: ExecutiveToolHandler = async (
  _params,
  ctx,
  deps,
) => {
  assertExecutiveRole(ctx);
  const rows: Array<{ status: string; cnt: string }> = await deps.dataSource
    .getRepository(TrackingStatus)
    .createQueryBuilder('ts')
    .select('status.name', 'status')
    .addSelect('COUNT(*)', 'cnt')
    .innerJoin('ts.statusId', 'status')
    .where('ts.isLatest = :latest', { latest: true })
    .andWhere('ts.deletedAt IS NULL')
    .andWhere('status.name IN (:...names)', {
      names: ['Ready', 'Pending', 'Verified', 'Pending_Approval', 'Approved'],
    })
    .groupBy('status.name')
    .getRawMany();

  const countByStatus = new Map<string, number>(
    rows.map((r) => [r.status, Number(r.cnt) || 0]),
  );

  const stages = [
    {
      fromStatus: 'Ready',
      fromStatusTh: toThaiStatus('Ready'),
      toStatus: 'Pending',
      toStatusTh: toThaiStatus('Pending'),
      queueDepth: countByStatus.get('Ready') ?? 0,
    },
    {
      fromStatus: 'Pending',
      fromStatusTh: toThaiStatus('Pending'),
      toStatus: 'Verified',
      toStatusTh: toThaiStatus('Verified'),
      queueDepth: countByStatus.get('Pending') ?? 0,
    },
    {
      fromStatus: 'Verified',
      fromStatusTh: toThaiStatus('Verified'),
      toStatus: 'Pending_Approval',
      toStatusTh: toThaiStatus('Pending_Approval'),
      queueDepth: countByStatus.get('Verified') ?? 0,
    },
    {
      fromStatus: 'Pending_Approval',
      fromStatusTh: toThaiStatus('Pending_Approval'),
      toStatus: 'Approved',
      toStatusTh: toThaiStatus('Approved'),
      queueDepth: countByStatus.get('Pending_Approval') ?? 0,
    },
  ];

  return { stages, asOf: nowIso() };
};

// ────────────────────────────────────────────────────────────────────
// 9. detectWorkflowAgingProjects
// ────────────────────────────────────────────────────────────────────

const detectWorkflowAgingProjects: ExecutiveToolHandler = async (
  params,
  ctx,
  deps,
) => {
  assertExecutiveRole(ctx);
  const thresholdDays = Math.min(
    Math.max(Number(params.thresholdDays ?? 14), 1),
    180,
  );
  const limit = Math.min(Math.max(Number(params.limit ?? 10), 1), 50);
  const scope = String(params.scope ?? 'all');

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - thresholdDays);

  const items: Array<Record<string, unknown>> = [];

  // MUST exclude Returned_For_Revision and Pull_Back per task §7.3.
  const eligibleStatuses = ['Pending', 'Pending_Approval'];

  if (scope === 'all' || scope === 'main') {
    // Wave 58 W58-BE-AGG-01 (D3 / D6) — JOIN GovernmentAgency for the
    // responsibleAgency name + creator-WH identity for the §5
    // origin-type classifier (drives `responsibleAgencyDisclosure`).
    const rows: Array<{
      pgid: string;
      title: string;
      statusname: string;
      createat: Date;
      planid: string | null;
      amphoeid: number | null;
      agencyid: number | null;
      agencyname: string | null;
      creatoramphoeid: string | number | null;
      creatorlaoid: string | number | null;
    }> = await deps.dataSource
      .getRepository(TrackingStatus)
      .createQueryBuilder('ts')
      .select('pg.id', 'pgid')
      .addSelect('pg.title', 'title')
      .addSelect('status.name', 'statusname')
      .addSelect('ts.createAt', 'createat')
      .addSelect('pg.development_plan_id', 'planid')
      .addSelect('pg.amphoe_id', 'amphoeid')
      .addSelect('pg.responsible_agency_id', 'agencyid')
      .addSelect('ga.name', 'agencyname')
      .addSelect('wh_amp.id', 'creatoramphoeid')
      .addSelect('wh_lao.id', 'creatorlaoid')
      .innerJoin('ts.projectGroupId', 'pg')
      .innerJoin('ts.statusId', 'status')
      .leftJoin(GovernmentAgency, 'ga', 'ga.id = pg.responsible_agency_id')
      .leftJoin('pg.createdBy', 'wh')
      .leftJoin('wh.amphoe', 'wh_amp')
      .leftJoin('wh.localAdministrativeOrganization', 'wh_lao')
      .where('ts.isLatest = :latest', { latest: true })
      .andWhere('ts.deletedAt IS NULL')
      .andWhere('pg.deletedAt IS NULL')
      .andWhere('status.name IN (:...names)', { names: eligibleStatuses })
      .andWhere('ts.createAt < :cutoff', { cutoff })
      .orderBy('ts.createAt', 'ASC')
      .limit(limit)
      .getRawMany();
    for (const r of rows) {
      const ageDays = Math.max(
        1,
        Math.ceil(
          (Date.now() - new Date(r.createat).getTime()) / (1000 * 60 * 60 * 24),
        ),
      );
      const trimmedAgencyName =
        typeof r.agencyname === 'string' ? r.agencyname.trim() : '';
      const responsibleAgencyName =
        trimmedAgencyName.length > 0 ? trimmedAgencyName : null;
      const originType = classifyOriginFromIdScalars(
        r.creatoramphoeid,
        r.creatorlaoid,
      );
      const responsibleAgencyDisclosure =
        r.agencyid == null && originType === 'lao-coordinated'
          ? PENDING_RESPONSIBLE_AGENCY_DISCLOSURE
          : null;
      const entry: Record<string, unknown> = {
        projectId: r.pgid,
        projectKind: 'original',
        name: r.title,
        currentStatus: r.statusname,
        statusTh: toThaiStatus(r.statusname),
        // W67-BE-AGG-01 — computed 4-group executive rollup. Eligible
        // statuses are Pending / Pending_Approval (set by
        // `eligibleStatuses` above), so the value is always a non-null
        // group (`pending_review` or `awaiting_approval`).
        executiveStatus: mapToExecutiveStatusGroup(r.statusname),
        enteredStatusAt: new Date(r.createat).toISOString(),
        ageDays,
        responsibleAgencyName,
        responsibleAgencyDisclosure,
      };
      if (r.planid) entry.planId = r.planid;
      if (r.amphoeid != null) entry.amphoeId = Number(r.amphoeid);
      if (r.agencyid != null) entry.responsibleAgencyId = Number(r.agencyid);
      assertAgencyLabelPlaceholderFree({
        responsibleAgencyName,
        responsibleAgencyDisclosure,
      });
      items.push(entry);
    }
  }

  if (
    (scope === 'all' || scope === 'revision' || scope === 'change') &&
    items.length < limit
  ) {
    const remaining = limit - items.length;
    // Wave 58 W58-BE-AGG-01 (D3 / D6) — agency-name JOIN + creator-WH
    // identity for the origin-type classifier.
    const rows: Array<{
      rpgid: string;
      title: string;
      statusname: string;
      createat: Date;
      agencyid: number | null;
      agencyname: string | null;
      creatoramphoeid: string | number | null;
      creatorlaoid: string | number | null;
    }> = await deps.dataSource
      .getRepository(TrackingStatus)
      .createQueryBuilder('ts')
      .select('rpg.id', 'rpgid')
      .addSelect('rpg.title', 'title')
      .addSelect('status.name', 'statusname')
      .addSelect('ts.createAt', 'createat')
      .addSelect('rpg.responsible_agency_id', 'agencyid')
      .addSelect('ga.name', 'agencyname')
      .addSelect('wh_amp.id', 'creatoramphoeid')
      .addSelect('wh_lao.id', 'creatorlaoid')
      .innerJoin('ts.revisedProjectGroupId', 'rpg')
      .innerJoin('ts.statusId', 'status')
      .leftJoin(GovernmentAgency, 'ga', 'ga.id = rpg.responsible_agency_id')
      .leftJoin('rpg.createdBy', 'wh')
      .leftJoin('wh.amphoe', 'wh_amp')
      .leftJoin('wh.localAdministrativeOrganization', 'wh_lao')
      .where('ts.isLatest = :latest', { latest: true })
      .andWhere('ts.deletedAt IS NULL')
      .andWhere('rpg.deletedAt IS NULL')
      .andWhere('status.name IN (:...names)', { names: eligibleStatuses })
      .andWhere('ts.createAt < :cutoff', { cutoff })
      .orderBy('ts.createAt', 'ASC')
      .limit(remaining)
      .getRawMany();
    for (const r of rows) {
      const ageDays = Math.max(
        1,
        Math.ceil(
          (Date.now() - new Date(r.createat).getTime()) / (1000 * 60 * 60 * 24),
        ),
      );
      const trimmedAgencyName =
        typeof r.agencyname === 'string' ? r.agencyname.trim() : '';
      const responsibleAgencyName =
        trimmedAgencyName.length > 0 ? trimmedAgencyName : null;
      const originType = classifyOriginFromIdScalars(
        r.creatoramphoeid,
        r.creatorlaoid,
      );
      const responsibleAgencyDisclosure =
        r.agencyid == null && originType === 'lao-coordinated'
          ? PENDING_RESPONSIBLE_AGENCY_DISCLOSURE
          : null;
      const entry: Record<string, unknown> = {
        projectId: r.rpgid,
        projectKind: 'revised',
        name: r.title,
        currentStatus: r.statusname,
        statusTh: toThaiStatus(r.statusname),
        // W67-BE-AGG-01 — computed 4-group executive rollup (eligible
        // statuses → pending_review / awaiting_approval).
        executiveStatus: mapToExecutiveStatusGroup(r.statusname),
        enteredStatusAt: new Date(r.createat).toISOString(),
        ageDays,
        responsibleAgencyName,
        responsibleAgencyDisclosure,
      };
      if (r.agencyid != null) entry.responsibleAgencyId = Number(r.agencyid);
      assertAgencyLabelPlaceholderFree({
        responsibleAgencyName,
        responsibleAgencyDisclosure,
      });
      items.push(entry);
    }
  }

  return { items, thresholdDays, asOf: nowIso() };
};

// ────────────────────────────────────────────────────────────────────
// 10. highlightBudgetOutliers
// ────────────────────────────────────────────────────────────────────

const highlightBudgetOutliers: ExecutiveToolHandler = async (
  params,
  ctx,
  deps,
) => {
  assertExecutiveRole(ctx);
  const planId = String(params.planId);
  const method = params.method === 'stddev' ? 'stddev' : 'percentile';
  const defaultThreshold = method === 'percentile' ? 0.95 : 2.0;
  const threshold =
    typeof params.threshold === 'number' && Number.isFinite(params.threshold)
      ? params.threshold
      : defaultThreshold;
  const limit = Math.min(Math.max(Number(params.limit ?? 10), 1), 30);

  type ProjectBudget = {
    projectId: string;
    projectKind: 'original' | 'revised' | 'supplement';
    name: string;
    budget: number;
  };

  // BE-W53-02 — pool candidates from three scopes (main / revised /
  // supplement).  Each is summed INDEPENDENTLY at the project level,
  // then the three arrays are UNIONed on the application side so the
  // percentile / stddev math operates on the pooled distribution per
  // task §7.3.
  // Wave 57 W57-BE-AGG-01 — HEAD-of-lineage anti-join (CLAUDE.md §14.2).
  // Outlier detection MUST score on HEAD rows only; otherwise a parent
  // PG and its derived RPG appear as two distinct candidates.
  const mainOutlierQb = deps.dataSource
    .getRepository(Budget)
    .createQueryBuilder('b')
    .select('pg.id', 'pid')
    .addSelect('pg.title', 'title')
    .addSelect('COALESCE(SUM(b.quantity), 0)', 'budget')
    .innerJoin('b.projectGroupId', 'pg')
    .where('pg.deletedAt IS NULL')
    .andWhere('pg.development_plan_id = :planId', { planId })
    .groupBy('pg.id')
    .addGroupBy('pg.title');
  applyHeadFilterForProjectGroup(mainOutlierQb, 'pg');
  const mainRawRows: Array<{
    pid: string;
    title: string;
    budget: string | null;
  }> = await mainOutlierQb.getRawMany();

  const revisedOutlierQb = deps.dataSource
    .getRepository(Budget)
    .createQueryBuilder('b')
    .select('rpg.id', 'pid')
    .addSelect('rpg.title', 'title')
    .addSelect('COALESCE(SUM(b.quantity), 0)', 'budget')
    .innerJoin('b.revisedProjectGroupId', 'rpg')
    .innerJoin('rpg.developmentPlanRevision', 'dpr')
    .where('rpg.deletedAt IS NULL')
    .andWhere('dpr.deletedAt IS NULL')
    .andWhere('dpr.development_plan_id = :planId', { planId })
    .groupBy('rpg.id')
    .addGroupBy('rpg.title');
  applyHeadFilterForRevisedProjectGroup(revisedOutlierQb, 'rpg');
  const revisedRawRows: Array<{
    pid: string;
    title: string;
    budget: string | null;
  }> = await revisedOutlierQb.getRawMany();

  const supplementRawRows: Array<{
    pid: string;
    title: string;
    budget: string | null;
  }> = await deps.dataSource
    .getRepository(Budget)
    .createQueryBuilder('b')
    .select('spg.id', 'pid')
    .addSelect('spg.title', 'title')
    .addSelect('COALESCE(SUM(b.quantity), 0)', 'budget')
    .innerJoin('b.supplementProjectGroupId', 'spg')
    .innerJoin('spg.developmentPlanSupplement', 'dps')
    .where('spg.deletedAt IS NULL')
    .andWhere('dps.deletedAt IS NULL')
    .andWhere('dps.development_plan_id = :planId', { planId })
    .groupBy('spg.id')
    .addGroupBy('spg.title')
    .getRawMany();

  const budgets: ProjectBudget[] = [
    ...mainRawRows.map((r) => ({
      projectId: r.pid,
      projectKind: 'original' as const,
      name: r.title,
      budget: Number(r.budget) || 0,
    })),
    ...revisedRawRows.map((r) => ({
      projectId: r.pid,
      projectKind: 'revised' as const,
      name: r.title,
      budget: Number(r.budget) || 0,
    })),
    ...supplementRawRows.map((r) => ({
      projectId: r.pid,
      projectKind: 'supplement' as const,
      name: r.title,
      budget: Number(r.budget) || 0,
    })),
  ].filter((r) => r.budget > 0);

  if (budgets.length === 0) {
    return {
      items: [],
      planId,
      method,
      threshold,
      asOf: nowIso(),
    };
  }

  let outliers: Array<ProjectBudget & { rank: number; reason: string }> = [];
  if (method === 'percentile') {
    const sorted = [...budgets].sort((a, b) => a.budget - b.budget);
    const cutIdx = Math.max(
      0,
      Math.min(sorted.length - 1, Math.ceil(threshold * sorted.length) - 1),
    );
    const cut = sorted[cutIdx]?.budget ?? 0;
    outliers = budgets
      .filter((b) => b.budget >= cut)
      .sort((a, b) => b.budget - a.budget)
      .slice(0, limit)
      .map((b, idx) => ({
        ...b,
        rank: idx + 1,
        reason: `อยู่ในเปอร์เซ็นไทล์ที่ ${Math.round(threshold * 100)}`,
      }));
  } else {
    const mean = budgets.reduce((sum, b) => sum + b.budget, 0) / budgets.length;
    const variance =
      budgets.reduce((sum, b) => sum + (b.budget - mean) ** 2, 0) /
      budgets.length;
    const stddev = Math.sqrt(variance);
    outliers = budgets
      .map((b) => ({
        b,
        z: stddev > 0 ? (b.budget - mean) / stddev : 0,
      }))
      .filter(({ z }) => z >= threshold)
      .sort((a, b) => b.z - a.z)
      .slice(0, limit)
      .map(({ b, z }, idx) => ({
        ...b,
        rank: idx + 1,
        reason: `สูงกว่าค่าเฉลี่ย ${z.toFixed(1)} SD`,
      }));
  }

  return {
    items: outliers.map((o) => ({
      projectId: o.projectId,
      projectKind: o.projectKind,
      name: o.name,
      budget: o.budget,
      planId,
      rank: o.rank,
      reason: o.reason,
    })),
    planId,
    method,
    threshold,
    asOf: nowIso(),
  };
};

// ────────────────────────────────────────────────────────────────────
// 11. listProjectsInPlan (BE-W48-03)
// ────────────────────────────────────────────────────────────────────

/**
 * Enumerate ProjectGroup rows bound to a given `planId`.
 *
 * Wave 48 scope: main-plan PG only. Revision / supplement enumeration
 * deferred to a follow-up wave. `scope` param is accepted for future
 * compatibility but currently clamps to `main`.
 *
 * Projection discipline — MUST NOT expose `createdBy`, `user`,
 * `firstName`, `lastName`, `citizenId`. Selects only id/title/status/
 * amphoeId/agencyId/summed budget (see §9 of BE-W48-03).
 *
 * Classification fields (strategy/tactic/plan/developmentIssue/
 * indicator) are deliberately NOT read — this is a plain roster, not a
 * classification analysis (§16.5 / §17.7 branching not needed).
 */
// BE-W49-01 — defensive UUID guard. paramsSchema already enforces
// `format: 'uuid'` at the tool-loop adapter, but if a future refactor
// reorders validation, or if a caller bypasses the adapter, the handler
// MUST still return a structured envelope instead of throwing. This
// converts the P0 outage path (bad UUID → 502 AI_SCHEMA_DRIFT → FE
// "ระบบขัดข้อง" banner) into an LLM-recoverable empty-result turn.
// §17.2 advisory preserved — NEVER gates a workflow transition.
const UUID_RX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
// Nil-UUID sentinel — required because `returnSchema.planId` is declared
// with `format: 'uuid'`; returning an empty string would re-trigger
// AI_SCHEMA_DRIFT at the return-validation gate and defeat the guard.
// The nil-UUID signals "unknown plan" to the LLM without violating the
// schema contract. The `message` field is additive (returnSchema does
// NOT set `additionalProperties: false` at root).
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

const listProjectsInPlan: ExecutiveToolHandler = async (params, ctx, deps) => {
  assertExecutiveRole(ctx);
  const planIdRaw = String(params.planId ?? '');
  if (!UUID_RX.test(planIdRaw)) {
    return {
      planId: NIL_UUID,
      items: [],
      asOf: nowIso(),
      message:
        'planId ต้องเป็น UUID ที่ได้จาก listActivePlans.items[i].planId เท่านั้น กรุณาเรียก listActivePlans ก่อน แล้วส่ง UUID ของแผนที่ตรงกัน',
    };
  }
  const planId = planIdRaw;
  const scope = String(params.scope ?? 'main');
  const overallLimit = Math.min(Math.max(Number(params.limit ?? 20), 1), 50);
  // Wave 58 W58-BE-AGG-01 (D4) — opt-in `groupBy=byRevisionRound` mode.
  // Default mode (param absent) preserves the flat `items[]` shape for
  // Wave 48–57 callers. Discriminated-union envelope: a payload either
  // emits `items[]` OR `groups[]`, never both.
  // Wave 60c — Default flip to `byBookCompleteness` forces structured
  // `groups[]` envelope shape; LLMs were dedup'ing identical-title
  // bullets across buckets when given flat `items[]`, dropping entire
  // revision rounds (e.g. เปลี่ยนแปลง 2 missing while edit-1 + change-1
  // showed). With structured groups[], the LLM iterates groups and is
  // far less likely to silently collapse one. Direct backend callers
  // (W53 contract tests) opt back into flat by passing `groupBy: 'flat'`.
  const groupByRaw =
    params.groupBy != null ? String(params.groupBy) : 'byBookCompleteness';
  const groupBy = groupByRaw === 'flat' ? '' : groupByRaw;
  const groupByRound = groupBy === 'byRevisionRound';
  // Wave 60 W60-BE-AGG-01 — opt-in book-completeness mode. Differs from
  // `byRevisionRound` in TWO ways:
  //   1. HEAD-of-lineage filter is SKIPPED (every non-soft-deleted row
  //      stays visible, including historical ones whose HEAD lives in a
  //      later revision/supplement book).
  //   2. Each row carries an `isHead` boolean computed via the same
  //      anti-join used by §14.2 — see `selectIsHeadFor*` helpers — so
  //      the LLM can disclose "(เวอร์ชันเก่า)" / "(เวอร์ชันล่าสุด)" when
  //      asked.
  // Soft-delete (`deletedAt IS NULL`) and Ready-hidden (W57 EXEC_VISIBLE_STATUSES)
  // filters continue to apply.
  const groupByBookCompleteness = groupBy === 'byBookCompleteness';

  // BE-W53-02 — scope split for `scope === 'all'`.
  // Quota: main ≤ ceil(limit*0.5), revised ≤ ceil(limit*0.3), supplement
  // ≤ remainder (non-negative).  Total items MUST never exceed the
  // requested overall limit; if an earlier scope returns fewer rows than
  // its quota, the unused budget is NOT rolled into later scopes (simpler
  // reasoning for the LLM, and matches task §7.1).
  //
  // Wave 60c (2026-04-25) — when `groupByBookCompleteness` is set the
  // user explicitly asked for ALL books in the plan. The W53 scope-split
  // quotas were dropping entire DPR buckets when their alphabetically-
  // late rows fell past the global LIMIT (e.g. "เปลี่ยนแปลง ครั้งที่ 2"
  // missing while "เปลี่ยนแปลง ครั้งที่ 1" survived). Use a generous
  // ceiling (50, the DSL hard upper bound) per scope so every book with
  // rows is represented. Default + `byRevisionRound` modes keep the W53
  // quota semantics.
  const mainQuota = groupByBookCompleteness
    ? 50
    : scope === 'main'
      ? overallLimit
      : scope === 'all'
        ? Math.ceil(overallLimit * 0.5)
        : 0;
  const revisedQuota = groupByBookCompleteness
    ? 50
    : scope === 'revised'
      ? overallLimit
      : scope === 'all'
        ? Math.ceil(overallLimit * 0.3)
        : 0;
  const supplementQuota = groupByBookCompleteness
    ? 50
    : scope === 'supplement'
      ? overallLimit
      : scope === 'all'
        ? Math.max(0, overallLimit - mainQuota - revisedQuota)
        : 0;

  const items: Array<Record<string, unknown>> = [];

  // ── Main (ProjectGroup) ──────────────────────────────────────────────
  if (mainQuota > 0) {
    // Wave 57 W57-BE-AGG-01 — HEAD-of-lineage filter (CLAUDE.md §14.2).
    // Wave 58 W58-BE-AGG-01 — LEFT JOIN GovernmentAgency for D3 / D6
    // (agency name) AND LEFT JOIN creator-WH amphoe + LAO for the
    // §5 origin-type classifier (drives the `responsibleAgencyDisclosure`
    // contract for null-FK LAO-origin rows). Pattern reference: the
    // existing `getTeamWorkloadSummary` join at line ~355 uses the same
    // `leftJoin(GovernmentAgency, 'ga', 'ga.id = pg.responsible_agency_id')`
    // shape — Wave 54 no-raw-SQL gate compatible.
    const listMainQb = deps.dataSource
      .getRepository(ProjectGroup)
      .createQueryBuilder('pg')
      .select('pg.id', 'pgid')
      .addSelect('pg.title', 'title')
      .addSelect('status.name', 'statusname')
      .addSelect('pg.amphoe_id', 'amphoeid')
      .addSelect('pg.responsible_agency_id', 'agencyid')
      .addSelect('ga.name', 'agencyname')
      .addSelect('wh_amp.id', 'creatoramphoeid')
      .addSelect('wh_lao.id', 'creatorlaoid')
      // Wave 58 W58-BE-AGG-03 (D7) — book-page surfacing.
      .addSelect('pg.pageNumber', 'pagenumber')
      // Wave 59 W59-BE-AGG-01 (D-B) — objective for "วัตถุประสงค์" Q&A.
      .addSelect('pg.objective', 'objective')
      // Wave 59 W59-BE-AGG-01 (D-C) — location triple. amphoe + LAO
      // names come from relation JOINs (entity property paths, Wave 54
      // no-raw-SQL gate); start/end lat-lng come from the row itself.
      .addSelect('pg_amp.name', 'amphoename')
      .addSelect('pg_lao.name', 'laoname')
      .addSelect('pg.startLat', 'startlat')
      .addSelect('pg.startLng', 'startlng')
      .addSelect('pg.endLat', 'endlat')
      .addSelect('pg.endLng', 'endlng')
      // Wave 62 W62-BE-AGG-02 — extended classification fields.
      .addSelect('pg.goal', 'goal')
      .addSelect('pg.expected', 'expected')
      .addSelect('pg.indicator', 'indicator')
      .addSelect('di.name', 'developmentissuename')
      .addSelect('dp.report_format', 'reportformat')
      // BE-W53-01 — eliminate hand-written plural table literal. Using
      // TypeORM correlated sub-query builder so `.from(Budget, 'b')`
      // resolves the physical table name from entity metadata
      // (`@Entity('budget')`).
      .addSelect(
        (subQb: SelectQueryBuilder<Budget>) =>
          subQb
            .select('COALESCE(SUM(b.quantity), 0)')
            .from(Budget, 'b')
            .where('b.project_group_id = pg.id'),
        'budget',
      )
      .leftJoin('pg.trackingStatus', 'ts', 'ts.isLatest = true')
      .leftJoin('ts.statusId', 'status')
      .leftJoin(GovernmentAgency, 'ga', 'ga.id = pg.responsible_agency_id')
      .leftJoin('pg.createdBy', 'wh')
      .leftJoin('wh.amphoe', 'wh_amp')
      .leftJoin('wh.localAdministrativeOrganization', 'wh_lao')
      // Wave 59 (D-C) — relation-based JOINs for project's own amphoe
      // and LAO. Distinct aliases (`pg_amp`, `pg_lao`) so they do NOT
      // collide with the existing creator-WH joins above.
      .leftJoin('pg.amphoe', 'pg_amp')
      .leftJoin('pg.localAdministrativeOrganization', 'pg_lao')
      // Wave 62 W62-BE-AGG-02 — developmentIssue (LEFT JOIN, soft-delete
      // filter per §16.6) and developmentPlan (LEFT JOIN; reportFormat
      // lookup for §17.7 branching).
      .leftJoin('pg.developmentIssue', 'di', 'di.deletedAt IS NULL')
      .leftJoin('pg.developmentPlan', 'dp')
      .where('pg.deletedAt IS NULL')
      .andWhere('pg.development_plan_id = :planId', { planId })
      // W60c (2026-04-25) — sort by pageNumber asc nulls last, then
      // title for stable ordering. Per user preference: executive
      // expects book-page reading order.
      .orderBy('pg.pageNumber', 'ASC', 'NULLS LAST')
      .addOrderBy('pg.title', 'ASC')
      .limit(mainQuota);
    if (groupByBookCompleteness) {
      // Wave 60 W60-BE-AGG-01 — book-completeness mode keeps historical
      // rows visible. HEAD filter is SKIPPED; instead `isHead` is
      // projected per row via the `selectIsHeadForProjectGroup` helper
      // (same anti-join, materialized as a boolean instead of a WHERE).
      // Ready remains hidden by default per §17.2 EXEC_VISIBLE_STATUSES.
      selectIsHeadForProjectGroup(listMainQb, 'pg');
      listMainQb.andWhere('status.name IN (:...visibleStatuses)', {
        visibleStatuses: [...EXEC_VISIBLE_STATUSES],
      });
    } else {
      applyHeadFilterForProjectGroup(listMainQb, 'pg');
    }
    const rows: Array<{
      pgid: string;
      title: string;
      statusname: string | null;
      amphoeid: number | null;
      agencyid: number | null;
      agencyname: string | null;
      creatoramphoeid: string | number | null;
      creatorlaoid: string | number | null;
      budget: string | null;
      pagenumber: number | null;
      objective: string | null;
      amphoename: string | null;
      laoname: string | null;
      startlat: number | string | null;
      startlng: number | string | null;
      endlat: number | string | null;
      endlng: number | string | null;
      goal: string | null;
      expected: string | null;
      indicator: string | null;
      developmentissuename: string | null;
      reportformat: string | null;
      ishead?: boolean | string | number | null;
    }> = await listMainQb.getRawMany();

    for (const r of rows) {
      const entry = buildProjectEntry({
        projectId: r.pgid,
        projectKind: 'original',
        title: r.title,
        statusname: r.statusname,
        planId,
        budget: r.budget,
        amphoeId: r.amphoeid,
        agencyId: r.agencyid,
        agencyName: r.agencyname,
        creatorAmphoeId: r.creatoramphoeid,
        creatorLaoId: r.creatorlaoid,
        revisionRoundType: 'main',
        revisionRoundId: null,
        revisionNumber: null,
        revisionDescription: null,
        pageNumber: r.pagenumber,
        objectiveRaw: r.objective,
        amphoeName: r.amphoename,
        laoName: r.laoname,
        startLat: r.startlat,
        startLng: r.startlng,
        endLat: r.endlat,
        endLng: r.endlng,
        goalRaw: r.goal,
        expectedRaw: r.expected,
        indicatorRaw: r.indicator,
        developmentIssueLabel: r.developmentissuename,
        reportFormat: coerceReportFormat(r.reportformat),
        // Wave 60 — only emit `isHead` under book-completeness mode.
        // Default / `byRevisionRound` modes apply HEAD filter so every
        // surviving row is HEAD by construction; the field is omitted
        // there to keep the existing flat-mode envelope contract intact.
        isHead: groupByBookCompleteness ? coerceBoolean(r.ishead) : undefined,
      });
      items.push(entry);
    }
  }

  // ── Revised (RevisedProjectGroup) ────────────────────────────────────
  const remainingAfterMain = overallLimit - items.length;
  const revisedBudget = Math.min(revisedQuota, Math.max(0, remainingAfterMain));
  if (revisedBudget > 0) {
    // Wave 57 W57-BE-AGG-01 — HEAD-of-lineage filter (CLAUDE.md §14.2).
    // Wave 58 W58-BE-AGG-01 (D3 / D4 / D6) — JOIN GovernmentAgency for
    // the responsibleAgency name and project DPR `description` +
    // `id` so the round-grouping discriminator is explicit instead of
    // collapsing edit and change rounds into a single LLM-synthesized
    // heading.
    const listRevQb = deps.dataSource
      .getRepository(RevisedProjectGroup)
      .createQueryBuilder('rpg')
      .select('rpg.id', 'rpgid')
      .addSelect('rpg.title', 'title')
      .addSelect('status.name', 'statusname')
      .addSelect('rpg.amphoe_id', 'amphoeid')
      .addSelect('rpg.responsible_agency_id', 'agencyid')
      .addSelect('ga.name', 'agencyname')
      .addSelect('wh_amp.id', 'creatoramphoeid')
      .addSelect('wh_lao.id', 'creatorlaoid')
      .addSelect('dpr.id', 'dprid')
      .addSelect('dpr.revision_number', 'revisionnumber')
      .addSelect('dpr.description', 'dprdescription')
      .addSelect('rt.name', 'revisiontypename')
      // Wave 58 W58-BE-AGG-03 (D7) — book-page surfacing.
      .addSelect('rpg.pageNumber', 'pagenumber')
      // Wave 59 W59-BE-AGG-01 (D-B / D-C) — objective + location triple.
      .addSelect('rpg.objective', 'objective')
      .addSelect('rpg_amp.name', 'amphoename')
      .addSelect('rpg_lao.name', 'laoname')
      .addSelect('rpg.startLat', 'startlat')
      .addSelect('rpg.startLng', 'startlng')
      .addSelect('rpg.endLat', 'endlat')
      .addSelect('rpg.endLng', 'endlng')
      // Wave 62 W62-BE-AGG-02 — extended classification fields. RPG has
      // a direct `developmentPlan` relation; JOIN it for reportFormat.
      .addSelect('rpg.goal', 'goal')
      .addSelect('rpg.expected', 'expected')
      .addSelect('rpg.indicator', 'indicator')
      .addSelect('di.name', 'developmentissuename')
      .addSelect('dp.report_format', 'reportformat')
      .addSelect(
        (subQb: SelectQueryBuilder<Budget>) =>
          subQb
            .select('COALESCE(SUM(b.quantity), 0)')
            .from(Budget, 'b')
            .where('b.revised_project_group_id = rpg.id'),
        'budget',
      )
      .innerJoin('rpg.developmentPlanRevision', 'dpr')
      .leftJoin('dpr.revisionType', 'rt')
      .leftJoin('rpg.trackingStatus', 'ts', 'ts.isLatest = true')
      .leftJoin('ts.statusId', 'status')
      .leftJoin(GovernmentAgency, 'ga', 'ga.id = rpg.responsible_agency_id')
      .leftJoin('rpg.createdBy', 'wh')
      .leftJoin('wh.amphoe', 'wh_amp')
      .leftJoin('wh.localAdministrativeOrganization', 'wh_lao')
      // Wave 59 (D-C) — project's own amphoe + LAO via relation paths.
      .leftJoin('rpg.amphoe', 'rpg_amp')
      .leftJoin('rpg.localAdministrativeOrganization', 'rpg_lao')
      // Wave 62 W62-BE-AGG-02 — developmentIssue (LEFT JOIN, soft-delete
      // filter per §16.6) and developmentPlan (LEFT JOIN; reportFormat).
      .leftJoin('rpg.developmentIssue', 'di', 'di.deletedAt IS NULL')
      .leftJoin('rpg.developmentPlan', 'dp')
      .where('rpg.deletedAt IS NULL')
      .andWhere('dpr.deletedAt IS NULL')
      .andWhere('dpr.development_plan_id = :planId', { planId })
      // W60c — sort by pageNumber asc nulls last, then title.
      .orderBy('rpg.pageNumber', 'ASC', 'NULLS LAST')
      .addOrderBy('rpg.title', 'ASC')
      .limit(revisedBudget);
    if (groupByBookCompleteness) {
      // Wave 60 W60-BE-AGG-01 — same opt-in. Skip HEAD filter, project
      // `isHead`, hide Ready.
      selectIsHeadForRevisedProjectGroup(listRevQb, 'rpg');
      listRevQb.andWhere('status.name IN (:...visibleStatuses)', {
        visibleStatuses: [...EXEC_VISIBLE_STATUSES],
      });
    } else {
      applyHeadFilterForRevisedProjectGroup(listRevQb, 'rpg');
    }
    const rows: Array<{
      rpgid: string;
      title: string;
      statusname: string | null;
      amphoeid: number | null;
      agencyid: number | null;
      agencyname: string | null;
      creatoramphoeid: string | number | null;
      creatorlaoid: string | number | null;
      dprid: string | null;
      revisionnumber: number | null;
      dprdescription: string | null;
      revisiontypename: string | null;
      budget: string | null;
      pagenumber: number | null;
      objective: string | null;
      amphoename: string | null;
      laoname: string | null;
      startlat: number | string | null;
      startlng: number | string | null;
      endlat: number | string | null;
      endlng: number | string | null;
      goal: string | null;
      expected: string | null;
      indicator: string | null;
      developmentissuename: string | null;
      reportformat: string | null;
      ishead?: boolean | string | number | null;
    }> = await listRevQb.getRawMany();

    for (const r of rows) {
      // Wave 58 — `RevisionType.name` carries the Thai discriminator
      // ("แก้ไข" / "เปลี่ยนแปลง") sourced from the lookup table. Map it
      // to the canonical `RevisionRoundType` enum so the LLM-facing
      // discriminator is stable English. Unknown values fall back to
      // `'edit'` to keep the bucket distinguishable from `change`.
      const rtName = (r.revisiontypename ?? '').trim();
      const roundType: RevisionRoundType =
        rtName === 'เปลี่ยนแปลง' || rtName.toLowerCase() === 'change'
          ? 'change'
          : 'edit';
      const entry = buildProjectEntry({
        projectId: r.rpgid,
        projectKind: 'revised',
        title: r.title,
        statusname: r.statusname,
        planId,
        budget: r.budget,
        amphoeId: r.amphoeid,
        agencyId: r.agencyid,
        agencyName: r.agencyname,
        creatorAmphoeId: r.creatoramphoeid,
        creatorLaoId: r.creatorlaoid,
        revisionRoundType: roundType,
        revisionRoundId: r.dprid,
        revisionNumber: r.revisionnumber,
        revisionDescription: r.dprdescription,
        revisionTypeName: r.revisiontypename,
        pageNumber: r.pagenumber,
        objectiveRaw: r.objective,
        amphoeName: r.amphoename,
        laoName: r.laoname,
        startLat: r.startlat,
        startLng: r.startlng,
        endLat: r.endlat,
        endLng: r.endlng,
        goalRaw: r.goal,
        expectedRaw: r.expected,
        indicatorRaw: r.indicator,
        developmentIssueLabel: r.developmentissuename,
        reportFormat: coerceReportFormat(r.reportformat),
        // Wave 60 — RPG isHead from CASE-WHEN projection. Defaults to
        // true under non-book-completeness modes (HEAD filter already
        // ran), undefined to omit the key.
        isHead: groupByBookCompleteness ? coerceBoolean(r.ishead) : undefined,
      });
      items.push(entry);
    }
  }

  // ── Supplement (SupplementProjectGroup) ──────────────────────────────
  const remainingAfterRevised = overallLimit - items.length;
  const supplementBudget = Math.min(
    supplementQuota,
    Math.max(0, remainingAfterRevised),
  );
  if (supplementBudget > 0) {
    // SPG has no `amphoe_id` column (see supplement-project-group.entity.ts);
    // omit that field in the projection.  `responsible_agency_id` IS present.
    // Wave 58 W58-BE-AGG-01 (D3 / D4) — JOIN GovernmentAgency for the
    // responsibleAgency name and project DPS `description` / `id` for
    // the supplement-round bucket discriminator.
    const spgQb = deps.dataSource
      .getRepository(SupplementProjectGroup)
      .createQueryBuilder('spg')
      .select('spg.id', 'spgid')
      .addSelect('spg.title', 'title')
      .addSelect('status.name', 'statusname')
      .addSelect('spg.responsible_agency_id', 'agencyid')
      .addSelect('ga.name', 'agencyname')
      .addSelect('wh_amp.id', 'creatoramphoeid')
      .addSelect('wh_lao.id', 'creatorlaoid')
      .addSelect('dps.id', 'dpsid')
      .addSelect('dps.supplement_number', 'supplementnumber')
      .addSelect('dps.description', 'dpsdescription')
      // Wave 58 W58-BE-AGG-03 (D7) — book-page surfacing. SPG.pageNumber
      // ships in the same wave (W58-DB-01); when both PRs merge, the
      // column exists and the projection is honored.
      .addSelect('spg.pageNumber', 'pagenumber')
      // Wave 59 W59-BE-AGG-01 (D-B / D-C) — objective + location triple.
      // SPG carries `amphoe` (W55-DB-01) but does NOT have a
      // `localAdministrativeOrganization` relation — the LAO link on SPG
      // is `originAgencyId` (the LAO that originated the project, per
      // §5.2). The location triple's `laoName` therefore reads from the
      // origin-LAO join here so the envelope semantics remain "the LAO
      // that owns this project", consistent with PG / RPG.
      .addSelect('spg.objective', 'objective')
      .addSelect('spg_amp.name', 'amphoename')
      .addSelect('spg_lao.name', 'laoname')
      .addSelect('spg.startLat', 'startlat')
      .addSelect('spg.startLng', 'startlng')
      .addSelect('spg.endLat', 'endlat')
      .addSelect('spg.endLng', 'endlng')
      // Wave 62 W62-BE-AGG-02 — extended classification fields. SPG has
      // no direct `developmentPlan` relation; reportFormat is JOINed
      // through `developmentPlanSupplement.developmentPlan`.
      .addSelect('spg.goal', 'goal')
      .addSelect('spg.expected', 'expected')
      .addSelect('spg.indicator', 'indicator')
      .addSelect('di.name', 'developmentissuename')
      .addSelect('dp.report_format', 'reportformat')
      .addSelect(
        (subQb: SelectQueryBuilder<Budget>) =>
          subQb
            .select('COALESCE(SUM(b.quantity), 0)')
            .from(Budget, 'b')
            .where('b.supplement_project_group_id = spg.id'),
        'budget',
      )
      .innerJoin('spg.developmentPlanSupplement', 'dps')
      .leftJoin('spg.trackingStatus', 'ts', 'ts.isLatest = true')
      .leftJoin('ts.statusId', 'status')
      .leftJoin(GovernmentAgency, 'ga', 'ga.id = spg.responsible_agency_id')
      .leftJoin('spg.createdBy', 'wh')
      .leftJoin('wh.amphoe', 'wh_amp')
      .leftJoin('wh.localAdministrativeOrganization', 'wh_lao')
      // Wave 59 (D-C) — project's own amphoe + origin LAO.
      .leftJoin('spg.amphoe', 'spg_amp')
      .leftJoin('spg.originAgencyId', 'spg_lao')
      // Wave 62 W62-BE-AGG-02 — developmentIssue (LEFT JOIN, soft-delete
      // filter per §16.6) and dps.developmentPlan (LEFT JOIN; reportFormat).
      .leftJoin('spg.developmentIssue', 'di', 'di.deletedAt IS NULL')
      .leftJoin('dps.developmentPlan', 'dp')
      .where('spg.deletedAt IS NULL')
      .andWhere('dps.deletedAt IS NULL')
      .andWhere('dps.development_plan_id = :planId', { planId });
    if (groupByBookCompleteness) {
      // Wave 60 — Ready hidden under EXEC_VISIBLE_STATUSES. SPG has no
      // descendant in the §14.1 lineage model (RPG.prev_project_type is
      // 'original' | 'revised' only), so every SPG row is HEAD by
      // construction; no JOIN needed.
      spgQb.andWhere('status.name IN (:...visibleStatuses)', {
        visibleStatuses: [...EXEC_VISIBLE_STATUSES],
      });
    }
    const rows: Array<{
      spgid: string;
      title: string;
      statusname: string | null;
      agencyid: number | null;
      agencyname: string | null;
      creatoramphoeid: string | number | null;
      creatorlaoid: string | number | null;
      dpsid: string | null;
      supplementnumber: number | null;
      dpsdescription: string | null;
      budget: string | null;
      pagenumber: number | null;
      objective: string | null;
      amphoename: string | null;
      laoname: string | null;
      startlat: number | string | null;
      startlng: number | string | null;
      endlat: number | string | null;
      endlng: number | string | null;
      goal: string | null;
      expected: string | null;
      indicator: string | null;
      developmentissuename: string | null;
      reportformat: string | null;
    }> = await spgQb
      // W60c — sort by pageNumber (SPG was added in W58-DB-01).
      .orderBy('spg.pageNumber', 'ASC', 'NULLS LAST')
      .addOrderBy('spg.title', 'ASC')
      .limit(supplementBudget)
      .getRawMany();

    for (const r of rows) {
      const entry = buildProjectEntry({
        projectId: r.spgid,
        projectKind: 'supplement',
        title: r.title,
        statusname: r.statusname,
        planId,
        budget: r.budget,
        amphoeId: null,
        agencyId: r.agencyid,
        agencyName: r.agencyname,
        creatorAmphoeId: r.creatoramphoeid,
        creatorLaoId: r.creatorlaoid,
        revisionRoundType: 'supplement',
        revisionRoundId: r.dpsid,
        revisionNumber: r.supplementnumber,
        revisionDescription: r.dpsdescription,
        supplementNumber: r.supplementnumber,
        pageNumber: r.pagenumber,
        objectiveRaw: r.objective,
        amphoeName: r.amphoename,
        laoName: r.laoname,
        startLat: r.startlat,
        startLng: r.startlng,
        endLat: r.endlat,
        endLng: r.endlng,
        goalRaw: r.goal,
        expectedRaw: r.expected,
        indicatorRaw: r.indicator,
        developmentIssueLabel: r.developmentissuename,
        reportFormat: coerceReportFormat(r.reportformat),
        // Wave 60 — SPG is always HEAD per §14.1. Emit `true` under
        // book-completeness mode; omit under default / byRevisionRound.
        isHead: groupByBookCompleteness ? true : undefined,
      });
      items.push(entry);
    }
  }

  // Wave 58 W58-BE-AGG-01 (D4) — discriminated-union envelope. When the
  // caller requested `groupBy=byRevisionRound`, repackage `items[]` into
  // `groups[]` keyed by `(revisionRoundType, revisionRoundId)` so revised
  // and change rounds are NEVER co-mingled and a multi-round fork chain
  // remains distinguishable. Default mode (groupBy unset) returns the
  // flat `items[]` shape unchanged for backward compatibility with all
  // Wave 48–57 callers.
  if (groupByRound) {
    return {
      planId,
      groups: groupItemsByRevisionRound(items),
      asOf: nowIso(),
    };
  }

  // Wave 60 W60-BE-AGG-01 — book-completeness mode. Same `groups[]`
  // discriminated-union shape as `byRevisionRound` (§17.9 — single
  // schema branch reused), but partitioned by BOOK identity instead of
  // by revision-round identity:
  //   - PG rows → ONE main bucket (revisionRoundId=null).
  //   - RPG rows → bucket per `developmentPlanRevisionId` (one per DPR).
  //   - SPG rows → bucket per `developmentPlanSupplementId` (one per DPS).
  // Each row carries `isHead: boolean` projected via `selectIsHeadFor*`
  // so the LLM can disclose lineage state without a second tool call.
  if (groupByBookCompleteness) {
    const groups = groupItemsByBookCompleteness(items);
    // W60c (2026-04-25) — server-rendered markdown body. The LLM was
    // dropping entire buckets when project titles repeated byte-for-byte
    // across revision rounds (e.g. "เปลี่ยนแปลง 2" missing while
    // "เปลี่ยนแปลง 1" + "แก้ไข 1" rendered). Confirmed via debug log:
    // handler returned all 4 groups; LLM truncated to 3. Prompt rules
    // alone (#27c, #30) are insufficient — the LLM treats identical
    // bullet text as redundant. Solution: pre-render the answer body
    // server-side and instruct the LLM to emit verbatim (rule #32).
    // W68-FIX-05 (2026-04-28) — D2 verbose-fields gate. Per prompt
    // rule #30 the five verbose lines (วัตถุประสงค์ / เป้าหมาย /
    // ผลที่คาดว่าจะได้รับ / ตัวชี้วัด / ประเด็นการพัฒนา) MUST be opt-in via
    // trigger words. The LLM forwards the trigger detection by setting
    // `verbose: true` on this tool call; default (absent / false) keeps
    // the core-fields-only render and appends the Q4 hint footer.
    const verbose = params.verbose === true;
    const renderedMarkdown = renderBookCompletenessMarkdown(groups, {
      verbose,
    });
    // W60c (2026-04-25 — round 4) — REMOVE `groups[]` from the envelope
    // when `renderedMarkdown` is present. Earlier rounds kept `groups[]`
    // alongside `renderedMarkdown` and the LLM stubbornly ignored the
    // markdown and dedup-rendered the structured data, dropping
    // change-r2 (debug log confirmed handler returned all 4 groups).
    // Removing the structured payload leaves the LLM with NO source
    // to dedup from — only the pre-rendered markdown.
    // Group metadata is preserved as a thin `groupSummary` (label +
    // count only, no row data) for downstream consumers that need a
    // structural pointer (e.g. UI envelope-banner, advisories layer).
    return {
      planId,
      renderedMarkdown,
      groupSummary: groups.map((g) => ({
        revisionRoundType: g.revisionRoundType,
        revisionRoundId: g.revisionRoundId,
        revisionRoundLabel: g.revisionRoundLabel,
        projectCount: g.projects.length,
      })),
      asOf: nowIso(),
    };
  }

  return {
    planId,
    items,
    asOf: nowIso(),
  };
};

/**
 * W60c — Server-side markdown rendering for `byBookCompleteness` mode.
 *
 * Returns a deterministic, pre-formatted body the LLM is instructed to
 * emit verbatim (per prompt rule #32). This bypasses the LLM's tendency
 * to dedup identical-title bullets across distinct revision rounds.
 *
 * Format per spec (user direction 2026-04-25):
 *   ### <revisionRoundLabel>
 *   1. **<title>**
 *      - สถานะ: ...
 *      - หน่วยงานรับผิดชอบ: ...
 *      - งบประมาณ: x,xxx,xxx บาท
 *      - หน้า: N
 *
 * W68-FIX-05 (2026-04-28) — D2 verbose-fields gate. Prompt rule #30
 * says วัตถุประสงค์ / เป้าหมาย / ผลที่คาดว่าจะได้รับ / ตัวชี้วัด /
 * ประเด็นการพัฒนา MUST be opt-in via trigger words. Pre-FIX-05 the
 * handler unconditionally emitted those rows whenever the envelope
 * carried them — overriding rule #30 because rule #32 instructs the
 * LLM to emit `renderedMarkdown` verbatim. The `verbose` option here
 * is the canonical gate: the tool param `listProjectsInPlan.verbose`
 * (default false) propagates to this function. When false, the five
 * verbose lines are suppressed and a discreet hint footer is appended
 * (Q4) so the user knows how to opt in. When true, full verbose
 * render is produced WITHOUT the hint footer.
 */
// W68-FIX-05 (2026-04-28) — exported as the canonical hint copy so
// tests + future surfaces never drift on the wording. Italic markdown
// is intentional (low-key UX hint, not load-bearing data). Copy is
// fixed (W66 anti-prose-translation lock — not LLM-generated).
export const VERBOSE_MODE_HINT_FOOTER =
  '_(แสดงเฉพาะคอลัมน์หลัก — ขอ "พร้อมรายละเอียด" เพื่อดูทุกคอลัมน์)_';

// W68-FIX-05 (2026-04-28) — exported for unit testing the verbose
// gate. Production callers continue to use the function via the
// `listProjectsInPlan` handler. §17.2 advisory-only — pure render.
export function renderBookCompletenessMarkdown(
  groups: GroupedProjectRound[],
  options: { verbose: boolean } = { verbose: false },
): string {
  const verbose = options.verbose === true;
  const lines: string[] = [];
  for (const g of groups) {
    if (g.projects.length === 0) continue;
    lines.push(`### ${g.revisionRoundLabel}`);
    lines.push('');
    g.projects.forEach((p, idx) => {
      const item = p;
      const title = String(item.name ?? '');
      const status = String(item.statusTh ?? item.currentStatus ?? '');
      const agencyName =
        (typeof item.responsibleAgencyName === 'string' &&
          item.responsibleAgencyName) ||
        (typeof item.responsibleAgencyDisclosure === 'string' &&
          item.responsibleAgencyDisclosure) ||
        '';
      const budgetVal =
        typeof item.budget === 'number'
          ? Number(item.budget).toLocaleString('en-US')
          : '';
      const pageNum =
        typeof item.pageNumber === 'number' ? item.pageNumber : null;

      lines.push(`${idx + 1}. **${title}**`);
      if (status) lines.push(`   - สถานะ: ${status}`);
      if (agencyName) lines.push(`   - หน่วยงานรับผิดชอบ: ${agencyName}`);
      if (budgetVal) lines.push(`   - งบประมาณ: ${budgetVal} บาท`);
      if (pageNum != null) lines.push(`   - หน้า: ${pageNum}`);

      // W68-FIX-05 (2026-04-28) — verbose-only fields. Wave 65 had
      // these unconditional. Per CLAUDE.md §17.2 advisory-only the
      // gate is display-only. §16.5 / §17.7 — `indicator` and
      // `developmentIssueLabel` are mutually exclusive per row,
      // enforced defensively in `buildProjectEntry()` (one is null,
      // the other is populated based on the parent plan's
      // `reportFormat`). Numbered long-text fields are routed through
      // `formatNumberedListMarkdown()` so inline runs ("1. xxx 2.
      // yyy") render as nested ordered lists under the bullet label.
      if (verbose) {
        const objectiveStr =
          typeof item.objective === 'string' ? item.objective : '';
        const goalStr = typeof item.goal === 'string' ? item.goal : '';
        const expectedStr =
          typeof item.expected === 'string' ? item.expected : '';
        const indicatorStr =
          typeof item.indicator === 'string' ? item.indicator : '';
        const developmentIssueLabelStr =
          typeof item.developmentIssueLabel === 'string'
            ? item.developmentIssueLabel
            : '';

        if (objectiveStr) {
          lines.push(
            `   - วัตถุประสงค์: ${formatNumberedListMarkdown(objectiveStr) ?? ''}`,
          );
        }
        if (goalStr) {
          lines.push(
            `   - เป้าหมาย: ${formatNumberedListMarkdown(goalStr) ?? ''}`,
          );
        }
        if (expectedStr) {
          lines.push(
            `   - ผลที่คาดว่าจะได้รับ: ${formatNumberedListMarkdown(expectedStr) ?? ''}`,
          );
        }
        if (indicatorStr) {
          // STRATEGY_BASED only — `buildProjectEntry()` already nulls
          // this out for ISSUE_BASED rows per §16.5.
          lines.push(
            `   - ตัวชี้วัด: ${formatNumberedListMarkdown(indicatorStr) ?? ''}`,
          );
        }
        if (developmentIssueLabelStr) {
          // ISSUE_BASED only — `buildProjectEntry()` already nulls
          // this out for STRATEGY_BASED rows per §16.5. Short label,
          // no numbered-list normalization needed.
          lines.push(`   - ประเด็นการพัฒนา: ${developmentIssueLabelStr}`);
        }
      }

      lines.push('');
    });
  }
  // W68-FIX-05 (2026-04-28) — Q4: discreet verbose-mode hint footer.
  // Only appended in default (non-verbose) mode. Italic markdown is
  // intentional (low-key UX hint, not load-bearing data). Copy is
  // fixed (W66 anti-prose-translation lock — not LLM-generated).
  let body = lines.join('\n').trimEnd();
  if (!verbose && body.length > 0) {
    body = `${body}\n\n${VERBOSE_MODE_HINT_FOOTER}`;
  }
  return body;
}

// Wave 60 — defensive boolean coerce. TypeORM raw mode returns Postgres
// `boolean` columns as-is in node-postgres but some drivers / mocks
// return `'t' | 'f'` strings or `1 | 0` integers. Treat anything truthy
// (other than 'f' / 'false') as true; null / undefined → false.
function coerceBoolean(v: unknown): boolean {
  if (v === true) return true;
  if (v === false || v == null) return false;
  if (typeof v === 'string') {
    const lc = v.toLowerCase();
    if (lc === 'f' || lc === 'false' || lc === '0' || lc === '') return false;
    return true;
  }
  if (typeof v === 'number') return v !== 0;
  return Boolean(v);
}

// ────────────────────────────────────────────────────────────────────
// Wave 58 W58-BE-AGG-01 — project-row envelope shaper.
//
// Centralizes the new fields introduced for D3 (responsibleAgencyName),
// D4 (revisionRound{Label,Type,Id}), and D6 (`responsibleAgencyDisclosure`
// for null-FK LAO-origin projects). Used by every project-row aggregator
// in the registry so the contract is uniform.
//
// §17.9 — placeholder defense via `assertAgencyLabelPlaceholderFree`.
// Throws if the projection accidentally yields a forbidden synthesized
// label (`"หน่วยงานที่ N"` / `"agency #N"`); the exception code is
// `PROJECT_ENVELOPE_AGENCY_PLACEHOLDER`.
// ────────────────────────────────────────────────────────────────────

interface BuildProjectEntryArgs {
  projectId: string;
  projectKind: 'original' | 'revised' | 'supplement';
  title: string | null;
  statusname: string | null;
  // W60c (2026-04-25 — round 5): widened to nullable. The enriched
  // `searchProjectsByKeyword` envelope passes null for revised/supplement
  // rows when no plan filter is applied (planId is unknown until
  // joined via DPR/DPS). `buildProjectEntry` already coerces this for
  // omit-on-null rendering.
  planId: string | null;
  budget: string | null;
  amphoeId: number | null;
  agencyId: number | null;
  agencyName: string | null;
  creatorAmphoeId: string | number | null | undefined;
  creatorLaoId: string | number | null | undefined;
  revisionRoundType: RevisionRoundType;
  revisionRoundId: string | null;
  revisionNumber: number | null;
  revisionDescription: string | null;
  revisionTypeName?: string | null;
  supplementNumber?: number | null;
  // Wave 58 W58-BE-AGG-03 (D7) — book-page projection. PG / RPG carry
  // their own `pageNumber` column; SPG also has one (W58-DB-01). The
  // value is `int nullable`: populated only when the book has been
  // compiled (`isBooked=true`), null otherwise.
  pageNumber?: number | null;
  // Wave 59 W59-BE-AGG-01 (D-B) — raw `objective` straight from the
  // entity column. Truncation happens inside `buildProjectEntry()` via
  // `truncateObjective()`, NEVER at the call-site, so the 500-char cap
  // is uniformly enforced across PG / RPG / SPG paths.
  objectiveRaw?: string | null;
  // Wave 59 W59-BE-AGG-01 (D-C) — location triple. `amphoeName` /
  // `laoName` are JOIN-projected; `startLat / startLng / endLat / endLng`
  // come from the project row itself. Each pair (start / end) collapses
  // to null when EITHER lat or lng is null; the parent `geoCoordinates`
  // collapses to null only when BOTH pairs are null.
  amphoeName?: string | null;
  laoName?: string | null;
  startLat?: number | string | null;
  startLng?: number | string | null;
  endLat?: number | string | null;
  endLng?: number | string | null;
  // Wave 60 W60-BE-AGG-01 — HEAD-of-lineage disclosure for book-
  // completeness mode. `undefined` → key omitted (default and
  // `byRevisionRound` modes already filter to HEAD); `boolean` → emit
  // verbatim. SPG rows always pass `true` (no descendants per §14.1).
  isHead?: boolean | undefined;
  // Wave 62 W62-BE-AGG-01 — extended classification fields. The
  // envelope now exposes `goal`, `expected`, plus a format-branched
  // pair (`indicator` for STRATEGY_BASED rows, `developmentIssueLabel`
  // for ISSUE_BASED rows) per CLAUDE.md §16.5 / §17.7. The handler
  // enforces the §16.5 invariant defensively even if the row column
  // would yield a stale value (e.g. legacy data drift).
  //
  // - `goalRaw` / `expectedRaw` — raw text columns; truncated at 500
  //   chars via `truncateObjective()` (reused for the same 500-char
  //   §17.9 cap).
  // - `indicatorRaw` — short label; populated only when STRATEGY_BASED.
  //   Coerced to null on ISSUE_BASED rows even if the column carries
  //   data.
  // - `developmentIssueLabel` — JOIN-projected `development_issues.name`;
  //   populated only when ISSUE_BASED. Coerced to null on STRATEGY_BASED
  //   rows.
  // - `reportFormat` — resolved parent-plan format. Drives the §17.7
  //   branching. `undefined` is tolerated (legacy data / missing parent
  //   plan); both `indicator` and `developmentIssueLabel` collapse to
  //   null in that case.
  goalRaw?: string | null;
  expectedRaw?: string | null;
  indicatorRaw?: string | null;
  developmentIssueLabel?: string | null;
  reportFormat?: 'STRATEGY_BASED' | 'ISSUE_BASED' | null | undefined;
}

/**
 * Wave 59 W59-BE-AGG-01 (D-C) — geoCoordinates composer.
 *
 * Coerces a (lat, lng) pair to either `{lat, lng}` (both finite numbers)
 * or `null` (either missing). Composes the start + end pairs into the
 * envelope-level `geoCoordinates`, returning `null` ONLY when BOTH pairs
 * are absent. A single-point project (start set, end null) keeps the
 * parent object non-null with `end: null`.
 */
/**
 * Wave 62 W62-BE-AGG-02 — `reportFormat` raw-row coercion.
 *
 * The TypeORM raw mode (`getRawMany`) returns `dp.report_format` as a
 * string (column type is varchar). Coerce the unknown raw shape into the
 * narrow `'STRATEGY_BASED' | 'ISSUE_BASED' | null` union expected by
 * `BuildProjectEntryArgs.reportFormat`. Unknown values (legacy data,
 * missing parent plan) fall through to `null`, in which case the
 * envelope collapses both `indicator` and `developmentIssueLabel` to
 * null per §17.7 defensive branching.
 */
function coerceReportFormat(
  raw: unknown,
): 'STRATEGY_BASED' | 'ISSUE_BASED' | null {
  if (raw === 'STRATEGY_BASED' || raw === 'ISSUE_BASED') return raw;
  return null;
}

function coerceLatLng(
  lat: number | string | null | undefined,
  lng: number | string | null | undefined,
): { lat: number; lng: number } | null {
  if (lat == null || lng == null) return null;
  const latNum = typeof lat === 'number' ? lat : Number(lat);
  const lngNum = typeof lng === 'number' ? lng : Number(lng);
  if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) return null;
  return { lat: latNum, lng: lngNum };
}

function composeGeoCoordinates(
  startLat: number | string | null | undefined,
  startLng: number | string | null | undefined,
  endLat: number | string | null | undefined,
  endLng: number | string | null | undefined,
): {
  start: { lat: number; lng: number } | null;
  end: { lat: number; lng: number } | null;
} | null {
  const start = coerceLatLng(startLat, startLng);
  const end = coerceLatLng(endLat, endLng);
  if (start == null && end == null) return null;
  return { start, end };
}

function buildProjectEntry(
  args: BuildProjectEntryArgs,
): Record<string, unknown> {
  const trimmedAgencyName =
    typeof args.agencyName === 'string' ? args.agencyName.trim() : '';
  const responsibleAgencyName =
    trimmedAgencyName.length > 0 ? trimmedAgencyName : null;
  const originType = classifyOriginFromIdScalars(
    args.creatorAmphoeId,
    args.creatorLaoId,
  );
  // Wave 58 D6 — disclosure copy is set ONLY when the FK is null AND the
  // creator's WorkHistory classifies the project as `lao-coordinated`
  // (per §5.2 — only LAO-origin projects legitimately have a null FK
  // pre-assignment). Agency-origin rows must NEVER carry a disclosure.
  const responsibleAgencyDisclosure =
    args.agencyId == null && originType === 'lao-coordinated'
      ? PENDING_RESPONSIBLE_AGENCY_DISCLOSURE
      : null;

  const revisionRoundLabel = resolveRevisionRoundLabel({
    type: args.revisionRoundType,
    number: args.revisionNumber,
    description: args.revisionDescription,
  });

  // Wave 58 W58-BE-AGG-03 (D7) — pageNumber surfacing. Always emit the
  // key (presence enforced by the schema, null permitted at runtime via
  // the W58-BE-AGG-02 nullable-via-required-only convention).
  const pageNumber =
    typeof args.pageNumber === 'number' && Number.isFinite(args.pageNumber)
      ? Number(args.pageNumber)
      : null;

  // Wave 59 W59-BE-AGG-01 (D-B) — objective truncated at the source.
  // §17.9 prompt-injection defense — bound the free-form text size BEFORE
  // it is folded into the `<<<TOOL_RESULT>>>` envelope.
  //
  // Wave 63 W63-BE-AGG-01 (RC-B) — apply `normalizeDisplayText()` BEFORE
  // truncation so inline numbered lists ("1. xxx 2. yyy 3. zzz") are
  // split across newlines for proper chat-markdown ordered-list render.
  // The normalization is display-only; the DB column is untouched
  // (§17.9). Order matters: normalize first so the cap budget includes
  // the inserted newlines.
  const normalizedObjective = normalizeDisplayText(args.objectiveRaw);
  const truncatedObjective = truncateObjective(normalizedObjective);

  // Wave 62 W62-BE-AGG-01 — `goal` and `expected` truncated at the same
  // 500-char cap used for `objective`. Same §17.9 prompt-injection
  // budget; the helper is shape-compatible (the cap is named
  // `OBJECTIVE_HARD_CAP` for legacy reasons but applies identically).
  //
  // Wave 63 W63-BE-AGG-01 — same `normalizeDisplayText` pre-pass as
  // `objective` above. Short-label fields (agencyName, amphoeName,
  // laoName) are deliberately NOT normalized — they never carry
  // multi-item numbered runs.
  const normalizedGoal = normalizeDisplayText(args.goalRaw);
  const normalizedExpected = normalizeDisplayText(args.expectedRaw);
  const truncatedGoal = truncateObjective(normalizedGoal);
  const truncatedExpected = truncateObjective(normalizedExpected);

  // Wave 62 W62-BE-AGG-01 — §17.7 reportFormat branching. The handler
  // enforces the §16.5 mutually-exclusive invariant defensively: even
  // if the underlying row carried legacy data in the wrong column, the
  // envelope only surfaces the field that matches the parent plan's
  // declared `reportFormat`. When `reportFormat` is missing (legacy
  // data / no parent plan), BOTH fields collapse to null.
  const trimmedIndicator =
    typeof args.indicatorRaw === 'string' ? args.indicatorRaw.trim() : '';
  const trimmedIssueLabel =
    typeof args.developmentIssueLabel === 'string'
      ? args.developmentIssueLabel.trim()
      : '';
  const indicator =
    args.reportFormat === 'STRATEGY_BASED' && trimmedIndicator.length > 0
      ? trimmedIndicator
      : null;
  const developmentIssueLabel =
    args.reportFormat === 'ISSUE_BASED' && trimmedIssueLabel.length > 0
      ? trimmedIssueLabel
      : null;

  // Wave 59 W59-BE-AGG-01 (D-C) — location triple composition.
  // `amphoeName` / `laoName` are JOIN-projected; trim and coerce empty
  // strings to null so the LLM never has to disambiguate "" vs "no value".
  // The geoCoordinates pair is null when EITHER lat or lng is null; the
  // parent object is null only when BOTH pairs are null. lat/lng come
  // back from PG numeric columns either as `number` or as `string`
  // (TypeORM raw-mode) — defensively coerce via Number() and reject NaN.
  const trimmedAmphoeName =
    typeof args.amphoeName === 'string' ? args.amphoeName.trim() : '';
  const amphoeName = trimmedAmphoeName.length > 0 ? trimmedAmphoeName : null;
  const trimmedLaoName =
    typeof args.laoName === 'string' ? args.laoName.trim() : '';
  const laoName = trimmedLaoName.length > 0 ? trimmedLaoName : null;
  const geoCoordinates = composeGeoCoordinates(
    args.startLat,
    args.startLng,
    args.endLat,
    args.endLng,
  );

  // W67-BE-AGG-01 — computed `executiveStatus` (4-group rollup over the 8
  // canonical statuses). Always-present envelope key; value is null when
  // the row's status is in the workflow-internal set (Ready / Pull_Back /
  // Returned_For_Revision) that does not surface in the executive view.
  // §17.2 advisory only — value MUST NOT gate any workflow transition.
  const executiveStatus = mapToExecutiveStatusGroup(args.statusname ?? null);

  const entry: Record<string, unknown> = {
    projectId: args.projectId,
    projectKind: args.projectKind,
    name: args.title ?? '',
    currentStatus: args.statusname ?? '',
    // W67-BE-AGG-01: `statusTh` continues to flow through `toThaiStatus`
    // here for back-compat. The deprecated STATUS_TH_MAP was synced to
    // the W67 DB seed values (`Pending → 'รอตรวจสอบ'`, `Rejected →
    // 'เกินศักยภาพ'`) so the legacy and DB paths now resolve to the
    // same string. New aggregator-handler envelopes (e.g.
    // getTeamWorkloadSummary, getProjectStatusBreakdown) load the
    // labels from `status.th_name` directly via `loadStatusThaiLabels`.
    statusTh: toThaiStatus(args.statusname),
    executiveStatus,
    planId: args.planId,
    budget: Number(args.budget) || 0,
    // Wave 58 D3 — agency name + disclosure ALWAYS surfaced as keys so
    // the schema validator can rely on them being present. `null` is the
    // honest signal that no name is available.
    responsibleAgencyName,
    responsibleAgencyDisclosure,
    // Wave 58 D4 — round metadata for grouping. `revisionRoundId` is
    // null for `main` projects (there is no DPR / DPS row to point at).
    revisionRoundType: args.revisionRoundType,
    revisionRoundId: args.revisionRoundId,
    revisionRoundLabel,
    // Wave 58 D7 — page number from the entity column (nullable until
    // the book is compiled).
    pageNumber,
    // Wave 59 D-B — objective + truncation flag. `objective` is null when
    // the column is null/empty; the LLM treats null as "no objective
    // recorded" rather than synthesizing copy.
    objective: truncatedObjective.text,
    objectiveTruncated: truncatedObjective.truncated,
    // Wave 62 W62-BE-AGG-01 — `goal` / `expected` mirror the
    // `objective` shape (truncated text + boolean flag). Always
    // surfaced as keys; null when the source column is null/empty.
    goal: truncatedGoal.text,
    goalTruncated: truncatedGoal.truncated,
    expected: truncatedExpected.text,
    expectedTruncated: truncatedExpected.truncated,
    // Wave 62 W62-BE-AGG-01 — §17.7 format branching. EXACTLY ONE of
    // these two fields is non-null per row (§16.5 invariant): STRATEGY_BASED
    // → `indicator` populated; ISSUE_BASED → `developmentIssueLabel`
    // populated; missing reportFormat → both null. The handler does NOT
    // emit `indicator` for ISSUE_BASED rows even if the column has data.
    indicator,
    developmentIssueLabel,
    // Wave 59 D-C — location triple. amphoeName / laoName / geoCoordinates
    // are ALWAYS surfaced as keys with `null` permitted at runtime
    // (per the W58-BE-AGG-02 nullable-via-required-only convention).
    amphoeName,
    laoName,
    geoCoordinates,
  };
  if (args.amphoeId != null) entry.amphoeId = Number(args.amphoeId);
  if (args.agencyId != null) entry.responsibleAgencyId = Number(args.agencyId);
  if (args.revisionNumber != null && args.projectKind === 'revised') {
    entry.revisionNumber = Number(args.revisionNumber);
  }
  if (args.revisionTypeName) {
    entry.revisionTypeName = args.revisionTypeName;
  }
  if (args.supplementNumber != null && args.projectKind === 'supplement') {
    entry.supplementNumber = Number(args.supplementNumber);
  }
  // Wave 60 — only emit `isHead` when explicitly provided. Caller
  // (book-completeness mode) passes `true|false`; legacy modes pass
  // `undefined` to keep the existing envelope shape unchanged.
  if (typeof args.isHead === 'boolean') {
    entry.isHead = args.isHead;
  }

  // Belt-and-braces — reject any envelope where the agency-string field
  // matches the `"หน่วยงานที่ N"` / `"agency #N"` placeholder. The DB
  // join is the primary defense; this is the §17.9 paranoia net.
  assertAgencyLabelPlaceholderFree({
    responsibleAgencyName,
    responsibleAgencyDisclosure,
  });

  return entry;
}

// W68-FIX-05 (2026-04-28) — exported for spec coverage of the
// verbose-mode gate in `renderBookCompletenessMarkdown`.
export interface GroupedProjectRound {
  revisionRoundType: RevisionRoundType;
  revisionRoundId: string | null;
  revisionRoundLabel: string;
  projects: Array<Record<string, unknown>>;
}

const ROUND_TYPE_ORDER: Record<RevisionRoundType, number> = {
  main: 0,
  edit: 1,
  change: 2,
  supplement: 3,
};

function groupItemsByRevisionRound(
  items: Array<Record<string, unknown>>,
): GroupedProjectRound[] {
  const buckets = new Map<string, GroupedProjectRound>();
  for (const it of items) {
    const t = (it.revisionRoundType as RevisionRoundType) ?? 'main';
    const id = (it.revisionRoundId as string | null) ?? null;
    const key = `${t}|${id ?? ''}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        revisionRoundType: t,
        revisionRoundId: id,
        revisionRoundLabel:
          (it.revisionRoundLabel as string | undefined) ??
          (t === 'main' ? REVISION_ROUND_LABEL_MAIN : ''),
        projects: [],
      };
      buckets.set(key, bucket);
    }
    bucket.projects.push(it);
  }
  return Array.from(buckets.values()).sort((a, b) => {
    const da = ROUND_TYPE_ORDER[a.revisionRoundType] ?? 99;
    const db = ROUND_TYPE_ORDER[b.revisionRoundType] ?? 99;
    if (da !== db) return da - db;
    // Stable secondary order — by revisionRoundLabel ascending.
    return a.revisionRoundLabel.localeCompare(b.revisionRoundLabel);
  });
}

// Wave 60 W60-BE-AGG-01 — book-completeness partitioner.
//
// Partitions `items[]` into per-book buckets:
//   - every `original` (PG) row → ONE shared "main" bucket
//     (revisionRoundId = null).
//   - every `revised` (RPG) row → bucket keyed by `revisionRoundId`
//     (the DPR id), preserving the round-type discriminator
//     ('edit' | 'change') the row already carries.
//   - every `supplement` (SPG) row → bucket keyed by `revisionRoundId`
//     (the DPS id).
//
// Soft-delete and Ready filtering happen UPSTREAM (in the SQL layer);
// this function is shape-only.
//
// Sort order matches `groupItemsByRevisionRound` so the two modes
// produce structurally similar `groups[]` arrays — main first, then
// edit, change, supplement; alphabetical secondary by label.
function groupItemsByBookCompleteness(
  items: Array<Record<string, unknown>>,
): GroupedProjectRound[] {
  const buckets = new Map<string, GroupedProjectRound>();
  for (const it of items) {
    const projectKind =
      (it.projectKind as 'original' | 'revised' | 'supplement') ?? 'original';
    let bucketType: RevisionRoundType;
    let bucketId: string | null;
    if (projectKind === 'original') {
      bucketType = 'main';
      bucketId = null;
    } else {
      bucketType =
        (it.revisionRoundType as RevisionRoundType) ??
        (projectKind === 'supplement' ? 'supplement' : 'edit');
      bucketId = (it.revisionRoundId as string | null) ?? null;
    }
    const key = `${bucketType}|${bucketId ?? ''}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        revisionRoundType: bucketType,
        revisionRoundId: bucketId,
        revisionRoundLabel:
          (it.revisionRoundLabel as string | undefined) ??
          (bucketType === 'main' ? REVISION_ROUND_LABEL_MAIN : ''),
        projects: [],
      };
      buckets.set(key, bucket);
    }
    bucket.projects.push(it);
  }
  return Array.from(buckets.values()).sort((a, b) => {
    const da = ROUND_TYPE_ORDER[a.revisionRoundType] ?? 99;
    const db = ROUND_TYPE_ORDER[b.revisionRoundType] ?? 99;
    if (da !== db) return da - db;
    return a.revisionRoundLabel.localeCompare(b.revisionRoundLabel);
  });
}

// ────────────────────────────────────────────────────────────────────
// Wave 53 (BE-W53-03): getProjectClassificationBreakdown
//
// Surfaces classification groupings per plan with §17.7 branching and
// §16.5 exactly-one-shape defense:
//   - STRATEGY_BASED → group by Strategy → Tactic → Plan. NEVER read
//     `development_issue_id` in this branch.
//   - ISSUE_BASED → group by DevelopmentIssue. NEVER read
//     `strategy_id / tactic_id / plan_id / indicator` in this branch.
//
// Plan-not-found fallback intentionally returns a valid envelope
// (reportFormat=STRATEGY_BASED, shape='strategy', items=[], message=…)
// so the schema validator accepts the payload and the LLM can recover.
//
// Wave 53 scope: main-plan PG only. RevisedProjectGroup / SupplementProjectGroup
// classification breakdown deferred per task §4.
// ────────────────────────────────────────────────────────────────────

const getProjectClassificationBreakdown: ExecutiveToolHandler = async (
  params,
  ctx,
  deps,
) => {
  assertExecutiveRole(ctx);
  const planIdRaw = params.planId != null ? String(params.planId).trim() : '';

  // Wave 57 W57-BE-AGG-04 — dual-bucket fallback (Q12). When the caller
  // omits `planId`, return BOTH STRATEGY_BASED and ISSUE_BASED partitions
  // side by side instead of refusing or guessing a default plan.
  if (!planIdRaw) {
    // STRATEGY_BASED partition — count across every STRATEGY_BASED plan.
    // Wave 57 W57-BE-AGG-01 — HEAD-of-lineage filter.
    const stratQb = deps.dataSource
      .getRepository(ProjectGroup)
      .createQueryBuilder('pg')
      .innerJoin('pg.developmentPlan', 'dp')
      .leftJoin('pg.strategy', 's')
      .leftJoin('pg.tactic', 't')
      .leftJoin('pg.plan', 'pl')
      .select('s.id', 'strategyid')
      .addSelect('s.name', 'strategyname')
      .addSelect('t.id', 'tacticid')
      .addSelect('t.name', 'tacticname')
      .addSelect('pl.id', 'planlevelid')
      .addSelect('pl.name', 'planlevelname')
      .addSelect('COUNT(pg.id)', 'projectcount')
      .where('pg.deletedAt IS NULL')
      .andWhere('dp.deletedAt IS NULL')
      .andWhere('dp.report_format = :rf', { rf: 'STRATEGY_BASED' })
      .andWhere('pg.strategy_id IS NOT NULL')
      .groupBy('s.id')
      .addGroupBy('s.name')
      .addGroupBy('t.id')
      .addGroupBy('t.name')
      .addGroupBy('pl.id')
      .addGroupBy('pl.name');
    applyHeadFilterForProjectGroup(stratQb, 'pg');
    const stratRows: Array<{
      strategyid: string | null;
      strategyname: string | null;
      tacticid: string | null;
      tacticname: string | null;
      planlevelid: string | null;
      planlevelname: string | null;
      projectcount: string;
    }> = await stratQb.getRawMany();

    // ISSUE_BASED partition — count across every ISSUE_BASED plan.
    const issueQb = deps.dataSource
      .getRepository(ProjectGroup)
      .createQueryBuilder('pg')
      .innerJoin('pg.developmentPlan', 'dp')
      .leftJoin('pg.developmentIssue', 'di')
      .select('di.id', 'issueid')
      .addSelect('di.name', 'issuename')
      .addSelect('COUNT(pg.id)', 'projectcount')
      .where('pg.deletedAt IS NULL')
      .andWhere('dp.deletedAt IS NULL')
      .andWhere('dp.report_format = :rf', { rf: 'ISSUE_BASED' })
      .andWhere('pg.development_issue_id IS NOT NULL')
      .groupBy('di.id')
      .addGroupBy('di.name');
    applyHeadFilterForProjectGroup(issueQb, 'pg');
    const issueRows: Array<{
      issueid: string | null;
      issuename: string | null;
      projectcount: string;
    }> = await issueQb.getRawMany();

    return {
      shape: 'dual-bucket' as const,
      partitions: [
        {
          reportFormat: ReportFormat.STRATEGY_BASED,
          shape: 'strategy' as const,
          items: stratRows.map((r) => ({
            strategyId: r.strategyid ?? '',
            strategyName: r.strategyname ?? '(ไม่ระบุ)',
            tacticId: r.tacticid ?? '',
            tacticName: r.tacticname ?? '(ไม่ระบุ)',
            planLevelId: r.planlevelid ?? '',
            planLevelName: r.planlevelname ?? '(ไม่ระบุ)',
            projectCount: Number(r.projectcount) || 0,
          })),
        },
        {
          reportFormat: ReportFormat.ISSUE_BASED,
          shape: 'issue' as const,
          items: issueRows.map((r) => ({
            issueId: r.issueid ?? '',
            issueName: r.issuename ?? '(ไม่ระบุ)',
            projectCount: Number(r.projectcount) || 0,
          })),
        },
      ],
      advisories: ['dual-bucket-classification', HEAD_OF_LINEAGE_ADVISORY],
      asOf: nowIso(),
    };
  }

  const planId = planIdRaw;
  const plan = await deps.dataSource
    .getRepository(DevelopmentPlan)
    .findOne({ where: { id: planId } });

  if (!plan) {
    return {
      planId,
      reportFormat: ReportFormat.STRATEGY_BASED,
      shape: 'strategy' as const,
      items: [],
      asOf: nowIso(),
      message: 'ไม่พบแผนที่ระบุ',
    };
  }

  if (plan.reportFormat === ReportFormat.ISSUE_BASED) {
    // §16.5 / §17.7 — ISSUE_BASED branch: read `development_issue_id`
    // only. NEVER project strategy/tactic/plan/indicator here.
    // Wave 57 W57-BE-AGG-01 — HEAD-of-lineage filter (CLAUDE.md §14.2).
    const issueQb = deps.dataSource
      .getRepository(ProjectGroup)
      .createQueryBuilder('pg')
      .leftJoin('pg.developmentIssue', 'di')
      .select('di.id', 'issueid')
      .addSelect('di.name', 'issuename')
      .addSelect('COUNT(pg.id)', 'projectcount')
      .where('pg.deletedAt IS NULL')
      .andWhere('pg.development_plan_id = :planId', { planId })
      // §16.5 defensive filter — skip any row that violates the
      // ISSUE_BASED shape invariant. The DB CHECK constraint is the
      // terminal guard; this filter ensures a rogue row cannot pollute
      // the aggregate.
      .andWhere('pg.development_issue_id IS NOT NULL')
      .groupBy('di.id')
      .addGroupBy('di.name');
    applyHeadFilterForProjectGroup(issueQb, 'pg');
    const rows: Array<{
      issueid: string | null;
      issuename: string | null;
      projectcount: string;
    }> = await issueQb.getRawMany();

    return {
      planId,
      reportFormat: plan.reportFormat,
      shape: 'issue' as const,
      items: rows.map((r) => ({
        issueId: r.issueid ?? '',
        issueName: r.issuename ?? '(ไม่ระบุ)',
        projectCount: Number(r.projectcount) || 0,
      })),
      asOf: nowIso(),
    };
  }

  // STRATEGY_BASED branch — read strategy/tactic/plan. NEVER read
  // `development_issue_id` here (§16.5 / §17.7 invariant).
  // Wave 57 W57-BE-AGG-01 — HEAD-of-lineage filter (CLAUDE.md §14.2).
  const strategyQb = deps.dataSource
    .getRepository(ProjectGroup)
    .createQueryBuilder('pg')
    .leftJoin('pg.strategy', 's')
    .leftJoin('pg.tactic', 't')
    .leftJoin('pg.plan', 'pl')
    .select('s.id', 'strategyid')
    .addSelect('s.name', 'strategyname')
    .addSelect('t.id', 'tacticid')
    .addSelect('t.name', 'tacticname')
    .addSelect('pl.id', 'planlevelid')
    .addSelect('pl.name', 'planlevelname')
    .addSelect('COUNT(pg.id)', 'projectcount')
    // `indicator` is projected (not grouped) as an informational sample
    // — MIN() yields a deterministic non-null representative if any row
    // in the group supplies one. Grouping on indicator would over-split
    // the aggregate, so we explicitly do not GROUP BY it.
    .addSelect('MIN(pg.indicator)', 'sampleindicator')
    .where('pg.deletedAt IS NULL')
    .andWhere('pg.development_plan_id = :planId', { planId })
    // §16.5 defensive filter — skip any row that violates the
    // STRATEGY_BASED shape invariant.
    .andWhere('pg.strategy_id IS NOT NULL')
    .groupBy('s.id')
    .addGroupBy('s.name')
    .addGroupBy('t.id')
    .addGroupBy('t.name')
    .addGroupBy('pl.id')
    .addGroupBy('pl.name');
  applyHeadFilterForProjectGroup(strategyQb, 'pg');
  const rows: Array<{
    strategyid: string | null;
    strategyname: string | null;
    tacticid: string | null;
    tacticname: string | null;
    planlevelid: string | null;
    planlevelname: string | null;
    projectcount: string;
    sampleindicator: string | null;
  }> = await strategyQb.getRawMany();

  return {
    planId,
    reportFormat: plan.reportFormat ?? ReportFormat.STRATEGY_BASED,
    shape: 'strategy' as const,
    items: rows.map((r) => {
      const entry: Record<string, unknown> = {
        strategyId: r.strategyid ?? '',
        strategyName: r.strategyname ?? '(ไม่ระบุ)',
        tacticId: r.tacticid ?? '',
        tacticName: r.tacticname ?? '(ไม่ระบุ)',
        planLevelId: r.planlevelid ?? '',
        planLevelName: r.planlevelname ?? '(ไม่ระบุ)',
        projectCount: Number(r.projectcount) || 0,
      };
      if (r.sampleindicator) {
        entry.sampleIndicator = r.sampleindicator;
      }
      return entry;
    }),
    asOf: nowIso(),
  };
};

// ────────────────────────────────────────────────────────────────────
// Wave 53 (BE-W53-02): listDevelopmentPlanRevisions
//
// Enumerate DevelopmentPlanRevision rounds of a plan.  Per task §7.7 the
// `projectCount` aggregate is a single GROUP-BY query over
// RevisedProjectGroup keyed by `development_plan_revision_id` — avoids
// the N+1 pathology flagged in task §11.  RevisionType.name surfaces the
// Thai vocabulary (แก้ไข / เปลี่ยนแปลง / other).
// ────────────────────────────────────────────────────────────────────

const listDevelopmentPlanRevisions: ExecutiveToolHandler = async (
  params,
  ctx,
  deps,
) => {
  assertExecutiveRole(ctx);
  const planIdRaw = String(params.planId ?? '');
  if (!UUID_RX.test(planIdRaw)) {
    return {
      planId: NIL_UUID,
      items: [],
      asOf: nowIso(),
      message:
        'planId ต้องเป็น UUID ที่ได้จาก listActivePlans.items[i].planId เท่านั้น',
    };
  }
  const planId = planIdRaw;
  const limit = Math.min(Math.max(Number(params.limit ?? 20), 1), 50);

  const revisions = await deps.dataSource
    .getRepository(DevelopmentPlanRevision)
    .createQueryBuilder('dpr')
    .leftJoinAndSelect('dpr.revisionType', 'rt')
    .where('dpr.deletedAt IS NULL')
    .andWhere('dpr.development_plan_id = :planId', { planId })
    .orderBy('dpr.createdAt', 'DESC')
    .take(limit)
    .getMany();

  const revisionIds = revisions.map((r) => r.id);
  const countRows: Array<{ dprid: string; cnt: string }> = revisionIds.length
    ? await deps.dataSource
        .getRepository(RevisedProjectGroup)
        .createQueryBuilder('rpg')
        .select('rpg.development_plan_revision_id', 'dprid')
        .addSelect('COUNT(*)', 'cnt')
        .where('rpg.deletedAt IS NULL')
        .andWhere('rpg.development_plan_revision_id IN (:...ids)', {
          ids: revisionIds,
        })
        .groupBy('rpg.development_plan_revision_id')
        .getRawMany()
    : [];
  const countByRevision = new Map<string, number>(
    countRows.map((r) => [String(r.dprid), Number(r.cnt) || 0]),
  );

  return {
    planId,
    items: revisions.map((r) => ({
      revisionId: r.id,
      revisionNumber: r.revisionNumber,
      revisionTypeName: r.revisionType?.name ?? '(ไม่ระบุ)',
      isLatest: !!r.isLatest,
      isOpen: !!r.isOpen,
      isBooked: !!r.isBooked,
      projectCount: countByRevision.get(r.id) ?? 0,
    })),
    asOf: nowIso(),
  };
};

// ────────────────────────────────────────────────────────────────────
// Wave 53 (BE-W53-02): listDevelopmentPlanSupplements
// ────────────────────────────────────────────────────────────────────

const listDevelopmentPlanSupplements: ExecutiveToolHandler = async (
  params,
  ctx,
  deps,
) => {
  assertExecutiveRole(ctx);
  const planIdRaw = String(params.planId ?? '');
  if (!UUID_RX.test(planIdRaw)) {
    return {
      planId: NIL_UUID,
      items: [],
      asOf: nowIso(),
      message:
        'planId ต้องเป็น UUID ที่ได้จาก listActivePlans.items[i].planId เท่านั้น',
    };
  }
  const planId = planIdRaw;
  const limit = Math.min(Math.max(Number(params.limit ?? 20), 1), 50);

  const supplements = await deps.dataSource
    .getRepository(DevelopmentPlanSupplement)
    .createQueryBuilder('dps')
    .where('dps.deletedAt IS NULL')
    .andWhere('dps.development_plan_id = :planId', { planId })
    .orderBy('dps.createdAt', 'DESC')
    .take(limit)
    .getMany();

  const supplementIds = supplements.map((s) => s.id);
  const countRows: Array<{ dpsid: string; cnt: string }> = supplementIds.length
    ? await deps.dataSource
        .getRepository(SupplementProjectGroup)
        .createQueryBuilder('spg')
        .select('spg.development_plan_supplement_id', 'dpsid')
        .addSelect('COUNT(*)', 'cnt')
        .where('spg.deletedAt IS NULL')
        .andWhere('spg.development_plan_supplement_id IN (:...ids)', {
          ids: supplementIds,
        })
        .groupBy('spg.development_plan_supplement_id')
        .getRawMany()
    : [];
  const countBySupplement = new Map<string, number>(
    countRows.map((r) => [String(r.dpsid), Number(r.cnt) || 0]),
  );

  return {
    planId,
    items: supplements.map((s) => ({
      supplementId: s.id,
      supplementNumber: s.supplementNumber,
      isLatest: !!s.isLatest,
      isOpen: !!s.isOpen,
      isBooked: !!s.isBooked,
      projectCount: countBySupplement.get(s.id) ?? 0,
    })),
    asOf: nowIso(),
  };
};

// ────────────────────────────────────────────────────────────────────
// Wave 53 (BE-W53-02): getProjectLocationBreakdown
//
// Per-อำเภอ counts + total budget under a planId.
//
// Scope enum: main | revised | supplement | all.
//
// IMPORTANT — SupplementProjectGroup lacks `amphoe_id` (entity check:
// `supplement-project-group.entity.ts` defines no Amphoe relation).  The
// `supplement` scope is therefore EXCLUDED: `scope='supplement'` returns
// an empty items array with an advisory `message`, and `scope='all'`
// silently aggregates only `main + revised`.  Per task §7.9 this
// exclusion is documented in the tool description and surfaced here via
// the `message` field.
//
// For scope='all' the two contributing scopes are merged at the
// application layer (amphoeId is the merge key) rather than via a SQL
// UNION, to keep the grouping predictable when an amphoe contains both
// main and revised projects.
// ────────────────────────────────────────────────────────────────────

const getProjectLocationBreakdown: ExecutiveToolHandler = async (
  params,
  ctx,
  deps,
) => {
  assertExecutiveRole(ctx);
  const planIdRaw = String(params.planId ?? '');
  if (!UUID_RX.test(planIdRaw)) {
    return {
      planId: NIL_UUID,
      scope: 'all' as const,
      items: [],
      asOf: nowIso(),
      message:
        'planId ต้องเป็น UUID ที่ได้จาก listActivePlans.items[i].planId เท่านั้น',
    };
  }
  const planId = planIdRaw;
  const scope = String(params.scope ?? 'all');
  const limit = Math.min(Math.max(Number(params.limit ?? 20), 1), 50);

  type Agg = { projectCount: number; totalBudget: number; amphoeName: string };
  const byAmphoe = new Map<string, Agg>();

  const wantsMain = scope === 'all' || scope === 'main';
  const wantsRevised = scope === 'all' || scope === 'revised';
  const excludedSupplement = scope === 'supplement';

  // Two passes per scope — COUNT pass on the project table, then a
  // separate SUM pass on Budget joined through the same project table.
  // Avoids the "budget-row multiplier" pathology that an inline JOIN
  // would introduce on the COUNT.  Both passes go through TypeORM
  // entity metadata — no raw table literals.
  const absorbCount = (
    amphoeId: string | null,
    amphoeName: string | null,
    cnt: number,
  ) => {
    const key = amphoeId == null ? '__null__' : String(amphoeId);
    const existing = byAmphoe.get(key) ?? {
      projectCount: 0,
      totalBudget: 0,
      amphoeName: amphoeName ?? '(ไม่ระบุ)',
    };
    existing.projectCount += cnt;
    if (
      existing.amphoeName === '(ไม่ระบุ)' &&
      amphoeName &&
      amphoeName.length > 0
    ) {
      existing.amphoeName = amphoeName;
    }
    byAmphoe.set(key, existing);
  };
  const absorbBudget = (amphoeId: string | null, total: number) => {
    const key = amphoeId == null ? '__null__' : String(amphoeId);
    const existing = byAmphoe.get(key) ?? {
      projectCount: 0,
      totalBudget: 0,
      amphoeName: '(ไม่ระบุ)',
    };
    existing.totalBudget += total;
    byAmphoe.set(key, existing);
  };

  // ── Main ─────────────────────────────────────────────────────────────
  if (wantsMain) {
    const countRows: Array<{
      amphoeid: string | null;
      amphoename: string | null;
      cnt: string;
    }> = await deps.dataSource
      .getRepository(ProjectGroup)
      .createQueryBuilder('pg')
      .leftJoin(Amphoe, 'amp', 'amp.id = pg.amphoe_id')
      .select('pg.amphoe_id', 'amphoeid')
      .addSelect('amp.name', 'amphoename')
      .addSelect('COUNT(DISTINCT pg.id)', 'cnt')
      .where('pg.deletedAt IS NULL')
      .andWhere('pg.development_plan_id = :planId', { planId })
      .groupBy('pg.amphoe_id')
      .addGroupBy('amp.name')
      .getRawMany();
    for (const r of countRows) {
      absorbCount(r.amphoeid, r.amphoename, Number(r.cnt) || 0);
    }

    const budgetRows: Array<{
      amphoeid: string | null;
      sumbudget: string | null;
    }> = await deps.dataSource
      .getRepository(Budget)
      .createQueryBuilder('b')
      .innerJoin('b.projectGroupId', 'pg')
      .select('pg.amphoe_id', 'amphoeid')
      .addSelect('COALESCE(SUM(b.quantity), 0)', 'sumbudget')
      .where('pg.deletedAt IS NULL')
      .andWhere('pg.development_plan_id = :planId', { planId })
      .groupBy('pg.amphoe_id')
      .getRawMany();
    for (const r of budgetRows) {
      absorbBudget(r.amphoeid, Number(r.sumbudget) || 0);
    }
  }

  // ── Revised ──────────────────────────────────────────────────────────
  if (wantsRevised) {
    const countRows: Array<{
      amphoeid: string | null;
      amphoename: string | null;
      cnt: string;
    }> = await deps.dataSource
      .getRepository(RevisedProjectGroup)
      .createQueryBuilder('rpg')
      .innerJoin('rpg.developmentPlanRevision', 'dpr')
      .leftJoin(Amphoe, 'amp', 'amp.id = rpg.amphoe_id')
      .select('rpg.amphoe_id', 'amphoeid')
      .addSelect('amp.name', 'amphoename')
      .addSelect('COUNT(DISTINCT rpg.id)', 'cnt')
      .where('rpg.deletedAt IS NULL')
      .andWhere('dpr.deletedAt IS NULL')
      .andWhere('dpr.development_plan_id = :planId', { planId })
      .groupBy('rpg.amphoe_id')
      .addGroupBy('amp.name')
      .getRawMany();
    for (const r of countRows) {
      absorbCount(r.amphoeid, r.amphoename, Number(r.cnt) || 0);
    }

    const budgetRows: Array<{
      amphoeid: string | null;
      sumbudget: string | null;
    }> = await deps.dataSource
      .getRepository(Budget)
      .createQueryBuilder('b')
      .innerJoin('b.revisedProjectGroupId', 'rpg')
      .innerJoin('rpg.developmentPlanRevision', 'dpr')
      .select('rpg.amphoe_id', 'amphoeid')
      .addSelect('COALESCE(SUM(b.quantity), 0)', 'sumbudget')
      .where('rpg.deletedAt IS NULL')
      .andWhere('dpr.deletedAt IS NULL')
      .andWhere('dpr.development_plan_id = :planId', { planId })
      .groupBy('rpg.amphoe_id')
      .getRawMany();
    for (const r of budgetRows) {
      absorbBudget(r.amphoeid, Number(r.sumbudget) || 0);
    }
  }

  const items = [...byAmphoe.entries()]
    .map(([key, agg]) => ({
      amphoeId: key === '__null__' ? 0 : Number(key),
      amphoeName: agg.amphoeName,
      projectCount: agg.projectCount,
      totalBudget: agg.totalBudget,
    }))
    .sort((a, b) => b.projectCount - a.projectCount)
    .slice(0, limit);

  const envelope: Record<string, unknown> = {
    planId,
    scope: scope as 'main' | 'revised' | 'supplement' | 'all',
    items,
    asOf: nowIso(),
  };
  if (excludedSupplement) {
    envelope.message =
      'SupplementProjectGroup ไม่มีฟิลด์ amphoe_id — ตารางนี้ถูกตัดออกจากผลสรุป';
  } else if (scope === 'all') {
    // Soft hint so the LLM tells the user why supplement rows are absent.
    envelope.message =
      'หมายเหตุ: SupplementProjectGroup ไม่มีฟิลด์ amphoe_id จึงไม่ถูกนับในสรุปรายอำเภอ (รวมเฉพาะเล่มหลักและเล่มแก้ไข/เปลี่ยนแปลง)';
  }
  return envelope;
};

// ────────────────────────────────────────────────────────────────────
// Wave 54 BE-W54-06 — Tier C executive tools.
//
// These three handlers compose Tier B aggregation services via the
// extended `ExecutiveToolHandlerDeps` bag. They MUST NOT call
// `deps.dataSource.getRepository()` — all data access goes through
// `deps.unifiedProject | deps.budget | deps.status | deps.geo |
// deps.agency`.
//
// Contract invariants (task §7 / §10):
//   - First line of every handler body: `assertExecutiveRole(ctx)`.
//   - Direct composition — NO `ResilienceEnvelope` wrapping. Errors
//     propagate; BE-W54-07 will later wrap each dimension call.
//   - Classification branching is INLINE on `unifiedProject.planReportFormat`
//     (no dedicated `ClassificationBranching` service — task §4 LOCKED
//     2026-04-24). Shape mismatches surface as `missingDimensions:
//     ['classification']` + advisory.
//   - Envelope shape obeys `docs/reports/wave54/WAVE54_EXECUTIVE_QUERY_ENGINE_DESIGN.md`
//     §5.1: `{ shape, data, partial, missingDimensions, advisories, asOf }`.
//   - `advisories` is ALWAYS present (empty array on full-success runs).
//   - `partial === missingDimensions.length > 0` (invariant derived).
//   - No PII projection. No `tracking_status` writes. No workflow mutation.
// ────────────────────────────────────────────────────────────────────

/**
 * Normalise the DSL `scope` array into the Tier B service's scope
 * vocabulary. The DSL accepts `'main' | 'revision' | 'supplement' |
 * 'all'`; `IUnifiedProjectAggregator.listUnifiedProjects` accepts
 * `'main' | 'revised' | 'supplement' | 'all'`. Map `'revision'` →
 * `'revised'` at the seam.
 */
function normaliseDslScope(
  scope: unknown,
): Array<'main' | 'revised' | 'supplement' | 'all'> {
  const raw = Array.isArray(scope) ? scope : [];
  const out = new Set<'main' | 'revised' | 'supplement' | 'all'>();
  for (const entry of raw) {
    const s = String(entry);
    if (s === 'main' || s === 'revised' || s === 'supplement' || s === 'all') {
      out.add(s);
    } else if (s === 'revision') {
      // DSL vocabulary → service vocabulary.
      out.add('revised');
    }
  }
  // Default to `['all']` if the caller passed an empty or all-unknown
  // array — matches the defensive behavior of the Wave 53 Tier B
  // service (`[]` → `[]`) without failing the turn.
  if (out.size === 0) out.add('all');
  return [...out];
}

function clampLimit(raw: unknown): number | undefined {
  if (raw == null) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(Math.max(Math.trunc(n), 1), 50);
}

type GroupByKey =
  | 'status'
  | 'amphoe'
  | 'agency'
  | 'strategy'
  | 'issue'
  | 'planLevel'
  // Wave 55 W55-BE-07 — derived project-origin discriminator (§1 + §5).
  | 'originType'
  // Wave 57 W57-BE-AGG-03 — explicit "หน่วยงานรับผิดชอบ" alias for
  // `agency` (project.responsible_agency_id). Both names are accepted
  // and route to the same bucket logic per task §3.
  | 'responsibleAgency'
  // W67-LAO-RESOLVER — per-LAO bucket keyed by
  // `local_administrative_organization_id`. Pairs with `filters.laoIds`
  // for "อปท ใน [อำเภอ X] มีกี่โครงการแต่ละแห่ง" breakdowns.
  | 'lao';

function parseGroupBy(raw: unknown): GroupByKey[] {
  if (!Array.isArray(raw)) return [];
  const allowed = new Set<GroupByKey>([
    'status',
    'amphoe',
    'agency',
    'strategy',
    'issue',
    'planLevel',
    'originType',
    'responsibleAgency',
    'lao',
  ]);
  const out: GroupByKey[] = [];
  for (const entry of raw) {
    const s = String(entry);
    if (allowed.has(s as GroupByKey)) {
      // Wave 57 W57-BE-AGG-03 — coalesce `responsibleAgency` → `agency`
      // so the downstream bucket switch only handles the canonical key.
      const k = s === 'responsibleAgency' ? 'agency' : (s as GroupByKey);
      out.push(k);
    }
  }
  return out;
}

/**
 * Wave 55 W55-BE-06 — Normalise the DSL `filters` clause before handing
 * it to the Tier B aggregator. The DSL schema (`EXECUTIVE_QUERY_SCHEMA`)
 * already validates shape at the JSON-schema layer; this pass-through is
 * defensive and silently drops unknown sub-keys / malformed entries so
 * a malformed LLM payload never crashes the turn. Returns `undefined`
 * when no meaningful filter survives (keeps the query object minimal).
 */
type UnifiedFilters = {
  status?: string[];
  amphoeIds?: string[];
  // W67-LAO-RESOLVER — string-PK array forwarded to
  // `applyFilters({ laoIds })`; targets `local_administrative_organization_id`.
  laoIds?: string[];
  agencyIds?: string[];
  budgetRange?: { min?: number; max?: number };
  dateRange?: { from?: string; to?: string };
  // Wave 55 W55-BE-07 — derived project-origin discriminator (§1 + §5).
  originType?: Array<'lao-coordinated' | 'agency-normal'>;
};

function parseFilters(raw: unknown): UnifiedFilters | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const src = raw as Record<string, unknown>;
  const out: UnifiedFilters = {};

  if (Array.isArray(src.status)) {
    const vals = src.status.filter(
      (v): v is string => typeof v === 'string' && v.length > 0,
    );
    if (vals.length > 0) out.status = vals;
  }
  if (Array.isArray(src.amphoeIds)) {
    const vals = src.amphoeIds
      .map((v) => (typeof v === 'string' ? v : String(v)))
      .filter((v) => v.length > 0);
    if (vals.length > 0) out.amphoeIds = vals;
  }
  // W67-LAO-RESOLVER — same shape as amphoeIds; pass-through string[].
  if (Array.isArray(src.laoIds)) {
    const vals = src.laoIds
      .map((v) => (typeof v === 'string' ? v : String(v)))
      .filter((v) => v.length > 0);
    if (vals.length > 0) out.laoIds = vals;
  }
  if (Array.isArray(src.agencyIds)) {
    const vals = src.agencyIds
      .map((v) => (typeof v === 'string' ? v : String(v)))
      .filter((v) => v.length > 0);
    if (vals.length > 0) out.agencyIds = vals;
  }
  if (src.budgetRange && typeof src.budgetRange === 'object') {
    const r = src.budgetRange as Record<string, unknown>;
    const range: { min?: number; max?: number } = {};
    if (typeof r.min === 'number' && Number.isFinite(r.min)) range.min = r.min;
    if (typeof r.max === 'number' && Number.isFinite(r.max)) range.max = r.max;
    if (range.min !== undefined || range.max !== undefined) {
      out.budgetRange = range;
    }
  }
  if (src.dateRange && typeof src.dateRange === 'object') {
    const r = src.dateRange as Record<string, unknown>;
    const range: { from?: string; to?: string } = {};
    if (typeof r.from === 'string' && r.from.length > 0) range.from = r.from;
    if (typeof r.to === 'string' && r.to.length > 0) range.to = r.to;
    if (range.from !== undefined || range.to !== undefined) {
      out.dateRange = range;
    }
  }
  // Wave 55 W55-BE-07 — defensive originType normaliser. Unknown values
  // are silently DROPPED so a malformed LLM payload never crashes the
  // turn; an all-dropped array collapses to absence (the filter is
  // skipped entirely rather than mapped to a no-match here — the Tier B
  // `applyFilters` owns the all-dropped → 1=0 decision).
  if (Array.isArray(src.originType)) {
    const vals: Array<'lao-coordinated' | 'agency-normal'> = [];
    for (const v of src.originType) {
      if (v === 'lao-coordinated' || v === 'agency-normal') vals.push(v);
    }
    if (vals.length > 0) out.originType = vals;
  }

  // Collapse empty object to undefined.
  return Object.keys(out).length > 0 ? out : undefined;
}

// ────────────────────────────────────────────────────────────────────
// Wave 54 BE-W54-07 — shared helpers for Tier C dimension composition.
// ────────────────────────────────────────────────────────────────────

/**
 * Extract the `value` of a successful dimension result, typed as `T`.
 * Returns `undefined` when the dimension was absent from the task set
 * (e.g. `includeBudget === false`) OR the dimension failed (`ok: false`).
 * Callers MUST treat `undefined` as "dimension not available".
 */
function pickOk<T>(
  results: ResilienceDimensionResult[],
  dim: string,
): T | undefined {
  const r = results.find((x) => x.dimension === dim && x.ok);
  return r ? (r.value as T) : undefined;
}

/**
 * Classification-shape resolution (§17.7 / §16.5). Executed inside a
 * dimension thunk so a malformed plan surfaces as a missing-dimension
 * + `CLASSIFICATION_UNAVAILABLE` advisory instead of throwing.
 *
 * On shape mismatch between the plan's `reportFormat` and the
 * requested `groupBy`, THROW a sentinel `ClassificationShapeError`
 * whose message is the matching Thai advisory — that advisory is then
 * re-surfaced via `expectedAdvisoryOnFailure` so the envelope carries
 * the shape-specific string rather than the generic CLASSIFICATION
 * unavailable copy.
 */
class ClassificationShapeError extends Error {
  readonly advisory: string;
  constructor(advisory: string) {
    super('CLASSIFICATION_SHAPE_MISMATCH');
    this.name = 'ClassificationShapeError';
    this.advisory = advisory;
  }
}

async function resolveClassificationShape(
  reportFormat: string | null,
  groupBy: GroupByKey[],
): Promise<{ reportFormat: string | null }> {
  const wantsStrategyShape = groupBy.some(
    (g) => g === 'strategy' || g === 'planLevel',
  );
  const wantsIssueShape = groupBy.includes('issue');
  if (reportFormat === 'STRATEGY_BASED' && wantsIssueShape) {
    throw new ClassificationShapeError(CLASSIFICATION_SHAPE_STRATEGY);
  }
  if (reportFormat === 'ISSUE_BASED' && wantsStrategyShape) {
    throw new ClassificationShapeError(CLASSIFICATION_SHAPE_ISSUE);
  }
  return { reportFormat };
}

/**
 * GeoEnrichment and AgencyEnrichment surface documented-expected
 * partials (e.g. `'geo:supplement'`) via their own result objects
 * (design §5.3) — NOT via a rejection. When the dimension succeeded,
 * harvest those partials into the envelope so the LLM still sees the
 * SPG-skip advisory. Safe to call on any envelope; no-ops when the
 * result is absent.
 */
function mergeEnrichmentDocumentedPartials(
  envelope: {
    missingDimensions: MissingDimension[];
    advisories: string[];
    partial: boolean;
  },
  results: ResilienceDimensionResult[],
): void {
  const withPartials = (r: ResilienceDimensionResult): boolean => {
    if (!r.ok || !r.value || typeof r.value !== 'object') return false;
    return 'missingDimensions' in r.value && 'advisories' in r.value;
  };
  for (const r of results.filter(withPartials)) {
    const v = r.value as {
      missingDimensions: MissingDimension[];
      advisories: string[];
    };
    for (const md of v.missingDimensions) {
      if (!envelope.missingDimensions.includes(md)) {
        envelope.missingDimensions.push(md);
      }
    }
    for (const a of v.advisories) {
      if (!envelope.advisories.includes(a)) envelope.advisories.push(a);
    }
  }
  envelope.partial = envelope.missingDimensions.length > 0;
}

// ────────────────────────────────────────────────────────────────────
// Wave 54 BE-W54-06 / BE-W54-07 — 16. getPlanOverview
//
// Spine (unifiedProject.listUnifiedProjects) runs UNWRAPPED — spine
// failures propagate. Enrichment dimensions (budget / status / geo /
// agency / classification) run through `deps.resilience.runDimensions`
// so a single dimension failure surfaces as a partial envelope with
// a server-authored Thai advisory instead of throwing to the LLM.
// ────────────────────────────────────────────────────────────────────
const getPlanOverview: ExecutiveToolHandler = async (params, ctx, deps) => {
  assertExecutiveRole(ctx);

  const planIdRaw = String(params.planId ?? '');
  const planId = UUID_RX.test(planIdRaw) ? planIdRaw : null;
  const scope = normaliseDslScope(params.scope);
  const limit = clampLimit(params.limit);
  const includeBudget = Boolean(params.includeBudget);
  const includeStatus = Boolean(params.includeStatus);
  const includeGeo = Boolean(params.includeGeo);
  const includeAgency = Boolean(params.includeAgency);
  const includeClassification = Boolean(params.includeClassification);
  const groupBy = parseGroupBy(params.groupBy);
  // Wave 55 BE-W55-05 — §14.2 head-of-lineage filter. Default false;
  // executive callers virtually never need historical versions, and a
  // true flag re-opens the GAP-3 double-count.
  const includeHistoricalVersions = Boolean(params.includeHistoricalVersions);
  // Wave 55 W55-BE-06 — forward DSL `filters` to the aggregator.
  const filters = parseFilters(params.filters);

  if (!planId) {
    // Schema would normally reject this (planId REQUIRED for this tool),
    // but a defensive envelope keeps the turn recoverable if the
    // validator is bypassed.
    return {
      shape: 'planOverview',
      data: { planId: NIL_UUID, projectCount: 0 },
      asOf: nowIso(),
      partial: true,
      missingDimensions: ['classification'],
      advisories: [
        'planId ต้องเป็น UUID ที่ได้จาก listActivePlans.items[i].planId เท่านั้น',
      ],
    };
  }

  // Spine — UNWRAPPED. No projects = hard fail (correct).
  const projects = await deps.unifiedProject.listUnifiedProjects({
    planId,
    scope,
    limit,
    includeHistoricalVersions,
    filters,
  });

  // Classification branching (§17.7 / §16.5) — INLINE on planReportFormat.
  const reportFormat = projects[0]?.planReportFormat ?? null;

  // Build dimension tasks conditionally. Each thunk is a plain async
  // function — the ResilienceEnvelope wraps the timeout + try/catch.
  const tasks: DimensionTask[] = [];
  if (includeBudget) {
    tasks.push({
      dimension: 'budget',
      run: () => deps.budget.totalsForUnifiedProjects(projects),
    });
  }
  if (includeStatus) {
    tasks.push({
      dimension: 'status',
      run: () => deps.status.latestStatusFor(projects),
    });
  }
  if (includeGeo) {
    tasks.push({
      dimension: 'geo',
      run: () => deps.geo.annotate(projects),
    });
  }
  if (includeAgency) {
    tasks.push({
      dimension: 'agency',
      run: () => deps.agency.annotate(projects),
    });
  }
  if (includeClassification) {
    tasks.push({
      dimension: 'classification',
      run: () => resolveClassificationShape(reportFormat, groupBy),
    });
  }

  let capturedResults: ResilienceDimensionResult[] = [];
  const envelope = await deps.resilience.runDimensions(
    tasks,
    (results) => {
      capturedResults = results;
      const budgetMap = pickOk<Map<string, number>>(results, 'budget');
      const statusMap = pickOk<Map<string, LatestStatus>>(results, 'status');
      const geoResult = pickOk<GeoEnrichmentResult>(results, 'geo');
      const agencyResult = pickOk<AgencyEnrichmentResult>(results, 'agency');

      const data: Record<string, unknown> = {
        planId,
        projectCount: projects.length,
        reportFormat: reportFormat ?? undefined,
        scope,
      };
      if (budgetMap) {
        let total = 0;
        for (const v of budgetMap.values()) total += v;
        data.totalBudget = total;
      }
      if (statusMap) {
        // W67-FIX-01 — `statusBreakdown` is a Thai-display rollup the
        // LLM quotes verbatim in user-facing prose. Use the Thai
        // sibling `statusNameTh` here; `statusName` is now canonical
        // English (logic-only).
        const byStatus = new Map<string, number>();
        for (const s of statusMap.values()) {
          const label = s.statusNameTh || s.statusName;
          byStatus.set(label, (byStatus.get(label) ?? 0) + 1);
        }
        data.statusBreakdown = [...byStatus.entries()].map(
          ([statusName, count]) => ({ statusName, count }),
        );
      }
      if (geoResult) {
        data.geoLabelCount = geoResult.labels.size;
      }
      if (agencyResult) {
        data.agencyLabelCount = agencyResult.labels.size;
      }
      return data;
    },
    { shape: 'planOverview' },
  );

  // Merge GeoEnrichment / AgencyEnrichment success-case
  // documented-partial advisories (e.g. `geo:supplement`) into the
  // envelope. These are surfaced via the Tier B result objects, not
  // via a rejection, so they bypass `runDimensions`' failure trap.
  mergeEnrichmentDocumentedPartials(envelope, capturedResults);

  // Envelope is structurally a string-keyed object — cast widens it to
  // the handler-map return type `Record<string, unknown>` without
  // changing any field (§17.2 advisory-only shape preserved).
  return envelope as unknown as Record<string, unknown>;
};

// ────────────────────────────────────────────────────────────────────
// Wave 54 BE-W54-06 — 17. getExecutiveDashboardSnapshot
// ────────────────────────────────────────────────────────────────────
const getExecutiveDashboardSnapshot: ExecutiveToolHandler = async (
  params,
  ctx,
  deps,
) => {
  assertExecutiveRole(ctx);

  const planIdRaw = params.planId != null ? String(params.planId) : null;
  const planId = planIdRaw && UUID_RX.test(planIdRaw) ? planIdRaw : undefined;
  const scope = normaliseDslScope(params.scope);
  const limit = clampLimit(params.limit);
  const groupBy = parseGroupBy(params.groupBy);
  // W67 hotfix — defensive auto-include when groupBy needs an enrichment
  // dimension. Without this, an LLM call with `groupBy: ['status']` but
  // missing `includeStatus: true` silently produced "(ไม่ระบุ)" buckets
  // for every project, masking the real status counts behind a single
  // unspecified pile. Same pathology for amphoe (geo) / agency.
  // (`budget` is a totals dimension, not a bucket key; auto-include is
  // not needed for it because it cannot appear in `groupBy`.)
  //
  // W67 hotfix-3 — `includeStatus` defaults to TRUE for the executive
  // snapshot (matches the schema default flip in tool-registry). LLMs
  // habitually omit the flag, then fill the rule #11b 4-group template
  // with hallucinated zeros. Defaulting on guarantees
  // `data.executiveStatusBreakdown` is always populated when projects
  // exist. Explicit `includeStatus: false` still opts out.
  const includeBudget = Boolean(params.includeBudget);
  const includeStatus =
    params.includeStatus !== false || groupBy.includes('status');
  const includeGeo = Boolean(params.includeGeo) || groupBy.includes('amphoe');
  const includeAgency =
    Boolean(params.includeAgency) ||
    groupBy.includes('agency') ||
    groupBy.includes('responsibleAgency');
  const includeClassification = Boolean(params.includeClassification);
  // Wave 55 BE-W55-05 — §14.2 head-of-lineage filter (see getPlanOverview).
  const includeHistoricalVersions = Boolean(params.includeHistoricalVersions);
  // Wave 55 W55-BE-06 — forward DSL `filters` to the aggregator.
  const filters = parseFilters(params.filters);

  // Spine — UNWRAPPED.
  const projects = await deps.unifiedProject.listUnifiedProjects({
    planId,
    scope,
    limit,
    includeHistoricalVersions,
    filters,
  });

  const tasks: DimensionTask[] = [];
  if (includeBudget) {
    tasks.push({
      dimension: 'budget',
      run: () => deps.budget.totalsForUnifiedProjects(projects),
    });
  }
  if (includeStatus) {
    tasks.push({
      dimension: 'status',
      run: () => deps.status.latestStatusFor(projects),
    });
  }
  if (includeGeo) {
    tasks.push({
      dimension: 'geo',
      run: () => deps.geo.annotate(projects),
    });
  }
  if (includeAgency) {
    tasks.push({
      dimension: 'agency',
      run: () => deps.agency.annotate(projects),
    });
  }
  if (includeClassification) {
    tasks.push({
      dimension: 'classification',
      run: () => resolveCrossPlanClassification(projects, groupBy),
    });
  }

  // W67-LAO-RESOLVER — when `groupBy: ['lao']` is requested we need a
  // per-projectId LAO label map. UnifiedProject does NOT carry the LAO
  // FK directly (only `originType` is derived from the creator's
  // WorkHistory chain — a different concept). We compute the labels
  // inline via a single batched LEFT JOIN against the three project
  // tables BEFORE entering the runDimensions callback so the bucket
  // loop has synchronous access to the resolved Thai names. Failures
  // here are advisory only (§17.2) — the bucket falls back to the
  // sentinel string the same way `amphoe` / `agency` do.
  const wantsLaoBucket = groupBy.includes('lao');
  const laoLabels = wantsLaoBucket
    ? await fetchLaoLabelsForUnifiedProjects(deps, projects)
    : null;

  // W68-FIX-06 (D4) — pre-fetch classification (Strategy / Tactic /
  // Plan / DevelopmentIssue) Thai names when groupBy asks for any of
  // those dimensions. Pre-fix the bucket builder emitted FK ids as
  // bucket keys, producing prose like "ประเด็นการพัฒนา 1: 2 โครงการ".
  // Mirrors the LAO pre-fetch pattern above; auto-include is independent
  // of the existing `includeClassification` advisory flag (which gates a
  // shape-mismatch advisory only — see `resolveCrossPlanClassification`).
  // §17.7 — graceful NULL per inactive shape; §17.2 advisory only.
  const wantsClassificationBucket =
    groupBy.includes('strategy') ||
    groupBy.includes('planLevel') ||
    groupBy.includes('issue');
  const classificationLabels = wantsClassificationBucket
    ? await fetchClassificationLabelsForUnifiedProjects(deps, projects)
    : null;

  let capturedResults: ResilienceDimensionResult[] = [];
  const envelope = await deps.resilience.runDimensions(
    tasks,
    (results) => {
      capturedResults = results;
      const budgetMap = pickOk<Map<string, number>>(results, 'budget');
      const statusMap = pickOk<Map<string, LatestStatus>>(results, 'status');
      const geoResult = pickOk<GeoEnrichmentResult>(results, 'geo');
      const agencyResult = pickOk<AgencyEnrichmentResult>(results, 'agency');

      // groupBy aggregation — structured summaries only, no raw rows.
      const buckets: Record<
        string,
        Array<{ key: string; count: number; totalBudget?: number }>
      > = {};

      for (const key of groupBy) {
        const byBucket = new Map<
          string,
          { count: number; totalBudget: number }
        >();
        for (const p of projects) {
          let bucketKey: string | null = null;
          if (key === 'status') {
            // W67-FIX-01 — `groupBy:['status']` produces a Thai-keyed
            // bucket the LLM quotes verbatim (rule #11 in the prompt).
            // Use the Thai sibling `statusNameTh`; the canonical
            // English `statusName` is logic-only after the fix.
            const s = statusMap?.get(`${p.projectKind}:${p.projectId}`);
            bucketKey = s?.statusNameTh ?? '(ไม่ระบุ)';
          } else if (key === 'amphoe') {
            const label = geoResult?.labels.get(p.projectId);
            bucketKey = label?.amphoeName ?? '(ไม่ระบุ)';
          } else if (key === 'agency') {
            const label = agencyResult?.labels.get(p.projectId);
            bucketKey = label?.agencyName ?? 'ไม่ระบุ';
          } else if (key === 'strategy') {
            if (includeClassification && p.planReportFormat === 'ISSUE_BASED') {
              continue;
            }
            // W68-FIX-06 (D4) — emit Thai name (not FK UUID) so the LLM
            // can quote bucket keys verbatim per prompt rules
            // #11/#28/#37. Falls back to sentinel when the project has
            // no strategy FK or the resolver missed the row.
            const cl = classificationLabels?.get(p.projectId);
            bucketKey = cl?.strategyName ?? '(ไม่ระบุ)';
          } else if (key === 'issue') {
            if (
              includeClassification &&
              p.planReportFormat === 'STRATEGY_BASED'
            ) {
              continue;
            }
            // W68-FIX-06 (D4) — Thai DevelopmentIssue.name; see strategy
            // branch above.
            const cl = classificationLabels?.get(p.projectId);
            bucketKey = cl?.issueName ?? '(ไม่ระบุ)';
          } else if (key === 'planLevel') {
            if (includeClassification && p.planReportFormat === 'ISSUE_BASED') {
              continue;
            }
            // W68-FIX-06 (D4) — Thai Plan.name (the §16.5 "plan-level"
            // node); see strategy branch above.
            const cl = classificationLabels?.get(p.projectId);
            bucketKey = cl?.planLevelName ?? '(ไม่ระบุ)';
          } else if (key === 'originType') {
            // Wave 55 W55-BE-07 — derived project-origin discriminator.
            // Always present on every UnifiedProject (§1 + §5), so no
            // shape-mismatch branching is required.
            bucketKey = p.originType;
          } else if (key === 'lao') {
            // W67-LAO-RESOLVER — bucket by project's own
            // `local_administrative_organization_id` (resolved Thai name).
            // Falls back to the (ไม่ระบุ) sentinel matching `amphoe`'s
            // shape so the bucket envelope stays consistent across
            // dimensions when an FK is NULL.
            const label = laoLabels?.get(p.projectId);
            bucketKey = label?.laoName ?? '(ไม่ระบุ)';
          }
          if (bucketKey == null) continue;
          const cur = byBucket.get(bucketKey) ?? {
            count: 0,
            totalBudget: 0,
          };
          cur.count += 1;
          if (budgetMap) {
            cur.totalBudget +=
              budgetMap.get(`${p.projectKind}:${p.projectId}`) ?? 0;
          }
          byBucket.set(bucketKey, cur);
        }
        buckets[key] = [...byBucket.entries()].map(([k, v]) => {
          const out: { key: string; count: number; totalBudget?: number } = {
            key: k,
            count: v.count,
          };
          if (budgetMap) out.totalBudget = v.totalBudget;
          return out;
        });
      }

      const data: Record<string, unknown> = {
        planId: planId ?? null,
        scope,
        projectCount: projects.length,
        groupBy,
        buckets,
      };
      if (budgetMap) {
        let total = 0;
        for (const v of budgetMap.values()) total += v;
        data.totalBudget = total;
      }
      // W67-FIX-02 — `executiveStatusBreakdown` is now sourced from a
      // direct DB COUNT path (see
      // `UnifiedProjectAggregator.countExecutiveStatusBreakdown`) and
      // is wired in AFTER `runDimensions` returns, NOT from the
      // limit-capped `statusMap` here. Reasons:
      //   1. The list path uses `splitBudget` (40/35/25 across `all`
      //      scope) and a DSL-clamped `limit` — for an account with
      //      e.g. 11 main projects the list returns only 8 main rows,
      //      so a rollup over `statusMap` under-reported by 3.
      //   2. The breakdown is meant to convey TOTALS for the executive
      //      view; truncation by token-budget is a list-display
      //      concern, not a totals concern.
      // §14.2 head-of-lineage is still respected — the count helper
      // applies the SAME anti-join when
      // `includeHistoricalVersions=false`. §17.2 advisory-only — the
      // breakdown does not gate any workflow transition.
      //
      // The per-row `groupBy:['status']` bucket builder above remains
      // limit-capped on purpose: it powers the project-list rendering
      // ("8 visible main projects, here's how they split"), not the
      // headline totals.
      return data;
    },
    { shape: 'dashboardSnapshot' },
  );

  // W67-FIX-02 — direct-COUNT path. Runs ONLY when the caller wants
  // status (matches the `includeStatus` gate above). Honors the SAME
  // planId / scope / filters / includeHistoricalVersions the list
  // call used so the count window matches the list semantics.
  if (includeStatus) {
    try {
      const breakdown = await deps.unifiedProject.countExecutiveStatusBreakdown(
        {
          planId,
          scope,
          filters,
          includeHistoricalVersions,
        },
      );
      // Cast through `unknown` because `envelope` is typed as the
      // ExecutiveEnvelope generic; the field merge here is a benign
      // augmentation of `data` post-runDimensions and matches the
      // pre-FIX-02 shape of `data.executiveStatusBreakdown`.
      const env = envelope as unknown as { data: Record<string, unknown> };
      env.data.executiveStatusBreakdown = breakdown;
    } catch {
      // §17.2 advisory-only — a failure of the count path MUST NOT
      // throw out of the snapshot handler. Leave
      // `executiveStatusBreakdown` undefined so the LLM falls back to
      // the per-row buckets (still truncated, but at least populated).
    }
  }

  // W67-FIX-B — opt-in hierarchical drill-down. Default OFF (Q1
  // opt-in). When `includeStatusDrill: true` AND status is requested,
  // attach `data.statusBreakdownByBook[]` so prompt rule #39 can
  // render the nested-bullets hierarchy. Failures are advisory-only
  // (§17.2) — they MUST NOT throw out of the snapshot handler.
  //
  // W68-FIX-12 (2026-04-28) — defensive auto-include when filters narrow
  // the result set to a specific entity (laoIds / agencyIds). The user
  // intent is clearly "show me projects for this LAO/agency" so the
  // drill output is what they want. gpt-4.1-mini sometimes forgets to
  // set the flag despite rule #39 trigger words; this server-side gate
  // makes the behavior reliable. Same pattern as HOTFIX-2 auto-include
  // for status enrichment when groupBy needs it.
  const focusedEntityFilter =
    (Array.isArray((filters as { laoIds?: unknown[] })?.laoIds) &&
      ((filters as { laoIds?: unknown[] }).laoIds?.length ?? 0) > 0) ||
    (Array.isArray((filters as { agencyIds?: unknown[] })?.agencyIds) &&
      ((filters as { agencyIds?: unknown[] }).agencyIds?.length ?? 0) > 0);
  const includeStatusDrill =
    params.includeStatusDrill === true || focusedEntityFilter;
  if (includeStatus && includeStatusDrill) {
    try {
      const drill = await deps.unifiedProject.groupedExecutiveStatusBreakdown({
        planId,
        scope,
        filters,
        includeHistoricalVersions,
      });
      const env = envelope as unknown as { data: Record<string, unknown> };
      env.data.statusBreakdownByBook = drill.books;
    } catch {
      // §17.2 advisory-only.
    }
  }

  // Wave 103 PR2 — canonical aggregator reroute (Q1's tool path).
  //
  // When `EXECUTIVE_AI_CANONICAL_AGENCY_AGGREGATOR=true` AND the caller
  // narrowed the query to a specific agency (`filters.agencyIds`), the
  // canonical aggregator (PR1) is the source of truth for `count` /
  // `budgetTotal` / per-book rollup. The legacy `listUnifiedProjects`
  // spine still ran above (it powers the per-`groupBy` buckets, status
  // breakdown, geo / agency enrichments) so the response shape — every
  // existing field — is preserved byte-for-byte.
  //
  // Side-by-side telemetry (logged inside the aggregator service via
  // `Logger.warn`) compares the canonical envelope against the legacy
  // dashboard count for the first 24-48h after deploy. The flag-OFF
  // path remains the only source of truth for non-agency queries
  // (`agencyIds` empty) — those drop straight through to the legacy
  // path with zero behavior change.
  //
  // §17.2 advisory only — never gates a workflow transition. §17.3
  // read-only — no `tracking_status` writes. §11 / §14 / §15 — the
  // canonical aggregator is lineage-aware (HEAD-of-lineage anti-join)
  // and book-frozenness-aware (status policy split per `dp.isLatest`).
  try {
    await applyCanonicalAggregatorReroute({
      deps,
      envelope,
      filters,
      legacyCount: (envelope as unknown as { data: Record<string, unknown> })
        .data.projectCount as number,
      legacyBudget: (envelope as unknown as { data: Record<string, unknown> })
        .data.totalBudget as number | undefined,
      planId,
      legacyKind: 'dashboard',
    });
  } catch {
    // Aggregator failure MUST NOT throw out of the snapshot handler —
    // the legacy envelope is already intact and is the safe fallback.
    // §17.2 advisory only.
  }

  mergeEnrichmentDocumentedPartials(envelope, capturedResults);

  // Envelope is structurally a string-keyed object — cast widens it to
  // the handler-map return type `Record<string, unknown>` without
  // changing any field (§17.2 advisory-only shape preserved).
  return envelope as unknown as Record<string, unknown>;
};

/**
 * Wave 103 PR2 — shared canonical-aggregator reroute helper used by
 * `getExecutiveDashboardSnapshot` and `getCrossPlanInsights`.
 *
 * When the feature flag is OFF, or the caller has not narrowed the
 * query to a specific agency, the helper is a no-op. Otherwise it
 * calls `AgencyProjectsCanonicalAggregatorService.computeWithLegacyComparison`
 * — which runs the canonical query AND emits a side-by-side log line
 * comparing the canonical result against the legacy `count` / `budget`
 * — and overrides `data.projectCount` / `data.totalBudget` /
 * `data.byBook` on the envelope.
 *
 * The override is in-place (mutating `envelope.data`) because the
 * envelope was assembled by the resilience layer and the response
 * shape must remain byte-for-byte identical for the LLM contract. We
 * are swapping VALUES, not field names.
 *
 * MUST be awaited by the caller; the inline `.catch(() => {})` at the
 * call site keeps a flag-on aggregator failure from rejecting the
 * outer handler promise (advisory-only per §17.2).
 */
async function applyCanonicalAggregatorReroute(args: {
  deps: ExecutiveToolHandlerDeps;
  envelope: unknown;
  filters: UnifiedFilters | undefined;
  legacyCount: number;
  legacyBudget: number | undefined;
  planId: string | undefined;
  legacyKind: 'dashboard' | 'crossPlan';
}): Promise<void> {
  if (!isCanonicalAgencyAggregatorEnabled()) return;
  const aggregator = args.deps.agencyProjectsCanonical;
  if (!aggregator) return;

  // Coerce string-shaped agencyIds (parseFilters output) back to numbers
  // — the canonical aggregator's `IN (:...mainAgencyIds)` parameter
  // accepts numbers from PostgreSQL's bigint coercion, and the
  // `government_agencies.id` column is a serial integer.
  const rawAgencyIds = args.filters?.agencyIds ?? [];
  const agencyIds: number[] = [];
  for (const v of rawAgencyIds) {
    const n = Number(v);
    if (Number.isFinite(n) && Number.isInteger(n) && n > 0) {
      agencyIds.push(n);
    }
  }

  // Non-agency questions stay on the legacy path. The canonical
  // aggregator only understands "agency-scoped" queries — answering a
  // generic "how many projects in plan X" without an agency filter is
  // out of scope for PR1 / PR2.
  if (agencyIds.length === 0) return;

  const legacyEntry = {
    count: Number.isFinite(args.legacyCount) ? args.legacyCount : 0,
    budget:
      typeof args.legacyBudget === 'number' &&
      Number.isFinite(args.legacyBudget)
        ? args.legacyBudget
        : 0,
  };

  const canonical = await aggregator.computeWithLegacyComparison(
    { agencyIds, planId: args.planId },
    args.legacyKind === 'dashboard'
      ? { dashboard: legacyEntry }
      : { crossPlan: legacyEntry },
  );

  // In-place override of the value-bearing scalars + per-book rollup.
  // Field names are unchanged — the LLM response template stays stable.
  const env = args.envelope as { data: Record<string, unknown> };
  env.data.projectCount = canonical.count;
  if (env.data.totalBudget !== undefined || canonical.budgetTotal > 0) {
    env.data.totalBudget = canonical.budgetTotal;
  }
  env.data.byBook = canonical.byBook;
}

/**
 * Cross-plan classification resolver for dashboard snapshot: surfaces
 * a shape advisory only when groupBy asks for a shape that NO plan in
 * the batch supports (design §5.3). Mixed-format batches silently skip
 * mismatched rows without advising.
 */
async function resolveCrossPlanClassification(
  projects: { planReportFormat: string | null }[],
  groupBy: GroupByKey[],
): Promise<{ ok: true }> {
  const hasStrategyPlan = projects.some(
    (p) => p.planReportFormat === 'STRATEGY_BASED',
  );
  const hasIssuePlan = projects.some(
    (p) => p.planReportFormat === 'ISSUE_BASED',
  );
  const wantsStrategyShape = groupBy.some(
    (g) => g === 'strategy' || g === 'planLevel',
  );
  const wantsIssueShape = groupBy.includes('issue');
  if (wantsIssueShape && hasStrategyPlan && !hasIssuePlan) {
    throw new ClassificationShapeError(CLASSIFICATION_SHAPE_STRATEGY);
  }
  if (wantsStrategyShape && hasIssuePlan && !hasStrategyPlan) {
    throw new ClassificationShapeError(CLASSIFICATION_SHAPE_ISSUE);
  }
  return { ok: true };
}

// ────────────────────────────────────────────────────────────────────
// Wave 54 BE-W54-06 — 18. getCrossPlanInsights
// ────────────────────────────────────────────────────────────────────
const getCrossPlanInsights: ExecutiveToolHandler = async (
  params,
  ctx,
  deps,
) => {
  assertExecutiveRole(ctx);

  // Schema forbids `planId` at this tool — defensively strip anything
  // the validator let through.
  const scope = normaliseDslScope(params.scope);
  const limit = clampLimit(params.limit);
  const includeBudget = Boolean(params.includeBudget);
  const includeStatus = Boolean(params.includeStatus);
  const includeGeo = Boolean(params.includeGeo);
  const includeAgency = Boolean(params.includeAgency);
  const groupBy = parseGroupBy(params.groupBy);
  // Wave 55 BE-W55-05 — §14.2 head-of-lineage filter (see getPlanOverview).
  const includeHistoricalVersions = Boolean(params.includeHistoricalVersions);
  // Wave 55 W55-BE-06 — forward DSL `filters` to the aggregator.
  const filters = parseFilters(params.filters);

  // Spine — UNWRAPPED. Cross-plan roll-up has no planId scoping.
  const projects = await deps.unifiedProject.listUnifiedProjects({
    scope,
    limit,
    includeHistoricalVersions,
    filters,
  });

  const tasks: DimensionTask[] = [];
  if (includeBudget) {
    tasks.push({
      dimension: 'budget',
      run: () => deps.budget.totalsForUnifiedProjects(projects),
    });
  }
  if (includeStatus) {
    tasks.push({
      dimension: 'status',
      run: () => deps.status.latestStatusFor(projects),
    });
  }
  if (includeGeo) {
    tasks.push({
      dimension: 'geo',
      run: () => deps.geo.annotate(projects),
    });
  }
  if (includeAgency) {
    tasks.push({
      dimension: 'agency',
      run: () => deps.agency.annotate(projects),
    });
  }

  // W67-LAO-RESOLVER — see getExecutiveDashboardSnapshot for the
  // rationale; same inline LAO label pre-fetch when groupBy includes
  // 'lao' (cross-plan rollup also benefits from the per-LAO bucket).
  const wantsLaoBucketCrossPlan = groupBy.includes('lao');
  const laoLabelsCrossPlan = wantsLaoBucketCrossPlan
    ? await fetchLaoLabelsForUnifiedProjects(deps, projects)
    : null;

  let capturedResults: ResilienceDimensionResult[] = [];
  const envelope = await deps.resilience.runDimensions(
    tasks,
    (results) => {
      capturedResults = results;
      const budgetMap = pickOk<Map<string, number>>(results, 'budget');
      const statusMap = pickOk<Map<string, LatestStatus>>(results, 'status');
      const geoResult = pickOk<GeoEnrichmentResult>(results, 'geo');
      const agencyResult = pickOk<AgencyEnrichmentResult>(results, 'agency');

      // Per-plan roll-up — count / total budget per planId.
      const perPlan = new Map<
        string,
        {
          planId: string;
          reportFormat: string;
          projectCount: number;
          totalBudget: number;
        }
      >();
      for (const p of projects) {
        const cur = perPlan.get(p.planId) ?? {
          planId: p.planId,
          reportFormat: p.planReportFormat,
          projectCount: 0,
          totalBudget: 0,
        };
        cur.projectCount += 1;
        if (budgetMap) {
          cur.totalBudget +=
            budgetMap.get(`${p.projectKind}:${p.projectId}`) ?? 0;
        }
        perPlan.set(p.planId, cur);
      }
      const plans = [...perPlan.values()].sort(
        (a, b) => b.projectCount - a.projectCount,
      );

      // Optional groupBy cross-plan roll-up.
      const buckets: Record<string, Array<{ key: string; count: number }>> = {};
      for (const key of groupBy) {
        const byBucket = new Map<string, number>();
        for (const p of projects) {
          let bucketKey: string | null = null;
          if (key === 'status') {
            // W67-FIX-01 — Thai-keyed bucket for LLM display; use
            // `statusNameTh` (English `statusName` is logic-only).
            const s = statusMap?.get(`${p.projectKind}:${p.projectId}`);
            bucketKey = s?.statusNameTh ?? '(ไม่ระบุ)';
          } else if (key === 'amphoe') {
            const label = geoResult?.labels.get(p.projectId);
            bucketKey = label?.amphoeName ?? '(ไม่ระบุ)';
          } else if (key === 'agency') {
            const label = agencyResult?.labels.get(p.projectId);
            bucketKey = label?.agencyName ?? 'ไม่ระบุ';
          } else if (key === 'originType') {
            // Wave 55 W55-BE-07 — derived project-origin discriminator,
            // meaningful at cross-plan level (§1 + §5).
            bucketKey = p.originType;
          } else if (key === 'lao') {
            // W67-LAO-RESOLVER — cross-plan per-LAO bucket.
            const label = laoLabelsCrossPlan?.get(p.projectId);
            bucketKey = label?.laoName ?? '(ไม่ระบุ)';
          } else {
            // Classification dimensions are inherently plan-scoped; skip
            // silently at cross-plan level.
            continue;
          }
          if (bucketKey == null) continue;
          byBucket.set(bucketKey, (byBucket.get(bucketKey) ?? 0) + 1);
        }
        buckets[key] = [...byBucket.entries()].map(([k, v]) => ({
          key: k,
          count: v,
        }));
      }

      const data: Record<string, unknown> = {
        scope,
        projectCount: projects.length,
        planCount: plans.length,
        plans,
        groupBy,
        buckets,
      };
      if (budgetMap) {
        let total = 0;
        for (const v of budgetMap.values()) total += v;
        data.totalBudget = total;
      }
      return data;
    },
    { shape: 'crossPlanInsights' },
  );

  // Wave 103 PR2 — canonical aggregator reroute (Q2's tool path).
  //
  // Cross-plan tool by definition has NO `planId` (the schema forbids
  // it; we pass `planId: undefined` so the aggregator's "all books"
  // default applies — matching this tool's semantic). When the flag
  // is ON AND the caller narrowed to a specific agency, the canonical
  // aggregator answers `count` / `budgetTotal` / `byBook`. The legacy
  // `plans[]` per-plan rollup remains intact (it powers the LLM's
  // per-book breakdown and is computed from `listUnifiedProjects`).
  //
  // Side-by-side telemetry on the legacy crossPlan count is logged
  // inside `computeWithLegacyComparison`. §17.2 / §17.3 / §11 / §14 /
  // §15 — see helper docstring above.
  try {
    await applyCanonicalAggregatorReroute({
      deps,
      envelope,
      filters,
      legacyCount: (envelope as unknown as { data: Record<string, unknown> })
        .data.projectCount as number,
      legacyBudget: (envelope as unknown as { data: Record<string, unknown> })
        .data.totalBudget as number | undefined,
      planId: undefined,
      legacyKind: 'crossPlan',
    });
  } catch {
    // §17.2 advisory only — fall back to the legacy envelope intact.
  }

  mergeEnrichmentDocumentedPartials(envelope, capturedResults);

  // Envelope is structurally a string-keyed object — cast widens it to
  // the handler-map return type `Record<string, unknown>` without
  // changing any field (§17.2 advisory-only shape preserved).
  return envelope as unknown as Record<string, unknown>;
};

// ────────────────────────────────────────────────────────────────────
// Wave 61 — Mode 3 lineage handlers.
//
// `getProjectHeadBook` answers "เล่มล่าสุดของโครงการ X" via
// `ProjectLineageService.getProjectHeadBook`. `getProjectLineage`
// answers "ไทม์ไลน์โครงการ X" via `ProjectLineageService.getProjectLineage`.
//
// Both handlers re-assert §17.11 role/workStatus, then delegate to the
// Tier B service. The result is reshaped to drop any `null` scalar so
// the in-house schema validator (which has no nullable-scalar shape)
// doesn't reject otherwise-correct envelopes — mirrors the
// "nullable-via-required-only" convention used in `listProjectsInPlan`.
// ────────────────────────────────────────────────────────────────────

function stripNulls<T extends Record<string, unknown>>(row: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out as T;
}

const getProjectHeadBook: ExecutiveToolHandler = async (params, ctx, deps) => {
  assertExecutiveRole(ctx);
  const projectId = String(params.projectId ?? '');
  if (!projectId) throw new Error('PROJECT_ID_REQUIRED');
  if (!deps.projectLineage) {
    return {
      projectId,
      headProjectId: projectId,
      headBookLabel: '',
      headBookType: 'main',
      isInputHead: true,
      advisories: ['lineage-service-unavailable'],
      asOf: new Date().toISOString(),
    };
  }
  const result = await deps.projectLineage.getProjectHeadBook(projectId);
  if (!result) {
    return {
      projectId,
      headProjectId: projectId,
      headBookLabel: '',
      headBookType: 'main',
      isInputHead: true,
      advisories: ['project-not-found'],
      asOf: new Date().toISOString(),
    };
  }
  return stripNulls({
    projectId: result.projectId,
    headProjectId: result.headProjectId,
    headBookLabel: result.headBookLabel,
    headBookType: result.headBookType,
    headRevisionNumber: result.headRevisionNumber,
    headDprId: result.headDprId,
    headDpsId: result.headDpsId,
    isInputHead: result.isInputHead,
    advisories: result.advisories,
    asOf: result.asOf,
  });
};

const getProjectLineage: ExecutiveToolHandler = async (params, ctx, deps) => {
  assertExecutiveRole(ctx);
  const projectId = String(params.projectId ?? '');
  if (!projectId) throw new Error('PROJECT_ID_REQUIRED');
  if (!deps.projectLineage) {
    return {
      projectId,
      rootProjectId: projectId,
      headProjectId: projectId,
      chain: [],
      advisories: ['lineage-service-unavailable'],
      asOf: new Date().toISOString(),
    };
  }
  const result = await deps.projectLineage.getProjectLineage(projectId);
  if (!result) {
    return {
      projectId,
      rootProjectId: projectId,
      headProjectId: projectId,
      chain: [],
      advisories: ['project-not-found'],
      asOf: new Date().toISOString(),
    };
  }
  return {
    projectId: result.projectId,
    rootProjectId: result.rootProjectId,
    headProjectId: result.headProjectId,
    chain: result.chain.map((s) => stripNulls({ ...s })),
    advisories: result.advisories,
    asOf: result.asOf,
  };
};

// ────────────────────────────────────────────────────────────────────
// Wave 66 W66-BE-AGG-01 — listProjectsWithoutResponsibleAgency
//
// Dedicated lister + counter for the "ไม่มีหน่วยงานรับผิดชอบ" question
// (responsible_agency_id IS NULL). Walks THREE source tables:
//   - PG joined to DevelopmentPlan (main)
//   - RPG joined to DevelopmentPlanRevision filtered to type='แก้ไข' / edit
//   - RPG joined to DevelopmentPlanRevision filtered to type='เปลี่ยนแปลง' / change
//
// Disambiguates from `getTeamWorkloadSummary.inReviewCount` per W57 rule
// #26 — null FK is a DATA STATE, NOT a workflow status. Returns BOTH
// `totalCount` + `scopeBreakdown` + `items[]` so the LLM never has to
// confuse the two surfaces (W66-BE-PROMPT-01 codifies the routing).
//
// §17.2 advisory only. §17.3 read-only — no mutation. §17.7 — does NOT
// read classification fields, safe across both reportFormat values.
// §17.11 — `assertExecutiveRole` enforced.
// Wave 54 — entity property paths only (no raw SQL literals).
// ────────────────────────────────────────────────────────────────────

const listProjectsWithoutResponsibleAgency: ExecutiveToolHandler = async (
  params,
  ctx,
  deps,
) => {
  assertExecutiveRole(ctx);

  const planIdRaw = params.planId != null ? String(params.planId).trim() : '';
  const planId =
    planIdRaw.length > 0 && UUID_RX.test(planIdRaw) ? planIdRaw : null;

  const scopeRaw = String(params.scope ?? 'all').toLowerCase();
  const scope: 'all' | 'main' | 'edit' | 'change' =
    scopeRaw === 'main' || scopeRaw === 'edit' || scopeRaw === 'change'
      ? scopeRaw
      : 'all';

  const limit = Math.min(Math.max(Number(params.limit ?? 50), 1), 100);

  // Quota split when scope='all' — main 50% / edit 25% / change 25%.
  // Each quota is the per-branch row CEILING; the totalCount is computed
  // independently and reflects the FULL truth across all three branches
  // (not capped by the items budget).
  const mainQuota =
    scope === 'all'
      ? Math.max(1, Math.ceil(limit * 0.5))
      : scope === 'main'
        ? limit
        : 0;
  const editQuota =
    scope === 'all'
      ? Math.max(1, Math.ceil(limit * 0.25))
      : scope === 'edit'
        ? limit
        : 0;
  const changeQuota =
    scope === 'all'
      ? Math.max(0, limit - mainQuota - editQuota)
      : scope === 'change'
        ? limit
        : 0;

  const items: Array<Record<string, unknown>> = [];
  let mainCount = 0;
  let editCount = 0;
  let changeCount = 0;

  // ── Branch A — ProjectGroup (main plan) ─────────────────────────────
  if (scope === 'all' || scope === 'main') {
    // Full count first (independent of items quota).
    const mainCountQb = deps.dataSource
      .getRepository(ProjectGroup)
      .createQueryBuilder('pg')
      .innerJoin('pg.developmentPlan', 'dp')
      .where('pg.responsible_agency_id IS NULL')
      .andWhere('pg.deletedAt IS NULL')
      .andWhere('dp.deletedAt IS NULL');
    if (planId) {
      mainCountQb.andWhere('dp.id = :planId', { planId });
    }
    mainCount = await mainCountQb.getCount();

    // W66c — always issue list QB when quota allows; the count short-circuit
    // mis-aligned mock indices in unit tests (off-by-one when early branches
    // had 0 count but later branches had data). Empty getRawMany is cheap.
    if (mainQuota > 0) {
      const mainListQb = deps.dataSource
        .getRepository(ProjectGroup)
        .createQueryBuilder('pg')
        .select('pg.id', 'pgid')
        .addSelect('pg.title', 'title')
        .addSelect('pg.pageNumber', 'pagenumber')
        .addSelect('status.name', 'statusname')
        .addSelect('dp.id', 'planid')
        .addSelect('dp.name', 'planname')
        .addSelect('pg_amp.name', 'amphoename')
        .addSelect('pg_lao.name', 'laoname')
        .addSelect(
          (subQb: SelectQueryBuilder<Budget>) =>
            subQb
              .select('COALESCE(SUM(b.quantity), 0)')
              .from(Budget, 'b')
              .where('b.project_group_id = pg.id'),
          'budget',
        )
        .innerJoin('pg.developmentPlan', 'dp')
        .leftJoin('pg.amphoe', 'pg_amp')
        .leftJoin('pg.localAdministrativeOrganization', 'pg_lao')
        .leftJoin('pg.trackingStatus', 'ts', 'ts.isLatest = true')
        .leftJoin('ts.statusId', 'status')
        .where('pg.responsible_agency_id IS NULL')
        .andWhere('pg.deletedAt IS NULL')
        .andWhere('dp.deletedAt IS NULL');
      if (planId) {
        mainListQb.andWhere('dp.id = :planId', { planId });
      }
      mainListQb
        .orderBy('pg.pageNumber', 'ASC', 'NULLS LAST')
        .addOrderBy('pg.title', 'ASC')
        .limit(mainQuota);

      const rows: Array<{
        pgid: string;
        title: string | null;
        pagenumber: number | null;
        statusname: string | null;
        planid: string;
        planname: string | null;
        amphoename: string | null;
        laoname: string | null;
        budget: string | null;
      }> = await mainListQb.getRawMany();

      for (const r of rows) {
        items.push(
          buildPendingAgencyEntry({
            projectId: r.pgid,
            projectKind: 'main',
            title: r.title,
            statusname: r.statusname,
            planId: r.planid,
            planName: r.planname,
            revisionRoundLabel: null,
            revisionRoundId: null,
            pageNumber: r.pagenumber,
            budget: r.budget,
            amphoeName: r.amphoename,
            laoName: r.laoname,
          }),
        );
      }
    }
  }

  // ── Branch B — RevisedProjectGroup with revisionType = edit ─────────
  if (scope === 'all' || scope === 'edit') {
    const editCountQb = deps.dataSource
      .getRepository(RevisedProjectGroup)
      .createQueryBuilder('rpg')
      .innerJoin('rpg.developmentPlanRevision', 'dpr')
      .innerJoin('dpr.revisionType', 'rt')
      .innerJoin('dpr.developmentPlan', 'dp')
      .where('rpg.responsible_agency_id IS NULL')
      .andWhere('rpg.deletedAt IS NULL')
      .andWhere('dpr.deletedAt IS NULL')
      .andWhere('dp.deletedAt IS NULL')
      .andWhere('(rt.name = :nameTh OR LOWER(rt.name) = :nameEn)', {
        nameTh: 'แก้ไข',
        nameEn: 'edit',
      });
    if (planId) {
      editCountQb.andWhere('dp.id = :planId', { planId });
    }
    editCount = await editCountQb.getCount();

    if (editQuota > 0) {
      const editListQb = deps.dataSource
        .getRepository(RevisedProjectGroup)
        .createQueryBuilder('rpg')
        .select('rpg.id', 'rpgid')
        .addSelect('rpg.title', 'title')
        .addSelect('rpg.pageNumber', 'pagenumber')
        .addSelect('status.name', 'statusname')
        .addSelect('dp.id', 'planid')
        .addSelect('dp.name', 'planname')
        .addSelect('dpr.id', 'dprid')
        .addSelect('dpr.revision_number', 'revisionnumber')
        .addSelect('dpr.description', 'dprdescription')
        .addSelect('rpg_amp.name', 'amphoename')
        .addSelect('rpg_lao.name', 'laoname')
        .addSelect(
          (subQb: SelectQueryBuilder<Budget>) =>
            subQb
              .select('COALESCE(SUM(b.quantity), 0)')
              .from(Budget, 'b')
              .where('b.revised_project_group_id = rpg.id'),
          'budget',
        )
        .innerJoin('rpg.developmentPlanRevision', 'dpr')
        .innerJoin('dpr.revisionType', 'rt')
        .innerJoin('dpr.developmentPlan', 'dp')
        .leftJoin('rpg.amphoe', 'rpg_amp')
        .leftJoin('rpg.localAdministrativeOrganization', 'rpg_lao')
        .leftJoin('rpg.trackingStatus', 'ts', 'ts.isLatest = true')
        .leftJoin('ts.statusId', 'status')
        .where('rpg.responsible_agency_id IS NULL')
        .andWhere('rpg.deletedAt IS NULL')
        .andWhere('dpr.deletedAt IS NULL')
        .andWhere('dp.deletedAt IS NULL')
        .andWhere('(rt.name = :nameTh OR LOWER(rt.name) = :nameEn)', {
          nameTh: 'แก้ไข',
          nameEn: 'edit',
        });
      if (planId) {
        editListQb.andWhere('dp.id = :planId', { planId });
      }
      editListQb
        .orderBy('rpg.pageNumber', 'ASC', 'NULLS LAST')
        .addOrderBy('rpg.title', 'ASC')
        .limit(editQuota);

      const rows: Array<{
        rpgid: string;
        title: string | null;
        pagenumber: number | null;
        statusname: string | null;
        planid: string;
        planname: string | null;
        dprid: string | null;
        revisionnumber: number | null;
        dprdescription: string | null;
        amphoename: string | null;
        laoname: string | null;
        budget: string | null;
      }> = await editListQb.getRawMany();

      for (const r of rows) {
        const label = resolveRevisionRoundLabel({
          type: 'edit',
          number: r.revisionnumber,
          description: r.dprdescription,
        });
        items.push(
          buildPendingAgencyEntry({
            projectId: r.rpgid,
            projectKind: 'edit',
            title: r.title,
            statusname: r.statusname,
            planId: r.planid,
            planName: r.planname,
            revisionRoundLabel: label,
            revisionRoundId: r.dprid,
            pageNumber: r.pagenumber,
            budget: r.budget,
            amphoeName: r.amphoename,
            laoName: r.laoname,
          }),
        );
      }
    }
  }

  // ── Branch C — RevisedProjectGroup with revisionType = change ───────
  if (scope === 'all' || scope === 'change') {
    const changeCountQb = deps.dataSource
      .getRepository(RevisedProjectGroup)
      .createQueryBuilder('rpg')
      .innerJoin('rpg.developmentPlanRevision', 'dpr')
      .innerJoin('dpr.revisionType', 'rt')
      .innerJoin('dpr.developmentPlan', 'dp')
      .where('rpg.responsible_agency_id IS NULL')
      .andWhere('rpg.deletedAt IS NULL')
      .andWhere('dpr.deletedAt IS NULL')
      .andWhere('dp.deletedAt IS NULL')
      .andWhere('(rt.name = :nameTh OR LOWER(rt.name) = :nameEn)', {
        nameTh: 'เปลี่ยนแปลง',
        nameEn: 'change',
      });
    if (planId) {
      changeCountQb.andWhere('dp.id = :planId', { planId });
    }
    changeCount = await changeCountQb.getCount();

    if (changeQuota > 0) {
      const changeListQb = deps.dataSource
        .getRepository(RevisedProjectGroup)
        .createQueryBuilder('rpg')
        .select('rpg.id', 'rpgid')
        .addSelect('rpg.title', 'title')
        .addSelect('rpg.pageNumber', 'pagenumber')
        .addSelect('status.name', 'statusname')
        .addSelect('dp.id', 'planid')
        .addSelect('dp.name', 'planname')
        .addSelect('dpr.id', 'dprid')
        .addSelect('dpr.revision_number', 'revisionnumber')
        .addSelect('dpr.description', 'dprdescription')
        .addSelect('rpg_amp.name', 'amphoename')
        .addSelect('rpg_lao.name', 'laoname')
        .addSelect(
          (subQb: SelectQueryBuilder<Budget>) =>
            subQb
              .select('COALESCE(SUM(b.quantity), 0)')
              .from(Budget, 'b')
              .where('b.revised_project_group_id = rpg.id'),
          'budget',
        )
        .innerJoin('rpg.developmentPlanRevision', 'dpr')
        .innerJoin('dpr.revisionType', 'rt')
        .innerJoin('dpr.developmentPlan', 'dp')
        .leftJoin('rpg.amphoe', 'rpg_amp')
        .leftJoin('rpg.localAdministrativeOrganization', 'rpg_lao')
        .leftJoin('rpg.trackingStatus', 'ts', 'ts.isLatest = true')
        .leftJoin('ts.statusId', 'status')
        .where('rpg.responsible_agency_id IS NULL')
        .andWhere('rpg.deletedAt IS NULL')
        .andWhere('dpr.deletedAt IS NULL')
        .andWhere('dp.deletedAt IS NULL')
        .andWhere('(rt.name = :nameTh OR LOWER(rt.name) = :nameEn)', {
          nameTh: 'เปลี่ยนแปลง',
          nameEn: 'change',
        });
      if (planId) {
        changeListQb.andWhere('dp.id = :planId', { planId });
      }
      changeListQb
        .orderBy('rpg.pageNumber', 'ASC', 'NULLS LAST')
        .addOrderBy('rpg.title', 'ASC')
        .limit(changeQuota);

      const rows: Array<{
        rpgid: string;
        title: string | null;
        pagenumber: number | null;
        statusname: string | null;
        planid: string;
        planname: string | null;
        dprid: string | null;
        revisionnumber: number | null;
        dprdescription: string | null;
        amphoename: string | null;
        laoname: string | null;
        budget: string | null;
      }> = await changeListQb.getRawMany();

      for (const r of rows) {
        const label = resolveRevisionRoundLabel({
          type: 'change',
          number: r.revisionnumber,
          description: r.dprdescription,
        });
        items.push(
          buildPendingAgencyEntry({
            projectId: r.rpgid,
            projectKind: 'change',
            title: r.title,
            statusname: r.statusname,
            planId: r.planid,
            planName: r.planname,
            revisionRoundLabel: label,
            revisionRoundId: r.dprid,
            pageNumber: r.pagenumber,
            budget: r.budget,
            amphoeName: r.amphoename,
            laoName: r.laoname,
          }),
        );
      }
    }
  }

  return {
    planId,
    totalCount: mainCount + editCount + changeCount,
    scopeBreakdown: {
      main: mainCount,
      edit: editCount,
      change: changeCount,
    },
    items,
    asOf: nowIso(),
  };
};

interface BuildPendingAgencyEntryArgs {
  projectId: string;
  projectKind: 'main' | 'edit' | 'change';
  title: string | null;
  statusname: string | null;
  planId: string;
  planName: string | null;
  revisionRoundLabel: string | null;
  revisionRoundId: string | null;
  pageNumber: number | null;
  budget: string | null;
  amphoeName: string | null;
  laoName: string | null;
}

/**
 * Wave 66 W66-BE-AGG-01 — per-row envelope shaper for the
 * "no responsibleAgency" lister. The disclosure copy is hard-wired to
 * W57 rule #26 because every row in this lister has a NULL FK by
 * construction. The §5 origin-type classifier is NOT invoked here — the
 * agency-vs-LAO distinction is irrelevant for this surface; the question
 * is simply "which projects have no responsible agency" and the answer
 * always carries the same disclosure.
 */
function buildPendingAgencyEntry(
  args: BuildPendingAgencyEntryArgs,
): Record<string, unknown> {
  const trimmedAmphoeName =
    typeof args.amphoeName === 'string' ? args.amphoeName.trim() : '';
  const amphoeName = trimmedAmphoeName.length > 0 ? trimmedAmphoeName : null;
  const trimmedLaoName =
    typeof args.laoName === 'string' ? args.laoName.trim() : '';
  const laoName = trimmedLaoName.length > 0 ? trimmedLaoName : null;
  const pageNumber =
    typeof args.pageNumber === 'number' && Number.isFinite(args.pageNumber)
      ? Number(args.pageNumber)
      : null;
  const budget = Number(args.budget) || 0;
  const entry: Record<string, unknown> = {
    projectId: args.projectId,
    projectKind: args.projectKind,
    title: args.title ?? '',
    statusname: args.statusname ?? null,
    statusTh: toThaiStatus(args.statusname ?? null),
    // W67-BE-AGG-01 — computed 4-group executive rollup. Nullable when
    // status is workflow-internal (Ready / Pull_Back / Returned_For_Revision)
    // or when the row has no tracking status yet.
    executiveStatus: mapToExecutiveStatusGroup(args.statusname ?? null),
    planId: args.planId,
    planName: args.planName ?? '',
    revisionRoundLabel: args.revisionRoundLabel,
    revisionRoundId: args.revisionRoundId,
    pageNumber,
    budget,
    amphoeName,
    laoName,
    responsibleAgencyDisclosure: PENDING_RESPONSIBLE_AGENCY_DISCLOSURE,
  };
  // Belt-and-braces — disclosure copy MUST NOT match the "หน่วยงานที่ N"
  // placeholder family. Static literal so this is a hard pass; the guard
  // is here to catch any future copy regression via the same defense path
  // every other project envelope uses.
  assertAgencyLabelPlaceholderFree({
    responsibleAgencyName: null,
    responsibleAgencyDisclosure: PENDING_RESPONSIBLE_AGENCY_DISCLOSURE,
  });
  return entry;
}

// ────────────────────────────────────────────────────────────────────
// Wave 67 W67-AMPHOE-FIX-PROMPT-01 (Path A) — listAmphoes resolver.
//
// Maps amphoe name (or partial Thai phrase) → string PK. Single-province
// deployment (Nakhon Ratchasima per §13.5) — the `amphoes` table
// contains only Nakhon Ratchasima rows and the entity has no `changwat`
// relation, so no province filter is needed. ~32 amphoes total — one
// query, no pagination required.
//
// §17.2 advisory only. §17.3 read-only — single SELECT against the
// amphoes table. §17.7 reportFormat-agnostic. §17.9 — schema validates
// `additionalProperties: false` at the registry layer; the handler
// re-trims the input here. §17.11 — role enforcement via
// `assertExecutiveRole`.
// ────────────────────────────────────────────────────────────────────

const listAmphoes: ExecutiveToolHandler = async (params, ctx, deps) => {
  assertExecutiveRole(ctx);

  const rawNameContains = params.nameContains;
  const nameContains =
    typeof rawNameContains === 'string' && rawNameContains.trim().length > 0
      ? rawNameContains.trim()
      : undefined;

  const qb = deps.dataSource
    .getRepository(Amphoe)
    .createQueryBuilder('a')
    .select('a.id', 'id')
    .addSelect('a.name', 'name')
    .where('a.deletedAt IS NULL');

  if (nameContains) {
    qb.andWhere('LOWER(a.name) LIKE LOWER(:pat)', {
      pat: `%${nameContains}%`,
    });
  }

  qb.orderBy('a.name', 'ASC');

  const rows: Array<{ id: string; name: string }> = await qb.getRawMany();

  return {
    items: rows.map((r) => ({ amphoeId: String(r.id), name: r.name })),
    asOf: nowIso(),
    missingDimensions: [],
    advisories: [],
    partial: false,
  };
};

// ────────────────────────────────────────────────────────────────────
// Wave 67 W67-LAO-RESOLVER — listLaos resolver.
//
// Mirror of `listAmphoes`. Maps LAO Thai name (or amphoe scope) →
// `local_administrative_organizations.id` (string PK) consumed by
// `filters.laoIds` on the shared ExecutiveQuery DSL.
//
// Hybrid validation (Q2=c locked 2026-04-26): the schema accepts both
// params optionally, the HANDLER additionally enforces at-least-one-of
// `{ amphoeId, nameContains }`. Empty payload → `items: []` +
// advisory `'lao-filter-required'` (no throw — keeps the envelope
// shape the LLM already understands).
//
// §17.2 advisory only. §17.3 read-only (single SELECT against
// `local_administrative_organizations` LEFT JOIN `amphoes`).
// §17.7 reportFormat-agnostic. §17.9 — schema validates
// `additionalProperties: false`; handler trims whitespace-only inputs
// to "omitted" before the at-least-one-of check. §17.11 — role
// re-checked via `assertExecutiveRole`. §13.5 — single-province
// deployment; the `local_administrative_organizations` table is
// already constrained to Nakhon Ratchasima.
// ────────────────────────────────────────────────────────────────────

const listLaos: ExecutiveToolHandler = async (params, ctx, deps) => {
  assertExecutiveRole(ctx);

  const rawAmphoeId = params.amphoeId;
  const amphoeId =
    typeof rawAmphoeId === 'string' && rawAmphoeId.trim().length > 0
      ? rawAmphoeId.trim()
      : undefined;

  const rawNameContains = params.nameContains;
  const nameContains =
    typeof rawNameContains === 'string' && rawNameContains.trim().length > 0
      ? rawNameContains.trim()
      : undefined;

  // W68-FIX-11 (2026-04-28) — exact-match LAO type filter. Used by
  // prompt rule #25b Path A type-aware lookup (e.g., "อบต. โคกกรวด"
  // → type='อบต.', nameContains='โคกกรวด'). Strict equality match
  // against `local_administrative_organizations.type`.
  const rawType = params.type;
  const typeFilter =
    typeof rawType === 'string' && rawType.trim().length > 0
      ? rawType.trim()
      : undefined;

  // Q2=c — hybrid validation. At least one of `amphoeId` /
  // `nameContains` / `type` (W68-FIX-11) MUST be present (post-trim).
  // Empty payload returns an empty list with a structured advisory
  // instead of throwing so the LLM can recover by calling with a
  // refined filter.
  if (!amphoeId && !nameContains && !typeFilter) {
    return {
      items: [],
      asOf: nowIso(),
      missingDimensions: [],
      advisories: ['lao-filter-required'],
      partial: false,
    };
  }

  const qb = deps.dataSource
    .getRepository(LocalAdministrativeOrganization)
    .createQueryBuilder('lao')
    .leftJoin('lao.amphoe', 'amp')
    .select('lao.id', 'id')
    .addSelect('lao.name', 'name')
    .addSelect('lao.type', 'type')
    .addSelect('amp.id', 'amphoeId')
    .addSelect('amp.name', 'amphoeName')
    .where('lao.deleteAt IS NULL');

  if (amphoeId) {
    qb.andWhere('amp.id = :amphoeId', { amphoeId });
  }
  if (nameContains) {
    qb.andWhere('LOWER(lao.name) LIKE LOWER(:pat)', {
      pat: `%${nameContains}%`,
    });
  }
  if (typeFilter) {
    // W68-FIX-11 — strict equality match. The DB column is `type` (no
    // compound name), so the property-path emits `lao.type` regardless
    // of TypeORM camelCase / snake_case naming convention.
    qb.andWhere('lao.type = :typeFilter', { typeFilter });
  }

  qb.orderBy('amp.name', 'ASC').addOrderBy('lao.name', 'ASC');

  const rows: Array<{
    id: string;
    name: string;
    type: string;
    amphoeId: string | null;
    amphoeName: string | null;
  }> = await qb.getRawMany();

  return {
    items: rows.map((r) => ({
      laoId: String(r.id),
      name: r.name,
      type: r.type,
      amphoeId: String(r.amphoeId ?? ''),
      amphoeName: r.amphoeName ?? '',
    })),
    asOf: nowIso(),
    missingDimensions: [],
    advisories: [],
    partial: false,
  };
};

// ────────────────────────────────────────────────────────────────────
// W67-LAO-RESOLVER — internal helper: resolve per-projectId LAO
// labels for `groupBy: ['lao']` aggregation in
// `getExecutiveDashboardSnapshot` / `getCrossPlanInsights`.
//
// UnifiedProject does NOT carry the LAO FK directly (Tier B
// `IUnifiedProjectAggregator` only projects amphoe / agency / origin-
// type), so we issue ONE LEFT JOIN per project kind keyed on the row
// PK and stitch the results into a single Map<projectId, label>. All
// three project tables share the same FK column name
// (`local_administrative_organization_id`) — same shape as
// AgencyEnrichmentService.
//
// Failures propagate to runDimensions' partial-envelope pathway via
// the surrounding await (the helper is intentionally non-throwing for
// empty input). §17.2 advisory only.
// ────────────────────────────────────────────────────────────────────
async function fetchLaoLabelsForUnifiedProjects(
  deps: ExecutiveToolHandlerDeps,
  projects: Array<{
    projectKind: 'main' | 'revised' | 'supplement';
    projectId: string;
  }>,
): Promise<Map<string, { laoId: string; laoName: string }>> {
  const labels = new Map<string, { laoId: string; laoName: string }>();
  if (!projects || projects.length === 0) return labels;

  const mainIds: string[] = [];
  const revisedIds: string[] = [];
  // SPG kind intentionally skipped — see SPG-no-LAO-column note below.
  for (const p of projects) {
    if (p.projectKind === 'main') mainIds.push(p.projectId);
    else if (p.projectKind === 'revised') revisedIds.push(p.projectId);
  }

  type Row = {
    projectid: string;
    laoid: string | null;
    laoname: string | null;
  };

  const fetchMain = async (ids: string[]): Promise<Row[]> => {
    if (ids.length === 0) return [];
    return deps.dataSource
      .getRepository(ProjectGroup)
      .createQueryBuilder('pg')
      .leftJoin(
        LocalAdministrativeOrganization,
        'lao',
        'lao.id = pg.local_administrative_organization_id AND lao.delete_at IS NULL',
      )
      .select('pg.id', 'projectid')
      .addSelect('lao.id', 'laoid')
      .addSelect('lao.name', 'laoname')
      .where('pg.id IN (:...ids)', { ids })
      .getRawMany();
  };
  const fetchRevised = async (ids: string[]): Promise<Row[]> => {
    if (ids.length === 0) return [];
    return deps.dataSource
      .getRepository(RevisedProjectGroup)
      .createQueryBuilder('rpg')
      .leftJoin(
        LocalAdministrativeOrganization,
        'lao',
        'lao.id = rpg.local_administrative_organization_id AND lao.delete_at IS NULL',
      )
      .select('rpg.id', 'projectid')
      .addSelect('lao.id', 'laoid')
      .addSelect('lao.name', 'laoname')
      .where('rpg.id IN (:...ids)', { ids })
      .getRawMany();
  };
  // SPG has NO `local_administrative_organization_id` column — its
  // only LAO-typed FK is `origin_agency_id` (a different concept,
  // §5.2). SPG rows therefore cannot contribute to the per-LAO
  // bucket and are skipped at the label-fetch stage. The
  // `applyFilters({ laoIds })` path matches this exclusion by
  // mapping the SPG kind to a no-match.
  const [mainRows, revisedRows] = await Promise.all([
    fetchMain(mainIds),
    fetchRevised(revisedIds),
  ]);
  const supplementRows: Row[] = [];

  for (const r of [...mainRows, ...revisedRows, ...supplementRows]) {
    if (r.laoid && r.laoname) {
      labels.set(String(r.projectid), {
        laoId: String(r.laoid),
        laoName: r.laoname,
      });
    }
  }
  return labels;
}

// ────────────────────────────────────────────────────────────────────
// W68-FIX-06 (D4) — internal helper: resolve per-projectId classification
// labels (Strategy / Tactic / Plan / DevelopmentIssue) for the
// `groupBy: ['strategy'|'issue'|'planLevel']` aggregation in
// `getExecutiveDashboardSnapshot`.
//
// Mirrors `fetchLaoLabelsForUnifiedProjects`. UnifiedProject only
// projects classification FK *ids* (`strategyid` / `tacticid` /
// `planlevelid` / `issueid`) — not the human-readable Thai names — so
// before the W68 fix the bucket builder emitted UUIDs as bucket keys,
// producing prose like "ประเด็นการพัฒนา 1: 2 โครงการ".
//
// All three project tables share the same FK column shape
// (`strategy_id`, `tactic_id`, `plan_id`, `development_issue_id`) — see
// §16.5 classification shape invariant. ISSUE_BASED rows carry only
// `development_issue_id`; STRATEGY_BASED rows carry only the
// strategy/tactic/plan triplet; the helper gracefully returns NULL per
// inactive shape.
//
// §17.2 advisory only — bucket label is display-only; no workflow gate.
// §17.7 — branches purely on FK presence; no `reportFormat` read here.
// Wave 54 — entity property paths only (no raw table literals).
// ────────────────────────────────────────────────────────────────────
export type ClassificationLabel = {
  strategyName: string | null;
  tacticName: string | null;
  planLevelName: string | null;
  issueName: string | null;
};

export async function fetchClassificationLabelsForUnifiedProjects(
  deps: ExecutiveToolHandlerDeps,
  projects: Array<{
    projectKind: 'main' | 'revised' | 'supplement';
    projectId: string;
  }>,
): Promise<Map<string, ClassificationLabel>> {
  const labels = new Map<string, ClassificationLabel>();
  if (!projects || projects.length === 0) return labels;
  // W68-FIX-06 defensive guard (added 2026-04-28 follow-up): if the
  // caller's `deps.dataSource` is missing `getRepository` (test mocks
  // that pre-date W68-FIX-06 don't stub it), short-circuit to an empty
  // label map instead of throwing. Production wiring always supplies
  // a real DataSource via DI; this guard only affects unit tests.
  // §17.2 advisory-only — empty labels collapse to '(ไม่ระบุ)' bucket
  // keys in the snapshot, which is the same fallback used pre-W68-FIX-06.
  if (
    !deps?.dataSource ||
    typeof (deps.dataSource as { getRepository?: unknown }).getRepository !==
      'function'
  ) {
    return labels;
  }

  const mainIds: string[] = [];
  const revisedIds: string[] = [];
  const supplementIds: string[] = [];
  for (const p of projects) {
    if (p.projectKind === 'main') mainIds.push(p.projectId);
    else if (p.projectKind === 'revised') revisedIds.push(p.projectId);
    else if (p.projectKind === 'supplement') supplementIds.push(p.projectId);
  }

  type Row = {
    projectid: string;
    strategyname: string | null;
    tacticname: string | null;
    planname: string | null;
    issuename: string | null;
  };

  const fetchMain = async (ids: string[]): Promise<Row[]> => {
    if (ids.length === 0) return [];
    return deps.dataSource
      .getRepository(ProjectGroup)
      .createQueryBuilder('pg')
      .leftJoin(Strategy, 's', 's.id = pg.strategy_id AND s.deleted_at IS NULL')
      .leftJoin(Tactic, 't', 't.id = pg.tactic_id AND t.deleted_at IS NULL')
      .leftJoin(Plan, 'pl', 'pl.id = pg.plan_id AND pl.deleted_at IS NULL')
      .leftJoin(
        DevelopmentIssue,
        'di',
        'di.id = pg.development_issue_id AND di.deleted_at IS NULL',
      )
      .select('pg.id', 'projectid')
      .addSelect('s.name', 'strategyname')
      .addSelect('t.name', 'tacticname')
      .addSelect('pl.name', 'planname')
      .addSelect('di.name', 'issuename')
      .where('pg.id IN (:...ids)', { ids })
      .getRawMany();
  };

  const fetchRevised = async (ids: string[]): Promise<Row[]> => {
    if (ids.length === 0) return [];
    return deps.dataSource
      .getRepository(RevisedProjectGroup)
      .createQueryBuilder('rpg')
      .leftJoin(
        Strategy,
        's',
        's.id = rpg.strategy_id AND s.deleted_at IS NULL',
      )
      .leftJoin(Tactic, 't', 't.id = rpg.tactic_id AND t.deleted_at IS NULL')
      .leftJoin(Plan, 'pl', 'pl.id = rpg.plan_id AND pl.deleted_at IS NULL')
      .leftJoin(
        DevelopmentIssue,
        'di',
        'di.id = rpg.development_issue_id AND di.deleted_at IS NULL',
      )
      .select('rpg.id', 'projectid')
      .addSelect('s.name', 'strategyname')
      .addSelect('t.name', 'tacticname')
      .addSelect('pl.name', 'planname')
      .addSelect('di.name', 'issuename')
      .where('rpg.id IN (:...ids)', { ids })
      .getRawMany();
  };

  const fetchSupplement = async (ids: string[]): Promise<Row[]> => {
    if (ids.length === 0) return [];
    return deps.dataSource
      .getRepository(SupplementProjectGroup)
      .createQueryBuilder('spg')
      .leftJoin(
        Strategy,
        's',
        's.id = spg.strategy_id AND s.deleted_at IS NULL',
      )
      .leftJoin(Tactic, 't', 't.id = spg.tactic_id AND t.deleted_at IS NULL')
      .leftJoin(Plan, 'pl', 'pl.id = spg.plan_id AND pl.deleted_at IS NULL')
      .leftJoin(
        DevelopmentIssue,
        'di',
        'di.id = spg.development_issue_id AND di.deleted_at IS NULL',
      )
      .select('spg.id', 'projectid')
      .addSelect('s.name', 'strategyname')
      .addSelect('t.name', 'tacticname')
      .addSelect('pl.name', 'planname')
      .addSelect('di.name', 'issuename')
      .where('spg.id IN (:...ids)', { ids })
      .getRawMany();
  };

  const [mainRows, revisedRows, supplementRows] = await Promise.all([
    fetchMain(mainIds),
    fetchRevised(revisedIds),
    fetchSupplement(supplementIds),
  ]);

  for (const r of [...mainRows, ...revisedRows, ...supplementRows]) {
    labels.set(String(r.projectid), {
      strategyName: r.strategyname ?? null,
      tacticName: r.tacticname ?? null,
      planLevelName: r.planname ?? null,
      issueName: r.issuename ?? null,
    });
  }
  return labels;
}

// ────────────────────────────────────────────────────────────────────
// Wave 67 W67-AGENCY-RESOLVER — listAgencies resolver.
//
// Mirror of `listAmphoes` / `listLaos`. Maps government-agency Thai
// name (or partial phrase) → `government_agencies.id` (auto-increment
// integer PK, typed as `string` at the TS layer per the entity).
// Required because the LLM had no path to translate "กองยุทธศาสตร์" /
// "กองช่าง" → the integer PK consumed by `filters.agencyIds` on the
// shared ExecutiveQuery DSL — sending the Thai literal binds 0 rows
// (the aggregator's `applyFilters({ agencyIds })` coerces via
// `Number(x)`).
//
// No at-least-one-of guard (cf. `listLaos` Q2=c) — agencies are the
// ~40 departments under อบจ.นครราชสีมา (vs 430+ LAOs province-wide),
// so the full-list dump when no filter is provided is acceptable
// token-wise.
//
// §17.2 advisory only. §17.3 read-only — single SELECT against
// `government_agencies`. §17.7 reportFormat-agnostic. §17.9 —
// schema validates `additionalProperties: false`; handler trims
// whitespace-only `nameContains` to "omitted". §17.11 — role
// re-checked via `assertExecutiveRole`. §13.5 — agencies are scoped
// to the อบจ.นครราชสีมา deployment by data; no extra filter needed.
// ────────────────────────────────────────────────────────────────────

const listAgencies: ExecutiveToolHandler = async (params, ctx, deps) => {
  assertExecutiveRole(ctx);

  const rawNameContains = params.nameContains;
  const nameContains =
    typeof rawNameContains === 'string' && rawNameContains.trim().length > 0
      ? rawNameContains.trim()
      : undefined;

  const qb = deps.dataSource
    .getRepository(GovernmentAgency)
    .createQueryBuilder('a')
    .select('a.id', 'id')
    .addSelect('a.name', 'name')
    .where('a.deletedAt IS NULL');

  if (nameContains) {
    qb.andWhere('LOWER(a.name) LIKE LOWER(:pat)', {
      pat: `%${nameContains}%`,
    });
  }

  qb.orderBy('a.name', 'ASC');

  const rows: Array<{ id: string | number; name: string }> =
    await qb.getRawMany();

  return {
    // W68-FIX-07 (2026-04-28): emit `agencyId` as integer to match
    // government_agency.id (@PrimaryGeneratedColumn). Pre-fix coerced
    // to String which caused gpt-4o to send back integer in
    // filters.agencyIds — schema demanded string → soft-fail loop →
    // "ไม่สามารถ resolve ID ได้". Now schema + handler + DB all agree:
    // agency PK is integer.
    items: rows.map((r) => ({ agencyId: Number(r.id), name: r.name })),
    asOf: nowIso(),
    missingDimensions: [],
    advisories: [],
    partial: false,
  };
};

// ────────────────────────────────────────────────────────────────────
// Wave AI-Exec-Chat-Book-Coverage BE-01 (2026-05-28) — sub-book
// drill-down read tools (4 new handlers).
//
// Source-of-truth:
//   - `docs/tasks/wave-ai-exec-chat-book-coverage/README.md` (locked
//     Q1=org-wide read, Q2=200+offset, Q3=prompt-engineering, Q4=narrow,
//     Q5=minimal additive)
//   - CLAUDE.md §17.2 advisory-only / §17.3 audit separation / §17.9
//     schema-strict / §17.11 no role exemption / §14.2 HEAD-of-lineage
//   - Wave 54 no-raw-SQL gate — TypeORM QueryBuilder via entity classes
//
// Pattern reference: `listProjectsInPlan` (line ~1852) and
// `listDevelopmentPlanRevisions` (line ~3327) for the agency-JOIN +
// tracking-status JOIN + budget sub-query pattern.
//
// HEAD-of-lineage default per §14.2:
//   - listProjectsInRevisionBook applies `applyHeadFilterForRevisedProjectGroup`
//     unless `includeHistoricalVersions: true`
//   - listProjectsInSupplementBook applies `applyHeadFilterForSupplementProjectGroup`
//     unless `includeHistoricalVersions: true`
//   - Summary tools (getRevisionBookSummary / getSupplementBookSummary)
//     always apply HEAD filter — historical inclusion is a list-only
//     advisory flag, summaries must reflect current-truth headcount.
//
// Org-wide read per Q1: NO `createdBy` filter; the `assertExecutiveRole`
// guard is the only authority check. PII projection discipline is
// preserved — handlers expose only `{ projectId, title, currentStatus,
// statusTh, executiveStatus, responsibleAgencyId, responsibleAgencyName,
// budget, pageNumber, createdAt }`.
// ────────────────────────────────────────────────────────────────────

/**
 * Build the per-row envelope shared by both listers
 * (`listProjectsInRevisionBook` / `listProjectsInSupplementBook`).
 *
 * `statusTh` is sourced from the DB-loaded `status.th_name` lookup per
 * the W67 Thai-label-source-of-truth contract. `executiveStatus` is the
 * 4-group rollup per §17.7 / CLAUDE.md "Executive View Status Groups";
 * null for workflow-internal states (Ready / Pull_Back / Returned_For_Revision).
 *
 * Nullable fields (`currentStatus` / `statusTh` / `executiveStatus` /
 * `responsibleAgencyId` / `responsibleAgencyName` / `pageNumber`) follow
 * the §17.9 nullable-via-required-only convention — present as keys,
 * value may be null at runtime.
 */
function buildSubBookProjectItem(args: {
  projectId: string;
  title: string;
  statusName: string | null;
  statusTh: string | null;
  budget: string | number | null;
  responsibleAgencyId: string | number | null;
  responsibleAgencyName: string | null;
  pageNumber: number | null;
  createdAt: Date | string;
}): Record<string, unknown> {
  const exec = mapToExecutiveStatusGroup(args.statusName);
  const createdAtIso =
    args.createdAt instanceof Date
      ? args.createdAt.toISOString()
      : String(args.createdAt);
  const agencyIdRaw = args.responsibleAgencyId;
  const agencyId =
    agencyIdRaw === null || agencyIdRaw === undefined
      ? null
      : Number(agencyIdRaw);
  return {
    projectId: args.projectId,
    title: args.title,
    currentStatus: args.statusName ?? null,
    statusTh: args.statusTh ?? null,
    executiveStatus: exec ?? null,
    responsibleAgencyId: agencyId,
    responsibleAgencyName: args.responsibleAgencyName ?? null,
    budget: Number(args.budget ?? 0) || 0,
    pageNumber: args.pageNumber ?? null,
    createdAt: createdAtIso,
  };
}

/**
 * Initialize the 8-key status breakdown used by both summary tools.
 * Mirrors the canonical 8-status vocabulary (Ready, Pending, Verified,
 * Pending_Approval, Approved, Pull_Back, Returned_For_Revision,
 * Rejected — CLAUDE.md "Core Status Machine").
 */
function emptyStatusBreakdown(): Record<string, number> {
  return {
    Ready: 0,
    Pending: 0,
    Verified: 0,
    Pending_Approval: 0,
    Approved: 0,
    Pull_Back: 0,
    Returned_For_Revision: 0,
    Rejected: 0,
  };
}

// ────────────────────────────────────────────────────────────────────
// Handler 1: listProjectsInRevisionBook
// ────────────────────────────────────────────────────────────────────

const listProjectsInRevisionBook: ExecutiveToolHandler = async (
  params,
  ctx,
  deps,
) => {
  assertExecutiveRole(ctx);
  const revisionIdRaw = String(params.revisionId ?? '');
  if (!UUID_RX.test(revisionIdRaw)) {
    return {
      items: [],
      totalCount: 0,
      limit: 50,
      offset: 0,
      nextOffset: null,
      revisionMeta: {
        revisionId: NIL_UUID,
        revisionNumber: 0,
        revisionTypeName: '(ไม่ระบุ)',
        isOpen: false,
        isBooked: false,
      },
      asOf: nowIso(),
      message:
        'revisionId ต้องเป็น UUID ที่ได้จาก listDevelopmentPlanRevisions.items[i].revisionId เท่านั้น กรุณาเรียก listDevelopmentPlanRevisions ก่อน',
    };
  }
  const revisionId = revisionIdRaw;
  const limit = Math.min(Math.max(Number(params.limit ?? 50), 1), 200);
  const offset = Math.max(Number(params.offset ?? 0), 0);
  const includeHistorical = Boolean(params.includeHistoricalVersions);
  const statusFilter =
    typeof params.status === 'string' && params.status.length > 0
      ? params.status
      : undefined;

  // Resolve the DPR meta. If absent, return a friendly empty envelope
  // (mirrors the listProjectsInPlan UUID-not-found pattern at line 1855)
  // — UUID is well-formed but no row exists.
  const dpr = await deps.dataSource
    .getRepository(DevelopmentPlanRevision)
    .createQueryBuilder('dpr')
    .leftJoinAndSelect('dpr.revisionType', 'rt')
    .where('dpr.deletedAt IS NULL')
    .andWhere('dpr.id = :revisionId', { revisionId })
    .getOne();

  if (!dpr) {
    return {
      items: [],
      totalCount: 0,
      limit,
      offset,
      nextOffset: null,
      revisionMeta: {
        revisionId,
        revisionNumber: 0,
        revisionTypeName: '(ไม่ระบุ)',
        isOpen: false,
        isBooked: false,
      },
      asOf: nowIso(),
      message:
        'ไม่พบเล่มแก้ไข/เปลี่ยนแปลงตาม revisionId ที่ระบุ — โปรดยืนยัน UUID จาก listDevelopmentPlanRevisions',
    };
  }

  const revisionMeta = {
    revisionId: dpr.id,
    revisionNumber: dpr.revisionNumber,
    revisionTypeName: dpr.revisionType?.name ?? '(ไม่ระบุ)',
    isOpen: !!dpr.isOpen,
    isBooked: !!dpr.isBooked,
  };

  // Build base QB: RPG → DPR via FK, plus latest-tracking + agency JOINs.
  const buildBaseQb = () => {
    const qb = deps.dataSource
      .getRepository(RevisedProjectGroup)
      .createQueryBuilder('rpg')
      .leftJoin('rpg.trackingStatus', 'ts', 'ts.isLatest = true')
      .leftJoin('ts.statusId', 'status')
      .leftJoin(
        GovernmentAgency,
        'ga',
        'ga.id = rpg.responsible_agency_id',
      )
      .where('rpg.deletedAt IS NULL')
      .andWhere('rpg.development_plan_revision_id = :revisionId', {
        revisionId,
      });
    if (!includeHistorical) {
      // §14.2 HEAD-of-lineage anti-join. Aliases default to 'rpg_desc_w57'
      // — distinct from any other helper alias.
      applyHeadFilterForRevisedProjectGroup(qb, 'rpg');
    }
    if (statusFilter) {
      qb.andWhere('status.name = :statusFilter', { statusFilter });
    }
    return qb;
  };

  // Count query (uses DISTINCT to defuse the rare case where multiple
  // tracking rows share `isLatest=true` for the same RPG — defensive).
  const countQb = buildBaseQb().select('COUNT(DISTINCT rpg.id)', 'cnt');
  const countRow = await countQb.getRawOne<{ cnt: string }>();
  const totalCount = Number(countRow?.cnt ?? 0) || 0;

  // Page query.
  const listQb = buildBaseQb()
    .select('rpg.id', 'rpgid')
    .addSelect('rpg.title', 'title')
    .addSelect('status.name', 'statusname')
    .addSelect('status.th_name', 'statusth')
    .addSelect('rpg.responsible_agency_id', 'agencyid')
    .addSelect('ga.name', 'agencyname')
    .addSelect('rpg.pageNumber', 'pagenumber')
    .addSelect('rpg.createdAt', 'createdat')
    .addSelect(
      (subQb: SelectQueryBuilder<Budget>) =>
        subQb
          .select('COALESCE(SUM(b.quantity), 0)')
          .from(Budget, 'b')
          .where('b.revised_project_group_id = rpg.id'),
      'budget',
    )
    .orderBy('rpg.pageNumber', 'ASC', 'NULLS LAST')
    .addOrderBy('rpg.createdAt', 'ASC')
    .offset(offset)
    .limit(limit);

  const rows: Array<{
    rpgid: string;
    title: string;
    statusname: string | null;
    statusth: string | null;
    agencyid: string | number | null;
    agencyname: string | null;
    pagenumber: number | null;
    createdat: Date | string;
    budget: string | null;
  }> = await listQb.getRawMany();

  const items = rows.map((r) =>
    buildSubBookProjectItem({
      projectId: r.rpgid,
      title: r.title,
      statusName: r.statusname,
      statusTh: r.statusth,
      budget: r.budget,
      responsibleAgencyId: r.agencyid,
      responsibleAgencyName: r.agencyname,
      pageNumber: r.pagenumber,
      createdAt: r.createdat,
    }),
  );

  const nextOffset =
    offset + items.length < totalCount ? offset + items.length : null;

  return {
    items,
    totalCount,
    limit,
    offset,
    nextOffset,
    revisionMeta,
    asOf: nowIso(),
  };
};

// ────────────────────────────────────────────────────────────────────
// Handler 2: listProjectsInSupplementBook
// ────────────────────────────────────────────────────────────────────

const listProjectsInSupplementBook: ExecutiveToolHandler = async (
  params,
  ctx,
  deps,
) => {
  assertExecutiveRole(ctx);
  const supplementIdRaw = String(params.supplementId ?? '');
  if (!UUID_RX.test(supplementIdRaw)) {
    return {
      items: [],
      totalCount: 0,
      limit: 50,
      offset: 0,
      nextOffset: null,
      supplementMeta: {
        supplementId: NIL_UUID,
        supplementNumber: 0,
        isOpen: false,
        isBooked: false,
      },
      asOf: nowIso(),
      message:
        'supplementId ต้องเป็น UUID ที่ได้จาก listDevelopmentPlanSupplements.items[i].supplementId เท่านั้น กรุณาเรียก listDevelopmentPlanSupplements ก่อน',
    };
  }
  const supplementId = supplementIdRaw;
  const limit = Math.min(Math.max(Number(params.limit ?? 50), 1), 200);
  const offset = Math.max(Number(params.offset ?? 0), 0);
  const includeHistorical = Boolean(params.includeHistoricalVersions);
  const statusFilter =
    typeof params.status === 'string' && params.status.length > 0
      ? params.status
      : undefined;

  const dps = await deps.dataSource
    .getRepository(DevelopmentPlanSupplement)
    .createQueryBuilder('dps')
    .where('dps.deletedAt IS NULL')
    .andWhere('dps.id = :supplementId', { supplementId })
    .getOne();

  if (!dps) {
    return {
      items: [],
      totalCount: 0,
      limit,
      offset,
      nextOffset: null,
      supplementMeta: {
        supplementId,
        supplementNumber: 0,
        isOpen: false,
        isBooked: false,
      },
      asOf: nowIso(),
      message:
        'ไม่พบเล่มเพิ่มเติมตาม supplementId ที่ระบุ — โปรดยืนยัน UUID จาก listDevelopmentPlanSupplements',
    };
  }

  const supplementMeta = {
    supplementId: dps.id,
    supplementNumber: dps.supplementNumber,
    isOpen: !!dps.isOpen,
    isBooked: !!dps.isBooked,
  };

  const buildBaseQb = () => {
    const qb = deps.dataSource
      .getRepository(SupplementProjectGroup)
      .createQueryBuilder('spg')
      .leftJoin('spg.trackingStatus', 'ts', 'ts.isLatest = true')
      .leftJoin('ts.statusId', 'status')
      .leftJoin(
        GovernmentAgency,
        'ga',
        'ga.id = spg.responsible_agency_id',
      )
      .where('spg.deletedAt IS NULL')
      .andWhere('spg.development_plan_supplement_id = :supplementId', {
        supplementId,
      });
    if (!includeHistorical) {
      // §14.2 HEAD-of-lineage anti-join. SPG with no live RPG
      // descendant via `prev_project_type='supplement'` per Wave SUPP-4
      // (2026-05-24) lineage edges.
      applyHeadFilterForSupplementProjectGroup(qb, 'spg');
    }
    if (statusFilter) {
      qb.andWhere('status.name = :statusFilter', { statusFilter });
    }
    return qb;
  };

  const countQb = buildBaseQb().select('COUNT(DISTINCT spg.id)', 'cnt');
  const countRow = await countQb.getRawOne<{ cnt: string }>();
  const totalCount = Number(countRow?.cnt ?? 0) || 0;

  const listQb = buildBaseQb()
    .select('spg.id', 'spgid')
    .addSelect('spg.title', 'title')
    .addSelect('status.name', 'statusname')
    .addSelect('status.th_name', 'statusth')
    .addSelect('spg.responsible_agency_id', 'agencyid')
    .addSelect('ga.name', 'agencyname')
    .addSelect('spg.pageNumber', 'pagenumber')
    .addSelect('spg.createdAt', 'createdat')
    .addSelect(
      (subQb: SelectQueryBuilder<Budget>) =>
        subQb
          .select('COALESCE(SUM(b.quantity), 0)')
          .from(Budget, 'b')
          .where('b.supplement_project_group_id = spg.id'),
      'budget',
    )
    .orderBy('spg.pageNumber', 'ASC', 'NULLS LAST')
    .addOrderBy('spg.createdAt', 'ASC')
    .offset(offset)
    .limit(limit);

  const rows: Array<{
    spgid: string;
    title: string;
    statusname: string | null;
    statusth: string | null;
    agencyid: string | number | null;
    agencyname: string | null;
    pagenumber: number | null;
    createdat: Date | string;
    budget: string | null;
  }> = await listQb.getRawMany();

  const items = rows.map((r) =>
    buildSubBookProjectItem({
      projectId: r.spgid,
      title: r.title,
      statusName: r.statusname,
      statusTh: r.statusth,
      budget: r.budget,
      responsibleAgencyId: r.agencyid,
      responsibleAgencyName: r.agencyname,
      pageNumber: r.pagenumber,
      createdAt: r.createdat,
    }),
  );

  const nextOffset =
    offset + items.length < totalCount ? offset + items.length : null;

  return {
    items,
    totalCount,
    limit,
    offset,
    nextOffset,
    supplementMeta,
    asOf: nowIso(),
  };
};

// ────────────────────────────────────────────────────────────────────
// Handler 3: getRevisionBookSummary
// ────────────────────────────────────────────────────────────────────

const getRevisionBookSummary: ExecutiveToolHandler = async (
  params,
  ctx,
  deps,
) => {
  assertExecutiveRole(ctx);
  const revisionIdRaw = String(params.revisionId ?? '');
  const emptyMeta = {
    revisionId: NIL_UUID,
    revisionNumber: 0,
    revisionTypeName: '(ไม่ระบุ)',
    isOpen: false,
    isBooked: false,
  };
  if (!UUID_RX.test(revisionIdRaw)) {
    return {
      revisionMeta: emptyMeta,
      totalProjects: 0,
      statusBreakdown: emptyStatusBreakdown(),
      executiveStatusBreakdown: {
        pendingReviewCount: 0,
        awaitingApprovalCount: 0,
        approvedCount: 0,
        rejectedCount: 0,
      },
      totalBudget: 0,
      averageBudget: 0,
      asOf: nowIso(),
      message:
        'revisionId ต้องเป็น UUID ที่ได้จาก listDevelopmentPlanRevisions.items[i].revisionId เท่านั้น',
    };
  }
  const revisionId = revisionIdRaw;

  const dpr = await deps.dataSource
    .getRepository(DevelopmentPlanRevision)
    .createQueryBuilder('dpr')
    .leftJoinAndSelect('dpr.revisionType', 'rt')
    .where('dpr.deletedAt IS NULL')
    .andWhere('dpr.id = :revisionId', { revisionId })
    .getOne();
  if (!dpr) {
    return {
      revisionMeta: { ...emptyMeta, revisionId },
      totalProjects: 0,
      statusBreakdown: emptyStatusBreakdown(),
      executiveStatusBreakdown: {
        pendingReviewCount: 0,
        awaitingApprovalCount: 0,
        approvedCount: 0,
        rejectedCount: 0,
      },
      totalBudget: 0,
      averageBudget: 0,
      asOf: nowIso(),
      message:
        'ไม่พบเล่มแก้ไข/เปลี่ยนแปลงตาม revisionId ที่ระบุ — โปรดยืนยัน UUID จาก listDevelopmentPlanRevisions',
    };
  }

  const revisionMeta = {
    revisionId: dpr.id,
    revisionNumber: dpr.revisionNumber,
    revisionTypeName: dpr.revisionType?.name ?? '(ไม่ระบุ)',
    isOpen: !!dpr.isOpen,
    isBooked: !!dpr.isBooked,
  };

  // Status-grouped count over HEAD-of-lineage RPG rows. Aggregates are
  // uncapped per Q2 — no `.take()` / `.limit()`.
  const statusGroupQb = deps.dataSource
    .getRepository(RevisedProjectGroup)
    .createQueryBuilder('rpg')
    .leftJoin('rpg.trackingStatus', 'ts', 'ts.isLatest = true')
    .leftJoin('ts.statusId', 'status')
    .select('status.name', 'statusname')
    .addSelect('COUNT(DISTINCT rpg.id)', 'cnt')
    .where('rpg.deletedAt IS NULL')
    .andWhere('rpg.development_plan_revision_id = :revisionId', { revisionId })
    .groupBy('status.name');
  applyHeadFilterForRevisedProjectGroup(statusGroupQb, 'rpg');
  const statusRows: Array<{ statusname: string | null; cnt: string }> =
    await statusGroupQb.getRawMany();

  const statusBreakdown = emptyStatusBreakdown();
  let totalProjects = 0;
  for (const r of statusRows) {
    const n = Number(r.cnt) || 0;
    totalProjects += n;
    if (r.statusname && r.statusname in statusBreakdown) {
      statusBreakdown[r.statusname] += n;
    }
  }
  const executiveStatusBreakdown = buildExecutiveStatusBreakdown(
    new Map(statusRows.map((r) => [r.statusname ?? '', Number(r.cnt) || 0])),
  );

  // Sum-of-budgets over the HEAD-of-lineage RPG set. Two-step pattern
  // mirroring `getProjectLocationBreakdown` (lines ~3565-3573) — query
  // through the Budget repo joined to RPG via the entity relation, so
  // the no-raw-SQL gate (`wave53-no-raw-sql.spec.ts`) does not see any
  // bare `FROM budget` literal. The HEAD anti-join is applied on the
  // joined RPG alias.
  const budgetQb = deps.dataSource
    .getRepository(Budget)
    .createQueryBuilder('b')
    .innerJoin('b.revisedProjectGroupId', 'rpg')
    .select('COALESCE(SUM(b.quantity), 0)', 'totalbudget')
    .where('rpg.deletedAt IS NULL')
    .andWhere('rpg.development_plan_revision_id = :revisionId', { revisionId });
  applyHeadFilterForRevisedProjectGroup(budgetQb, 'rpg');
  const budgetRow = await budgetQb.getRawOne<{ totalbudget: string }>();
  const totalBudget = Number(budgetRow?.totalbudget ?? 0) || 0;
  const averageBudget =
    totalProjects > 0 ? Math.round((totalBudget / totalProjects) * 100) / 100 : 0;

  return {
    revisionMeta,
    totalProjects,
    statusBreakdown,
    executiveStatusBreakdown,
    totalBudget,
    averageBudget,
    asOf: nowIso(),
  };
};

// ────────────────────────────────────────────────────────────────────
// Handler 4: getSupplementBookSummary
// ────────────────────────────────────────────────────────────────────

const getSupplementBookSummary: ExecutiveToolHandler = async (
  params,
  ctx,
  deps,
) => {
  assertExecutiveRole(ctx);
  const supplementIdRaw = String(params.supplementId ?? '');
  const emptyMeta = {
    supplementId: NIL_UUID,
    supplementNumber: 0,
    isOpen: false,
    isBooked: false,
  };
  if (!UUID_RX.test(supplementIdRaw)) {
    return {
      supplementMeta: emptyMeta,
      totalProjects: 0,
      statusBreakdown: emptyStatusBreakdown(),
      executiveStatusBreakdown: {
        pendingReviewCount: 0,
        awaitingApprovalCount: 0,
        approvedCount: 0,
        rejectedCount: 0,
      },
      totalBudget: 0,
      averageBudget: 0,
      asOf: nowIso(),
      message:
        'supplementId ต้องเป็น UUID ที่ได้จาก listDevelopmentPlanSupplements.items[i].supplementId เท่านั้น',
    };
  }
  const supplementId = supplementIdRaw;

  const dps = await deps.dataSource
    .getRepository(DevelopmentPlanSupplement)
    .createQueryBuilder('dps')
    .where('dps.deletedAt IS NULL')
    .andWhere('dps.id = :supplementId', { supplementId })
    .getOne();
  if (!dps) {
    return {
      supplementMeta: { ...emptyMeta, supplementId },
      totalProjects: 0,
      statusBreakdown: emptyStatusBreakdown(),
      executiveStatusBreakdown: {
        pendingReviewCount: 0,
        awaitingApprovalCount: 0,
        approvedCount: 0,
        rejectedCount: 0,
      },
      totalBudget: 0,
      averageBudget: 0,
      asOf: nowIso(),
      message:
        'ไม่พบเล่มเพิ่มเติมตาม supplementId ที่ระบุ — โปรดยืนยัน UUID จาก listDevelopmentPlanSupplements',
    };
  }

  const supplementMeta = {
    supplementId: dps.id,
    supplementNumber: dps.supplementNumber,
    isOpen: !!dps.isOpen,
    isBooked: !!dps.isBooked,
  };

  const statusGroupQb = deps.dataSource
    .getRepository(SupplementProjectGroup)
    .createQueryBuilder('spg')
    .leftJoin('spg.trackingStatus', 'ts', 'ts.isLatest = true')
    .leftJoin('ts.statusId', 'status')
    .select('status.name', 'statusname')
    .addSelect('COUNT(DISTINCT spg.id)', 'cnt')
    .where('spg.deletedAt IS NULL')
    .andWhere('spg.development_plan_supplement_id = :supplementId', {
      supplementId,
    })
    .groupBy('status.name');
  applyHeadFilterForSupplementProjectGroup(statusGroupQb, 'spg');
  const statusRows: Array<{ statusname: string | null; cnt: string }> =
    await statusGroupQb.getRawMany();

  const statusBreakdown = emptyStatusBreakdown();
  let totalProjects = 0;
  for (const r of statusRows) {
    const n = Number(r.cnt) || 0;
    totalProjects += n;
    if (r.statusname && r.statusname in statusBreakdown) {
      statusBreakdown[r.statusname] += n;
    }
  }
  const executiveStatusBreakdown = buildExecutiveStatusBreakdown(
    new Map(statusRows.map((r) => [r.statusname ?? '', Number(r.cnt) || 0])),
  );

  // Sum-of-budgets via Budget repo join (mirrors revision-summary
  // handler — avoids any raw `FROM budget` literal that the no-raw-SQL
  // gate would flag).
  const budgetQb = deps.dataSource
    .getRepository(Budget)
    .createQueryBuilder('b')
    .innerJoin('b.supplementProjectGroupId', 'spg')
    .select('COALESCE(SUM(b.quantity), 0)', 'totalbudget')
    .where('spg.deletedAt IS NULL')
    .andWhere('spg.development_plan_supplement_id = :supplementId', {
      supplementId,
    });
  applyHeadFilterForSupplementProjectGroup(budgetQb, 'spg');
  const budgetRow = await budgetQb.getRawOne<{ totalbudget: string }>();
  const totalBudget = Number(budgetRow?.totalbudget ?? 0) || 0;
  const averageBudget =
    totalProjects > 0 ? Math.round((totalBudget / totalProjects) * 100) / 100 : 0;

  return {
    supplementMeta,
    totalProjects,
    statusBreakdown,
    executiveStatusBreakdown,
    totalBudget,
    averageBudget,
    asOf: nowIso(),
  };
};

// ────────────────────────────────────────────────────────────────────
// Export: handler map keyed by registry tool name.
// ────────────────────────────────────────────────────────────────────

export const EXECUTIVE_TOOL_HANDLERS: ExecutiveToolHandlerMap = {
  listActivePlans,
  getDevelopmentIssues,
  getPendingCountsByScope,
  getTeamWorkloadSummary,
  getBudgetSummaryByPlan,
  searchProjectsByKeyword,
  getProjectClassificationBreakdown,
  getProjectStatusBreakdown,
  getApprovalPipelineSnapshot,
  detectWorkflowAgingProjects,
  highlightBudgetOutliers,
  listProjectsInPlan,
  // BE-W53-02 additions.
  getProjectLocationBreakdown,
  listDevelopmentPlanRevisions,
  listDevelopmentPlanSupplements,
  // Wave 54 BE-W54-06 — Tier C surface.
  getPlanOverview,
  getExecutiveDashboardSnapshot,
  getCrossPlanInsights,
  // Wave 61 — Mode 3 lineage handlers.
  getProjectHeadBook,
  getProjectLineage,
  // Wave 66 W66-BE-AGG-01 — explicit "no responsibleAgency" lister.
  listProjectsWithoutResponsibleAgency,
  // Wave 67 W67-AMPHOE-FIX-PROMPT-01 (Path A) — amphoe name → PK
  // resolver (closes rule #25/#25a prompt gap).
  listAmphoes,
  // Wave 67 W67-LAO-RESOLVER — LAO name → PK resolver (closes prompt
  // rule #25b gap; mirrors `listAmphoes`).
  listLaos,
  // Wave 67 W67-AGENCY-RESOLVER — government-agency name → PK resolver
  // (closes prompt rule #25d gap; mirrors `listAmphoes` / `listLaos`).
  listAgencies,
  // Wave AI-Exec-Chat-Book-Coverage BE-01 (2026-05-28) — sub-book
  // drill-down read tools (4 new handlers). Closes the gap in
  // `listProjectsInPlan` which could not drill into a single DPR / DPS.
  listProjectsInRevisionBook,
  listProjectsInSupplementBook,
  getRevisionBookSummary,
  getSupplementBookSummary,
  // Wave AI-Exec-Chat-Enterprise-Output-Tone BE-01 (2026-05-28) — Phase 1
  // document-centric catalog orchestrator. Fans out listActivePlans +
  // per-plan listDevelopmentPlanRevisions + listDevelopmentPlanSupplements
  // and pre-renders the canonical Rule #47 bullet layout in
  // `renderedMarkdown`. Q1 ('none' → silence), Q3 (empty bucket → silence)
  // are enforced inside the composer. §17.11 no role exemption.
  getPlanCatalogOverview,
};

// Unused but-exported so downstream files can import the context type
// without bringing the handler map.
export type { ExecutiveCallerContext };
