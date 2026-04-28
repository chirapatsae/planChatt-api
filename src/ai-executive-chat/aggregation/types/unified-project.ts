/**
 * Wave 54 — Aggregation Layer Foundation (BE-W54-01).
 *
 * `UnifiedProject` is the logical row projected across the three
 * project-owning tables (`ProjectGroup`, `RevisedProjectGroup`,
 * `SupplementProjectGroup`) with `projectKind` as the discriminator.
 *
 * Shape contract — must match design memo §3.1 verbatim:
 *
 *   projectKind          — discriminator
 *   projectId            — PG.id | RPG.id | SPG.id
 *   name                 — projected from the owning entity
 *   planId               — DevelopmentPlan.id (resolved via chain)
 *   planReportFormat     — STRATEGY_BASED | ISSUE_BASED (§16)
 *   amphoeId?            — null for SPG (no column) — advisory dimension
 *   responsibleAgencyId? — nullable on all three shapes
 *   latestStatus?        — Thai status name (populated when includeStatus)
 *   latestStatusAt?      — ISO timestamp
 *   totalBudget?         — SUM across the three Budget FKs
 *   strategyId? / tacticId? / planLevelId? / indicator? —
 *                          STRATEGY_BASED classification fields (§16.5)
 *   developmentIssueId?  — ISSUE_BASED classification field (§16.5)
 *
 * CLAUDE.md references:
 *   - §10 Project Scope Binding — `planId` resolution walks the chain
 *     belonging to THIS project row (never a global latest lookup).
 *   - §16.5 Classification Shape Invariant — the classification fields
 *     obey exactly-one-shape; `ClassificationBranching` enforces it.
 *   - §17   PII discipline — NO person-level fields (`firstName`,
 *     `lastName`, `citizenId`, `phone`, `email`). Wave 55 W55-BE-07
 *     adds a JOIN through `createdBy` solely to read the creator
 *     WorkHistory's `amphoe.id` / `localAdministrativeOrganization.id`
 *     ID scalars for the `originType` discriminator (§1 + §5). Those
 *     IDs are NOT PII.
 */
import type { ProjectKind } from './project-kind';

export type PlanReportFormat = 'STRATEGY_BASED' | 'ISSUE_BASED';

export interface UnifiedProject {
  /** Discriminator — `main` | `revised` | `supplement`. */
  projectKind: ProjectKind;

  /** Physical project row id (PG.id | RPG.id | SPG.id). */
  projectId: string;

  /** Project name projected from the owning entity. */
  name: string;

  /** Resolved parent DevelopmentPlan id (via the appropriate chain). */
  planId: string;

  /** Parent plan's §16 `reportFormat`. */
  planReportFormat: PlanReportFormat;

  // ---- Optional dimensions (populated on-demand by Tier B services) ----

  /**
   * Amphoe FK on the row. Populated by `GeoEnrichment.annotate`.
   * Always `null` for `projectKind === 'supplement'` — SPG has no
   * `amphoe_id` column (see design §3.4, §5.3; locked decision §11.3).
   */
  amphoeId?: number | null;

  /**
   * Responsible-agency FK on the row. Populated when `includeAgency`
   * is requested.
   */
  responsibleAgencyId?: number | null;

  /**
   * Latest Thai status name — populated by `StatusAggregator`
   * (design §3.3). Derived from `TrackingStatus` with `isLatest=true`.
   */
  latestStatus?: string;

  /**
   * ISO timestamp of the latest `TrackingStatus` row — paired with
   * `latestStatus`.
   */
  latestStatusAt?: string;

  /**
   * SUM of `Budget.quantity` fanned across the three FK columns for
   * this row. Populated by `BudgetAggregator` (design §3.2).
   */
  totalBudget?: number;

  // ---- Classification — exactly ONE shape per row per §16.5 ----

  /** STRATEGY_BASED. */
  strategyId?: string | null;
  /** STRATEGY_BASED. */
  tacticId?: string | null;
  /** STRATEGY_BASED — the canonical `Plan` classification entity id. */
  planLevelId?: string | null;
  /** STRATEGY_BASED — KPI text. NULL in ISSUE_BASED shape. */
  indicator?: string | null;

  /** ISSUE_BASED. */
  developmentIssueId?: string | null;

  // ---- Wave 55 W55-BE-07 — Project origin discriminator ----

  /**
   * Derived classification of the project origin per CLAUDE.md §1 + §5.
   *
   *   - `'agency-normal'`    — creator WorkHistory classified as `agency`
   *                            (amphoe.id === '3001' AND LAO.id === '3001027').
   *                            Business label: "โครงการปกติ".
   *   - `'lao-coordinated'`  — all other classifications.
   *                            Business label: "โครงการประสานแผน".
   *
   * Derivation is done AT QUERY TIME from the row's own
   * `createdBy.workHistory` amphoe + LAO id scalars — NEVER from the
   * current caller's WorkHistory. Per §5 project type is immutable once
   * the row is inserted, so `originType` is deterministic across calls.
   *
   * Only the two ID scalars flow out of the JOIN; no PII (no firstname /
   * lastname / citizenId / email / phone) is projected.
   */
  originType: 'lao-coordinated' | 'agency-normal';
}
