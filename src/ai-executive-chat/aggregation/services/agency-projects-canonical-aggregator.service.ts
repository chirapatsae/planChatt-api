/**
 * Wave 103 — PR1 Canonical Agency-Projects Aggregator.
 *
 * SOURCE OF TRUTH for "how many projects does agency X own?" across
 * Executive AI tools. PR0 audit confirmed the user-visible count drift
 * (5 vs 8) was caused by two independent bugs in the prior tool layer:
 *
 *   - `getCrossPlanInsights` walks every book; `getExecutiveDashboardSnapshot`
 *     filters to a single plan via `dp.id = :planId`.
 *   - `listUnifiedProjects` has NO default status filter, so older books
 *     leak in-flight statuses (`Pending_Approval`, `Returned_For_Revision`,
 *     etc.) into the count.
 *
 * This service provides ONE deterministic answer with deterministic
 * scope/status defaults.
 *
 * POLICY DEFAULTS (per CTO + sensible defaults brief):
 *
 *   1. **Book scope**: ALL BOOKS (`planId` optional; omitted = all books).
 *   2. **Lineage**: PG + RPG + SPG, but HEAD-only per chain (Wave 55
 *      `applyHeadFilterFor*` pattern). Each chain contributes 1 row.
 *   3. **Status filter** — §15-aware:
 *        - On `is_latest=true` book → include {Approved, Pending,
 *          Verified, Pending_Approval} ("active workflow").
 *        - On `is_latest=false` book → include {Approved} only (history).
 *      EXCLUDED ALWAYS: {Ready, Pull_Back, Returned_For_Revision, Rejected}.
 *   4. **Agency match**: exact PK only (caller resolves via `listAgencies()`).
 *   5. **Soft-delete**: excluded everywhere (§14.2).
 *   6. **§16 reportFormat**: count is format-agnostic — `ProjectGroup.id`
 *      is the unit, not classification fields. Enrichment paths
 *      (description / classification) branch on `reportFormat` elsewhere.
 *
 * INVARIANTS (HARD):
 *   - READ-only. Zero `.save` / `.update` / `.delete` / `.softRemove`.
 *   - No `tracking_status` writes (§17.3).
 *   - Reads allowed on locked rows / frozen books (§14.6 / §15.7 / §17.6).
 *   - Advisory only — never gates a workflow transition (§17.2).
 *   - No role exemption (§17.11) — service accepts already-asserted
 *     executive context from Tier C.
 *
 * FEATURE FLAG:
 *   `EXECUTIVE_AI_CANONICAL_AGENCY_AGGREGATOR` (default OFF). PR1 adds
 *   no consumers; PR2 reroutes tool handlers behind the same flag.
 *
 * CLAUDE.md references:
 *   - §11 Versioning Rule
 *   - §14.1 / §14.2 Lineage Definition + Immutability
 *   - §15.2 / §15.3 Book Lineage Immutability + global timeline
 *   - §16.4 / §16.5 reportFormat ownership / shape invariant
 *   - §17.2 advisory, §17.3 audit separation, §17.7 classification
 *     branching, §17.11 no role exemption.
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, SelectQueryBuilder } from 'typeorm';

import { Budget } from 'src/budget/entities/budget.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';
import { Status } from 'src/status/entities/status.entity';
import { SupplementProjectGroup } from 'src/supplement-project-group/entities/supplement-project-group.entity';
import { TrackingStatus } from 'src/tracking-status/entities/tracking-status.entity';

import {
  applyHeadFilterForProjectGroup,
  applyHeadFilterForRevisedProjectGroup,
} from '../helpers/head-of-lineage';

// ─────────────────────────────────────────────────────────────────────
// Status policy constants
// ─────────────────────────────────────────────────────────────────────

/**
 * Active-workflow statuses surfaced when the parent book is the latest
 * (`development_plan.isLatest = true`). Excludes Ready, Pull_Back,
 * Returned_For_Revision, Rejected per §17.2 / Wave 67 rejected-as-exit.
 */
export const CANONICAL_ACTIVE_STATUSES = [
  'Approved',
  'Pending',
  'Verified',
  'Pending_Approval',
] as const;

/**
 * History-only statuses surfaced when the parent book is frozen
 * (`development_plan.isLatest = false`). On a frozen book only Approved
 * rows count toward the agency's portfolio (in-flight states on a
 * frozen book are workflow-stale by §15 and are ignored).
 */
export const CANONICAL_FROZEN_STATUSES = ['Approved'] as const;

// ─────────────────────────────────────────────────────────────────────
// Public API types
// ─────────────────────────────────────────────────────────────────────

