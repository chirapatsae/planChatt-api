/**
 * SUPP_AGG_BE_01 + 01b — Thin HTTP-facing wrapper around the Wave 54
 * `UnifiedProjectAggregator` with the SUPP_AGG_BE_01b enrichment layer.
 *
 * Responsibilities:
 *   1. Resolve the caller's current `WorkHistory` (isCurrent=true) and
 *      derive §1 classification (`agency` vs `lao`).
 *   2. Map classification + endpoint context onto the aggregator's
 *      `scope` discriminator — LAO owners receive only
 *      `['main','revised']`, agency owners receive `['main','revised',
 *      'supplement']`, executive callers always receive all three.
 *   3. Delegate the actual SQL composition to the aggregator (zero
 *      duplicated aggregation logic).
 *   4. Enrich the lean aggregator output with `UnifiedProjectEnricher
 *      Service` so FE consumers receive the structured `status`,
 *      `executiveStatusGroup`, `hasDescendant`, parent-book metadata,
 *      per-year budgets, and `createdByWorkHistoryId` fields.
 *   5. **Owner endpoint** (Ambiguity #2 fix) — row-ownership filter:
 *      after enrichment, keep only rows whose
 *      `createdByWorkHistoryId === callerWorkHistoryId`. The §1 scope
 *      gate still applies (it scopes WHICH KINDS the caller sees);
 *      this gate scopes WHICH ROWS within those kinds.
 *   6. **Executive endpoint** (Ambiguity #1 fix) — status exclusion:
 *      after enrichment, drop rows whose `status.name` is in
 *      `EXECUTIVE_EXCLUDED_STATUS_NAMES` so the executive surfaces
 *      never see in-flight authoring states.
 *   7. For `countOnly=true`, the 4-group rollup is computed AFTER
 *      enrichment + filtering so excluded statuses and non-owned rows
 *      are correctly absent from the totals.
 *
 * CLAUDE.md references:
 *   - §1   classification — `agency` iff WH.amphoe.id === '3001' AND
 *          WH.LAO.id === '3001027'; `lao` otherwise.
 *   - §3   W67 4-group rollup — single source of truth lives in
 *          `aggregation/constants/executive-status-groups.ts`.
 *   - §4   Ownership Model — `WorkHistory.id`, not `User.id`, is the
 *          ownership scalar. The owner-endpoint row filter compares
 *          `EnrichedUnifiedProject.createdByWorkHistoryId` against the
 *          caller's current WH id.
 *   - §10  Project Scope Binding — per-row plan chain walk is owned by
 *          the aggregator (this service never re-resolves plans).
 *   - §12  Audit Rule — read-only; zero `tracking_status` writes.
 *   - §14  Lineage Immutability — `hasDescendant` is computed by the
 *          enricher via the canonical `LineageLockService`.
 *   - §16  reportFormat inheritance — resolved by the aggregator's
 *          BookFormatResolver chain walk; enricher copies it through.
 *   - §17.2 / §17.3 / §17.11 — advisory, FK-isolated, no role
 *          exemption. Enricher loads ONLY `WorkHistory.id` (PII-safe).
 */
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { WorkHistory } from 'src/work-history/entities/work-history.entity';

import { UNIFIED_PROJECT_AGGREGATOR } from 'src/ai-executive-chat/aggregation/tokens';
import type {
  IUnifiedProjectAggregator,
  UnifiedProjectQuery,
} from 'src/ai-executive-chat/aggregation/interfaces/unified-project-aggregator.interface';
import {
  EXECUTIVE_EXCLUDED_STATUS_NAMES,
  mapToExecutiveStatusGroup,
} from 'src/ai-executive-chat/aggregation/constants/executive-status-groups';
import { classifyOriginFromWorkHistory } from 'src/ai-executive-chat/aggregation/helpers/origin-type';

import type {
  UnifiedProjectsCountEnvelope,
  UnifiedProjectsListQuery,
} from './dto/list-unified-projects.dto';
import { UnifiedProjectEnricherService } from './services/unified-project-enricher.service';
import type { EnrichedUnifiedProject } from './types/enriched-unified-project';

/**
 * Hard limit ceiling for HTTP consumers. The aggregator caps internally
 * at 50 (DSL `maximum: 50`). Wave 113 surfaces consume the COUNT path
 * for dashboard rollups and the LIST path for paginated views; the
 * aggregator's 50-row cap is sufficient for the current FE pagination
 * size. Raising the cap is a follow-up aggregator-level patch.
 */
