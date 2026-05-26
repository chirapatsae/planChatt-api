/**
 * SUPP_AGG_BE_01b — `UnifiedProjectEnricherService`.
 *
 * Post-aggregator, pre-HTTP enrichment layer that converts the lean
 * `UnifiedProject[]` projection produced by the Wave 54 aggregator into
 * the richer `EnrichedUnifiedProject[]` shape consumed by the
 * `/project` owner dashboard and the executive surfaces.
 *
 * Why a separate service (and NOT a fattened aggregator):
 *   - The Wave 54 aggregator is shared with the AI Executive Chat
 *     surface. Widening its emitted shape risks breaking those callers
 *     and violates §17 PII discipline scoping (chat tool handlers
 *     intentionally see only the lean projection).
 *   - The enriched shape needs full parent-book metadata, per-year
 *     budgets, and §14.10 lineage-lock — fields that are HTTP-consumer
 *     specific and have no place inside the aggregator's tool-facing
 *     contract.
 *
 * Query strategy — ZERO N+1:
 *   1. Split the input by `projectKind` into three id buckets.
 *   2. Issue THREE batch queries in parallel, each with its kind's
 *      required relations:
 *        - PG  → developmentPlan + budgets + trackingStatus + createdBy
 *        - RPG → developmentPlanRevision (+ developmentPlan +
 *                 revisionType) + budgets + trackingStatus + createdBy
 *        - SPG → developmentPlanSupplement (+ developmentPlan) +
 *                 budgets + trackingStatus + createdBy
 *      `TrackingStatus` relation is filtered to `isLatest = true` and
 *      joined with `Status` so the canonical English name + Thai display
 *      are loaded together with the project.
 *   3. For PG and RPG, run `LineageLockService.hasNonDeletedDescendant`
 *      in batch (per kind) to compute `hasDescendant`. SPG is hard-
 *      coded to `false` per current model (Wave SUPP-4 will introduce
 *      SPG→RPG lineage — see TODO marker).
 *   4. Merge enrichment back into the lean rows by `projectId` lookup
 *      map. The lean row's `projectKind` is preserved as the
 *      discriminator and the field order in the output matches the
 *      aggregator's input order (stable for the FE).
 *
 * PII discipline (§17 + §17.13): only `WorkHistory.id` is projected
 * into the response envelope. The `createdBy` relation is loaded as a
 * `WorkHistory` row but `WorkHistory` itself carries NO person-level
 * fields (no `firstName`, `lastName`, `citizenId`, `phone`, `email`,
 * `profileImageUrl` — those live on the related `User`, which is NOT
 * loaded because we do not request `createdBy.user` in `relations`).
 * The `EnrichedUnifiedProject.createdByWorkHistoryId` field surfaces
 * only the UUID scalar.
 *
 * Audit (§12): READ-only. No `tracking_status` write anywhere in this
 * service. The `TrackingStatus` relation is loaded only to project
 * `status.name`, `status.th_name`, and `createAt`.
 *
 * CLAUDE.md references:
 *   - §12 / §14.10 / §15 / §16 / §17 (see top of
 *     `enriched-unified-project.ts` for the per-field rationale).
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';

import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';
import { SupplementProjectGroup } from 'src/supplement-project-group/entities/supplement-project-group.entity';
import { LineageLockService } from 'src/common/lineage-lock/lineage-lock.service';
import { mapToExecutiveStatusGroup } from 'src/ai-executive-chat/aggregation/constants/executive-status-groups';
import type { UnifiedProject } from 'src/ai-executive-chat/aggregation/types';

import type {
  EnrichedBudget,
  EnrichedCreator,
  EnrichedDevelopmentPlan,
  EnrichedDevelopmentPlanRevision,
  EnrichedDevelopmentPlanSupplement,
  EnrichedStatus,
  EnrichedUnifiedProject,
} from '../types/enriched-unified-project';

/**
 * Internal per-row enrichment bundle keyed by `projectId`. Holds the
 * post-load, pre-merge values so the final fold step can index each
 * lean row in O(1) without re-walking the parent collections.
 */