export interface AgencyProjectsCanonicalInput {
  /** Resolved by `listAgencies()` — exact PK match. Empty = no rows. */
  agencyIds: number[];
  /** Optional book scope; when omitted, walks ALL books. */
  planId?: string;
  scope?: {
    /**
     * Default `true`. When `false`, frozen books are skipped entirely
     * (matches the legacy `getExecutiveDashboardSnapshot` single-plan
     * behavior when caller explicitly wants latest-book-only).
     */
    includeBookFrozen?: boolean;
    /**
     * Override the default status set. When provided, it replaces the
     * §15-aware (active vs frozen) split with a single uniform set
     * applied to every book (active and frozen alike).
     */
    includeStatuses?: ReadonlySet<string>;
  };
}

export interface AgencyProjectsByBook {
  bookName: string;
  bookId: string;
  isLatest: boolean;
  count: number;
  budget: number;
}

export interface AgencyProjectsCanonicalEnvelope {
  /**
   * Lineage-deduped count. Each lineage chain contributes 1 row (HEAD
   * only). This is the canonical "how many distinct projects does the
   * agency own" answer.
   */
  count: number;
  /** Sum of every Budget.quantity across the deduped row set. */
  budgetTotal: number;
  /** Per-book breakdown for "(N โครงการ in book X)" rendering. */
  byBook: AgencyProjectsByBook[];
  /** Per-lineage breakdown for diagnostics. */
  byLineage: { pg: number; rpg: number; spg: number };
  /** Raw per-table count (NOT deduped) for side-by-side debugging. */
  rawRowCount: { pg: number; rpg: number; spg: number };
  /** Diagnostic record of the policy actually applied. */
  scopeApplied: {
    bookScope: 'all-books' | `single-plan:${string}`;
    statusesActive: string[];
    statusesFrozen: string[];
    headFilterActive: true;
  };
}

// ─────────────────────────────────────────────────────────────────────
// Internal raw-row shapes (TypeORM lowercases raw aliases)
// ─────────────────────────────────────────────────────────────────────

type CountRow = {
  bookid: string;
  bookname: string | null;
  islatest: boolean | string | null;
  cnt: string | number;
  budgetsum: string | number | null;
};

// ─────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────