const HTTP_AGGREGATOR_LIMIT = 50;

/**
 * In-flight status set used by the executive-endpoint post-filter.
 * Stored as a `Set<string>` so the filter step is O(1) per row.
 *
 * `EXECUTIVE_EXCLUDED_STATUS_NAMES` is the canonical source from
 * `executive-status-groups.ts`; we only widen the tuple type to
 * `readonly string[]` here so `.has(...)` accepts arbitrary canonical
 * status name strings without a `as any` cast.
 */
const EXECUTIVE_EXCLUDED_SET = new Set<string>(
  EXECUTIVE_EXCLUDED_STATUS_NAMES as readonly string[],
);

@Injectable()
export class UnifiedProjectsService {
  constructor(
    @Inject(UNIFIED_PROJECT_AGGREGATOR)
    private readonly aggregator: IUnifiedProjectAggregator,
    @InjectRepository(WorkHistory)
    private readonly workHistoryRepo: Repository<WorkHistory>,
    private readonly enricher: UnifiedProjectEnricherService,
  ) {}

  /**
   * Owner endpoint — caller's classification-scoped + row-owned
   * projection.
   *
   * §1 gate (kind scope):
   *   - agency  → scope = ['main','revised','supplement']
   *   - lao     → scope = ['main','revised']  (SPG filtered out)
   *
   * §4 gate (row scope):
   *   - keep only rows where `createdByWorkHistoryId ===
   *     caller.currentWorkHistory.id`
   *
   * Both gates apply — the §1 gate scopes WHICH KINDS the caller can
   * see; the §4 gate scopes WHICH ROWS within those kinds. The
   * defensive SPG post-filter for LAO callers is retained even though
   * the row-ownership filter would already drop them — belt-and-braces
   * against any future aggregator change.
   *
   * `countOnly=true` returns the W67 4-group rollup envelope computed
   * AFTER enrichment + ownership filter (so totals match the list path
   * row-for-row).
   */
  async ownerList(
    userId: string,
    query: UnifiedProjectsListQuery,
  ): Promise<EnrichedUnifiedProject[] | UnifiedProjectsCountEnvelope> {
    const wh = await this.loadCurrentWorkHistory(userId);
    const origin = classifyOriginFromWorkHistory(wh);
    const callerWorkHistoryId = wh.id;

    // §1: LAO callers MUST NOT see supplement projects on the owner
    // dashboard (SPG creation is agency-exclusive per §5).
    const scope: UnifiedProjectQuery['scope'] =
      origin === 'agency-normal'
        ? ['main', 'revised', 'supplement']
        : ['main', 'revised'];

    // Load lean rows, enrich, and apply post-filters. The count path
    // re-uses the same enriched + filtered list so the rollup
    // semantics are guaranteed to match the list path exactly (no
    // separate aggregator code path to drift against).
    //
    // TODO(perf): the owner-list count path is bounded by the
    // aggregator's internal LIMIT_CEILING = 50 because we fold the
    // enriched + ownership-filtered list. This is acceptable today
    // because individual users rarely exceed 50 projects across PG +
    // RPG + SPG. If a future scale event requires accurate counts for
    // power-users, extend `UnifiedProjectQuery.filters` with an
    // `ownerWorkHistoryId?: string` clause and route ownerList's
    // countOnly branch to `aggregator.countExecutiveStatusBreakdown`
    // (unbounded GROUP BY) — mirroring the BE-01c fix already applied
    // to `executiveList`. The aggregator-side patch is small (one
    // bind param per kind in `applyFilters`) and would NOT duplicate
    // aggregation logic. As a stop-gap, FE may pass
    // `?developmentPlanId=...` to narrow the working set under the
    // 50-row ceiling.
    const leanRows = await this.aggregator.listUnifiedProjects({
      scope,
      planId: query.developmentPlanId,
      limit: HTTP_AGGREGATOR_LIMIT,
    });
    let enriched = await this.enricher.enrich(leanRows);

    // §4 ownership gate — row-level filter.
    enriched = enriched.filter(
      (r) => r.createdByWorkHistoryId === callerWorkHistoryId,
    );

    // Defensive: LAO callers must NEVER see SPG rows.
    if (origin !== 'agency-normal') {
      enriched = enriched.filter((r) => r.projectKind !== 'supplement');
    }

    if (query.countOnly) {
      return rollupExecutiveGroups(enriched);
    }
    return enriched;
  }