interface RowEnrichment {
  status: EnrichedStatus;
  developmentPlan: EnrichedDevelopmentPlan;
  developmentPlanRevision?: EnrichedDevelopmentPlanRevision;
  developmentPlanSupplement?: EnrichedDevelopmentPlanSupplement;
  budgets: EnrichedBudget[];
  createdAt: string;
  createdByWorkHistoryId: string;
  createdBy: EnrichedCreator;
  hasDescendant: boolean;
  /**
   * Per-row booked-state — Wave wave-supplement-convergence-milestone-
   * 2-spg-booked-fields / FE-01 (2026-05-25). §20 parity with PG/RPG
   * for SPG (whose entity gained these columns in DB-01). Forwarded
   * verbatim from the owning entity row.
   */
  isBooked: boolean;
  bookedAt: string | null;
}

@Injectable()
export class UnifiedProjectEnricherService {
  private readonly logger = new Logger(UnifiedProjectEnricherService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly lineageLock: LineageLockService,
  ) { }

  /**
   * Enrich a lean `UnifiedProject[]` into `EnrichedUnifiedProject[]`.
   *
   * Empty input → empty output. Rows whose enrichment cannot be
   * resolved (orphaned plan FK, missing latest tracking row, etc.) are
   * DROPPED from the output and logged at WARN. This keeps the FE
   * envelope structurally sound — a partial row would force the FE to
   * defensive-null-check every field of the contract.
   */
  async enrich(
    rows: readonly UnifiedProject[],
  ): Promise<EnrichedUnifiedProject[]> {
    if (rows.length === 0) return [];

    const mainIds: string[] = [];
    const revisedIds: string[] = [];
    const supplementIds: string[] = [];
    for (const r of rows) {
      switch (r.projectKind) {
        case 'main':
          mainIds.push(r.projectId);
          break;
        case 'revised':
          revisedIds.push(r.projectId);
          break;
        case 'supplement':
          supplementIds.push(r.projectId);
          break;
      }
    }

    // Three parallel batch loads — one per kind. The `In(ids)` clause
    // is fan-in across all rows of that kind so the total query count
    // is exactly 3 (regardless of input cardinality). Lineage-lock
    // checks fan out as 2 more queries (PG + RPG batch); SPG is `false`
    // by definition until Wave SUPP-4 lands.
    const manager = this.dataSource.manager;
    // PII discipline (§17): we load `createdBy` as a relation but
    // project ONLY `createdBy.id` into the enriched envelope. The
    // relation's other columns (firstName / lastName / citizenId / etc.
    // — all on the related `User`, not on `WorkHistory` itself) are
    // not transitively loaded because we do not request `createdBy.user`
    // in `relations`. `WorkHistory` itself carries only role / amphoe /
    // LAO id scalars, no person-level fields.
    const [pgRows, rpgRows, spgRows] = await Promise.all([
      mainIds.length > 0
        ? manager.find(ProjectGroup, {
          where: { id: In(mainIds) },
          relations: {
            developmentPlan: true,
            budgets: true,
            trackingStatus: { statusId: true },
            createdBy: {
              user: true,
              amphoe: true,
              localAdministrativeOrganization: true,
            },
          },
        })
        : Promise.resolve([] as ProjectGroup[]),
      revisedIds.length > 0
        ? manager.find(RevisedProjectGroup, {
          where: { id: In(revisedIds) },
          relations: {
            developmentPlanRevision: {
              developmentPlan: true,
              revisionType: true,
            },
            budgets: true,
            trackingStatus: { statusId: true },
            createdBy: {
              user: true,
              amphoe: true,
              localAdministrativeOrganization: true,
            },
          },
        })
        : Promise.resolve([] as RevisedProjectGroup[]),
      supplementIds.length > 0
        ? manager.find(SupplementProjectGroup, {
          where: { id: In(supplementIds) },
          relations: {
            developmentPlanSupplement: { developmentPlan: true },
            budgets: true,
            trackingStatus: { statusId: true },
            createdBy: {
              user: true,
              amphoe: true,
              localAdministrativeOrganization: true,
            },
          },
        })
        : Promise.resolve([] as SupplementProjectGroup[]),
    ]);

    // Lineage-lock fan-out. The current `LineageLockService` API takes
    // one id at a time; we fan a Promise per id but keep them all
    // inside a single `Promise.all` so latency stays at one round-trip
    // batch instead of serial. Each call is a `manager.exists(...)`
    // against the indexed `(prev_project_id, prev_project_type)`
    // column pair, so the cost is constant per row.
    const spgIds = spgRows.map((s) => s.id);
    const [pgLockMap, rpgLockMap, spgLockMap] = await Promise.all([
      this.batchLineageLocks(mainIds, 'original'),
      this.batchLineageLocks(revisedIds, 'revised'),
      // Wave SUPP-4 — SPG can now have RPG descendants
      // (prev_project_type='supplement'). Fan-out the lock query the
      // same way PG/RPG do.
      this.batchLineageLocks(spgIds, 'supplement'),
    ]);

    // Build the `projectId → RowEnrichment` lookup map. Rows that fail
    // to enrich are skipped here and logged at WARN.
    const enrichmentByProjectId = new Map<string, RowEnrichment>();
    for (const pg of pgRows) {
      const e = this.buildPgEnrichment(pg, pgLockMap.get(pg.id) ?? false);
      if (e) enrichmentByProjectId.set(pg.id, e);
    }
    for (const rpg of rpgRows) {
      const e = this.buildRpgEnrichment(rpg, rpgLockMap.get(rpg.id) ?? false);
      if (e) enrichmentByProjectId.set(rpg.id, e);
    }
    for (const spg of spgRows) {
      // Wave SUPP-4 — SPG lineage lock now live. Sources `spgLockMap`
      // populated by `batchLineageLocks(..., 'supplement')` above.
      const e = this.buildSpgEnrichment(spg, spgLockMap.get(spg.id) ?? false);
      if (e) enrichmentByProjectId.set(spg.id, e);
    }

    // Final fold: merge enrichment with the lean rows in input order.
    const out: EnrichedUnifiedProject[] = [];
    for (const lean of rows) {
      const enrichment = enrichmentByProjectId.get(lean.projectId);
      if (!enrichment) {
        this.logger.warn(
          `Dropping unified-project row id=${lean.projectId} kind=${lean.projectKind} — enrichment unresolved`,
        );
        continue;
      }
      out.push({
        ...lean,
        status: enrichment.status,
        executiveStatusGroup: mapToExecutiveStatusGroup(enrichment.status.name),
        hasDescendant: enrichment.hasDescendant,
        developmentPlan: enrichment.developmentPlan,
        developmentPlanRevision: enrichment.developmentPlanRevision,
        developmentPlanSupplement: enrichment.developmentPlanSupplement,
        budgets: enrichment.budgets,
        createdAt: enrichment.createdAt,
        createdByWorkHistoryId: enrichment.createdByWorkHistoryId,
        createdBy: enrichment.createdBy,
        isBooked: enrichment.isBooked,
        bookedAt: enrichment.bookedAt,
      });
    }
    return out;
  }