@Injectable()
export class AgencyProjectsCanonicalAggregatorService {
  private readonly logger = new Logger(
    AgencyProjectsCanonicalAggregatorService.name,
  );

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /**
   * Compute the canonical envelope for the given agency scope.
   * Returns an all-zero envelope on empty `agencyIds` — never throws.
   */
  async aggregate(
    input: AgencyProjectsCanonicalInput,
  ): Promise<AgencyProjectsCanonicalEnvelope> {
    const agencyIds = Array.isArray(input?.agencyIds) ? input.agencyIds : [];

    const includeBookFrozen = input?.scope?.includeBookFrozen ?? true;
    const overrideStatuses = input?.scope?.includeStatuses ?? null;

    const statusesActive = overrideStatuses
      ? Array.from(overrideStatuses)
      : ([...CANONICAL_ACTIVE_STATUSES] as string[]);
    const statusesFrozen = overrideStatuses
      ? Array.from(overrideStatuses)
      : ([...CANONICAL_FROZEN_STATUSES] as string[]);

    const bookScope: 'all-books' | `single-plan:${string}` = input.planId
      ? `single-plan:${input.planId}`
      : 'all-books';

    const empty = (): AgencyProjectsCanonicalEnvelope => ({
      count: 0,
      budgetTotal: 0,
      byBook: [],
      byLineage: { pg: 0, rpg: 0, spg: 0 },
      rawRowCount: { pg: 0, rpg: 0, spg: 0 },
      scopeApplied: {
        bookScope,
        statusesActive,
        statusesFrozen,
        headFilterActive: true,
      },
    });

    if (agencyIds.length === 0) return empty();

    const [pgRows, rpgRows, spgRows] = await Promise.all([
      this.countMain(
        agencyIds,
        input.planId,
        statusesActive,
        statusesFrozen,
        includeBookFrozen,
      ),
      this.countRevised(
        agencyIds,
        input.planId,
        statusesActive,
        statusesFrozen,
        includeBookFrozen,
      ),
      this.countSupplement(
        agencyIds,
        input.planId,
        statusesActive,
        statusesFrozen,
        includeBookFrozen,
      ),
    ]);

    // Per-book aggregation. Key by bookId; merge counts across the
    // three lineage tables. PG / SPG always group on the DevelopmentPlan
    // itself, so `bookId === planId` for those. RPG groups on its
    // parent DevelopmentPlanRevision but we surface the parent
    // DevelopmentPlan id as `bookId` so cross-lineage book grouping
    // collapses to the same key.
    const byBookMap = new Map<string, AgencyProjectsByBook>();
    let pgCount = 0;
    let rpgCount = 0;
    let spgCount = 0;
    let pgRaw = 0;
    let rpgRaw = 0;
    let spgRaw = 0;
    let totalBudget = 0;

    const fold = (rows: CountRow[]): { count: number; raw: number } => {
      let perKindCount = 0;
      let perKindRaw = 0;
      for (const r of rows) {
        const cnt = toFiniteNumber(r.cnt);
        const budget = toFiniteNumber(r.budgetsum);
        const isLatest = toBool(r.islatest);
        perKindCount += cnt;
        perKindRaw += cnt; // HEAD-filter is the dedup; raw == deduped here.
        totalBudget += budget;
        const key = r.bookid;
        const existing = byBookMap.get(key);
        if (existing) {
          existing.count += cnt;
          existing.budget += budget;
        } else {
          byBookMap.set(key, {
            bookId: r.bookid,
            bookName: r.bookname ?? '',
            isLatest,
            count: cnt,
            budget,
          });
        }
      }
      return { count: perKindCount, raw: perKindRaw };
    };

    const pgFold = fold(pgRows);
    pgCount = pgFold.count;
    pgRaw = pgFold.raw;

    const rpgFold = fold(rpgRows);
    rpgCount = rpgFold.count;
    rpgRaw = rpgFold.raw;

    const spgFold = fold(spgRows);
    spgCount = spgFold.count;
    spgRaw = spgFold.raw;

    return {
      count: pgCount + rpgCount + spgCount,
      budgetTotal: totalBudget,
      byBook: Array.from(byBookMap.values()).sort((a, b) => {
        // Latest book first, then by bookName for stability.
        if (a.isLatest !== b.isLatest) return a.isLatest ? -1 : 1;
        return a.bookName.localeCompare(b.bookName);
      }),
      byLineage: { pg: pgCount, rpg: rpgCount, spg: spgCount },
      rawRowCount: { pg: pgRaw, rpg: rpgRaw, spg: spgRaw },
      scopeApplied: {
        bookScope,
        statusesActive,
        statusesFrozen,
        headFilterActive: true,
      },
    };
  }

  /**
   * Side-by-side comparator used by PR2 during the rollout window.
   * Returns the canonical envelope and logs any divergence between it
   * and the legacy paths via `Logger.warn`.
   *
   * `legacyDashboard` and `legacyCrossPlan` are the {count, budget}
   * the existing tools produced via `listUnifiedProjects` — PR2 will
   * compute these inline before calling this method.
   *
   * Logging shape:
   *   `[W103] canonical=X legacy_dashboard=Y legacy_crossplan=Z agencyIds=[...]`
   */
  async computeWithLegacyComparison(
    input: AgencyProjectsCanonicalInput,
    legacy: {
      dashboard?: { count: number; budget: number };
      crossPlan?: { count: number; budget: number };
    },
  ): Promise<AgencyProjectsCanonicalEnvelope> {
    const canonical = await this.aggregate(input);

    const dash = legacy.dashboard;
    const cross = legacy.crossPlan;
    const dashCount = dash ? dash.count : 'n/a';
    const crossCount = cross ? cross.count : 'n/a';
    const dashBudget = dash ? dash.budget : 'n/a';
    const crossBudget = cross ? cross.budget : 'n/a';

    this.logger.warn(
      `[W103] canonical=${canonical.count} legacy_dashboard=${dashCount} legacy_crossplan=${crossCount} ` +
        `budgets canonical=${canonical.budgetTotal} legacy_dashboard=${dashBudget} legacy_crossplan=${crossBudget} ` +
        `agencyIds=[${input.agencyIds.join(',')}] planId=${input.planId ?? '-'}`,
    );

    return canonical;
  }

  // ───────────────────────────────────────────────────────────────────
  // Per-kind GROUP BY queries
  // ───────────────────────────────────────────────────────────────────

