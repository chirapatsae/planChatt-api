/**
 * SUPP_AGG_BE_01 — `UnifiedProjectsModule`.
 *
 * Exposes two read-only HTTP routes over the Wave 54 Tier B
 * `UnifiedProjectAggregator`. Dependency direction is one-way:
 *
 *   UnifiedProjectsModule  →  AggregationModule  (consumed via DI token)
 *
 * `AggregationModule` MUST NOT import this module — that would
 * reintroduce the W54 circular-import risk explicitly mitigated in
 * `aggregation.module.ts`.
 *
 * The `UNIFIED_PROJECT_AGGREGATOR` symbol is already exported from
 * `AggregationModule`; no provider duplication is needed here.
 *
 * `WorkStatusApprovedGuard` injects a `Repository<WorkHistory>`; the
 * `UnifiedProjectsService` also reads `WorkHistory` for the §1
 * classification gate. We register the entity once via `forFeature` and
 * both consumers share the same repository.
 *
 * Wave SUPP_AGG_BE_01b — enrichment layer.
 *   `UnifiedProjectEnricherService` post-processes the lean aggregator
 *   rows into the richer `EnrichedUnifiedProject` shape consumed by FE.
 *   It reads the PG / RPG / SPG repos transitively through
 *   `AggregationModule`'s re-exported `TypeOrmModule` (which already
 *   registers all three entities + Budget + TrackingStatus). The
 *   `LineageLockService` is provided via its own dedicated module so
 *   `hasDescendant` is computed by the same canonical helper used by
 *   the workflow write paths (§14.10).
 *
 * CLAUDE.md references:
 *   - §1   classification used by `UnifiedProjectsService`.
 *   - §12  audit — read-only, no writes anywhere in this module.
 *   - §14.10 lineage lock — delegated to the shared
 *           `LineageLockService` (no duplicated invariant).
 *   - §17.2 / §17.3 / §17.11 — advisory, FK-isolated, no role
 *     exemption.
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { AggregationModule } from 'src/ai-executive-chat/aggregation/aggregation.module';
import { RolesGuard } from 'src/auth/roles.guard';
import { WorkStatusApprovedGuard } from 'src/auth/work-status-approved.guard';
import { LineageLockModule } from 'src/common/lineage-lock/lineage-lock.module';

import { UnifiedProjectsController } from './unified-projects.controller';
import { UnifiedProjectsService } from './unified-projects.service';
import { UnifiedProjectEnricherService } from './services/unified-project-enricher.service';

@Module({
  imports: [
    // `WorkStatusApprovedGuard` + `UnifiedProjectsService` both inject
    // `Repository<WorkHistory>`. The entity is already registered at
    // the root DataSource in `app.module.ts`; this `forFeature` call
    // makes the repo injection token resolvable inside this module.
    TypeOrmModule.forFeature([WorkHistory]),
    // Tier B aggregation layer. Imports the `UNIFIED_PROJECT_AGGREGATOR`
    // DI token — the service injects by interface, not by concrete
    // class (matches the BE-W54-02 contract). Also re-exports
    // `TypeOrmModule` with PG / RPG / SPG / Budget / TrackingStatus
    // entities so the enricher can pull them via the ambient
    // `DataSource.manager` without redundant `forFeature` registration.
    AggregationModule,
    // SUPP_AGG_BE_01b — `LineageLockService` is the single source of
    // truth for §14 lineage-lock checks. Reusing it here (instead of
    // hand-rolling a query) guarantees the FE `hasDescendant` flag
    // never drifts from the workflow write paths.
    LineageLockModule,
  ],
  controllers: [UnifiedProjectsController],
  providers: [
    UnifiedProjectsService,
    // SUPP_AGG_BE_01b — enrichment helper. Kept as a separate service
    // so `UnifiedProjectsService` stays thin and the enrichment query
    // plan (3 batch loads + 2 lineage-lock fan-outs) is unit-testable
    // in isolation.
    UnifiedProjectEnricherService,
    // Guards used by the controller's @UseGuards(...) chain. Registered
    // here so DI can resolve them without leaning on the owning auth
    // module (mirrors `AiExecutiveChatModule`'s pattern).
    RolesGuard,
    WorkStatusApprovedGuard,
  ],
})
export class UnifiedProjectsModule {}