  // ---------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------

  /**
   * Fan-out lineage-lock checks for an id batch. Returns a Map so the
   * fold step indexes in O(1). Empty input → empty Map (no queries).
   */
  private async batchLineageLocks(
    ids: readonly string[],
    type: 'original' | 'revised' | 'supplement',
  ): Promise<Map<string, boolean>> {
    if (ids.length === 0) return new Map();
    const manager = this.dataSource.manager;
    const results = await Promise.all(
      ids.map(async (id) => {
        const has = await this.lineageLock.hasNonDeletedDescendant(
          id,
          type,
          manager,
        );
        return [id, has] as const;
      }),
    );
    return new Map(results);
  }

  private buildPgEnrichment(
    pg: ProjectGroup,
    hasDescendant: boolean,
  ): RowEnrichment | null {
    if (!pg.developmentPlan) return null;
    if (!pg.createdBy) return null;
    const status = pickLatestStatus(pg.trackingStatus);
    if (!status) return null;

    return {
      status,
      developmentPlan: mapDevelopmentPlan(pg.developmentPlan),
      developmentPlanRevision: undefined,
      developmentPlanSupplement: undefined,
      budgets: mapBudgets(pg.budgets),
      createdAt: toIsoString(pg.createdAt),
      createdByWorkHistoryId: pg.createdBy.id,
      createdBy: mapCreator(pg.createdBy as any),
      hasDescendant,
      isBooked: Boolean(pg.isBooked),
      bookedAt: toNullableIsoString(pg.bookedAt),
    };
  }