  /**
   * COUNT(*) GROUP BY parent DevelopmentPlan for ProjectGroup. Applies
   * §14.2 HEAD-of-lineage anti-join (Wave 57 helper) and the §15-aware
   * status set per `dp.isLatest`.
   *
   * The status predicate uses a CASE-style boolean expression so a
   * single query covers both branches in one round-trip. Budget is
   * summed via a correlated subquery (matches the pattern used in
   * `executive-tool-handlers.listProjectsInPlan`).
   */
  private async countMain(
    agencyIds: number[],
    planId: string | undefined,
    statusesActive: string[],
    statusesFrozen: string[],
    includeBookFrozen: boolean,
  ): Promise<CountRow[]> {
    const qb: SelectQueryBuilder<ProjectGroup> = this.dataSource
      .getRepository(ProjectGroup)
      .createQueryBuilder('pg')
      .innerJoin('pg.developmentPlan', 'dp')
      .innerJoin(
        TrackingStatus,
        'ts',
        'ts.project_group_id = pg.id ' +
          'AND ts.is_latest = true ' +
          'AND ts."deletedAt" IS NULL',
      )
      .innerJoin(Status, 'st', 'st.id = ts.status_id')
      // LEFT JOIN to Budget fans the spine out by N budget rows per
      // project. COUNT(DISTINCT pg.id) collapses back to the canonical
      // project count; COALESCE(SUM(b.quantity), 0) is the correct
      // total because the status join is 1:1 (is_latest=true filter).
      .leftJoin(Budget, 'b', 'b.project_group_id = pg.id')
      .select('dp.id', 'bookid')
      .addSelect('dp.name', 'bookname')
      .addSelect('dp.isLatest', 'islatest')
      .addSelect('COUNT(DISTINCT pg.id)', 'cnt')
      .addSelect('COALESCE(SUM(b.quantity), 0)', 'budgetsum')
      .where('pg.deletedAt IS NULL')
      .andWhere('dp.deletedAt IS NULL')
      .andWhere('pg.responsible_agency_id IN (:...mainAgencyIds)', {
        mainAgencyIds: agencyIds,
      })
      .andWhere(
        '((dp.isLatest = true AND st.name IN (:...mainStatusActive)) OR (dp.isLatest = false AND st.name IN (:...mainStatusFrozen)))',
        {
          mainStatusActive: statusesActive,
          mainStatusFrozen: statusesFrozen,
        },
      )
      .groupBy('dp.id')
      .addGroupBy('dp.name')
      .addGroupBy('dp.isLatest');

    if (planId) {
      qb.andWhere('dp.id = :mainPlanIdFilter', { mainPlanIdFilter: planId });
    }
    if (!includeBookFrozen) {
      qb.andWhere('dp.isLatest = true');
    }

    applyHeadFilterForProjectGroup(qb, 'pg');

    return qb.getRawMany<CountRow>();
  }

  /**
   * COUNT(*) GROUP BY DevelopmentPlan (the parent of the parent DPR)
   * for RevisedProjectGroup. RPG's effective "book frozenness" is
   * inherited from its DevelopmentPlan via the DPR chain (per §16.3
   * — reportFormat ownership — same hierarchy applies for `isLatest`).
   *
   * Note: RPG-level §15 frozenness within a plan (a DPR with a newer
   * sibling DPR / DPS) is NOT factored into the status policy here.
   * Status policy keys off the TOP-of-chain DevelopmentPlan only.
   * This matches the brief's "is_latest book" wording.
   */
  private async countRevised(
    agencyIds: number[],
    planId: string | undefined,
    statusesActive: string[],
    statusesFrozen: string[],
    includeBookFrozen: boolean,
  ): Promise<CountRow[]> {
    const qb: SelectQueryBuilder<RevisedProjectGroup> = this.dataSource
      .getRepository(RevisedProjectGroup)
      .createQueryBuilder('rpg')
      .innerJoin('rpg.developmentPlanRevision', 'dpr')
      .innerJoin('dpr.developmentPlan', 'dp')
      .innerJoin(
        TrackingStatus,
        'ts',
        'ts.revised_project_group_id = rpg.id ' +
          'AND ts.is_latest = true ' +
          'AND ts."deletedAt" IS NULL',
      )
      .innerJoin(Status, 'st', 'st.id = ts.status_id')
      .leftJoin(Budget, 'b', 'b.revised_project_group_id = rpg.id')
      .select('dp.id', 'bookid')
      .addSelect('dp.name', 'bookname')
      .addSelect('dp.isLatest', 'islatest')
      .addSelect('COUNT(DISTINCT rpg.id)', 'cnt')
      .addSelect('COALESCE(SUM(b.quantity), 0)', 'budgetsum')
      .where('rpg.deletedAt IS NULL')
      .andWhere('dpr.deletedAt IS NULL')
      .andWhere('dp.deletedAt IS NULL')
      .andWhere('rpg.responsible_agency_id IN (:...revisedAgencyIds)', {
        revisedAgencyIds: agencyIds,
      })
      .andWhere(
        '((dp.isLatest = true AND st.name IN (:...revisedStatusActive)) OR (dp.isLatest = false AND st.name IN (:...revisedStatusFrozen)))',
        {
          revisedStatusActive: statusesActive,
          revisedStatusFrozen: statusesFrozen,
        },
      )
      .groupBy('dp.id')
      .addGroupBy('dp.name')
      .addGroupBy('dp.isLatest');

    if (planId) {
      qb.andWhere('dp.id = :revisedPlanIdFilter', {
        revisedPlanIdFilter: planId,
      });
    }
    if (!includeBookFrozen) {
      qb.andWhere('dp.isLatest = true');
    }

    applyHeadFilterForRevisedProjectGroup(qb, 'rpg');

    return qb.getRawMany<CountRow>();
  }