  /**
   * Executive endpoint — system-wide projection across all three
   * kinds, with W67 in-flight statuses excluded (`Ready`, `Pull_Back`,
   * `Returned_For_Revision`).
   *
   * Status exclusion is applied AFTER enrichment because the lean
   * aggregator row does not carry `status.name`. The enricher loads
   * the latest `TrackingStatus` row + joined `Status` per project, so
   * the post-filter has the canonical English name available.
   *
   * `countOnly=true` (BE-01c) FAST-PATH: delegates to the aggregator's
   * unbounded `countExecutiveStatusBreakdown` — a direct DB GROUP BY
   * that honors the SAME `planId`, `scope`, `filters`, and §14.2
   * head-of-lineage semantics as `listUnifiedProjects` but is NOT
   * limit-bound. The previous fold-over-enriched-list path silently
   * capped totals at 50 (the aggregator's `LIMIT_CEILING`), which
   * under-reported system-wide executive metrics. The aggregator's
   * count path already excludes `Ready` via `EXEC_VISIBLE_STATUSES`
   * and the `mapToExecutiveStatusGroup` fold drops `Pull_Back` /
   * `Returned_For_Revision` to `null`, so the executive in-flight
   * exclusion semantics are preserved without enrichment.
   *
   * Non-count (list) path is unchanged: the response is still capped
   * at `HTTP_AGGREGATOR_LIMIT` because the enriched row payload is
   * expensive and FE consumes paginated views.
   */
  async executiveList(
    query: UnifiedProjectsListQuery,
  ): Promise<EnrichedUnifiedProject[] | UnifiedProjectsCountEnvelope> {
    // Executive read = system-wide, NO area scope (null filters).
    return this.executiveListWithScope(query, null);
  }

  /**
   * Staff-scoped area-bounded list — the staff-workspace analog of
   * `executiveList`. Response shape is BYTE-IDENTICAL to `executiveList`
   * (same `EnrichedUnifiedProject[]`, same W67 exclusion + tagging) so
   * the FE renders both with one code path; the ONLY difference is the
   * AREA SCOPE applied to the aggregator query.
   *
   * Area scope (§1 / §3 / §4.1) is resolved EXACTLY as
   * `StaffHomeService.getOverdue` does:
   *   - PG (`main`) rows → `filters.amphoeIds` = caller's responsible
   *     amphoe ids (`WorkHistoryAmphoeResponsibility`).
   *   - RPG (`revised`) + SPG (`supplement`) rows → `filters.agencyIds`
   *     = caller's responsible agency ids
   *     (`WorkHistoryGovernmentAgencyResponsibility`).
   *   - `admin` / `super-admin` → BYPASS the area filter (system-wide,
   *     matching the overdue aggregator + rollback bypass rules).
   *   - plain `staff` with ZERO responsibilities → FAIL-CLOSED `[]`.
   *     Never a global scan (the single most important security
   *     invariant of this endpoint).
   *
   * Validation order (CLAUDE.md VALIDATION ORDER): authed (guard) →
   * current WH (absent → `[]`) → `workStatus = approved` (else 401) →
   * role staff-lead (RolesGuard) → resolve area scope → aggregate →
   * enrich → W67 strip + tag → return.
   *
   * §17.2 / §18.13 — strictly advisory, read-side aggregator: ZERO
   * `tracking_status` writes, ZERO AI writes, ZERO notifications. SELECT
   * only. This is a §18.13-compliant staff-scoped read aggregator.
   */
  async staffList(
    userId: string,
    query: UnifiedProjectsListQuery,
  ): Promise<EnrichedUnifiedProject[] | UnifiedProjectsCountEnvelope> {
    const wh = await this.loadStaffWorkHistory(userId);
    // No current WorkHistory → graceful empty (mirrors StaffHomeService).
    if (!wh) {
      return query.countOnly ? rollupExecutiveGroups([]) : [];
    }

    const role = wh.role?.name;
    const bypassAreaFilter = role === 'admin' || role === 'super-admin';

    // admin / super-admin → system-wide (null scope, identical to
    // `executiveList`).
    if (bypassAreaFilter) {
      return this.executiveListWithScope(query, null);
    }

    // §3 / §4.1 area scope — same mechanism as the overdue aggregator.
    const amphoeIds = (wh.workHistoryResponsibleAmphoe ?? [])
      .map((r) => r.amphoe?.id)
      .filter((id): id is string => !!id);
    const agencyIds = (wh.workHistoryResponsibleGovernmentAgency ?? [])
      .map((r) => r.governmentAgency?.id)
      .filter((id): id is string => !!id);

    // Fail-closed: plain staff with zero responsibilities sees nothing.
    // NEVER fall through to a system-wide (null-scope) aggregator call.
    if (amphoeIds.length === 0 && agencyIds.length === 0) {
      return query.countOnly ? rollupExecutiveGroups([]) : [];
    }

    return this.executiveListWithScope(query, { amphoeIds, agencyIds });
  }

