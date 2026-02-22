import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { SmartApproveReferenceService } from './smart-approve-reference.service';
import { SmartApprovePrecheckService } from './smart-approve-precheck.service';
import { GeoBoundaryService } from './geo-boundary.service';
import { Strategy } from 'src/strategy/entities/strategy.entity';
import { Tactic } from 'src/tactic/entities/tactic.entity';
import { Plan } from 'src/plan/entities/plan.entity';
import { PlanTactic } from 'src/plan/entities/plan-tactic.entity';
import { Amphoe } from 'src/amphoes/entities/amphoe.entity';
import { LocalAdministrativeOrganization } from 'src/local-administrative-organizations/entities/local-administrative-organization.entity';
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
    ]),
    AiUsageQuotasModule,
  ],
  controllers: [AiController],
  providers: [
    AiService,
    SmartApproveReferenceService,
    GeoBoundaryService,
    SmartApprovePrecheckService,
  ],
})
export class AiModule { }
