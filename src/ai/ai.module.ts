import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { AiContextService } from './ai-context.service';
import { SmartApproveReferenceService } from './smart-approve-reference.service';
import { SmartApprovePrecheckService } from './smart-approve-precheck.service';
import { GeoBoundaryService } from './geo-boundary.service';
// Wave 29 N1 — deterministic land-use ground-truth lookup for ISSUE_BASED
// LAO AI generate. Advisory per §17.2; no FK into project tables (§17.3).
import { GeoFeatureLookupService } from './geo-feature-lookup.service';
// Wave 31 N2 — deterministic reverse-geocoder (pin -> tambon / amphoe /
// changwat triple) for NR. Advisory per §17.2; fails open on missing
// or malformed GeoJSON; no FK into project tables (§17.3).
import { AdminBoundaryLookupService } from './admin-boundary-lookup.service';
// Wave 32 N1 — two-LLM chain pre-classifier for ISSUE_BASED LAO AI
// generate. Advisory per §17.2; in-memory cache only (§17.3); strict
// schema-validated output (§17.9); structured-only input (§17.9).
import { LandUseClassifierService } from './land-use-classifier.service';
// Wave 30 N1 — deterministic feature × project-type conflict engine.
// Advisory per §17.2; pure, no I/O, no FK into project tables (§17.3).
import { GeoConflictService } from './conflict/geo-conflict.service';
// Wave 33.6 N1 — deterministic feasibility gate. Hard-stops AI generation
// when the (geoFeature, projectType, conflictLevel) triple is physically
// impossible (e.g. road in a reservoir). TOOL-BEHAVIOR gate per §17.2 —
// does NOT gate any workflow transition. Pure; no I/O; no persistence.
import { FeasibilityGateService } from './feasibility/feasibility-gate.service';
import { CoordinateContextService } from './coordinate-context.service';
import { Strategy } from 'src/strategy/entities/strategy.entity';
import { Tactic } from 'src/tactic/entities/tactic.entity';
import { Plan } from 'src/plan/entities/plan.entity';
import { PlanTactic } from 'src/plan/entities/plan-tactic.entity';
import { Amphoe } from 'src/amphoes/entities/amphoe.entity';
import { LocalAdministrativeOrganization } from 'src/local-administrative-organizations/entities/local-administrative-organization.entity';
import { DevelopmentIssue } from 'src/development-issue/entities/development-issue.entity';
import { ProjectGroup } from 'src/project-groups/entities/project-group.entity';
import { RevisedProjectGroup } from 'src/revised-project-group/entities/revised-project-group.entity';
import { SupplementProjectGroup } from 'src/supplement-project-group/entities/supplement-project-group.entity';
import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { Budget } from 'src/budget/entities/budget.entity';
import { TrackingStatus } from 'src/tracking-status/entities/tracking-status.entity';
// RF5 — persisted user-side pre-submit AI score (CLAUDE.md §17.3 / §17.4).
import { AiPreSubmitSnapshot } from './entities/ai-pre-submit-snapshot.entity';
import { PreSubmitSnapshotService } from './pre-submit-snapshot.service';
// Wave 40 N4 — schema-only scaffold for staff smart-approve reviewer
// runs (§17.3 / §17.4 `strict`). Registered here so TypeORM picks up
// the entity for metadata. Wave 41 N2 wires the write path via
// `StaffReviewCacheService`.
import { AiStaffReviewRun } from './entities/ai-staff-review-run.entity';
// Wave 41 N2 — staff reviewer cache service (strict staleness, cross-
// reviewer reuse, drift soft-delete+insert). Advisory-only (§17.2) and
// audit-separated (§17.3).
import { StaffReviewCacheService } from './staff-review-cache.service';
// Wave 41 N3 — staff reviewer-framed prompt builder + executor.
// Branches on §16.5 (STRATEGY_BASED / ISSUE_BASED), wraps user-sourced
// text in <<<USER_INPUT>>>...<<<END>>> delimiters per §17.9, and
// validates LLM output shape server-side (502 AI_SCHEMA_DRIFT on
// violation).
import { StaffReviewPromptService } from './staff-review-prompt.service';
import { WorkHistoryGovernmentAgencyResponsibility } from 'src/work-history-government-agency-responsibility/entities/work-history-government-agency-responsibility.entity';
import { AiUsageQuotasModule } from 'src/ai-usage-quotas/ai-usage-quotas.module';
// Wave 36 N2 — rich detail logging for every LLM call site.
// Imported via forwardRef to defuse any future cycle when
// AiUsageLogsModule needs to import from AiModule. One-sided ref is
// sufficient today because AiUsageLogsModule is a leaf.
import { AiUsageLogsModule } from 'src/ai-usage-logs/ai-usage-logs.module';
import { LineageLockModule } from 'src/common/lineage-lock/lineage-lock.module';
import { BookLockModule } from 'src/common/book-lock/book-lock.module';
// AI cooldown (CLAUDE.md §17.8) — additive registration, no DB coupling.
import { AiCooldownGuard } from './guards/ai-cooldown.guard';
import {
  AI_COOLDOWN_STORE,
  createAiCooldownStore,
} from './stores/ai-cooldown.store';
// Shared staleness-model foundation (CLAUDE.md §17). Read-only envelope
// composer consumed by downstream RF2/RF5.
import { AiResultEnvelopeService } from './ai-result-envelope.service';
// Wave 24 N1 — issue-based criteria registry. Exported so N3/N4 prompt
// injection can reuse the same lookup as the GET endpoint.
import { CriteriaModule } from './criteria/criteria.module';
// SEC-W44-02 — shared PII redactor (§17.9 complementary to delimiter
// wrap).  Every LLM call site in this module MUST invoke
// PiiRedactorService on user-controlled inputs BEFORE the LLM call.
import { PiiRedactorModule } from 'src/common/pii/pii-redactor.module';
// Wave 24 N4 — deterministic pre-checks feeding the pre-submit review
// prompt. Both services are advisory-only (§17.2) and stateless.
import { IssueCriteriaGeoCheckService } from './criteria/issue-criteria-geo-check.service';
import { IssueCriteriaEvidenceCheckService } from './criteria/issue-criteria-evidence-check.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Strategy,
      Tactic,
      Plan,
      PlanTactic,
      Amphoe,
      LocalAdministrativeOrganization,
      DevelopmentIssue,
      ProjectGroup,
      RevisedProjectGroup,
      SupplementProjectGroup,
      WorkHistory,
      Budget,
      TrackingStatus,
      AiPreSubmitSnapshot,
      AiStaffReviewRun,
      WorkHistoryGovernmentAgencyResponsibility,
    ]),
    AiUsageQuotasModule,
    forwardRef(() => AiUsageLogsModule),
    LineageLockModule,
    BookLockModule,
    CriteriaModule,
    PiiRedactorModule,
  ],
  controllers: [AiController],
  providers: [
    AiService,
    AiContextService,
    SmartApproveReferenceService,
    GeoBoundaryService,
    GeoFeatureLookupService,
    // Wave 31 N2 — NR reverse-geocoder for the [ADMIN_CONTEXT] block.
    AdminBoundaryLookupService,
    // Wave 32 N1 — land-use pre-classifier (two-LLM chain).
    LandUseClassifierService,
    // Wave 30 N1 — conflict engine.
    GeoConflictService,
    // Wave 33.6 N1 — feasibility gate (post-conflict short-circuit).
    FeasibilityGateService,
    CoordinateContextService,
    SmartApprovePrecheckService,
    // AI cooldown wiring. Memory store by default;
    // set AI_COOLDOWN_BACKEND=redis to swap to the Redis stub.
    {
      provide: AI_COOLDOWN_STORE,
      useFactory: () => createAiCooldownStore(),
    },
    AiCooldownGuard,
    // §17 shared staleness-model foundation (read-only helper).
    AiResultEnvelopeService,
    // RF5 — persisted pre-submit AI score (owner write + staff read).
    PreSubmitSnapshotService,
    // Wave 41 N2 — staff reviewer run cache.
    StaffReviewCacheService,
    // Wave 41 N3 — staff reviewer prompt builder + executor.
    StaffReviewPromptService,
    // Wave 24 N4 — criteria-aware pre-check services.
    IssueCriteriaGeoCheckService,
    IssueCriteriaEvidenceCheckService,
  ],
  exports: [
    AiResultEnvelopeService,
    CriteriaModule,
    // W113-BE-BATCH — `PreSubmitSnapshotService` is consumed by
    // `BulkUploadService` to fire the per-row §17.4 `no-ai-baseline`
    // snapshot post-commit. Exporting keeps the snapshot write path
    // single-sourced (no parallel `ai_pre_submit_snapshots` table writer).
    PreSubmitSnapshotService,
  ],
})
export class AiModule {}