  /**
   * COUNT(*) GROUP BY DevelopmentPlan for SupplementProjectGroup. SPG
   * has no §14 lineage chain (it is not part of the PG / RPG fork
   * lineage per existing aggregator comments) so HEAD anti-join is
   * intentionally skipped — every non-soft-deleted SPG row is its own
   * head.
   */
  private async countSupplement(
    agencyIds: number[],
    planId: string | undefined,
    statusesActive: string[],
    statusesFrozen: string[],
    includeBookFrozen: boolean,
  ): Promise<CountRow[]> {
    const qb: SelectQueryBuilder<SupplementProjectGroup> = this.dataSource
      .getRepository(SupplementProjectGroup)
      .createQueryBuilder('spg')
      .innerJoin('spg.developmentPlanSupplement', 'dps')
      .innerJoin('dps.developmentPlan', 'dp')
      .innerJoin(
        TrackingStatus,
        'ts',
        'ts.supplement_project_group_id = spg.id ' +
          'AND ts.is_latest = true ' +
          'AND ts."deletedAt" IS NULL',
      )
      .innerJoin(Status, 'st', 'st.id = ts.status_id')
      .leftJoin(Budget, 'b', 'b.supplement_project_group_id = spg.id')
      .select('dp.id', 'bookid')
      .addSelect('dp.name', 'bookname')
      .addSelect('dp.isLatest', 'islatest')
      .addSelect('COUNT(DISTINCT spg.id)', 'cnt')
      .addSelect('COALESCE(SUM(b.quantity), 0)', 'budgetsum')
      .where('spg.deletedAt IS NULL')
      .andWhere('dps.deletedAt IS NULL')
      .andWhere('dp.deletedAt IS NULL')
      .andWhere('spg.responsible_agency_id IN (:...supplementAgencyIds)', {
        supplementAgencyIds: agencyIds,
      })
      .andWhere(
        '((dp.isLatest = true AND st.name IN (:...supplementStatusActive)) OR (dp.isLatest = false AND st.name IN (:...supplementStatusFrozen)))',
        {
          supplementStatusActive: statusesActive,
          supplementStatusFrozen: statusesFrozen,
        },
      )
      .groupBy('dp.id')
      .addGroupBy('dp.name')
      .addGroupBy('dp.isLatest');

    if (planId) {
      qb.andWhere('dp.id = :supplementPlanIdFilter', {
        supplementPlanIdFilter: planId,
      });
    }
    if (!includeBookFrozen) {
      qb.andWhere('dp.isLatest = true');
    }

    return qb.getRawMany<CountRow>();
  }
}

// ─────────────────────────────────────────────────────────────────────
// Feature flag accessor
// ─────────────────────────────────────────────────────────────────────

/**
 * Wave 103 PR1 feature flag. Default OFF. PR2 will branch on this in
 * each tool handler — when OFF the legacy code path is unchanged.
 *
 * Read at call time (NOT module-init) so test harnesses can flip the
 * env var per test without re-importing.
 */
export function isCanonicalAgencyAggregatorEnabled(): boolean {
  return (
    process.env.EXECUTIVE_AI_CANONICAL_AGENCY_AGGREGATOR === 'true' ||
    process.env.EXEC_AI_CANONICAL_AGG === 'true'
  );
}

// ─────────────────────────────────────────────────────────────────────
// Internal coercion helpers
// ─────────────────────────────────────────────────────────────────────

function toFiniteNumber(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function toBool(v: boolean | string | number | null | undefined): boolean {
  if (typeof v === 'boolean') return v;
  if (v === null || v === undefined) return false;
  if (typeof v === 'number') return v !== 0;
  const s = String(v).toLowerCase();
  return s === 'true' || s === 't' || s === '1';
}
