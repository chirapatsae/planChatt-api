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
import { Budget } from 'src/budget/entities/budget.entity';
import { TrackingStatus } from 'src/tracking-status/entities/tracking-status.entity';
import { AiUsageQuotasModule } from 'src/ai-usage-quotas/ai-usage-quotas.module';

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
      Budget,
      TrackingStatus,
    ]),
    AiUsageQuotasModule,
  ],
  controllers: [AiController],
  providers: [
    AiService,
    AiContextService,
    SmartApproveReferenceService,
    GeoBoundaryService,
    CoordinateContextService,
    SmartApprovePrecheckService,
  ],
})
export class AiModule {}