  private buildRpgEnrichment(
    rpg: RevisedProjectGroup,
    hasDescendant: boolean,
  ): RowEnrichment | null {
    const dpr = rpg.developmentPlanRevision;
    if (!dpr) return null;
    if (!dpr.developmentPlan) return null;
    if (!rpg.createdBy) return null;
    const status = pickLatestStatus(rpg.trackingStatus);
    if (!status) return null;

    return {
      status,
      developmentPlan: mapDevelopmentPlan(dpr.developmentPlan),
      developmentPlanRevision: {
        id: dpr.id,
        revisionNumber: dpr.revisionNumber,
        revisionTypeName: dpr.revisionType?.name ?? '',
        description: dpr.description ?? null,
        isLatest: dpr.isLatest,
        isBooked: dpr.isBooked,
        isOpen: dpr.isOpen,
      },
      developmentPlanSupplement: undefined,
      budgets: mapBudgets(rpg.budgets),
      createdAt: toIsoString(rpg.createdAt),
      createdByWorkHistoryId: rpg.createdBy.id,
      createdBy: mapCreator(rpg.createdBy as any),
      hasDescendant,
      isBooked: Boolean(rpg.isBooked),
      bookedAt: toNullableIsoString(rpg.bookedAt),
    };
  }

  private buildSpgEnrichment(
    spg: SupplementProjectGroup,
    hasDescendant: boolean,
  ): RowEnrichment | null {
    const dps = spg.developmentPlanSupplement;
    if (!dps) return null;
    if (!dps.developmentPlan) return null;
    if (!spg.createdBy) return null;
    const status = pickLatestStatus(spg.trackingStatus);
    if (!status) return null;

    return {
      status,
      developmentPlan: mapDevelopmentPlan(dps.developmentPlan),
      developmentPlanRevision: undefined,
      developmentPlanSupplement: {
        id: dps.id,
        supplementNumber: dps.supplementNumber,
        description: dps.description ?? null,
        isLatest: dps.isLatest,
        isBooked: dps.isBooked,
        isOpen: dps.isOpen,
      },
      budgets: mapBudgets(spg.budgets),
      createdAt: toIsoString(spg.createdAt),
      createdByWorkHistoryId: spg.createdBy.id,
      createdBy: mapCreator(spg.createdBy as any),
      hasDescendant,
      // §20 parity — Wave wave-supplement-convergence-milestone-2-spg-
      // booked-fields. Reads directly from the SPG row (DB-01 added
      // these columns; BE-01 wires them at merge() / reset). Replaces
      // the legacy `dps.isBooked` inheritance which conflated the
      // SUPPLEMENT-ROUND booked state with the per-SPG booked state.
      isBooked: Boolean(spg.isBooked),
      bookedAt: toNullableIsoString(spg.bookedAt),
    };
  }
}

/**
 * Defensive ISO-string conversion. TypeORM returns `Date` for
 * `@CreateDateColumn`; older raw paths may already return ISO strings.
 * Falls back to empty string on unexpected input (the FE timeline-sort
 * memo guards against `0` so an unparseable value clusters at the
 * bottom rather than throwing).
 */
function toIsoString(value: Date | string | null | undefined): string {
  if (value == null) return '';
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  }
  if (typeof value === 'string') {
    const t = new Date(value).getTime();
    return Number.isFinite(t) ? new Date(t).toISOString() : '';
  }
  return '';
}

/**
 * Nullable variant of `toIsoString`. Null / undefined / unparseable
 * input → `null` (NOT empty string). Used for `bookedAt` where `null`
 * is the meaningful "not yet booked" sentinel — collapsing it to an
 * empty string would cause the FE `BookedBadge` to render a stale
 * dash instead of suppressing the date row.
 */
