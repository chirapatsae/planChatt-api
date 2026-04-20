import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { AiContextService } from './ai-context.service';
import { SmartApproveReferenceService } from './smart-approve-reference.service';
import { SmartApprovePrecheckService } from './smart-approve-precheck.service';
import { GeoBoundaryService } from './geo-boundary.service';
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
import { WorkHistoryGovernmentAgencyResponsibility } from 'src/work-history-government-agency-responsibility/entities/work-history-government-agency-responsibility.entity';
import { AiUsageQuotasModule } from 'src/ai-usage-quotas/ai-usage-quotas.module';
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
      WorkHistoryGovernmentAgencyResponsibility,
    ]),
    AiUsageQuotasModule,
    LineageLockModule,
    BookLockModule,
    CriteriaModule,
  ],
  controllers: [AiController],
  providers: [
    AiService,
    AiContextService,
    SmartApproveReferenceService,
    GeoBoundaryService,
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
    // Wave 24 N4 — criteria-aware pre-check services.
    IssueCriteriaGeoCheckService,
    IssueCriteriaEvidenceCheckService,
  ],
  exports: [AiResultEnvelopeService, CriteriaModule],
})
export class AiModule {}
