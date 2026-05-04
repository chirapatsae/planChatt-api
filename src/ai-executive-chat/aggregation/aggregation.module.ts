/**
 * Wave 54 — Aggregation Layer Foundation (BE-W54-01).
 *
 * `AggregationModule` scaffolds the Tier B composer layer. It registers
 * the 14 entities the six aggregation services need via
 * `TypeOrmModule.forFeature([...])` and re-exports the TypeORM surface
 * so concrete providers (added in BE-W54-02..05 and BE-W54-07) can
 * inject repositories directly.
 *
 * Intentional NON-scope for BE-W54-01:
 *   - NO providers. Concrete aggregation classes land in BE-W54-02..05.
 *   - NO exports of DI tokens yet — the tokens live in `tokens.ts`;
 *     BE-W54-02..05 will add each provider + export its token pair here.
 *   - NO controller. Tier B services are INTERNAL.
 *   - NO import of `AiExecutiveChatModule`. Dependency direction is
 *     one-way: `AiExecutiveChatModule` imports `AggregationModule`
 *     (task §11.R1 — circular-import mitigation).
 *
 * Design references:
 *   - `docs/reports/wave54/WAVE54_EXECUTIVE_QUERY_ENGINE_DESIGN.md`
 *     §2 (three-tier model), §3 (unification model).
 *   - `CLAUDE.md` §§12, 14, 15, 16.5, 17.2, 17.3, 17.11.
 *
 * Entity list — design §7 coverage matrix (14 entities):
 *   - DevelopmentPlan            — plan-scope + reportFormat
 *   - DevelopmentPlanRevision    — revised-chain parent
 *   - DevelopmentPlanSupplement  — supplement-chain parent
 *   - ProjectGroup               — `main` kind
 *   - RevisedProjectGroup        — `revised` kind
 *   - SupplementProjectGroup     — `supplement` kind
 *   - Budget                     — 3-FK fan-out (§3.2)
 *   - TrackingStatus             — 3-FK status composition (§3.3)
 *   - Amphoe                     — GeoEnrichment (§3.4)
 *   - GovernmentAgency           — AgencyEnrichment (§3.4)
 *   - Strategy                   — STRATEGY_BASED classification (§16.5)
 *   - Tactic                     — STRATEGY_BASED classification (§16.5)
 *   - Plan                       — STRATEGY_BASED planLevel entity
 *   - DevelopmentIssue           — ISSUE_BASED classification (§16.5)
 *
 * PII discipline (§17): `WorkHistory` is deliberately EXCLUDED from
 * `forFeature` registration. The executive engine NEVER projects
 * person-level fields (firstName / lastName / citizenId / phone /
 * email). Wave 55 W55-BE-07 composes a LEFT JOIN from project
 * `createdBy` → WorkHistory → (Amphoe | LocalAdministrativeOrganization)
 * via TypeORM relation metadata to read the two ID scalars
 * (amphoe.id / lao.id) that drive the §1 + §5 `originType`
 * discriminator. Those IDs are NOT PII and the JOIN runs through the
 * ambient DataSource without a repository injection.
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Amphoe } from 'src/amphoes/entities/amphoe.entity';
import { Budget } from 'src/budget/entities/budget.entity';
import { AgencyEnrichmentService } from './services/agency-enrichment.service';
import { AgencyProjectsCanonicalAggregatorService } from './services/agency-projects-canonical-aggregator.service';
import { BookTimelineService } from './services/book-timeline.service';
import { BudgetAggregatorService } from './services/budget-aggregator.service';
import { ProjectLineageService } from './services/project-lineage.service';
import { GeoEnrichmentService } from './services/geo-enrichment.service';
import { ResilienceEnvelopeService } from './resilience-envelope.service';
import { StatusAggregator } from './services/status-aggregator.service';
import { UnifiedProjectAggregator } from './services/unified-project-aggregator.service';
import {
  AGENCY_ENRICHMENT,
  BUDGET_AGGREGATOR,
  GEO_ENRICHMENT,
  RESILIENCE_ENVELOPE,
  STATUS_AGGREGATOR,
  UNIFIED_PROJECT_AGGREGATOR,
} from './tokens';
import { DevelopmentIssue } from 'src/development-issue/entities/development-issue.entity';
import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';
import { DevelopmentPlanRevision } from 'src/development-plan-revision/entities/development-plan-revision.entity';
import { DevelopmentPlanSupplement } from 'src/development-plan-supplement/entities/development-plan-supplement.entity';
import { GovernmentAgency } from 'src/government-agencies/entities/government-agency.entity';
// `Plan` here is the classification-level `Plan` entity (STRATEGY_BASED
// planLevelId), NOT `DevelopmentPlan` (the plan book). See task §11.R2.
import { Plan } from 'src/plan/entities/plan.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';
import { Strategy } from 'src/strategy/entities/strategy.entity';
import { SupplementProjectGroup } from 'src/supplement-project-group/entities/supplement-project-group.entity';
import { Tactic } from 'src/tactic/entities/tactic.entity';
import { TrackingStatus } from 'src/tracking-status/entities/tracking-status.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      DevelopmentPlan,
      DevelopmentPlanRevision,
      DevelopmentPlanSupplement,
      ProjectGroup,
      RevisedProjectGroup,
      SupplementProjectGroup,
      Budget,
      TrackingStatus,
      Amphoe,
      GovernmentAgency,
      Strategy,
      Tactic,
      Plan,
      DevelopmentIssue,
    ]),
  ],
  providers: [
    // BE-W54-02 — UnifiedProjectAggregator. Discriminated PG/RPG/SPG
    // projection keyed by `projectKind`. READ-only per §17.2. Bound to
    // the `UNIFIED_PROJECT_AGGREGATOR` token so Tier C handlers
    // (BE-W54-06) depend on `IUnifiedProjectAggregator`, not the
    // concrete class (design memo §2 Tier B rules).
    UnifiedProjectAggregator,
    {
      provide: UNIFIED_PROJECT_AGGREGATOR,
      useExisting: UnifiedProjectAggregator,
    },
    // BE-W54-03 — BudgetAggregator. Injected by Tier C handlers via the
    // `BUDGET_AGGREGATOR` DI token so consumers depend on the interface,
    // not the concrete class (design memo §2 Tier B rules).
    BudgetAggregatorService,
    { provide: BUDGET_AGGREGATOR, useExisting: BudgetAggregatorService },
    // BE-W54-04 — StatusAggregator. READ-only composition of
    // TrackingStatus across its three FK columns; §12 audit ownership
    // preserved (no `tracking_status` writes anywhere in this service).
    // Bound to the `STATUS_AGGREGATOR` token so Tier C handlers
    // (BE-W54-06) depend on `IStatusAggregator`, not the concrete class.
    StatusAggregator,
    { provide: STATUS_AGGREGATOR, useExisting: StatusAggregator },
    // BE-W54-05 — GeoEnrichment. LEFT JOIN Amphoe for main + revised;
    // SPG skipped per §11.3 locked decision (emits
    // `missingDimensions: ['geo:supplement']` + static Thai advisory).
    GeoEnrichmentService,
    { provide: GEO_ENRICHMENT, useExisting: GeoEnrichmentService },
    // BE-W54-05 — AgencyEnrichment. LEFT JOIN GovernmentAgency for all
    // three kinds; fallback label `'ไม่ระบุ'`. Agency numeric id is
    // NEVER emitted as an LLM-visible label.
    AgencyEnrichmentService,
    { provide: AGENCY_ENRICHMENT, useExisting: AgencyEnrichmentService },
    // BE-W54-07 — ResilienceEnvelope. Wraps each Tier C dimension call
    // in a soft-timeout + try/catch band, emitting a partial envelope
    // with server-authored Thai advisories on failure. NEVER throws on
    // dimension failure (design §5.2 / §17.2 / §17.9).
    ResilienceEnvelopeService,
    {
      provide: RESILIENCE_ENVELOPE,
      useExisting: ResilienceEnvelopeService,
    },
    // Wave 57 W57-BE-AGG-06 — Book global-timeline (§15.2) helpers used
    // by chat-tool surfaces that answer "เล่มล่าสุด" / "โครงการล่าสุด".
    // READ-only; no §17.3 audit boundary impact.
    BookTimelineService,
    // Wave 61 — Mode 3 lineage tools. `getProjectHeadBook` answers
    // "เล่มล่าสุดของโครงการ X" and `getProjectLineage` answers
    // "ไทม์ไลน์โครงการ X". §10 + §14.2 — walks the row's own plan chain
    // to find HEAD-of-lineage; §17.2 advisory; §17.3 read-only.
    ProjectLineageService,
    // Wave 103 PR1 — single source of truth for agency-project counts /
    // budget totals across Executive AI tools. Behind feature flag
    // `EXECUTIVE_AI_CANONICAL_AGENCY_AGGREGATOR` (default OFF). PR2
    // reroutes existing tool handlers; PR1 only registers the provider
    // so it's resolvable in DI graph and unit tests. §17.2 advisory,
    // §17.3 read-only, §11 / §14 / §15 lineage-aware.
    AgencyProjectsCanonicalAggregatorService,
  ],
  // Re-export `TypeOrmModule` so concrete providers (BE-W54-02..05,
  // BE-W54-07) resolve the repositories through this module once
  // wired, and so Tier C handlers in `AiExecutiveChatModule` can
  // reuse the same `forFeature` registrations transitively.
  // Also export the aggregation-service tokens so Tier C handlers
  // (BE-W54-06) can inject them.
  exports: [
    TypeOrmModule,
    UNIFIED_PROJECT_AGGREGATOR,
    BUDGET_AGGREGATOR,
    STATUS_AGGREGATOR,
    GEO_ENRICHMENT,
    AGENCY_ENRICHMENT,
    RESILIENCE_ENVELOPE,
    // Wave 57 W57-BE-AGG-06 — exposed by class for now (no DI token);
    // Tier C tools that consume it inject the concrete class.
    BookTimelineService,
    // Wave 61 — Mode 3 lineage tools. Exposed by class for now (no DI
    // token); Tier C tool handlers inject the concrete class.
    ProjectLineageService,
    // Wave 103 PR1 — exposed by class so PR2 tool handlers can inject
    // the concrete service when the canonical-aggregator feature flag
    // is on.
    AgencyProjectsCanonicalAggregatorService,
  ],
})
export class AggregationModule {}