  /**
   * Shared executive-list pipeline, parameterised by an optional area
   * scope. `executiveList` (no scope → system-wide) and `staffList`
   * (area scope) both delegate here so the enrich + W67 strip/tag path
   * is single-sourced and the two responses are byte-identical except
   * for the rows the scope filter admits.
   *
   * `areaScope = null` → no `filters` → ONE system-wide aggregator call
   *   across all three kinds (executive behaviour, UNCHANGED).
   *
   * `areaScope` set → the scope is split by KIND, because the aggregator
   *   ANDs `filters.amphoeIds` and `filters.agencyIds` within a SINGLE
   *   kind's query (every kind carries both `amphoe_id` and
   *   `responsible_agency_id` columns). Passing both filters in one call
   *   would wrongly require PG rows to match amphoe AND agency. The §3 /
   *   §4.1 rule is an OR ACROSS dimensions: PG by amphoe, RPG/SPG by
   *   agency (identical to `StaffHomeService`). We therefore issue two
   *   scoped calls and merge:
   *     - `scope=['main']`             + `filters.amphoeIds`
   *     - `scope=['revised','supplement']` + `filters.agencyIds`
   *   A dimension with zero ids is simply not queried (no global scan).
   */
  private async executiveListWithScope(
    query: UnifiedProjectsListQuery,
    areaScope: { amphoeIds: string[]; agencyIds: string[] } | null,
  ): Promise<EnrichedUnifiedProject[] | UnifiedProjectsCountEnvelope> {
    if (!areaScope) {
      // System-wide (executive) — single call across all three kinds.
      return this.runScopedPipeline(
        query,
        ['main', 'revised', 'supplement'],
        undefined,
      );
    }

    // Area-scoped (staff) — split PG (amphoe) from RPG/SPG (agency) so
    // the per-dimension filters never AND across kinds.
    const calls: Array<{
      scope: UnifiedProjectQuery['scope'];
      filters: UnifiedProjectQuery['filters'];
    }> = [];
    if (areaScope.amphoeIds.length > 0) {
      calls.push({ scope: ['main'], filters: { amphoeIds: areaScope.amphoeIds } });
    }
    if (areaScope.agencyIds.length > 0) {
      calls.push({
        scope: ['revised', 'supplement'],
        filters: { agencyIds: areaScope.agencyIds },
      });
    }

    if (query.countOnly) {
      const envelope: UnifiedProjectsCountEnvelope = {
        pending_review: 0,
        awaiting_approval: 0,
        approved: 0,
        rejected: 0,
      };
      for (const c of calls) {
        const part = (await this.runScopedPipeline(
          query,
          c.scope,
          c.filters,
        )) as UnifiedProjectsCountEnvelope;
        envelope.pending_review += part.pending_review;
        envelope.awaiting_approval += part.awaiting_approval;
        envelope.approved += part.approved;
        envelope.rejected += part.rejected;
      }
      return envelope;
    }

    const merged: EnrichedUnifiedProject[] = [];
    for (const c of calls) {
      const part = (await this.runScopedPipeline(
        query,
        c.scope,
        c.filters,
      )) as EnrichedUnifiedProject[];
      merged.push(...part);
    }
    return merged;
  }