function toNullableIsoString(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === 'string') {
    const t = new Date(value).getTime();
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  return null;
}

// -----------------------------------------------------------------------
// Pure mappers — kept module-private and stateless so they can be unit-
// tested in isolation if a follow-up wave adds a test harness.
// -----------------------------------------------------------------------

function mapDevelopmentPlan(plan: {
  id: string;
  name: string;
  startYear: number;
  endYear: number;
  isLatest: boolean;
  isBooked: boolean;
  reportFormat: string;
}): EnrichedDevelopmentPlan {
  // The `DevelopmentPlan.reportFormat` column is typed as the
  // `ReportFormat` enum (`STRATEGY_BASED | ISSUE_BASED`) — see
  // `src/development-plan/types/report-format.enum.ts`. We accept it
  // as a generic string at the mapper boundary to avoid a nominal-
  // enum coupling against the FE shape, then narrow back to the union
  // at the type cast below. §16.4 guarantees no third value can ever
  // appear here.
  return {
    id: plan.id,
    name: plan.name,
    startYear: plan.startYear,
    endYear: plan.endYear,
    isLatest: plan.isLatest,
    isBooked: plan.isBooked,
    reportFormat: plan.reportFormat as 'STRATEGY_BASED' | 'ISSUE_BASED',
  };
}

function mapCreator(wh: {
  id: string;
  user?: { firstname?: string | null; lastname?: string | null } | null;
  amphoe?: { id: string; name: string } | null;
  localAdministrativeOrganization?: { id: string; name: string } | null;
}): EnrichedCreator {
  return {
    workHistoryId: wh.id,
    firstName: wh.user?.firstname ?? null,
    lastName: wh.user?.lastname ?? null,
    amphoe: wh.amphoe ? { id: wh.amphoe.id, name: wh.amphoe.name } : null,
    localAdministrativeOrganization: wh.localAdministrativeOrganization
      ? {
        id: wh.localAdministrativeOrganization.id,
        name: wh.localAdministrativeOrganization.name,
      }
      : null,
  };
}

function mapBudgets(
  budgets: ReadonlyArray<{ year: number; quantity: number | string }> | undefined,
): EnrichedBudget[] {
  if (!budgets || budgets.length === 0) return [];
  // `budget.quantity` is stored as `decimal(18,2)` — TypeORM returns it
  // as a string. Coerce defensively so the FE always sees a number.
  return budgets.map((b) => ({
    year: b.year,
    quantity: typeof b.quantity === 'string' ? Number(b.quantity) : b.quantity,
  }));
}

/**
 * Pick the row with `isLatest=true` from a TrackingStatus collection.
 * Returns `null` when the collection is empty or no latest row is
 * present (which signals an audit-state inconsistency — logged by the
 * caller).
 *
 * Per §12 there should be at most ONE `isLatest=true` row per project;
 * if the data violates that we keep the newest `createAt` defensively
 * (mirrors `StatusAggregator`'s duplicate-handling rule).
 */
function pickLatestStatus(
  trackingStatus:
    | ReadonlyArray<{
      isLatest: boolean;
      createAt: Date;
      statusId: { name: string; th_name: string } | null;
    }>
    | undefined,
): EnrichedStatus | null {
  if (!trackingStatus || trackingStatus.length === 0) return null;
  let chosen: {
    isLatest: boolean;
    createAt: Date;
    statusId: { name: string; th_name: string } | null;
  } | null = null;
  for (const ts of trackingStatus) {
    if (!ts.isLatest) continue;
    if (!ts.statusId) continue;
    if (!chosen) {
      chosen = ts;
      continue;
    }
    if (ts.createAt && chosen.createAt && ts.createAt > chosen.createAt) {
      chosen = ts;
    }
  }
  if (!chosen || !chosen.statusId) return null;
  return {
    name: chosen.statusId.name,
    thName: chosen.statusId.th_name ?? '',
    statusAt:
      chosen.createAt instanceof Date
        ? chosen.createAt.toISOString()
        : new Date(chosen.createAt as unknown as string).toISOString(),
  };
}
