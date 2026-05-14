import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AttachmentSupplementProjectGroupsController } from './attachment-supplement-project-groups.controller';
import { AttachmentSupplementProjectGroupsService } from './attachment-supplement-project-groups.service';
import { AttachmentSupplementProjectGroup } from './entities/attachment-supplement-project-group.entity';
import { SupplementProjectGroup } from 'src/supplement-project-group/entities/supplement-project-group.entity';
import { SupplementScopeModule } from 'src/common/supplement-scope/supplement-scope.module';
import { WorkHistoryModule } from 'src/work-history/work-history.module';

/**
 * SUPP-3 / BE-07 — Attachment module for `SupplementProjectGroup`.
 *
 * Mirrors `AttachmentProjectGroupsModule` /
 * `AttachmentRevisedProjectGroupsModule`. Two divergences vs PG / RPG:
 *
 *   1. Imports `SupplementScopeModule` + `WorkHistoryModule` so the
 *      service can enforce the §1+§2 supplement owner-scope gate
 *      (BE-04 contract) on upload + delete.
 *   2. Does NOT import `DocumentAnalysisModule` /
 *      `AiUsageQuotasModule` — `DocumentAnalysisService` does not yet
 *      expose an SPG `kind`, so the AI analysis read + retry endpoints
 *      are intentionally deferred. See `TODO(SUPP-3-later)` markers in
 *      the service.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      AttachmentSupplementProjectGroup,
      SupplementProjectGroup,
    ]),
    SupplementScopeModule,
    WorkHistoryModule,
  ],
  controllers: [AttachmentSupplementProjectGroupsController],
  providers: [AttachmentSupplementProjectGroupsService],
  exports: [AttachmentSupplementProjectGroupsService],
})
export class AttachmentSupplementProjectGroupsModule {}