  /**
   * Single aggregator call → enrich → W67 strip/tag (or unbounded
   * count). The atomic unit reused by both the system-wide executive
   * path and each per-dimension staff call.
   */
  private async runScopedPipeline(
    query: UnifiedProjectsListQuery,
    scope: UnifiedProjectQuery['scope'],
    filters: UnifiedProjectQuery['filters'] | undefined,
  ): Promise<EnrichedUnifiedProject[] | UnifiedProjectsCountEnvelope> {
    if (query.countOnly) {
      // BE-01c — unbounded count via the aggregator's direct-DB
      // GROUP BY. Re-key the result into the FE's snake_case envelope.
      const counts = await this.aggregator.countExecutiveStatusBreakdown({
        scope,
        planId: query.developmentPlanId,
        filters,
      });
      return {
        pending_review: counts.pendingReviewCount,
        awaiting_approval: counts.awaitingApprovalCount,
        approved: counts.approvedCount,
        rejected: counts.rejectedCount,
      };
    }

    const leanRows = await this.aggregator.listUnifiedProjects({
      scope,
      planId: query.developmentPlanId,
      filters,
      limit: HTTP_AGGREGATOR_LIMIT,
    });
    let enriched = await this.enricher.enrich(leanRows);

    // §3 W67 — exclude in-flight authoring states from the list path.
    // (The count path uses the aggregator's unbounded breakdown, which
    // excludes the same statuses at the SQL level.)
    enriched = enriched.filter(
      (r) => !EXECUTIVE_EXCLUDED_SET.has(r.status.name),
    );

    return enriched;
  }

  /**
   * Load the caller's current WorkHistory and the two relation rows
   * required for §1 classification (`amphoe`, `localAdministrative
   * Organization`). Throws 401 when the user has no current WH — a
   * defensive complement to `WorkStatusApprovedGuard` (which throws
   * 403 on missing approval but assumes the row exists).
   *
   * This is the canonical "current WorkHistory" lookup pattern used
   * across the codebase (mirrors `TrackingStatusService` /
   * `ProjectGroupsService` etc.) — same `where: { user: { id }, isCurrent: true }`
   * predicate, same relation set.
   */
  private async loadCurrentWorkHistory(userId: string): Promise<WorkHistory> {
    if (!userId) {
      throw new UnauthorizedException('UNAUTHENTICATED');
    }
    const wh = await this.workHistoryRepo.findOne({
      where: { user: { id: userId }, isCurrent: true },
      relations: ['amphoe', 'localAdministrativeOrganization'],
    });
    if (!wh) {
      throw new UnauthorizedException('NO_CURRENT_WORK_HISTORY');
    }
    return wh;
  }

  /**
   * Load the caller's current WorkHistory with the responsibility +
   * role relations needed for the §3 / §4.1 staff area-scope resolution.
   * Mirrors the relation set used by `StaffHomeService.getOverdue`
   * VERBATIM so the scoping rule is single-sourced (do not invent a new
   * resolution).
   *
   * Returns `null` (graceful empty, mirrors `StaffHomeService`) when the
   * user has no current WorkHistory. The `workStatus = approved` gate is
   * enforced by `WorkStatusApprovedGuard` at the controller; the
   * staff-lead role gate is enforced by `RolesGuard` + `@Roles(...)`.
   */
  private async loadStaffWorkHistory(
    userId: string,
  ): Promise<WorkHistory | null> {
    if (!userId) {
      throw new UnauthorizedException('UNAUTHENTICATED');
    }
    return this.workHistoryRepo.findOne({
      where: { user: { id: userId }, isCurrent: true },
      relations: [
        'role',
        'workStatus',
        'workHistoryResponsibleAmphoe',
        'workHistoryResponsibleAmphoe.amphoe',
        'workHistoryResponsibleGovernmentAgency',
        'workHistoryResponsibleGovernmentAgency.governmentAgency',
      ],
    });
  }
}

/**
 * Fold an enriched + filtered row list into the W67 4-group rollup
 * envelope. Rows whose canonical status maps to `null` (in-flight
 * authoring states) are SKIPPED — they should already have been
 * removed by the executive post-filter, but the skip is defensive in
 * case the owner endpoint includes them.
 *
 * §3 W67: the four bucket keys are FROZEN by
 * `executive-status-groups.ts`; mirroring them inline here would
 * silently drift if the canonical mapping is ever extended (e.g. a
 * fifth group), so we read the group key off the helper return.
 */
function rollupExecutiveGroups(
  rows: readonly EnrichedUnifiedProject[],
): UnifiedProjectsCountEnvelope {
  const envelope: UnifiedProjectsCountEnvelope = {
    pending_review: 0,
    awaiting_approval: 0,
    approved: 0,
    rejected: 0,
  };
  for (const r of rows) {
    const group =
      r.executiveStatusGroup ?? mapToExecutiveStatusGroup(r.status.name);
    if (!group) continue;
    envelope[group] += 1;
  }
  return envelope;
}
