import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AttachmentSupplementProjectGroupsController } from './attachment-supplement-project-groups.controller';
import { AttachmentSupplementProjectGroupsService } from './attachment-supplement-project-groups.service';
import { AttachmentSupplementProjectGroup } from './entities/attachment-supplement-project-group.entity';
import { SupplementProjectGroup } from 'src/supplement-project-group/entities/supplement-project-group.entity';
import { SupplementScopeModule } from 'src/common/supplement-scope/supplement-scope.module';
import { WorkHistoryModule } from 'src/work-history/work-history.module';
// SUPP_AI_BE_02 — AI analysis read + staff-lead retry endpoints now
// live on this controller, mirroring the PG / RPG controllers
// byte-for-byte. `DocumentAnalysisModule` exports the shared
// `DocumentAnalysisService` (kind union widened by SUPP_AI_BE_01 to
// include `'supplement-project-group'`); `AiUsageQuotasModule` exports
// the `AiQuotaGuard` used to gate the retry endpoint.
import { DocumentAnalysisModule } from 'src/document-analysis/document-analysis.module';
import { AiUsageQuotasModule } from 'src/ai-usage-quotas/ai-usage-quotas.module';

/**
 * SUPP-3 / BE-07 — Attachment module for `SupplementProjectGroup`.
 *
 * Mirrors `AttachmentProjectGroupsModule` /
 * `AttachmentRevisedProjectGroupsModule`. One divergence vs PG / RPG:
 *
 *   - Imports `SupplementScopeModule` + `WorkHistoryModule` so the
 *     service can enforce the §1+§2 supplement owner-scope gate
 *     (BE-04 contract) on upload + delete.
 *
 * AI wiring (SUPP_AI_BE_02): imports `DocumentAnalysisModule` and
 * `AiUsageQuotasModule` to enable the `GET :id/analysis` read and
 * `POST :id/analysis/retry` staff-lead retry endpoints on the
 * controller.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      AttachmentSupplementProjectGroup,
      SupplementProjectGroup,
    ]),
    SupplementScopeModule,
    WorkHistoryModule,
    DocumentAnalysisModule,
    AiUsageQuotasModule,
  ],
  controllers: [AttachmentSupplementProjectGroupsController],
  providers: [AttachmentSupplementProjectGroupsService],
  exports: [AttachmentSupplementProjectGroupsService],
})
export class AttachmentSupplementProjectGroupsModule {}
